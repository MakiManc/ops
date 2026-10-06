/**
 * What each site has ordered in a month.
 *
 * This replaced the recharge report, which had never produced a row: it filtered to
 * `sites.recharge = 1` and no site has ever had that set, and it priced from
 * `order_lines.recharge_unit_price`, which is only snapshotted for recharge sites — so of
 * 83 real order lines, none carried a price. The question people actually ask, "how much
 * has this restaurant had", had no answer for any site in the group.
 *
 * The two things this has to get right are which quantity it counts and which orders it
 * counts at all. Both are easy to get wrong in a direction that overstates.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { orderedBySite, orderedCsv } from '../src/server/reports/ordered.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, recharge) VALUES
      (1, 'M19', 'Maki M19', 'restaurant', 0),
      (2, 'M3', 'Maki M3', 'restaurant', 0),
      (3, 'MAF1', 'Guildford', 'franchise', 1);
    INSERT INTO products (id, name, stock_type) VALUES
      (48, 'Ramekin', 'internal'),
      (22, 'FOH Kimono', 'internal'),
      (37, 'Ladle', 'internal');
  `)
})

/** An order as approval leaves it: a status, a month, and an approved quantity per line. */
const order = (
  id: number, siteId: number, number: string, approvedAt: string | null,
  lines: [number, number, number | null][],
  status = 'posted',
) => {
  fake.exec(`INSERT INTO orders (id, order_number, site_id, type, status, approved_at)
             VALUES (${id}, '${number}', ${siteId}, 'replenishment', '${status}',
                     ${approvedAt ? `'${approvedAt}'` : 'NULL'})`)
  for (const [productId, requested, approved] of lines) {
    fake.exec(`INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved)
               VALUES (${id}, ${productId}, ${requested}, ${approved ?? 'NULL'})`)
  }
}

describe('every site, not just the franchises', () => {
  it('includes a corporate site, which the old report could never show', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60]])
    order(2, 3, 'MR-MAF1-001', '2026-10-02T11:00:00Z', [[48, 10, 10]])

    const report = await orderedBySite(db, '2026-10')
    expect(report.sites.map((s) => s.siteCode)).toEqual(['M19', 'MAF1'])
    expect(report.siteCount).toBe(2)
  })

  it('says which kind of site each is, because it changes who is asking', async () => {
    order(1, 3, 'MR-MAF1-001', '2026-10-02T11:00:00Z', [[48, 10, 10]])
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.siteType).toBe('franchise')
  })

  it('carries no money anywhere in the payload', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60]])
    const json = JSON.stringify(await orderedBySite(db, '2026-10'))
    // The money fields the old report carried, by name. `productTotals` and `itemCount`
    // stay: a total is not a price, and those are counts of things.
    for (const field of [
      'unitPrice', 'lineTotal', 'goodsTotal', 'orderFees', 'grandTotal',
      'rechargeUnitPrice', 'rechargeTotal', 'orderFee', 'unpricedLines',
    ]) {
      expect(json, `payload still carries ${field}`).not.toContain(field)
    }
  })
})

describe('which quantity it counts', () => {
  it('counts what was approved, not what was asked for', async () => {
    // An approver cutting 60 to 24 means 24 went. Reporting 60 would overstate every
    // site that ever had a request trimmed.
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 24]])
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.products[0]?.qty).toBe(24)
    expect(report.sites[0]?.itemCount).toBe(24)
  })

  it('adds the same product up across a site\'s orders, and says over how many', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60]])
    order(2, 1, 'MR-M19-002', '2026-10-04T11:00:00Z', [[48, 20, 20]])
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.products).toEqual([
      { productId: 48, productName: 'Ramekin', qty: 80, orders: 2 },
    ])
    expect(report.sites[0]?.orderCount).toBe(2)
  })

  it('leaves out a line signed off at nothing, and says how many there were', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [37, 5, 0]])
    const report = await orderedBySite(db, '2026-10')
    // Nothing was ordered for it, so listing it at 0 would read as an order for none.
    expect(report.sites[0]?.products.map((p) => p.productName)).toEqual(['Ramekin'])
    expect(report.warnings.join(' ')).toMatch(/1 line was signed off at nothing/)
  })

  it('reports a line with no approved quantity at all, which should be impossible', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, null]])
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.itemCount).toBe(0)
    expect(report.warnings.join(' ')).toMatch(/no approved quantity at all/)
  })
})

describe('which orders it counts', () => {
  it('leaves out a draft and a request still waiting for sign-off', async () => {
    order(1, 1, 'MR-M19-001', null, [[48, 60, null]], 'draft')
    order(2, 1, 'MR-M19-002', null, [[48, 60, null]], 'submitted')
    const report = await orderedBySite(db, '2026-10')
    // Neither is something the site has had.
    expect(report.sites).toEqual([])
  })

  it('leaves out a cancelled order, which is what keeps a merged-away one out', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60]])
    order(2, 1, 'MR-M19-002', '2026-10-02T11:00:00Z', [[22, 6, 6]], 'cancelled')
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.products.map((p) => p.productName)).toEqual(['Ramekin'])
  })

  it('counts an approved order but says it has not reached Mercium', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60]], 'approved')
    order(2, 1, 'MR-M19-002', '2026-10-03T11:00:00Z', [[22, 6, 6]], 'despatched')
    const report = await orderedBySite(db, '2026-10')
    // Signed off is not delivered, and a figure read as delivered would be wrong by
    // however much is still waiting.
    expect(report.sites[0]).toMatchObject({ orderCount: 2, ordersWithMercium: 1 })
  })

  it('buckets on the month it was signed off, so a slow despatch cannot move it', async () => {
    order(1, 1, 'MR-M19-001', '2026-09-30T23:00:00Z', [[48, 60, 60]])
    order(2, 1, 'MR-M19-002', '2026-10-01T01:00:00Z', [[22, 6, 6]])
    expect((await orderedBySite(db, '2026-09')).sites[0]?.itemCount).toBe(60)
    expect((await orderedBySite(db, '2026-10')).sites[0]?.itemCount).toBe(6)
  })

  it('refuses a month that is not a month', async () => {
    await expect(orderedBySite(db, 'October')).rejects.toThrow(/must look like 2026-10/)
  })

  it('says a quiet month is quiet', async () => {
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites).toEqual([])
    expect(report.warnings.join(' ')).toMatch(/No orders were signed off in 2026-10/)
  })
})

describe('the same figures cut by product', () => {
  it('totals each product across every site, biggest first', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [22, 6, 6]])
    order(2, 2, 'MR-M3-001', '2026-10-02T11:00:00Z', [[48, 20, 20]])
    const report = await orderedBySite(db, '2026-10')
    expect(report.productTotals).toEqual([
      { productId: 48, productName: 'Ramekin', qty: 80, orders: 2 },
      { productId: 22, productName: 'FOH Kimono', qty: 6, orders: 1 },
    ])
    expect(report.itemCount).toBe(86)
  })
})

describe('the CSV', () => {
  it('is one row per site and product, which is what a spreadsheet pivots from', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [22, 6, 6]])
    const csv = orderedCsv(await orderedBySite(db, '2026-10'))
    expect(csv.split('\n')).toEqual([
      'Month,Site,Site name,Type,Product,Quantity,Orders',
      '2026-10,M19,Maki M19,restaurant,FOH Kimono,6,1',
      '2026-10,M19,Maki M19,restaurant,Ramekin,60,1',
    ])
  })

  it('quotes a product name with a comma in it', async () => {
    fake.exec(`INSERT INTO products (id, name, stock_type) VALUES (99, 'Bowl, large', 'internal')`)
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[99, 4, 4]])
    expect(orderedCsv(await orderedBySite(db, '2026-10'))).toContain('"Bowl, large"')
  })

  it('has a header and nothing else in a quiet month', async () => {
    expect(orderedCsv(await orderedBySite(db, '2026-10')))
      .toBe('Month,Site,Site name,Type,Product,Quantity,Orders')
  })
})

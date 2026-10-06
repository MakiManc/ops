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
 *
 * It costs what it can from the China Stock Price File, and the thing to get right there
 * is the opposite direction: 28 of 93 products have no price in that file, so every total
 * is short, and the tests below pin that a missing price never reads as nothing. A gap
 * that shows is recoverable; a gap folded into a total is not.
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

/** A price as scripts/load-prices.ts leaves it: either a price or a reason, never both. */
const price = (
  productId: number, unitPrice: number | null, gapReason: string | null = null,
  extra: { distinct?: number; lowest?: number; highest?: number; note?: string } = {},
) => {
  fake.exec(
    `INSERT INTO product_prices
       (product_id, basis, unit_price, gap_reason, distinct_prices, lowest, highest, note)
     VALUES (${productId}, 'supplier', ${unitPrice ?? 'NULL'},
             ${gapReason ? `'${gapReason.replace(/'/g, "''")}'` : 'NULL'},
             ${extra.distinct ?? 1}, ${extra.lowest ?? 'NULL'}, ${extra.highest ?? 'NULL'},
             ${extra.note ? `'${extra.note.replace(/'/g, "''")}'` : 'NULL'})`,
  )
}

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

  it('never hands over a cost without saying what kind of cost it is', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60]])
    price(48, 0.86)
    const report = await orderedBySite(db, '2026-10')
    // Supplier cost reads as "what the site owes" to anyone who is not told otherwise,
    // and it is neither: no freight, no VAT, no duty, no markup.
    expect(report.cost).toBe(51.6)
    expect(report.priceBasisNote).toMatch(/[Ss]upplier cost of goods/)
    expect(report.priceBasisNote).toMatch(/[Ee]xcludes freight/)
    expect(report.priceBasisNote).toMatch(/VAT and duty/)
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
      {
        productId: 48, productName: 'Ramekin', qty: 80, orders: 2,
        unitPrice: null, cost: null, gapReason: null, priceNote: null,
      },
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
      {
        productId: 48, productName: 'Ramekin', qty: 80, orders: 2,
        unitPrice: null, cost: null, gapReason: null, priceNote: null,
      },
      {
        productId: 22, productName: 'FOH Kimono', qty: 6, orders: 1,
        unitPrice: null, cost: null, gapReason: null, priceNote: null,
      },
    ])
    expect(report.itemCount).toBe(86)
  })
})

describe('the CSV', () => {
  it('is one row per site and product, which is what a spreadsheet pivots from', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [22, 6, 6]])
    const csv = orderedCsv(await orderedBySite(db, '2026-10'))
    price(48, 0.86)
    price(22, null, 'Not in the price file.')
    const csv2 = orderedCsv(await orderedBySite(db, '2026-10'))
    expect(csv2.split('\n')).toEqual([
      'Month,Site,Site name,Type,Product,Quantity,Orders,Unit cost (GBP),Cost (GBP),Why no price',
      '2026-10,M19,Maki M19,restaurant,FOH Kimono,6,1,,,Not in the price file.',
      '2026-10,M19,Maki M19,restaurant,Ramekin,60,1,0.86,51.6,',
    ])
    expect(csv).toContain('Unit cost (GBP)')
  })

  it('quotes a product name with a comma in it', async () => {
    fake.exec(`INSERT INTO products (id, name, stock_type) VALUES (99, 'Bowl, large', 'internal')`)
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[99, 4, 4]])
    expect(orderedCsv(await orderedBySite(db, '2026-10'))).toContain('"Bowl, large"')
  })

  it('has a header and nothing else in a quiet month', async () => {
    expect(orderedCsv(await orderedBySite(db, '2026-10')))
      .toBe('Month,Site,Site name,Type,Product,Quantity,Orders,Unit cost (GBP),Cost (GBP),Why no price')
  })
})

describe('the money, and the gaps in it', () => {
  it('prices a line at the approved quantity, to the penny', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 24]])
    price(48, 0.86)
    const report = await orderedBySite(db, '2026-10')
    // 24 x 0.86 = 20.64, and not 20.639999999999997.
    expect(report.sites[0]?.products[0]).toMatchObject({ unitPrice: 0.86, cost: 20.64 })
    expect(report.sites[0]?.cost).toBe(20.64)
    expect(report.cost).toBe(20.64)
  })

  it('leaves an unpriced product at null, never at zero', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [22, 6, 6]])
    price(48, 0.86)
    price(22, null, 'Not in the price file.')
    const report = await orderedBySite(db, '2026-10')

    const kimono = report.sites[0]?.products.find((p) => p.productId === 22)
    // 0 is a price. null is the absence of one. A spreadsheet summing a column of zeros
    // gets a smaller answer and no hint that it is wrong.
    expect(kimono?.cost).toBeNull()
    expect(kimono?.unitPrice).toBeNull()
    expect(kimono?.gapReason).toBe('Not in the price file.')
  })

  it('says how much of the month it could not price', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [22, 6, 6]])
    order(2, 2, 'MR-M3-001', '2026-10-02T11:00:00Z', [[22, 4, 4], [37, 2, 2]])
    price(48, 0.86)
    price(22, null, 'Not in the price file.')
    price(37, null, 'Quoted per pack, not per unit.')

    const report = await orderedBySite(db, '2026-10')
    expect(report.cost).toBe(51.6)
    expect(report.unpricedProducts).toBe(2)
    expect(report.unpricedItems).toBe(12)   // 6 + 4 kimonos, 2 ladles
    expect(report.warnings.join(' '))
      .toMatch(/2 of the 3 products ordered have no price .* covering 12 items/)

    // And per site, because "which restaurant is this figure wrong for" is the question.
    expect(report.sites[0]).toMatchObject({ cost: 51.6, unpricedProducts: 1, unpricedItems: 6 })
    expect(report.sites[1]).toMatchObject({ cost: 0, unpricedProducts: 2, unpricedItems: 6 })
  })

  it('tells a product that cannot be priced from one nobody has loaded a price for', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [22, 6, 6]])
    price(48, null, 'Quoted per pack of 50, and we order these by the unit.')
    // 22 gets no row at all.

    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.products.find((p) => p.productId === 48)?.gapReason)
      .toMatch(/per pack of 50/)
    expect(report.sites[0]?.products.find((p) => p.productId === 22)?.gapReason).toBeNull()
    // Both are unpriced, but only one of them is somebody's job to go and load.
    expect(report.unpricedProducts).toBe(2)
    expect(report.warnings.join(' ')).toMatch(/1 product ordered this month is not in the price file at all/)
    expect(report.warnings.join(' ')).toMatch(/npm run prices/)
  })

  it('says so when the file holds more than one price for something', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 2, 2]])
    price(48, 99, null, { distinct: 2, lowest: 99, highest: 105 })
    const report = await orderedBySite(db, '2026-10')
    // £99 reads as settled. The documents say 99 and 105 and the latest happened to say 99.
    expect(report.sites[0]?.products[0]?.priceNote)
      .toMatch(/holds 2 different prices for this, from £99 to £105. The latest was taken./)
  })

  it('carries the price file’s own warning about a figure', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 2, 2]])
    price(48, 177, null, { note: 'Priced as the rectangle top; no separate golden-rim price.' })
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.products[0]?.priceNote).toMatch(/no separate golden-rim price/)
  })

  it('prices the summed quantity when a product is on two orders, not each order twice', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60]])
    order(2, 1, 'MR-M19-002', '2026-10-04T11:00:00Z', [[48, 20, 20]])
    price(48, 0.86)
    const report = await orderedBySite(db, '2026-10')
    expect(report.sites[0]?.products[0]).toMatchObject({ qty: 80, cost: 68.8 })
    expect(report.sites[0]?.cost).toBe(68.8)
  })

  it('charges nothing for a line signed off at nothing', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 0]])
    price(48, 0.86)
    const report = await orderedBySite(db, '2026-10')
    // The line is not listed at all, so it cannot cost anything.
    expect(report.sites[0]?.products).toEqual([])
    expect(report.cost).toBe(0)
  })

  it('keeps the three levels of the report agreeing with each other', async () => {
    order(1, 1, 'MR-M19-001', '2026-10-02T11:00:00Z', [[48, 60, 60], [22, 6, 6]])
    order(2, 2, 'MR-M3-001', '2026-10-02T11:00:00Z', [[48, 20, 20], [37, 3, 3]])
    price(48, 0.86)
    price(22, 7.9)
    price(37, 1.58)

    const report = await orderedBySite(db, '2026-10')
    const fromProducts = report.sites.flatMap((s) => s.products).reduce((n, p) => n + (p.cost ?? 0), 0)
    const fromSites = report.sites.reduce((n, s) => n + s.cost, 0)
    const fromTotals = report.productTotals.reduce((n, p) => n + (p.cost ?? 0), 0)
    expect(Math.round(fromProducts * 100) / 100).toBe(report.cost)
    expect(Math.round(fromSites * 100) / 100).toBe(report.cost)
    expect(Math.round(fromTotals * 100) / 100).toBe(report.cost)
    expect(report.cost).toBe(120.94)   // ramekins 68.80 + kimonos 47.40 + ladles 4.74
    expect(report.unpricedProducts).toBe(0)
    expect(report.warnings.join(' ')).not.toMatch(/no price/)
  })

  it('says nothing about money when nothing was ordered', async () => {
    const report = await orderedBySite(db, '2026-10')
    expect(report.cost).toBe(0)
    expect(report.unpricedProducts).toBe(0)
    expect(report.unpricedItems).toBe(0)
  })
})

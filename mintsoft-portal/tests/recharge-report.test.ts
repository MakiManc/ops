import { beforeEach, describe, expect, it } from 'vitest'
import { rechargeCsv, rechargeReport } from '../src/server/reports/recharge.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * What Finance invoices from. The numbers have to survive a price change, and a line
 * with no price must be visible rather than quietly counted as free.
 */

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, recharge) VALUES
      (1, 'MAF1', 'Guildford', 'franchise', 1),
      (2, 'MAF2', 'Reading', 'franchise', 1),
      (3, 'M9', 'Leith Walk', 'restaurant', 0);
    INSERT INTO products (id, name, stock_type, recharge_unit_price) VALUES
      (1, 'Ramen Bowl', 'internal', 4.20),
      (2, 'Chopsticks', 'internal', 0.08);
  `)
})

/** An approved franchise order with its prices snapshotted, as approval would leave it. */
const order = (
  id: number, siteId: number, orderNumber: string, approvedAt: string,
  lines: { productId: number; qty: number; price: number | null }[],
  orderFee = 12,
) => {
  fake.exec(`INSERT INTO orders (id, order_number, site_id, type, status, recharge, order_fee, approved_at)
             VALUES (${id}, '${orderNumber}', ${siteId}, 'replenishment', 'approved', 1, ${orderFee}, '${approvedAt}')`)
  for (const l of lines) {
    fake.exec(`INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved, recharge_unit_price)
               VALUES (${id}, ${l.productId}, ${l.qty}, ${l.qty}, ${l.price ?? 'NULL'})`)
  }
}

describe('the monthly report', () => {
  it('totals one site\'s orders, goods and fees separately', async () => {
    order(1, 1, 'MR-MAF1-20261005-001', '2026-10-05T10:00:00Z', [
      { productId: 1, qty: 10, price: 4.20 }, { productId: 2, qty: 200, price: 0.08 },
    ])
    const report = await rechargeReport(db, '2026-10')
    const site = report.siteTotals[0]!
    expect(site).toMatchObject({
      siteCode: 'MAF1', orderCount: 1, lineCount: 2, itemCount: 210,
      goodsTotal: 58, orderFees: 12, total: 70,
    })
  })

  it('counts the order fee once however many lines the order has', async () => {
    order(1, 1, 'MR-MAF1-20261005-001', '2026-10-05T10:00:00Z', [
      { productId: 1, qty: 1, price: 4.20 }, { productId: 2, qty: 1, price: 0.08 },
    ], 12)
    // A fee per line would triple-bill a three-line order.
    expect((await rechargeReport(db, '2026-10')).siteTotals[0]!.orderFees).toBe(12)
  })

  it('separates the franchise sites', async () => {
    order(1, 1, 'MR-MAF1-1', '2026-10-05T10:00:00Z', [{ productId: 1, qty: 10, price: 4.20 }])
    order(2, 2, 'MR-MAF2-1', '2026-10-06T10:00:00Z', [{ productId: 1, qty: 5, price: 4.20 }])
    const report = await rechargeReport(db, '2026-10')
    expect(report.siteTotals.map((s) => s.siteCode)).toEqual(['MAF1', 'MAF2'])
    expect(report.grandTotal).toBe(42 + 12 + 21 + 12)
  })

  it('leaves corporate sites out entirely', async () => {
    fake.exec(`INSERT INTO orders (id, order_number, site_id, type, status, recharge, approved_at)
               VALUES (9, 'MR-M9-1', 3, 'replenishment', 'approved', 0, '2026-10-05T10:00:00Z')`)
    fake.exec(`INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved, recharge_unit_price)
               VALUES (9, 1, 10, 10, 4.20)`)
    // Corporate sites are never recharged, whatever happens to sit on the line.
    expect((await rechargeReport(db, '2026-10')).siteTotals).toEqual([])
  })

  it('leaves out orders from other months', async () => {
    order(1, 1, 'MR-MAF1-SEP', '2026-09-30T23:59:00Z', [{ productId: 1, qty: 10, price: 4.20 }])
    order(2, 1, 'MR-MAF1-OCT', '2026-10-01T00:01:00Z', [{ productId: 1, qty: 1, price: 4.20 }])
    const report = await rechargeReport(db, '2026-10')
    expect(report.lines.map((l) => l.orderNumber)).toEqual(['MR-MAF1-OCT'])
  })

  it('leaves out orders that were never approved', async () => {
    order(1, 1, 'MR-MAF1-1', '2026-10-05T10:00:00Z', [{ productId: 1, qty: 10, price: 4.20 }])
    fake.exec(`UPDATE orders SET status = 'rejected' WHERE id = 1`)
    expect((await rechargeReport(db, '2026-10')).lines).toEqual([])
  })

  it('includes posted and despatched orders, not only just-approved ones', async () => {
    order(1, 1, 'MR-MAF1-1', '2026-10-05T10:00:00Z', [{ productId: 1, qty: 10, price: 4.20 }])
    fake.exec(`UPDATE orders SET status = 'despatched' WHERE id = 1`)
    expect((await rechargeReport(db, '2026-10')).lines).toHaveLength(1)
  })
})

describe('the price snapshot', () => {
  it('survives a later price change', async () => {
    order(1, 1, 'MR-MAF1-1', '2026-10-05T10:00:00Z', [{ productId: 1, qty: 10, price: 4.20 }])
    fake.exec(`UPDATE products SET recharge_unit_price = 99.99 WHERE id = 1`)
    // Reading the live price would silently restate an invoice already sent.
    const report = await rechargeReport(db, '2026-10')
    expect(report.lines[0]!.unitPrice).toBe(4.2)
    expect(report.siteTotals[0]!.goodsTotal).toBe(42)
  })

  it('shows an unpriced line with no value rather than counting it as free', async () => {
    order(1, 1, 'MR-MAF1-1', '2026-10-05T10:00:00Z', [
      { productId: 1, qty: 10, price: 4.20 }, { productId: 2, qty: 100, price: null },
    ])
    const report = await rechargeReport(db, '2026-10')
    // Lines come back sorted by product name, so find it rather than assume a position.
    const unpriced = report.lines.find((l) => l.productName === 'Chopsticks')!
    expect(unpriced.lineTotal).toBeNull()
    expect(unpriced.unitPrice).toBeNull()
    expect(report.siteTotals[0]!.unpricedLines).toBe(1)
    // And Finance is told, rather than left to notice the total looks light.
    expect(report.warnings[0]).toMatch(/had no price set/)
  })

  it('says plainly when a month has nothing in it', async () => {
    expect((await rechargeReport(db, '2026-10')).warnings[0]).toMatch(/No franchise orders/)
  })

  it('refuses a month it cannot parse', async () => {
    await expect(rechargeReport(db, 'October')).rejects.toThrow(/2026-10/)
  })
})

describe('the CSV', () => {
  it('carries the detail lines and the per-site totals in one file', async () => {
    order(1, 1, 'MR-MAF1-20261005-001', '2026-10-05T10:00:00Z', [
      { productId: 1, qty: 10, price: 4.20 }, { productId: 2, qty: 200, price: 0.08 },
    ])
    const csv = rechargeCsv(await rechargeReport(db, '2026-10'))
    const lines = csv.trim().split('\n')

    expect(lines[0]).toBe('Site,Site name,Order,Approved,Product,Quantity,Unit price,Line total')
    // Sorted by product name within an order, which keeps Finance's file stable
    // between runs rather than following insertion order.
    expect(lines[1]).toBe('MAF1,Guildford,MR-MAF1-20261005-001,2026-10-05,Chopsticks,200,0.08,16.00')
    expect(lines[2]).toBe('MAF1,Guildford,MR-MAF1-20261005-001,2026-10-05,Ramen Bowl,10,4.20,42.00')
    // The totals sit below the lines that made them, so they can be checked.
    expect(csv).toContain('Site,Site name,Orders,Lines,Items,Goods,Order fees,Total')
    expect(csv).toContain('MAF1,Guildford,1,2,210,58.00,12.00,70.00')
    expect(csv).toContain('Grand total,70.00')
  })

  it('quotes a product name containing a comma', async () => {
    fake.exec(`INSERT INTO products (id, name, stock_type, recharge_unit_price) VALUES (3, 'Bowl, large', 'internal', 5)`)
    order(1, 1, 'MR-MAF1-1', '2026-10-05T10:00:00Z', [{ productId: 3, qty: 2, price: 5 }])
    const csv = rechargeCsv(await rechargeReport(db, '2026-10'))
    // Otherwise every column after the name shifts by one in Finance's spreadsheet.
    expect(csv).toContain('"Bowl, large"')
  })

  it('leaves an unpriced line blank rather than writing 0.00', async () => {
    order(1, 1, 'MR-MAF1-1', '2026-10-05T10:00:00Z', [{ productId: 2, qty: 100, price: null }])
    const csv = rechargeCsv(await rechargeReport(db, '2026-10'))
    expect(csv).toContain('Chopsticks,100,,')
    expect(csv).toContain('Note: 1 line had no price set')
  })
})

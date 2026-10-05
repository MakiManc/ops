/**
 * The real M19 pair, as production held it on 5 October 2026.
 *
 * Ross asked for these two to be combined. Rather than hand-write SQL against the live
 * database and hope it matched mergeApprovedOrders, the live rows were replayed here, the
 * real function run against them, and the production fix written from what it produced.
 * So this test is the thing that was actually verified before anything was changed, and
 * it stays as a fixture: a real pair, with real quirks, that must keep merging correctly.
 *
 * The quirks are the point. One order was approved three days before the other, so it
 * owns the surviving number and the required date. The later one carries the early-order
 * reason a GM typed, which must not be lost because its order was absorbed. And two of
 * its three lines were approved at zero — the approver signed off the kimono and declined
 * the ladle and the sushi kimono — so the merge has to carry a zero across intact rather
 * than treating it as missing.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { linesForOrder, mergeApprovedOrders, orderById } from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import { rechargeTotals } from '../src/server/orders/approval.ts'
import { combinedStockRefusal } from '../src/server/orders/auto-merge.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, recharge, address_1, town, postcode)
      VALUES (1, 'M19', 'Maki M19', 'restaurant', 0, '1 St', 'Edinburgh', 'EH3 9QG');
    INSERT INTO users (id, email, name, role) VALUES (1, 'ross@makiramen.com', 'Ross', 'admin');
    INSERT INTO products (id, name, stock_type) VALUES
      (48, 'Ramekin', 'internal'),
      (37, '150ML LADLE - MRK011', 'internal'),
      (22, 'FOH Kimono (M)No apron', 'internal'),
      (69, 'Sushi Kimono (M)No apron', 'internal');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (948, 'RAM-01', 'Ramekin', '2026-10-05T09:00:00Z'),
      (937, 'LAD-01', 'Ladle', '2026-10-05T09:00:00Z'),
      (922, 'KIM-01', 'FOH Kimono', '2026-10-05T09:00:00Z'),
      (969, 'SKIM-01', 'Sushi Kimono', '2026-10-05T09:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES
      (48, 948, 'RAM-01', 1), (37, 937, 'LAD-01', 1), (22, 922, 'KIM-01', 1), (69, 969, 'SKIM-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at) VALUES
      (948, 1, 1, 2619, 0, 2619, '2026-10-05T09:00:00Z'),
      (937, 1, 1, 6, 0, 6, '2026-10-05T09:00:00Z'),
      (922, 1, 1, 27, 0, 27, '2026-10-05T09:00:00Z'),
      (969, 1, 1, 2, 0, 2, '2026-10-05T09:00:00Z');

    INSERT INTO orders (id, order_number, site_id, type, status, recharge, approved_by, approved_at, required_date, notes)
      VALUES (9, 'MR-M19-20261002-001', 1, 'replenishment', 'approved', 0, 1,
              '2026-10-02T15:24:57Z', '2026-10-05', 'na, Kait ordered thru Francheska');
    INSERT INTO orders (id, order_number, site_id, type, status, recharge, approved_by, approved_at, early_order_reason)
      VALUES (13, 'MR-M19-20261002-002', 1, 'replenishment', 'approved', 0, 1,
              '2026-10-05T09:16:22Z', 'The kimono had been requested for 2 months ');

    INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved, available_at_approval) VALUES
      (9, 48, 60, 60, 2619),
      (13, 37, 5, 0, 6),
      (13, 22, 6, 6, 27),
      (13, 69, 2, 0, 2);
  `)
})

const merge = () => mergeApprovedOrders(db, {
  keepId: 9, mergeId: 13, actor: 'ross@makiramen.com', actorRole: 'admin',
  recomputeTotals: (combined) => {
    // Corporate site: nothing is recharged, so both figures stay null.
    const t = rechargeTotals(combined, { recharge: false, orderFee: 0, passOrderFeeToFranchise: false })
    return { total: t?.total ?? null, orderFee: t?.orderFee ?? null }
  },
  checkCombined: (combined) => combinedStockRefusal(db, combined),
})

describe('the M19 pair', () => {
  it('combines, with the older order keeping its number', async () => {
    const result = await merge()
    expect(result).toEqual({
      keptOrderNumber: 'MR-M19-20261002-001',
      absorbedOrderNumber: 'MR-M19-20261002-002',
      linesMoved: 3,
      linesCombined: 0,
    })
  })

  it('puts all four lines on the surviving order, zeros included', async () => {
    await merge()
    const lines = await linesForOrder(db, 9)
    // Ordered by product name, which is how linesForOrder returns them.
    expect(lines.map((l) => [l.productId, l.qtyRequested, l.qtyApproved])).toEqual([
      [37, 5, 0],     // 150ML LADLE: declined, and a declined line is not a missing one
      [22, 6, 6],     // FOH Kimono: the one the GM had been asking about for two months
      [48, 60, 60],   // Ramekin, from the older order
      [69, 2, 0],     // Sushi Kimono: declined
    ])
    expect(lines.filter((l) => l.qtyApproved === null)).toEqual([])
  })

  it('keeps the date the ramekins were needed by', async () => {
    await merge()
    // The older order was needed by the 5th; the newer one named no date. Taking the
    // later or the absent one would quietly move a delivery.
    expect((await orderById(db, 9))?.requiredDate).toBe('2026-10-05')
  })

  it('keeps the early-order reason from the order that was absorbed', async () => {
    await merge()
    expect((await orderById(db, 9))?.earlyOrderReason)
      .toBe('The kimono had been requested for 2 months ')
  })

  it('leaves the absorbed order pointing at where its lines went', async () => {
    await merge()
    const absorbed = await orderById(db, 13)
    expect(absorbed?.status).toBe('cancelled')
    expect(absorbed?.mergedIntoOrderNumber).toBe('MR-M19-20261002-001')
    expect(await linesForOrder(db, 13)).toEqual([])
  })

  it('charges nothing, because M19 is a corporate site', async () => {
    await merge()
    const kept = await orderById(db, 9)
    expect(kept?.rechargeTotal).toBeNull()
    expect(kept?.orderFee).toBeNull()
  })

  it('passes the stock check: 60 ramekins of 2,619 and 6 kimonos of 27', async () => {
    await expect(merge()).resolves.toBeDefined()
  })

  it('writes a trail that can rebuild the absorbed order', async () => {
    await merge()
    const rows = fake.sqlite.prepare(
      `SELECT order_id, actor, event, detail FROM order_events ORDER BY id`,
    ).all() as { order_id: number; actor: string; event: string; detail: string }[]
    if (process.env.DUMP_M19) {
      for (const r of rows) console.log('TRAIL', JSON.stringify(r))
    }
    expect(rows.map((r) => [r.order_id, r.event])).toEqual([[9, 'merged_in'], [13, 'merged_into']])
  })
})

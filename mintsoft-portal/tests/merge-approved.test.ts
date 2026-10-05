/**
 * Merging orders that have already been signed off.
 *
 * Two approved orders for one restaurant is a fee Mercium charges twice and a van that
 * comes twice, so Ross asked for them to be combined. Doing it after sign-off is a
 * different job from the merge that happens before it: an approved order carries
 * decisions a pending one does not, and the send path reads them rather than the
 * requested quantities.
 *
 * Most of what is tested here is the ways this could cost money rather than the happy
 * path — a duplicate pallet, a franchise invoice that is wrong, an order that cannot be
 * sent at all.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  awaitingSend, cancelOrder, linesForOrder, mergeApprovedOrders, orderById,
  sitesWithSeveralAwaitingSend, OrderError,
} from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import { rechargeTotals } from '../src/server/orders/approval.ts'
import { rechargeReport } from '../src/server/reports/recharge.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database
const ACTOR = 'francheska@example.com'

/** One fee per order, passed on to franchise sites. The saving is in charging it once. */
const FEE = 12.5
const corporate = () => ({ recharge: false, orderFee: FEE, passOrderFeeToFranchise: true })
const franchise = () => ({ recharge: true, orderFee: FEE, passOrderFeeToFranchise: true })

const totalsFor = (ctx: ReturnType<typeof franchise>) =>
  (combined: { qtyApproved: number; rechargeUnitPrice: number | null }[]) => {
    const t = rechargeTotals(combined, ctx)
    return { total: t?.total ?? null, orderFee: t?.orderFee ?? null }
  }

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode) VALUES
      (1, 'M19', 'Maki Nineteen', 'restaurant', '1 Example St', 'Edinburgh', 'EH6 5AA'),
      (2, 'M3', 'Maki Three', 'restaurant', '2 Other St', 'Glasgow', 'G1 1AA');
    INSERT INTO users (id, email, name, role) VALUES (2, '${ACTOR}', 'Francheska', 'approver');
    INSERT INTO products (id, name, stock_type) VALUES
      (1, 'Ramen Bowl', 'internal'), (2, 'Chilli Oil', 'internal'), (3, 'Chopsticks', 'internal');
  `)
})

/** An approved order, with its lines already carrying approved quantities and prices. */
function approved(id: number, number: string, siteId: number, lines: [number, number, number, number | null][], over: Record<string, unknown> = {}) {
  const cols = { status: 'approved', recharge: 0, recharge_total: null as number | null, order_fee: null as number | null, ...over }
  fake.exec(`
    INSERT INTO orders (id, order_number, site_id, type, status, recharge, recharge_total, order_fee,
                        approved_by, approved_at, required_date, notes, post_error, send_claimed_at)
      VALUES (${id}, '${number}', ${siteId}, 'replenishment', '${cols.status}', ${cols.recharge},
              ${cols.recharge_total ?? 'NULL'}, ${cols.order_fee ?? 'NULL'}, 2, '2026-10-02T11:0${id}:00Z',
              ${over.required_date ? `'${over.required_date}'` : 'NULL'},
              ${over.notes ? `'${over.notes}'` : 'NULL'},
              ${over.post_error ? `'${over.post_error}'` : 'NULL'},
              ${over.send_claimed_at ? `'${over.send_claimed_at}'` : 'NULL'});
  `)
  for (const [productId, qtyRequested, qtyApproved, price] of lines) {
    fake.exec(`
      INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved, available_at_approval, recharge_unit_price)
        VALUES (${id}, ${productId}, ${qtyRequested}, ${qtyApproved}, 40, ${price ?? 'NULL'});
    `)
  }
}

const merge = (keepId: number, mergeId: number, ctx = corporate()) =>
  mergeApprovedOrders(db, { keepId, mergeId, actor: ACTOR, actorRole: 'approver', recomputeTotals: totalsFor(ctx) })

describe('combining two signed-off orders', () => {
  it('adds the approved quantities for a product on both', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 24, 20, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[1, 12, 10, null]])

    await merge(1, 2)

    const lines = await linesForOrder(db, 1)
    expect(lines).toHaveLength(1)
    // 20 + 10. The send posts qty_approved, so getting this wrong short-ships the site.
    expect(lines[0]?.qtyApproved).toBe(30)
    expect(lines[0]?.qtyRequested).toBe(36)
  })

  it('carries the approved quantity across for a product only on the absorbed order', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 24, 20, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 6, 4, 3.25]])

    await merge(1, 2)

    const lines = await linesForOrder(db, 1)
    const oil = lines.find((l) => l.productId === 2)
    // A NULL here is not a small bug: send.ts refuses the whole order over it, and the
    // order then has no route back to being approved.
    expect(oil?.qtyApproved).toBe(4)
    expect(oil?.rechargeUnitPrice).toBe(3.25)
    expect(oil?.availableAtApproval).toBe(40)
  })

  it('leaves no line without an approved quantity, which is what the send demands', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 24, 20, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 6, 4, null], [3, 10, 10, null]])

    await merge(1, 2)

    const lines = await linesForOrder(db, 1)
    expect(lines).toHaveLength(3)
    expect(lines.filter((l) => l.qtyApproved === null)).toEqual([])
  })

  it('closes the absorbed order and leaves the survivor ready to send', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 24, 20, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 6, 4, null]])

    const result = await merge(1, 2)

    expect(result).toMatchObject({
      keptOrderNumber: 'MR-M19-20261002-001',
      absorbedOrderNumber: 'MR-M19-20261002-002',
      linesMoved: 1, linesCombined: 0,
    })
    expect((await orderById(db, 2))?.status).toBe('cancelled')
    expect(await linesForOrder(db, 2)).toEqual([])
    const kept = await orderById(db, 1)
    expect(kept?.status).toBe('approved')
    // Held through the merge, given back at the end, or nobody could send it for ten minutes.
    expect(await awaitingSend(db)).toHaveLength(1)
  })
})

describe('the money', () => {
  it('charges the order fee once instead of twice', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, 2]], { recharge: 1, recharge_total: 32.5, order_fee: FEE })
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, 1]], { recharge: 1, recharge_total: 22.5, order_fee: FEE })

    await merge(1, 2, franchise())

    const kept = await orderById(db, 1)
    // 10x2 + 10x1 = 30 of goods, plus ONE 12.50 fee. Two orders would have been 55.
    expect(kept?.rechargeTotal).toBe(42.5)
    expect(kept?.orderFee).toBe(FEE)
  })

  it('takes the absorbed order out of the recharge report without losing its goods', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, 2]], { recharge: 1, recharge_total: 32.5, order_fee: FEE })
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, 1]], { recharge: 1, recharge_total: 22.5, order_fee: FEE })

    await merge(1, 2, franchise())

    const report = await rechargeReport(db, '2026-10')
    // Both products still invoiced, on one order, once.
    expect(report.lines.map((l) => l.orderNumber)).toEqual(['MR-M19-20261002-001', 'MR-M19-20261002-001'])
    expect(report.grandTotal).toBe(42.5)
  })

  it('records what the absorbed order held, because the lines are about to be deleted', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, 2]], { recharge: 1, recharge_total: 32.5, order_fee: FEE })
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 8, 1.5]], { recharge: 1, recharge_total: 22.5, order_fee: FEE })

    await merge(1, 2, franchise())

    const trail = fake.sqlite.prepare(
      `SELECT event, detail FROM order_events WHERE order_id = 2 AND event = 'merged_into'`,
    ).all() as { event: string; detail: string }[]
    const detail = JSON.parse(trail[0]!.detail) as {
      into: string; rechargeTotal: number; lines: { productId: number; qtyApproved: number; rechargeUnitPrice: number }[]
    }
    expect(detail.into).toBe('MR-M19-20261002-001')
    expect(detail.rechargeTotal).toBe(22.5)
    // The price and quantity as approved, so an invoiced month can be reconstructed.
    expect(detail.lines).toEqual([{ productId: 2, productName: 'Chilli Oil', qtyRequested: 10, qtyApproved: 8, rechargeUnitPrice: 1.5 }])
  })
})

describe('what it refuses, and why', () => {
  it('refuses an order that was sent with no reply, because that is how stock gets picked twice', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    // The uncertain state: still approved, post_error set, claim held by send.ts.
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]], {
      post_error: 'The portal lost contact before it heard back.',
    })

    await expect(merge(1, 2)).rejects.toThrow(/may already be with Mercium/)
    expect((await orderById(db, 2))?.status).toBe('approved')
  })

  it('still allows one Mintsoft refused outright, because nothing was created', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]], {
      status: 'post_failed', post_error: 'SKU OIL-01 is not active',
    })

    await merge(1, 2)
    expect((await orderById(db, 2))?.status).toBe('cancelled')
    // The survivor's stale reason is cleared: it was about a line set that no longer exists.
    expect((await orderById(db, 1))?.postError).toBeNull()
  })

  it('refuses while another send holds the order', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]], {
      send_claimed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    })

    await expect(merge(1, 2)).rejects.toThrow(/being sent right now/)
  })

  it('gives both orders back when it refuses, rather than stranding them', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]], {
      send_claimed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    })

    await expect(merge(1, 2)).rejects.toThrow()
    // Order 1 was claimed first and must not be left holding a claim it cannot use.
    const row = fake.sqlite.prepare(`SELECT send_claimed_at FROM orders WHERE id = 1`).get() as { send_claimed_at: string | null }
    expect(row.send_claimed_at).toBeNull()
  })

  it('refuses one already sent, by its status', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]])
    fake.exec(`UPDATE orders SET mintsoft_order_id = 8811, status = 'posted' WHERE id = 2`)

    await expect(merge(1, 2)).rejects.toThrow(/is posted, so it is not waiting to be sent/)
  })

  it('refuses one carrying a Mintsoft id even while it still reads as approved', async () => {
    // Belt and braces with the check above. An order that has an id has been created at
    // Mercium whatever our own status column says, and editing its lines would be
    // editing an order they are already picking.
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]])
    fake.exec(`UPDATE orders SET mintsoft_order_id = 8811 WHERE id = 2`)

    await expect(merge(1, 2)).rejects.toThrow(/already with Mercium as order 8811/)
  })

  it('refuses across sites, however alike the orders look', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M3-20261002-001', 2, [[1, 10, 10, null]])

    await expect(merge(1, 2)).rejects.toThrow(/same site/)
  })

  it('refuses a GM, who may not sign anything off', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]])

    await expect(mergeApprovedOrders(db, {
      keepId: 1, mergeId: 2, actor: 'gm@example.com', actorRole: 'gm',
      recomputeTotals: totalsFor(corporate()),
    })).rejects.toThrow(OrderError)
  })

  it('refuses a line with no approved quantity rather than making an order that cannot send', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]])
    fake.exec(`UPDATE order_lines SET qty_approved = NULL WHERE order_id = 2`)

    await expect(merge(1, 2)).rejects.toThrow(/no approved quantity/)
  })
})

describe('the absorbed order, which is not a cancelled one', () => {
  it('records which order its lines went to', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]])

    await merge(1, 2)
    // Without this the screen says "Cancelled", the GM reads "the stock is not coming",
    // and re-requests stock that is already on its way.
    expect((await orderById(db, 2))?.mergedIntoOrderNumber).toBe('MR-M19-20261002-001')
    expect((await orderById(db, 1))?.mergedIntoOrderNumber).toBeNull()
  })

  it('is left alone on an order cancelled for an ordinary reason', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    await cancelOrder(db, { orderId: 1, actor: ACTOR, reason: 'Ordered by mistake' })
    expect((await orderById(db, 1))?.mergedIntoOrderNumber).toBeNull()
  })
})

describe('cancelling while something holds the order', () => {
  it('is refused, so a cancel cannot be undone by a merge finishing after it', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]], {
      send_claimed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    })
    await expect(cancelOrder(db, { orderId: 1, actor: ACTOR, reason: null }))
      .rejects.toThrow(/being sent or combined right now/)
    expect((await orderById(db, 1))?.status).toBe('approved')
  })

  it('goes ahead once the hold has aged out', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]], {
      send_claimed_at: '2026-10-02T09:00:00Z',   // older than the ten-minute hold
    })
    await cancelOrder(db, { orderId: 1, actor: ACTOR, reason: null })
    expect((await orderById(db, 1))?.status).toBe('cancelled')
  })
})

describe('the four ways the money could go wrong', () => {
  it('refuses when one is recharged to the site and the other is not', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, 2]], { recharge: 1, order_fee: FEE })
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, 1]], { recharge: 0 })

    await expect(merge(1, 2, franchise())).rejects.toThrow(/not charged the same way/)
  })

  it('refuses across recharge months, because Finance may have invoiced one already', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, 2]], { recharge: 1, order_fee: FEE })
    approved(2, 'MR-M19-20260928-001', 1, [[2, 10, 10, 1]], { recharge: 1, order_fee: FEE })
    fake.exec(`UPDATE orders SET approved_at = '2026-09-28T11:00:00Z' WHERE id = 2`)

    await expect(merge(1, 2, franchise())).rejects.toThrow(/different months/)
  })

  it('refuses a product signed off at two different prices', async () => {
    // Summing the quantities onto one line would invoice half the units at a price
    // nobody approved for them.
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, 2.00]], { recharge: 1, order_fee: FEE })
    approved(2, 'MR-M19-20261002-002', 1, [[1, 10, 10, 2.50]], { recharge: 1, order_fee: FEE })

    await expect(merge(1, 2, franchise())).rejects.toThrow(/different price on each order/)
  })

  it('keeps the fee that was snapshotted, not whatever settings say today', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, 2]], { recharge: 1, recharge_total: 28, order_fee: 8 })
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, 1]], { recharge: 1, recharge_total: 18, order_fee: 8 })

    // The live fee is FEE (12.50); both orders were signed off at 8.
    await mergeApprovedOrders(db, {
      keepId: 1, mergeId: 2, actor: ACTOR, actorRole: 'approver',
      recomputeTotals: (combined) => {
        const keepFee = 8
        const t = rechargeTotals(combined, { recharge: true, orderFee: keepFee, passOrderFeeToFranchise: true })
        return { total: t?.total ?? null, orderFee: t?.orderFee ?? null }
      },
    })

    const kept = await orderById(db, 1)
    // 10x2 + 10x1 = 30 of goods, plus the 8 that was agreed, not the 12.50 of today.
    expect(kept?.orderFee).toBe(8)
    expect(kept?.rechargeTotal).toBe(38)
  })
})

describe('what the combined order says', () => {
  it('keeps the earlier required date, so a delivery is never quietly moved', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]], { required_date: '2026-10-20' })
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]], { required_date: '2026-10-09' })

    await merge(1, 2)
    expect((await orderById(db, 1))?.requiredDate).toBe('2026-10-09')
  })

  it('keeps both sets of notes, saying which order the second came from', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]], { notes: 'Leave at the back door.' })
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]], { notes: 'Chilli oil is urgent.' })

    await merge(1, 2)
    const notes = (await orderById(db, 1))?.notes ?? ''
    expect(notes).toContain('Leave at the back door.')
    expect(notes).toContain('From MR-M19-20261002-002: Chilli oil is urgent.')
  })
})

describe('finding the sites that need it', () => {
  it('names only the sites with more than one order waiting', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]])
    approved(3, 'MR-M3-20261002-001', 2, [[1, 10, 10, null]])

    const doubled = await sitesWithSeveralAwaitingSend(db)
    expect(doubled).toHaveLength(1)
    expect(doubled[0]?.siteCode).toBe('M19')
    // Oldest first: that is the number the combined order keeps.
    expect(doubled[0]?.orders.map((o) => o.orderNumber))
      .toEqual(['MR-M19-20261002-001', 'MR-M19-20261002-002'])
  })

  it('says nothing once they have been combined', async () => {
    approved(1, 'MR-M19-20261002-001', 1, [[1, 10, 10, null]])
    approved(2, 'MR-M19-20261002-002', 1, [[2, 10, 10, null]])

    await merge(1, 2)
    expect(await sitesWithSeveralAwaitingSend(db)).toEqual([])
  })
})

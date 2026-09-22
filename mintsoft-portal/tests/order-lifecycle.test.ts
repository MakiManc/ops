import { beforeEach, describe, expect, it } from 'vitest'
import {
  addToBasket, approvalQueue, approveOrder, cancelOrder, eventsForOrder, linesForOrder,
  mergeRequests, openRequestForSite, OrderError, orderById, rejectOrder, setLineQty,
  submitRequest,
} from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * The lifecycle from basket to sign-off. Two properties matter throughout: a site has
 * one open request at a time (Mercium bills per order), and everything that happens is
 * recorded in a trail that cannot be edited afterwards.
 */

let fake: FakeD1
let db: Database
const GM = 'gm.m9@example.com'
const APPROVER = 'francheska@example.com'

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type) VALUES (1, 'M9', 'Leith Walk', 'restaurant');
    INSERT INTO sites (id, code, name, type, recharge) VALUES (2, 'MAF1', 'Franchise', 'franchise', 1);
    INSERT INTO users (id, email, name, role) VALUES
      (1, '${GM}', 'GM', 'gm'), (2, '${APPROVER}', 'Francheska', 'approver');
    INSERT INTO products (id, name, stock_type) VALUES
      (1, 'Ramen Bowl', 'internal'), (2, 'Chopsticks', 'internal');
  `)
})

const add = (productId = 1, qty = 10, siteId = 1) =>
  addToBasket(db, { siteId, productId, qty, actor: GM, availableNow: 100 })

const submit = (orderId: number, over: Partial<{ earlyOrderReason: string | null }> = {}) =>
  submitRequest(db, {
    orderId, requesterName: 'Alex', requiredDate: null, notes: null,
    earlyOrderReason: null, actor: GM, ...over,
  })

describe('one open request per site', () => {
  it('opens a request on the first item and reuses it after that', async () => {
    const first = await add(1, 10)
    const second = await add(2, 5)
    // Mercium charges per order, so the second item joins the first request.
    expect(second.id).toBe(first.id)
    expect(await linesForOrder(db, first.id)).toHaveLength(2)
  })

  it('adds to the quantity when the same product goes in twice', async () => {
    const order = await add(1, 10)
    await add(1, 5)
    expect((await linesForOrder(db, order.id))[0]!.qtyRequested).toBe(15)
  })

  it('gives the order a number of the documented shape', async () => {
    const order = await add()
    expect(order.orderNumber).toMatch(/^MR-M9-\d{8}-001$/)
  })

  it('numbers a second order for the same site and day sequentially', async () => {
    const first = await add()
    await submit(first.id)
    await rejectOrder(db, { orderId: first.id, actor: APPROVER, actorRole: 'approver', reason: 'Too soon' })
    const second = await add()
    expect(second.orderNumber).toMatch(/-002$/)
  })

  it('starts a fresh request rather than changing one with the approver', async () => {
    const first = await add(1, 10)
    await submit(first.id)
    // The submitted one stays put -- an approver may be reading it, and a basket
    // changing underneath them is worse than a second request. The site is not
    // blocked: they get a new draft, and the approver merges the two before
    // approving, so Mercium still receives one order.
    const second = await add(2, 5)
    expect(second.id).not.toBe(first.id)
    expect(await linesForOrder(db, first.id)).toHaveLength(1)
  })

  it('keeps sites separate', async () => {
    await add(1, 10, 1)
    const other = await add(1, 10, 2)
    expect(other.siteCode).toBe('MAF1')
    expect((await openRequestForSite(db, 1))!.id).not.toBe(other.id)
  })
})

describe('editing a basket', () => {
  it('changes a quantity and records what it was', async () => {
    const order = await add(1, 10)
    await setLineQty(db, { orderId: order.id, productId: 1, qty: 24, actor: GM })
    expect((await linesForOrder(db, order.id))[0]!.qtyRequested).toBe(24)
    const events = await eventsForOrder(db, order.id)
    expect(events.map((e) => e.event)).toContain('qty_changed')
    expect(events.find((e) => e.event === 'qty_changed')!.detail).toMatchObject({ from: 10, to: 24 })
  })

  it('removes a line when the quantity goes to zero', async () => {
    const order = await add(1, 10)
    await add(2, 5)
    await setLineQty(db, { orderId: order.id, productId: 1, qty: 0, actor: GM })
    expect(await linesForOrder(db, order.id)).toHaveLength(1)
  })

  it('refuses to edit a submitted request', async () => {
    const order = await add()
    await submit(order.id)
    await expect(setLineQty(db, { orderId: order.id, productId: 1, qty: 5, actor: GM }))
      .rejects.toThrow(/has not been submitted/)
  })
})

describe('submitting', () => {
  it('needs a name, because site logins are shared', async () => {
    const order = await add()
    await expect(submitRequest(db, {
      orderId: order.id, requesterName: '  ', requiredDate: null,
      notes: null, earlyOrderReason: null, actor: GM,
    })).rejects.toThrow(/Put your name on the request/)
  })

  it('refuses an empty request', async () => {
    const order = await add()
    await setLineQty(db, { orderId: order.id, productId: 1, qty: 0, actor: GM })
    await expect(submit(order.id)).rejects.toThrow(/nothing in this request/)
  })

  it('records the reason given for ordering early', async () => {
    const order = await add()
    await submit(order.id, { earlyOrderReason: 'Ran out after a coach party' })
    expect((await orderById(db, order.id))!.earlyOrderReason).toBe('Ran out after a coach party')
  })

  it('puts it on the approval queue, oldest first', async () => {
    const a = await add(1, 10, 1)
    await submit(a.id)
    const b = await add(1, 10, 2)
    await submit(b.id)
    expect((await approvalQueue(db)).map((o) => o.siteCode)).toEqual(['M9', 'MAF1'])
  })
})

describe('approving', () => {
  it('records quantities the approver changed, not just the final state', async () => {
    const order = await add(1, 24)
    await submit(order.id)
    await approveOrder(db, {
      orderId: order.id, actor: APPROVER, actorRole: 'approver',
      lines: [{ productId: 1, qtyApproved: 12, rechargeUnitPrice: null, availableAtApproval: 100 }],
      rechargeTotal: null, orderFee: null,
    })
    // "approved 12 instead of 24" is what someone asks about weeks later.
    const approved = (await eventsForOrder(db, order.id)).find((e) => e.event === 'approved')
    expect(approved!.detail).toMatchObject({ quantityChanges: [{ productId: 1, from: 24, to: 12 }] })
  })

  it('refuses a GM, who may request but never sign off', async () => {
    const order = await add()
    await submit(order.id)
    await expect(approveOrder(db, {
      orderId: order.id, actor: 'someone@example.com', actorRole: 'gm',
      lines: [], rechargeTotal: null, orderFee: null,
    })).rejects.toThrow(OrderError)
  })

  it('accepts an admin, and records who signed it', async () => {
    // Who held the pen matters later, even though both roles are now entitled to hold
    // it. The role itself is resolved from the user at send time rather than frozen on
    // the order, so what the order has to carry is the identity.
    const order = await add()
    await submit(order.id)
    await approveOrder(db, {
      orderId: order.id, actor: 'admin@example.com', actorRole: 'admin',
      lines: [], rechargeTotal: null, orderFee: null,
    })
    expect((await orderById(db, order.id))!.status).toBe('approved')
    const events = await eventsForOrder(db, order.id)
    expect(events.map((e) => e.event)).toContain('approved')
    expect(events.find((e) => e.event === 'approved')!.actor).toBe('admin@example.com')
  })

  it('refuses an order that is not waiting for sign-off', async () => {
    const order = await add()
    await expect(approveOrder(db, {
      orderId: order.id, actor: APPROVER, actorRole: 'approver',
      lines: [], rechargeTotal: null, orderFee: null,
    })).rejects.toThrow(/not waiting for sign-off/)
  })

  it('frees the site to start a new request', async () => {
    const order = await add()
    await submit(order.id)
    await approveOrder(db, {
      orderId: order.id, actor: APPROVER, actorRole: 'approver',
      lines: [{ productId: 1, qtyApproved: 10, rechargeUnitPrice: null, availableAtApproval: 100 }],
      rechargeTotal: null, orderFee: null,
    })
    await expect(add(1, 5)).resolves.toBeDefined()
  })
})

describe('sending a request back', () => {
  it('needs a reason the site can act on', async () => {
    const order = await add()
    await submit(order.id)
    await expect(rejectOrder(db, {
      orderId: order.id, actor: APPROVER, actorRole: 'approver', reason: '  ',
    })).rejects.toThrow(/Say why/)
  })

  it('records the reason against the order', async () => {
    const order = await add()
    await submit(order.id)
    await rejectOrder(db, {
      orderId: order.id, actor: APPROVER, actorRole: 'approver', reason: 'Ordered last week already',
    })
    expect((await orderById(db, order.id))!.rejectedReason).toBe('Ordered last week already')
  })
})

describe('merging two requests for one site', () => {
  /** The case an approver actually meets: a site needed more before the first was signed off. */
  async function twoPending() {
    const a = await add(1, 10)
    await submit(a.id)
    const b = await add(2, 5)
    await submit(b.id)
    return { a, b }
  }

  it('moves the lines across and closes the one that was absorbed', async () => {
    const { a, b } = await twoPending()
    await mergeRequests(db, { keepId: a.id, mergeId: b.id, actor: APPROVER, actorRole: 'approver' })
    expect(await linesForOrder(db, a.id)).toHaveLength(2)
    expect((await orderById(db, b.id))!.status).toBe('cancelled')
  })

  it('adds quantities when both asked for the same product', async () => {
    const a = await add(1, 10)
    await submit(a.id)
    const b = await add(1, 7)
    await submit(b.id)
    await mergeRequests(db, { keepId: a.id, mergeId: b.id, actor: APPROVER, actorRole: 'approver' })
    const bowl = (await linesForOrder(db, a.id)).find((l) => l.productId === 1)
    expect(bowl!.qtyRequested).toBe(17)
  })

  it('leaves one order for Mercium to bill for, not two', async () => {
    const { a, b } = await twoPending()
    await mergeRequests(db, { keepId: a.id, mergeId: b.id, actor: APPROVER, actorRole: 'approver' })
    const pending = await approvalQueue(db)
    // This is the whole point of the merge: consolidation happens at sign-off.
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBe(a.id)
  })

  it('is logged on both orders, so neither trail has a gap', async () => {
    const { a, b } = await twoPending()
    await mergeRequests(db, { keepId: a.id, mergeId: b.id, actor: APPROVER, actorRole: 'approver' })
    expect((await eventsForOrder(db, a.id)).map((e) => e.event)).toContain('merged_in')
    expect((await eventsForOrder(db, b.id)).map((e) => e.event)).toContain('merged_into')
  })

  it('refuses to merge across sites', async () => {
    const a = await add(1, 10, 1); await submit(a.id)
    const b = await add(1, 10, 2); await submit(b.id)
    await expect(mergeRequests(db, { keepId: a.id, mergeId: b.id, actor: APPROVER, actorRole: 'approver' }))
      .rejects.toThrow(/same site/)
  })

  it('refuses anyone who is not an approver', async () => {
    const { a, b } = await twoPending()
    await expect(mergeRequests(db, { keepId: a.id, mergeId: b.id, actor: GM, actorRole: 'gm' }))
      .rejects.toThrow(OrderError)
  })
})

describe('cancelling', () => {
  it('refuses once the order is with the warehouse', async () => {
    const order = await add()
    await submit(order.id)
    fake.exec(`UPDATE orders SET status = 'posted' WHERE id = ${order.id}`)
    await expect(cancelOrder(db, { orderId: order.id, actor: GM, reason: null }))
      .rejects.toThrow(/already with the warehouse/)
  })

  it('is quietly fine to cancel something already cancelled', async () => {
    const order = await add()
    await cancelOrder(db, { orderId: order.id, actor: GM, reason: 'Changed my mind' })
    await expect(cancelOrder(db, { orderId: order.id, actor: GM, reason: null })).resolves.toBeUndefined()
  })
})

describe('the audit trail', () => {
  it('records the whole life of an order', async () => {
    const order = await add(1, 24)
    await setLineQty(db, { orderId: order.id, productId: 1, qty: 12, actor: GM })
    await submit(order.id)
    await approveOrder(db, {
      orderId: order.id, actor: APPROVER, actorRole: 'approver',
      lines: [{ productId: 1, qtyApproved: 12, rechargeUnitPrice: null, availableAtApproval: 50 }],
      rechargeTotal: null, orderFee: null,
    })
    expect((await eventsForOrder(db, order.id)).map((e) => e.event))
      .toEqual(['created', 'line_added', 'qty_changed', 'submitted', 'approved'])
  })

  it('cannot be edited or deleted afterwards', async () => {
    const order = await add()
    // Enforced by a database trigger rather than by everyone remembering.
    expect(() => fake.exec(`UPDATE order_events SET event = 'nothing happened' WHERE order_id = ${order.id}`))
      .toThrow(/append-only/)
    expect(() => fake.exec(`DELETE FROM order_events WHERE order_id = ${order.id}`))
      .toThrow(/append-only/)
  })
})

describe('the recharge flag', () => {
  it('is copied from the site when the request is opened', async () => {
    // Without this every order defaulted to not-recharged, and a franchise site's
    // stock would quietly have been given away.
    const franchise = await addToBasket(db, {
      siteId: 2, productId: 1, qty: 10, actor: GM, availableNow: 100,
    })
    expect(franchise.recharge).toBe(true)
  })

  it('stays off for a corporate site', async () => {
    const corporate = await add(1, 10, 1)
    expect(corporate.recharge).toBe(false)
  })

  it('records the arrangement that applied when the order was placed', async () => {
    const order = await addToBasket(db, {
      siteId: 2, productId: 1, qty: 10, actor: GM, availableNow: 100,
    })
    // A site switching to corporate later must not un-recharge an order already placed.
    fake.exec(`UPDATE sites SET recharge = 0 WHERE id = 2`)
    expect((await orderById(db, order.id))!.recharge).toBe(true)
  })
})

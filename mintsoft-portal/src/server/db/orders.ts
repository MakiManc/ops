/**
 * The order lifecycle: basket, submit, approve, merge, cancel.
 *
 * Two things are enforced here rather than trusted to callers. Every state change and
 * every quantity edit writes an order_events row — the table refuses updates and
 * deletes, so the trail is append-only in the database rather than by habit. And
 * multi-row changes go through D1 batches, so an approval either lands whole or not at
 * all; a half-approved order is one whose lines and status disagree.
 */
import { buildOrderNumber } from '../orders/order-number.ts'
import type { Database } from './repo.ts'
import { canApprove } from './types.ts'
import type { OrderStatus, Role } from './types.ts'

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

export class OrderError extends Error {
  constructor(message: string) { super(message); this.name = 'OrderError' }
}

export interface OrderSummary {
  id: number
  orderNumber: string
  siteId: number
  siteCode: string
  siteName: string
  type: 'replenishment' | 'expansion'
  status: OrderStatus
  requesterName: string | null
  requiredDate: string | null
  notes: string | null
  earlyOrderReason: string | null
  recharge: boolean
  rechargeTotal: number | null
  orderFee: number | null
  submittedAt: string | null
  approvedAt: string | null
  rejectedReason: string | null
  mintsoftOrderId: number | null
  /** What Mercium calls it: MRK-<id>, assigned by Mintsoft. Null until the order is sent. */
  mintsoftOrderNumber: string | null
  /**
   * Set only on an order that was folded into another. It is why a 'cancelled' order
   * must not always be read as cancelled: this one closed because its lines moved, and
   * the stock is still coming on the order named here.
   */
  mergedIntoOrderNumber: string | null
  postError: string | null
  despatchedAt: string | null
  trackingUrl: string | null
  createdAt: string
}

export interface OrderLineRow {
  id: number
  productId: number
  productName: string
  qtyRequested: number
  qtyApproved: number | null
  availableAtRequest: number | null
  availableAtApproval: number | null
  rechargeUnitPrice: number | null
}

const ORDER_SELECT = `
  SELECT o.id, o.order_number, o.site_id, s.code AS site_code, s.name AS site_name,
         o.type, o.status, o.requester_name, o.required_date, o.notes, o.early_order_reason,
         o.recharge, o.recharge_total, o.order_fee, o.submitted_at, o.approved_at,
         o.rejected_reason, o.mintsoft_order_id, o.mintsoft_order_number, o.post_error, o.despatched_at,
         (SELECT m.order_number FROM orders m WHERE m.id = o.merged_into_order_id) AS merged_into_order_number,
         o.tracking_url, o.created_at
    FROM orders o JOIN sites s ON s.id = o.site_id`

interface RawOrder {
  id: number; order_number: string; site_id: number; site_code: string; site_name: string
  type: 'replenishment' | 'expansion'; status: OrderStatus; requester_name: string | null
  required_date: string | null; notes: string | null; early_order_reason: string | null
  recharge: number; recharge_total: number | null; order_fee: number | null
  submitted_at: string | null; approved_at: string | null; rejected_reason: string | null
  mintsoft_order_id: number | null; mintsoft_order_number: string | null
  merged_into_order_number: string | null
  post_error: string | null; despatched_at: string | null
  tracking_url: string | null; created_at: string
}

const toSummary = (r: RawOrder): OrderSummary => ({
  id: r.id, orderNumber: r.order_number, siteId: r.site_id, siteCode: r.site_code,
  siteName: r.site_name, type: r.type, status: r.status, requesterName: r.requester_name,
  requiredDate: r.required_date, notes: r.notes, earlyOrderReason: r.early_order_reason,
  recharge: r.recharge === 1, rechargeTotal: r.recharge_total, orderFee: r.order_fee,
  submittedAt: r.submitted_at, approvedAt: r.approved_at, rejectedReason: r.rejected_reason,
  mintsoftOrderId: r.mintsoft_order_id, mintsoftOrderNumber: r.mintsoft_order_number,
  mergedIntoOrderNumber: r.merged_into_order_number,
  postError: r.post_error, despatchedAt: r.despatched_at,
  trackingUrl: r.tracking_url, createdAt: r.created_at,
})

/** Records something that happened to an order. Append-only, enforced by a trigger. */
export const auditStatement = (
  db: Database, orderId: number, actor: string, event: string, detail?: unknown,
) => db
  .prepare(`INSERT INTO order_events (order_id, actor, event, detail, at) VALUES (?, ?, ?, ?, ?)`)
  .bind(orderId, actor, event, detail === undefined ? null : JSON.stringify(detail), nowIso())

/**
 * The site's open request, if it has one.
 *
 * A site has at most one draft-or-submitted request at a time — the database enforces
 * it with a partial unique index. Mercium bills per order, so items join the open
 * request rather than starting a second one.
 */
export async function openRequestForSite(db: Database, siteId: number): Promise<OrderSummary | null> {
  const row = await db
    .prepare(`${ORDER_SELECT} WHERE o.site_id = ? AND o.status IN ('draft', 'submitted')`)
    .bind(siteId)
    .first<RawOrder>()
  return row ? toSummary(row) : null
}

export async function orderById(db: Database, orderId: number): Promise<OrderSummary | null> {
  const row = await db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).bind(orderId).first<RawOrder>()
  return row ? toSummary(row) : null
}

export async function linesForOrder(db: Database, orderId: number): Promise<OrderLineRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ol.id, ol.product_id, p.name AS product_name, ol.qty_requested, ol.qty_approved,
              ol.available_at_request, ol.available_at_approval, ol.recharge_unit_price
         FROM order_lines ol JOIN products p ON p.id = ol.product_id
        WHERE ol.order_id = ? ORDER BY p.name`,
    )
    .bind(orderId)
    .all<{
      id: number; product_id: number; product_name: string; qty_requested: number
      qty_approved: number | null; available_at_request: number | null
      available_at_approval: number | null; recharge_unit_price: number | null
    }>()
  return (results ?? []).map((r) => ({
    id: r.id, productId: r.product_id, productName: r.product_name,
    qtyRequested: r.qty_requested, qtyApproved: r.qty_approved,
    availableAtRequest: r.available_at_request, availableAtApproval: r.available_at_approval,
    rechargeUnitPrice: r.recharge_unit_price,
  }))
}

/** The next sequence for a site on a given day, so order numbers never repeat. */
async function nextSequence(db: Database, siteCode: string, date: Date): Promise<number> {
  const prefix = buildOrderNumber(siteCode, date, 1).slice(0, -3)
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE order_number LIKE ?`)
    .bind(`${prefix}%`)
    .first<{ n: number }>()
  return (row?.n ?? 0) + 1
}

/**
 * Adds a product to the site's open basket, starting one if there is not already a draft.
 *
 * A submitted request is left alone -- an approver may be reading it, and a basket that
 * changes underneath them is worse than a second request. So a site that needs
 * something else before sign-off gets a new draft, and the approver merges the two
 * before approving. Mercium still receives one order; the consolidation just happens at
 * sign-off rather than by refusing the GM.
 */
export async function addToBasket(
  db: Database,
  { siteId, productId, qty, actor, availableNow }: {
    siteId: number; productId: number; qty: number; actor: string; availableNow: number | null
  },
): Promise<OrderSummary> {
  if (!Number.isInteger(qty) || qty <= 0) throw new OrderError('Enter how many you need.')

  const draft = await db
    .prepare(`SELECT id FROM orders WHERE site_id = ? AND status = 'draft'`)
    .bind(siteId)
    .first<{ id: number }>()

  let orderId = draft?.id
  if (!orderId) {
    const site = await db
      .prepare(`SELECT code, type, recharge FROM sites WHERE id = ? AND active = 1`)
      .bind(siteId)
      .first<{ code: string; type: string; recharge: number }>()
    if (!site) throw new OrderError('That site is not open for ordering.')

    const now = new Date()
    const orderNumber = buildOrderNumber(site.code, now, await nextSequence(db, site.code, now))
    const created = await db
      .prepare(
        // The recharge flag is copied from the site at creation rather than read live
        // at approval, so an order carries the arrangement that applied when it was
        // placed. Without it every order defaulted to not-recharged, and a franchise
        // site's stock would quietly have been given away.
        `INSERT INTO orders (order_number, site_id, type, status, recharge, requested_by)
         VALUES (?, ?, 'replenishment', 'draft', ?, (SELECT id FROM users WHERE email = ?))
         RETURNING id`,
      )
      .bind(orderNumber, siteId, site.recharge, actor)
      .first<{ id: number }>()
    if (!created) throw new OrderError('Could not start a request.')
    orderId = created.id
    await auditStatement(db, orderId, actor, 'created', { orderNumber }).run()
  }

  const existing = await db
    .prepare(`SELECT id, qty_requested FROM order_lines WHERE order_id = ? AND product_id = ?`)
    .bind(orderId, productId)
    .first<{ id: number; qty_requested: number }>()

  if (existing) {
    const newQty = existing.qty_requested + qty
    await db.batch([
      db.prepare(`UPDATE order_lines SET qty_requested = ?, available_at_request = ? WHERE id = ?`)
        .bind(newQty, availableNow, existing.id),
      auditStatement(db, orderId, actor, 'qty_changed', {
        productId, from: existing.qty_requested, to: newQty,
      }),
    ])
  } else {
    await db.batch([
      db.prepare(
        `INSERT INTO order_lines (order_id, product_id, qty_requested, available_at_request)
         VALUES (?, ?, ?, ?)`,
      ).bind(orderId, productId, qty, availableNow),
      auditStatement(db, orderId, actor, 'line_added', { productId, qty }),
    ])
  }

  const updated = await orderById(db, orderId)
  if (!updated) throw new OrderError('The request disappeared while it was being updated.')
  return updated
}

export async function setLineQty(
  db: Database,
  { orderId, productId, qty, actor }: { orderId: number; productId: number; qty: number; actor: string },
): Promise<void> {
  const order = await orderById(db, orderId)
  if (!order) throw new OrderError('That request no longer exists.')
  if (order.status !== 'draft') throw new OrderError('Only a request that has not been submitted can be changed.')

  const line = await db
    .prepare(`SELECT id, qty_requested FROM order_lines WHERE order_id = ? AND product_id = ?`)
    .bind(orderId, productId)
    .first<{ id: number; qty_requested: number }>()
  if (!line) throw new OrderError('That product is not on this request.')

  if (qty <= 0) {
    await db.batch([
      db.prepare(`DELETE FROM order_lines WHERE id = ?`).bind(line.id),
      auditStatement(db, orderId, actor, 'line_removed', { productId, was: line.qty_requested }),
    ])
    return
  }

  await db.batch([
    db.prepare(`UPDATE order_lines SET qty_requested = ? WHERE id = ?`).bind(qty, line.id),
    auditStatement(db, orderId, actor, 'qty_changed', { productId, from: line.qty_requested, to: qty }),
  ])
}

export async function submitRequest(
  db: Database,
  { orderId, requesterName, requiredDate, notes, earlyOrderReason, actor }: {
    orderId: number; requesterName: string; requiredDate: string | null
    notes: string | null; earlyOrderReason: string | null; actor: string
  },
): Promise<void> {
  const order = await orderById(db, orderId)
  if (!order) throw new OrderError('That request no longer exists.')
  if (order.status !== 'draft') throw new OrderError(`This request is already ${order.status}.`)
  if (!requesterName.trim()) {
    // Site logins are often shared, so the login does not answer "who asked for this".
    throw new OrderError('Put your name on the request, so the approver knows who asked.')
  }

  const lines = await linesForOrder(db, orderId)
  if (lines.length === 0) throw new OrderError('There is nothing in this request yet.')

  await db.batch([
    db.prepare(
      `UPDATE orders SET status = 'submitted', requester_name = ?, required_date = ?,
              notes = ?, early_order_reason = ?, submitted_at = ?, updated_at = ?
         WHERE id = ?`,
    ).bind(requesterName.trim(), requiredDate, notes, earlyOrderReason, nowIso(), nowIso(), orderId),
    auditStatement(db, orderId, actor, 'submitted', {
      requesterName: requesterName.trim(), lines: lines.length, earlyOrderReason,
    }),
  ])
}

/** Requests waiting for sign-off, oldest first — the queue an approver works through. */
/**
 * Approved orders that have not reached Mercium yet.
 *
 * Signing an order off and sending it are deliberately two actions, so an approved order
 * needs somewhere to wait. Without this it left the queue and nothing offered to send
 * it — the endpoint existed and no screen could reach it.
 *
 * post_failed is included on purpose. It is not a dead end: it means the send stopped
 * before anything reached Mintsoft — short stock, a line nobody approved, an order
 * approved at zero — and once the cause is fixed the order should be sendable rather
 * than needing someone with database access. Anything already carrying a Mintsoft id is
 * excluded, because that one has gone.
 */
export async function awaitingSend(db: Database): Promise<OrderSummary[]> {
  const { results } = await db
    .prepare(
      `${ORDER_SELECT}
        WHERE o.status IN ('approved', 'post_failed')
          AND o.mintsoft_order_id IS NULL
        ORDER BY o.approved_at ASC`,
    )
    .all<RawOrder>()
  return (results ?? []).map(toSummary)
}

export async function approvalQueue(db: Database): Promise<OrderSummary[]> {
  const { results } = await db
    .prepare(`${ORDER_SELECT} WHERE o.status = 'submitted' ORDER BY o.submitted_at ASC`)
    .all<RawOrder>()
  return (results ?? []).map(toSummary)
}

/** A site's recent orders, for context beside a request in the queue. */
export async function recentOrdersForSite(
  db: Database, siteId: number, limit = 3,
): Promise<OrderSummary[]> {
  const { results } = await db
    .prepare(
      `${ORDER_SELECT} WHERE o.site_id = ? AND o.status NOT IN ('draft', 'submitted')
        ORDER BY o.created_at DESC LIMIT ?`,
    )
    .bind(siteId, limit)
    .all<RawOrder>()
  return (results ?? []).map(toSummary)
}

export async function ordersForSites(db: Database, siteIds: number[]): Promise<OrderSummary[]> {
  if (siteIds.length === 0) return []
  const placeholders = siteIds.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`${ORDER_SELECT} WHERE o.site_id IN (${placeholders}) ORDER BY o.created_at DESC LIMIT 100`)
    .bind(...siteIds)
    .all<RawOrder>()
  return (results ?? []).map(toSummary)
}

export interface ApprovedLine { productId: number; qtyApproved: number; rechargeUnitPrice: number | null; availableAtApproval: number | null }

/**
 * Signs an order off.
 *
 * Quantities the approver changed are recorded line by line, not just as a final state:
 * "approved 12 instead of 24" is the kind of thing someone asks about weeks later.
 */
export async function approveOrder(
  db: Database,
  { orderId, actor, actorRole, lines, rechargeTotal, orderFee }: {
    orderId: number; actor: string; actorRole: Role; lines: ApprovedLine[]
    rechargeTotal: number | null; orderFee: number | null
  },
): Promise<void> {
  if (!canApprove(actorRole)) {
    // Belt and braces with the route guard: this is the function that sets the state
    // the write gate later trusts.
    throw new OrderError('Only an approver or an administrator can sign an order off.')
  }
  const order = await orderById(db, orderId)
  if (!order) throw new OrderError('That request no longer exists.')
  if (order.status !== 'submitted') throw new OrderError(`This request is ${order.status}, not waiting for sign-off.`)

  const existing = await linesForOrder(db, orderId)

  /**
   * The approval has to cover every line on the order.
   *
   * Each UPDATE below is keyed `WHERE order_id = ? AND product_id = ?`, so a line the
   * payload omits simply keeps qty_approved NULL while the order flips to approved —
   * approved as a whole, with a line nobody decided on. It was never stock-checked or
   * priced either, because checkApproval only sees what it is handed.
   *
   * The way in is not the API. Two pending requests per site are allowed so that
   * merging works, and merging adds lines to an order another approver may already have
   * open; approving from that screen submits the lines it was loaded with. So this is
   * a stale-screen check, and the message says so rather than blaming the data.
   */
  const covered = new Set(lines.map((l) => l.productId))
  const missed = existing.filter((e) => !covered.has(e.productId))
  if (missed.length > 0) {
    throw new OrderError(
      `This request has changed since you opened it — ${missed.map((m) => m.productName).join(', ')} `
        + `${missed.length === 1 ? 'is' : 'are'} on it now. Reload the queue and look again before signing it off.`,
    )
  }

  const changes = lines
    .map((l) => {
      const before = existing.find((e) => e.productId === l.productId)
      return before && before.qtyRequested !== l.qtyApproved
        ? { productId: l.productId, from: before.qtyRequested, to: l.qtyApproved }
        : null
    })
    .filter(Boolean)

  await db.batch([
    ...lines.map((l) =>
      db.prepare(
        `UPDATE order_lines SET qty_approved = ?, recharge_unit_price = ?, available_at_approval = ?
           WHERE order_id = ? AND product_id = ?`,
      ).bind(l.qtyApproved, l.rechargeUnitPrice, l.availableAtApproval, orderId, l.productId),
    ),
    db.prepare(
      `UPDATE orders SET status = 'approved', approved_at = ?, updated_at = ?,
              approved_by = (SELECT id FROM users WHERE email = ?),
              recharge_total = ?, order_fee = ?
         WHERE id = ?`,
    ).bind(nowIso(), nowIso(), actor, rechargeTotal, orderFee, orderId),
    auditStatement(db, orderId, actor, 'approved', {
      lines: lines.length, quantityChanges: changes, rechargeTotal,
    }),
  ])
}

export async function rejectOrder(
  db: Database, { orderId, actor, actorRole, reason }: {
    orderId: number; actor: string; actorRole: Role; reason: string
  },
): Promise<void> {
  if (!canApprove(actorRole)) throw new OrderError('Only an approver or an administrator can send a request back.')
  if (!reason.trim()) throw new OrderError('Say why, so the site knows what to change.')

  const order = await orderById(db, orderId)
  if (!order) throw new OrderError('That request no longer exists.')
  if (order.status !== 'submitted') throw new OrderError(`This request is ${order.status}.`)

  await db.batch([
    db.prepare(`UPDATE orders SET status = 'rejected', rejected_reason = ?, updated_at = ? WHERE id = ?`)
      .bind(reason.trim(), nowIso(), orderId),
    auditStatement(db, orderId, actor, 'rejected', { reason: reason.trim() }),
  ])
}

/**
 * Merges one pending request into another for the same site.
 *
 * Mercium charges per order, so two requests from one site is a fee we do not need to
 * pay. Logged on both orders: the one that absorbed the lines, and the one that was
 * closed, so neither trail has a gap where the other half went.
 */
export async function mergeRequests(
  db: Database, { keepId, mergeId, actor, actorRole }: {
    keepId: number; mergeId: number; actor: string; actorRole: Role
  },
): Promise<void> {
  if (!canApprove(actorRole)) throw new OrderError('Only an approver or an administrator can merge requests.')
  if (keepId === mergeId) throw new OrderError('Those are the same request.')

  const keep = await orderById(db, keepId)
  const merge = await orderById(db, mergeId)
  if (!keep || !merge) throw new OrderError('One of those requests no longer exists.')
  if (keep.siteId !== merge.siteId) throw new OrderError('Requests can only be merged within the same site.')
  for (const o of [keep, merge]) {
    if (o.status !== 'submitted') throw new OrderError(`${o.orderNumber} is ${o.status}, so it cannot be merged.`)
  }

  const mergeLines = await linesForOrder(db, mergeId)
  const keepLines = await linesForOrder(db, keepId)

  const statements = mergeLines.map((line) => {
    const already = keepLines.find((k) => k.productId === line.productId)
    return already
      ? db.prepare(`UPDATE order_lines SET qty_requested = ? WHERE id = ?`)
          .bind(already.qtyRequested + line.qtyRequested, already.id)
      : db.prepare(
          `INSERT INTO order_lines (order_id, product_id, qty_requested, available_at_request)
           VALUES (?, ?, ?, ?)`,
        ).bind(keepId, line.productId, line.qtyRequested, line.availableAtRequest)
  })

  await db.batch([
    ...statements,
    db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).bind(mergeId),
    db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(nowIso(), mergeId),
    auditStatement(db, keepId, actor, 'merged_in', {
      from: merge.orderNumber, lines: mergeLines.length,
    }),
    auditStatement(db, mergeId, actor, 'merged_into', {
      into: keep.orderNumber, lines: mergeLines.length,
    }),
  ])
}

/**
 * How long a claim holds. Must match CLAIM_HOLDS_MS in src/server/orders/send.ts: both
 * take the same claim on the same column, and a merge that used a shorter window could
 * walk into an order a send still believes it holds.
 */
const CLAIM_HOLDS_MS = 10 * 60 * 1000

/** What a merge did, so the screen can say it rather than guess. */
export interface MergedApproved {
  keptOrderNumber: string
  absorbedOrderNumber: string
  /** Products that were only on the absorbed order and moved across whole. */
  linesMoved: number
  /** Products on both, whose quantities were added together. */
  linesCombined: number
}

/**
 * Folds one approved-but-unsent order into another for the same site.
 *
 * Mercium charges per order and delivers per order, so two signed-off orders sitting
 * unsent for one restaurant is a fee and a van we do not need. mergeRequests above does
 * this before sign-off; this does it after, which is a different job because an approved
 * order carries decisions a pending one does not.
 *
 * Three of those decisions matter:
 *
 *   1. qty_approved, not qty_requested, is what gets posted to Mintsoft — and send.ts
 *      refuses the whole order if any line's is NULL. So both quantities are summed, and
 *      a line that somehow has no approved quantity stops the merge here rather than
 *      producing an order that cannot be sent.
 *   2. The order fee is charged once per order, so the survivor carries one fee and the
 *      absorbed one's is dropped. For a franchise site that saving is the point of this.
 *   3. The claim. A send takes it with a conditional UPDATE, so this takes it the same
 *      way before touching a line: without that, a merge could delete the lines out from
 *      under a send that was already posting, or cancel the order it was posting.
 *
 * The absorbed order is cancelled, not deleted. Its trail says where its lines went and
 * the survivor's says where they came from, so neither side has a gap.
 */
export async function mergeApprovedOrders(
  db: Database,
  { keepId, mergeId, actor, actorRole, recomputeTotals, checkCombined }: {
    keepId: number; mergeId: number; actor: string; actorRole: Role
    /**
     * Given the combined approved lines, what the survivor's recharge_total and
     * order_fee become. Called inside the claim, once the real combined set is known.
     * The pricing rules live in orders/approval.ts; this only asks.
     */
    recomputeTotals: (combined: ApprovedLine[]) => { total: number | null; orderFee: number | null }
    /**
     * A last look at the combined set, inside the claim, before anything is written.
     * Return a reason to refuse, or null to go ahead.
     *
     * Stock is what this is for. Two orders are each approved against the same
     * unreserved pool, so together they can want more than exists — and once they are
     * one order there is no path in this codebase that can reduce an approved quantity.
     * Better to refuse and leave two sendable orders than to make one that cannot go.
     */
    checkCombined?: (combined: ApprovedLine[]) => Promise<string | null>
  },
): Promise<MergedApproved> {
  if (!canApprove(actorRole)) {
    throw new OrderError('Only an approver or an administrator can merge signed-off orders.')
  }
  if (keepId === mergeId) throw new OrderError('Those are the same order.')

  const keep = await orderById(db, keepId)
  const merge = await orderById(db, mergeId)
  if (!keep || !merge) throw new OrderError('One of those orders no longer exists.')
  if (keep.siteId !== merge.siteId) throw new OrderError('Orders can only be merged within the same site.')

  /**
   * Both halves have to be billed on the same basis.
   *
   * recharge is copied onto the order from the site at request time, so two orders for
   * one site normally agree — but a site switched between corporate and franchise
   * between the two sign-offs would not, and merging would silently bill one half on the
   * other's basis.
   */
  if (keep.recharge !== merge.recharge) {
    throw new OrderError(
      `${keep.orderNumber} and ${merge.orderNumber} are not charged the same way — one is `
        + 'recharged to the site and one is not. They cannot be combined without deciding '
        + 'which is right.',
    )
  }

  /**
   * And in the same month, because that is what the recharge report buckets on.
   *
   * rechargeReport counts an order in the month of its approved_at. Folding a September
   * order into an October one moves its goods into October — and if Finance has already
   * invoiced September, the goods leave that invoice and nothing says so.
   */
  const monthOf = (at: string | null) => (at ?? '').slice(0, 7)
  if (monthOf(keep.approvedAt) !== monthOf(merge.approvedAt)) {
    throw new OrderError(
      `${keep.orderNumber} and ${merge.orderNumber} were signed off in different months, so `
        + 'combining them would move goods between two recharge periods. Send them separately.',
    )
  }

  for (const o of [keep, merge]) {
    // post_failed belongs here with approved: it means the send stopped before anything
    // reached Mintsoft, so the order is still waiting to go. Anything carrying a Mintsoft
    // id has gone, and merging it would be editing an order Mercium is already picking.
    if (!['approved', 'post_failed'].includes(o.status)) {
      throw new OrderError(`${o.orderNumber} is ${o.status}, so it is not waiting to be sent.`)
    }
    if (o.mintsoftOrderId !== null) {
      throw new OrderError(`${o.orderNumber} is already with Mercium as order ${o.mintsoftOrderId}.`)
    }
    /**
     * The uncertain send, and the reason this check exists.
     *
     * A send whose reply never arrived leaves the order 'approved' with post_error set
     * and the claim deliberately held (send.ts:305-319): the order may be at Mercium
     * already. The claim ages out after ten minutes so the next attempt can re-run the
     * lookup, which matches on this order's own reference.
     *
     * Merge it and that recovery is gone. Its lines would move to another order with a
     * different reference, the lookup would find nothing, and the goods would be picked
     * twice. post_failed is a different thing -- Mintsoft said no, nothing was created --
     * so that one is safe and allowed above.
     */
    if (o.status === 'approved' && o.postError !== null) {
      throw new OrderError(
        `${o.orderNumber} was sent and we did not hear back, so it may already be with `
          + 'Mercium. It has to be looked up and settled before it can be merged — '
          + 'merging it now is how the same stock gets picked twice.',
      )
    }
  }

  // Take both orders before reading a line. Same predicate as the send's claim, so of a
  // merge and a send racing, exactly one proceeds.
  const claimed: number[] = []
  for (const id of [keepId, mergeId]) {
    if (await claimForMerge(db, id)) { claimed.push(id); continue }
    for (const held of claimed) await releaseMergeClaim(db, held)
    const stuck = id === keepId ? keep : merge
    throw new OrderError(
      `${stuck.orderNumber} is being sent right now. Wait for that to finish, then look again.`,
    )
  }

  try {
    const keepLines = await linesForOrder(db, keepId)
    const mergeLines = await linesForOrder(db, mergeId)

    const noQty = [...keepLines, ...mergeLines].filter((l) => l.qtyApproved === null)
    if (noQty.length > 0) {
      throw new OrderError(
        `${noQty.map((l) => l.productName).join(', ')} ${noQty.length === 1 ? 'has' : 'have'} no `
          + 'approved quantity, so these orders cannot be combined. Sign them off again before merging.',
      )
    }

    /**
     * A product on both orders, approved at two different prices, has no right answer.
     *
     * The surviving line carries one recharge_unit_price, and the recharge report prices
     * every unit on it at that figure — so whichever we keep, half the units are invoiced
     * at a price nobody approved for them. Stopping is the only honest move.
     */
    const priceClash = mergeLines
      .map((m) => ({ m, k: keepLines.find((k) => k.productId === m.productId) }))
      .filter(({ m, k }) => k && (k.rechargeUnitPrice ?? null) !== (m.rechargeUnitPrice ?? null))
    if (priceClash.length > 0) {
      throw new OrderError(
        `${priceClash.map(({ m }) => m.productName).join(', ')} ${priceClash.length === 1 ? 'was' : 'were'} `
          + 'signed off at a different price on each order, so the two cannot be added together. '
          + 'Send them separately, or sign one off again at the price that should apply.',
      )
    }

    /**
     * And no unpriced line on a recharged order.
     *
     * checkApproval refuses to sign off a recharge order with a NULL price, because the
     * report would invoice the franchise nothing for those units. Combining is the other
     * way the same line could arrive, so it is refused here too.
     */
    if (keep.recharge) {
      const unpriced = [...keepLines, ...mergeLines].filter((l) => l.rechargeUnitPrice === null)
      if (unpriced.length > 0) {
        throw new OrderError(
          `${unpriced.map((l) => l.productName).join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} `
            + 'no price set, and this site is recharged — combining would invoice nothing for them.',
        )
      }
    }

    let linesMoved = 0
    let linesCombined = 0
    const statements = mergeLines.map((line) => {
      const already = keepLines.find((k) => k.productId === line.productId)
      if (already) {
        linesCombined++
        return db
          .prepare(`UPDATE order_lines SET qty_requested = ?, qty_approved = ? WHERE id = ?`)
          .bind(
            already.qtyRequested + line.qtyRequested,
            already.qtyApproved! + line.qtyApproved!,
            already.id,
          )
      }
      linesMoved++
      return db
        .prepare(
          `INSERT INTO order_lines
             (order_id, product_id, qty_requested, qty_approved,
              available_at_request, available_at_approval, recharge_unit_price)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          keepId, line.productId, line.qtyRequested, line.qtyApproved,
          line.availableAtRequest, line.availableAtApproval, line.rechargeUnitPrice,
        )
    })

    // The combined set, as the survivor will look once the statements above have run.
    const combined: ApprovedLine[] = [...keepLines]
      .map((k) => {
        const other = mergeLines.find((m) => m.productId === k.productId)
        return {
          productId: k.productId,
          qtyApproved: k.qtyApproved! + (other?.qtyApproved ?? 0),
          rechargeUnitPrice: k.rechargeUnitPrice,
          availableAtApproval: k.availableAtApproval,
        }
      })
      .concat(
        mergeLines
          .filter((m) => !keepLines.some((k) => k.productId === m.productId))
          .map((m) => ({
            productId: m.productId,
            qtyApproved: m.qtyApproved!,
            rechargeUnitPrice: m.rechargeUnitPrice,
            availableAtApproval: m.availableAtApproval,
          })),
      )

    const refusal = checkCombined ? await checkCombined(combined) : null
    if (refusal) throw new OrderError(refusal)

    const totals = recomputeTotals(combined)

    await db.batch([
      ...statements,
      db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).bind(mergeId),
      // The survivor goes back to plain approved: a previous refusal was about the old
      // line set, and leaving post_error set would show a stale reason on a new order.
      db
        .prepare(
          `UPDATE orders SET status = 'approved', recharge_total = ?, order_fee = ?,
                  required_date = ?, notes = ?, early_order_reason = ?,
                  post_error = NULL, send_claimed_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .bind(
          totals.total, totals.orderFee,
          // The earlier date wins: if either half was needed by Friday, the combined
          // order is needed by Friday. Dropping it would quietly move a delivery.
          earliest(keep.requiredDate, merge.requiredDate),
          joinNotes(keep.notes, merge.notes, merge.orderNumber),
          // An early-order reason is the thing an approver was asked to read. Losing it
          // because the order it was typed on got absorbed would hide it from the trail.
          keep.earlyOrderReason ?? merge.earlyOrderReason,
          nowIso(), keepId,
        ),
      db
        .prepare(
          `UPDATE orders SET status = 'cancelled', recharge_total = NULL, order_fee = NULL,
                  send_claimed_at = NULL, merged_into_order_id = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(keepId, nowIso(), mergeId),
      /**
       * The detail, not just the count. The DELETE below destroys the absorbed order's
       * lines, and its recharge_total with them. If Finance has already invoiced a month
       * containing either order, this record is the only way to reconstruct what was
       * approved at what price before the two became one.
       */
      auditStatement(db, keepId, actor, 'merged_in', {
        from: merge.orderNumber, linesMoved, linesCombined,
        rechargeTotalBefore: keep.rechargeTotal, rechargeTotalAfter: totals.total,
        orderFeeBefore: keep.orderFee, orderFeeAfter: totals.orderFee,
        absorbed: mergeLines.map((l) => ({
          productId: l.productId, productName: l.productName,
          qtyRequested: l.qtyRequested, qtyApproved: l.qtyApproved,
          rechargeUnitPrice: l.rechargeUnitPrice,
        })),
      }),
      auditStatement(db, mergeId, actor, 'merged_into', {
        into: keep.orderNumber, linesMoved, linesCombined,
        // Its own figures, recorded on its own trail before they are cleared.
        rechargeTotal: merge.rechargeTotal, orderFee: merge.orderFee,
        approvedAt: merge.approvedAt,
        lines: mergeLines.map((l) => ({
          productId: l.productId, productName: l.productName,
          qtyRequested: l.qtyRequested, qtyApproved: l.qtyApproved,
          rechargeUnitPrice: l.rechargeUnitPrice,
        })),
      }),
    ])

    return {
      keptOrderNumber: keep.orderNumber,
      absorbedOrderNumber: merge.orderNumber,
      linesMoved,
      linesCombined,
    }
  } catch (err) {
    // Nothing was written, so give both orders back rather than stranding them for the
    // ten minutes a claim holds.
    for (const held of claimed) await releaseMergeClaim(db, held)
    throw err
  }
}

/** The earlier of two dates, either of which may be absent. */
const earliest = (a: string | null, b: string | null): string | null =>
  a && b ? (a < b ? a : b) : a ?? b

/** Both orders' notes, with the absorbed one attributed so nobody wonders whose it was. */
function joinNotes(keep: string | null, absorbed: string | null, absorbedNumber: string): string | null {
  if (!absorbed?.trim()) return keep
  const tail = `From ${absorbedNumber}: ${absorbed.trim()}`
  return keep?.trim() ? `${keep.trim()}\n\n${tail}` : tail
}

/** The send's claim, taken for a merge. Deliberately the same predicate. */
async function claimForMerge(db: Database, orderId: number): Promise<boolean> {
  const staleBefore = new Date(Date.now() - CLAIM_HOLDS_MS).toISOString().replace(/\.\d+Z$/, 'Z')
  const claimed = await db
    .prepare(
      `UPDATE orders SET send_claimed_at = ?, updated_at = ?
        WHERE id = ?
          AND status IN ('approved', 'post_failed')
          AND mintsoft_order_id IS NULL
          AND (send_claimed_at IS NULL OR send_claimed_at < ?)`,
    )
    .bind(nowIso(), nowIso(), orderId, staleBefore)
    .run()
  return (claimed as { meta?: { changes?: number } }).meta?.changes === 1
}

async function releaseMergeClaim(db: Database, orderId: number): Promise<void> {
  await db
    .prepare(`UPDATE orders SET send_claimed_at = NULL, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), orderId)
    .run()
}

/**
 * Sites with more than one order signed off and still waiting to go.
 *
 * Grouped rather than listed, because the question a person has in front of the
 * awaiting-send list is "is this restaurant getting two deliveries?" and a flat list
 * ordered by approval time does not answer it.
 */
export async function sitesWithSeveralAwaitingSend(
  db: Database,
): Promise<{ siteId: number; siteCode: string; siteName: string; orders: OrderSummary[] }[]> {
  const waiting = await awaitingSend(db)
  const bySite = new Map<number, OrderSummary[]>()
  for (const o of waiting) {
    const list = bySite.get(o.siteId) ?? []
    list.push(o)
    bySite.set(o.siteId, list)
  }
  return [...bySite.values()]
    .filter((orders) => orders.length > 1)
    .map((orders) => ({
      siteId: orders[0]!.siteId,
      siteCode: orders[0]!.siteCode,
      siteName: orders[0]!.siteName,
      // Oldest first: that is the one the others fold into, so its number survives.
      orders,
    }))
    .sort((a, b) => a.siteCode.localeCompare(b.siteCode))
}

export async function cancelOrder(
  db: Database, { orderId, actor, reason }: { orderId: number; actor: string; reason: string | null },
): Promise<void> {
  const order = await orderById(db, orderId)
  if (!order) throw new OrderError('That request no longer exists.')
  if (['posted', 'despatched'].includes(order.status)) {
    throw new OrderError(`${order.orderNumber} is already with the warehouse and cannot be cancelled here.`)
  }
  if (order.status === 'cancelled') return

  /**
   * Not while a send or a merge holds it.
   *
   * Without this, a cancel landing inside a merge's claim is overwritten by the merge's
   * own batch moments later — so an order the GM was told would not be sent goes back to
   * 'approved' and is sent. The claim is the one thing both operations contend on, so
   * cancelling respects it too.
   */
  const staleBefore = new Date(Date.now() - CLAIM_HOLDS_MS).toISOString().replace(/\.\d+Z$/, 'Z')
  const cancelled = await db
    .prepare(
      `UPDATE orders SET status = 'cancelled', updated_at = ?
        WHERE id = ?
          AND status = ?
          AND mintsoft_order_id IS NULL
          AND (send_claimed_at IS NULL OR send_claimed_at < ?)`,
    )
    .bind(nowIso(), orderId, order.status, staleBefore)
    .run()

  if ((cancelled as { meta?: { changes?: number } }).meta?.changes !== 1) {
    // The row moved between the read above and this write: another send or merge took it,
    // or it reached Mercium. A SELECT first would have had the same gap, which is why
    // this is the conditional UPDATE and not a check followed by a write.
    throw new OrderError(
      `${order.orderNumber} changed while this was being cancelled — it is being sent or `
        + 'combined, or it has already gone. Reload and look at where it is now.',
    )
  }

  await auditStatement(db, orderId, actor, 'cancelled', reason ? { reason } : undefined).run()
}

export async function eventsForOrder(db: Database, orderId: number) {
  const { results } = await db
    .prepare(`SELECT actor, event, detail, at FROM order_events WHERE order_id = ? ORDER BY at, id`)
    .bind(orderId)
    .all<{ actor: string; event: string; detail: string | null; at: string }>()
  return (results ?? []).map((r) => ({
    actor: r.actor, event: r.event, at: r.at,
    detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
  }))
}

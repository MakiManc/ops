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
         o.rejected_reason, o.mintsoft_order_id, o.post_error, o.despatched_at,
         o.tracking_url, o.created_at
    FROM orders o JOIN sites s ON s.id = o.site_id`

interface RawOrder {
  id: number; order_number: string; site_id: number; site_code: string; site_name: string
  type: 'replenishment' | 'expansion'; status: OrderStatus; requester_name: string | null
  required_date: string | null; notes: string | null; early_order_reason: string | null
  recharge: number; recharge_total: number | null; order_fee: number | null
  submitted_at: string | null; approved_at: string | null; rejected_reason: string | null
  mintsoft_order_id: number | null; post_error: string | null; despatched_at: string | null
  tracking_url: string | null; created_at: string
}

const toSummary = (r: RawOrder): OrderSummary => ({
  id: r.id, orderNumber: r.order_number, siteId: r.site_id, siteCode: r.site_code,
  siteName: r.site_name, type: r.type, status: r.status, requesterName: r.requester_name,
  requiredDate: r.required_date, notes: r.notes, earlyOrderReason: r.early_order_reason,
  recharge: r.recharge === 1, rechargeTotal: r.recharge_total, orderFee: r.order_fee,
  submittedAt: r.submitted_at, approvedAt: r.approved_at, rejectedReason: r.rejected_reason,
  mintsoftOrderId: r.mintsoft_order_id, postError: r.post_error, despatchedAt: r.despatched_at,
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

export async function cancelOrder(
  db: Database, { orderId, actor, reason }: { orderId: number; actor: string; reason: string | null },
): Promise<void> {
  const order = await orderById(db, orderId)
  if (!order) throw new OrderError('That request no longer exists.')
  if (['posted', 'despatched'].includes(order.status)) {
    throw new OrderError(`${order.orderNumber} is already with the warehouse and cannot be cancelled here.`)
  }
  if (order.status === 'cancelled') return

  await db.batch([
    db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(nowIso(), orderId),
    auditStatement(db, orderId, actor, 'cancelled', reason ? { reason } : undefined),
  ])
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

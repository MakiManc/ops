/**
 * Sending an approved order to the warehouse.
 *
 * Every path to Mintsoft's order-create endpoint goes through here, and here goes
 * through the write gate first. The gate needs both the flag and an approver's
 * sign-off; nothing in this file second-guesses it.
 *
 * The outcome is always recorded, including the uncertain one. An order we are unsure
 * about is the single most dangerous state in the system — it must never look like a
 * plain failure, because a failure invites a retry and a retry could be a duplicate.
 */
import { auditStatement, orderById, linesForOrder } from '../db/orders.ts'
import { readSettings } from '../db/settings.ts'
import type { Database } from '../db/repo.ts'
import type { Role } from '../db/types.ts'
import { allocateLine, type MappedSku } from './approval.ts'
import { type MintsoftWriteClient, postOrder, type OrderToPost } from './post.ts'
import { mayWriteToMintsoft } from './write-gate.ts'

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

export interface SendResult {
  ok: boolean
  status: 'posted' | 'already_posted' | 'refused' | 'rejected' | 'uncertain'
  message: string
  mintsoftOrderId?: number
}

export async function sendApprovedOrder(
  db: Database,
  client: MintsoftWriteClient,
  { orderId, actor, writesEnabled, clientId, warehouseId }: {
    orderId: number; actor: string; writesEnabled: boolean
    clientId: number | null; warehouseId: number | null
  },
): Promise<SendResult> {
  const order = await orderById(db, orderId)
  if (!order) return { ok: false, status: 'refused', message: 'That order no longer exists.' }

  const settings = await readSettings(db)

  const approver = await db
    .prepare(
      `SELECT u.role FROM orders o LEFT JOIN users u ON u.id = o.approved_by WHERE o.id = ?`,
    )
    .bind(orderId)
    .first<{ role: Role | null }>()

  // The single gate. Both conditions, one place.
  const decision = mayWriteToMintsoft({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    approvedByRole: approver?.role ?? null,
    approvedAt: order.approvedAt,
    mintsoftOrderId: order.mintsoftOrderId,
  }, { writesEnabled })

  if (!decision.allowed) {
    // Recorded even when nothing was attempted: "why did this not go" is a question
    // that gets asked, and the answer should already be written down.
    await auditStatement(db, orderId, actor, 'send_refused', { reason: decision.reason }).run()
    return {
      ok: false,
      status: order.mintsoftOrderId ? 'already_posted' : 'refused',
      message: decision.reason,
      mintsoftOrderId: order.mintsoftOrderId ?? undefined,
    }
  }

  const site = await db
    .prepare(
      `SELECT code, name, address_1, address_2, address_3, town, county, postcode, country,
              contact_name, contact_phone, delivery_notes, default_courier_service_id
         FROM sites WHERE id = ?`,
    )
    .bind(order.siteId)
    .first<{
      code: string; name: string; address_1: string | null; address_2: string | null
      address_3: string | null; town: string | null; county: string | null
      postcode: string | null; country: string; contact_name: string | null
      contact_phone: string | null; delivery_notes: string | null
      default_courier_service_id: number | null
    }>()
  if (!site) return { ok: false, status: 'refused', message: 'That order has no site.' }

  // Work out which warehouse SKUs each line is ordered against, re-reading stock now
  // rather than trusting what was on screen at approval.
  const lines = await linesForOrder(db, orderId)
  const { results: skuRows } = await db
    .prepare(
      `SELECT pmm.product_id, pmm.mintsoft_product_id, pmm.sku, pmm.is_primary,
              SUM(sc.available) AS available,
              COUNT(sc.id) AS rows_seen,
              COUNT(sc.available) AS rows_with_value
         FROM product_mintsoft_map pmm
         LEFT JOIN stock_cache sc ON sc.mintsoft_product_id = pmm.mintsoft_product_id
        GROUP BY pmm.mintsoft_product_id`,
    )
    .all<{
      product_id: number; mintsoft_product_id: number; sku: string; is_primary: number
      available: number | null; rows_seen: number; rows_with_value: number
    }>()

  const skusByProduct = new Map<number, MappedSku[]>()
  for (const r of skuRows ?? []) {
    // A SKU with no stock row, or with any row missing its figure, is unknown rather
    // than zero — and an unknown blocks the allocation rather than silently ordering
    // against nothing.
    const available = r.rows_seen === 0 || r.rows_with_value < r.rows_seen ? null : r.available
    skusByProduct.set(r.product_id, [
      ...(skusByProduct.get(r.product_id) ?? []),
      { mintsoftProductId: r.mintsoft_product_id, sku: r.sku, isPrimary: r.is_primary === 1, available },
    ])
  }

  const allocations = lines.map((line) => allocateLine({
    productId: line.productId,
    productName: line.productName,
    qtyApproved: line.qtyApproved ?? line.qtyRequested,
    skus: skusByProduct.get(line.productId) ?? [],
    rechargeUnitPrice: line.rechargeUnitPrice,
  }))

  const short = allocations.filter((a) => a.kind === 'short')
  if (short.length > 0) {
    const message = short.map((a) => (a.kind === 'short' ? a.message : '')).join(' ')
    await db.batch([
      db.prepare(`UPDATE orders SET status = 'post_failed', post_error = ?, updated_at = ? WHERE id = ?`)
        .bind(message, nowIso(), orderId),
      auditStatement(db, orderId, actor, 'send_blocked', { reason: message }),
    ])
    return { ok: false, status: 'refused', message }
  }

  const toPost: OrderToPost = {
    orderNumber: order.orderNumber,
    siteCode: site.code,
    companyName: site.name,
    contactName: site.contact_name,
    address1: site.address_1, address2: site.address_2, address3: site.address_3,
    town: site.town, county: site.county, postcode: site.postcode, country: site.country,
    phone: site.contact_phone,
    deliveryNotes: site.delivery_notes,
    requiredDate: order.requiredDate,
    comments: order.notes,
    // A site's own courier wins; otherwise the account default. Never null: Mintsoft
    // refuses an order with no courier service, and a refusal at this point looks to a
    // GM like the portal is broken rather than like a missing setting.
    courierServiceId: site.default_courier_service_id ?? settings.defaultCourierServiceId,
    clientId, warehouseId,
    lines: allocations.flatMap((a) => (a.kind === 'allocated' ? a.parts : []))
      .map((p) => ({ sku: p.sku, quantity: p.qty })),
  }

  const outcome = await postOrder(client, toPost)

  switch (outcome.kind) {
    case 'created':
    case 'already_exists': {
      await db.batch([
        db.prepare(
          `UPDATE orders SET status = 'posted', mintsoft_order_id = ?, posted_at = ?,
                  post_error = NULL, updated_at = ? WHERE id = ?`,
        ).bind(outcome.mintsoftOrderId, nowIso(), nowIso(), orderId),
        auditStatement(db, orderId, actor, outcome.kind === 'created' ? 'posted' : 'attached_existing', {
          mintsoftOrderId: outcome.mintsoftOrderId,
          lines: toPost.lines,
        }),
      ])
      return {
        ok: true,
        status: outcome.kind === 'created' ? 'posted' : 'already_posted',
        message: outcome.kind === 'created'
          ? `Sent to Mercium as order ${outcome.mintsoftOrderId}.`
          : `Already in Mintsoft as order ${outcome.mintsoftOrderId}; attached rather than sent again.`,
        mintsoftOrderId: outcome.mintsoftOrderId,
      }
    }

    case 'rejected': {
      await db.batch([
        db.prepare(`UPDATE orders SET status = 'post_failed', post_error = ?, updated_at = ? WHERE id = ?`)
          .bind(outcome.reason, nowIso(), orderId),
        auditStatement(db, orderId, actor, 'post_rejected', { reason: outcome.reason }),
      ])
      return { ok: false, status: 'rejected', message: `Mintsoft refused the order: ${outcome.reason}` }
    }

    case 'uncertain': {
      // Deliberately NOT marked failed. A failed order invites a retry, and the whole
      // problem here is that we do not know whether one already exists. It stays
      // approved so the next attempt re-runs the lookup, which is what the order
      // number is for.
      await db.batch([
        db.prepare(`UPDATE orders SET post_error = ?, updated_at = ? WHERE id = ?`)
          .bind(outcome.reason, nowIso(), orderId),
        auditStatement(db, orderId, actor, 'post_uncertain', { reason: outcome.reason }),
      ])
      return { ok: false, status: 'uncertain', message: outcome.reason }
    }
  }
}

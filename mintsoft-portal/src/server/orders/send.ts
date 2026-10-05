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

/**
 * How long a claim is honoured before another send may take it.
 *
 * A process that dies between claiming and recording the outcome would otherwise strand
 * the order forever, fixable only with database access. Reclaiming is safe because the
 * Order/Search lookup still runs before the PUT: if the dead process did create the
 * order, the lookup finds it and attaches rather than creating a second one.
 */
const CLAIM_HOLDS_MS = 10 * 60 * 1000

/**
 * Takes the order, or reports that somebody else has it.
 *
 * A conditional UPDATE, because SQLite serialises writers: of two sends racing, exactly
 * one changes a row. Every earlier guard was a read, which is how two approvers pressing
 * Send at the same moment could both pass and both create a real order at Mercium.
 */
async function claimForSending(db: Database, orderId: number): Promise<boolean> {
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

/**
 * Gives the order back, so a refusal or a plain failure can be retried.
 *
 * Never called once a PUT has gone out with an uncertain result: there the order may
 * exist at Mercium, and holding the claim is what stops a retry duplicating it.
 */
/**
 * Records a send that stopped before anything went out.
 *
 * Conditional, and that is the whole point. An order whose send went uncertain sits at
 * status 'approved' with post_error set, and that pair is the only record that it may
 * already be at Mercium. A second press that trips one of the guards below would
 * otherwise overwrite the marker and demote the order to post_failed -- which reads as
 * "Mintsoft refused it, nothing was created" and is exactly what the merge treats as safe
 * to combine. One blocked retry would turn a maybe into a duplicate pallet.
 */
async function recordSendBlocked(
  db: Database, orderId: number, actor: string, message: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE orders SET status = 'post_failed', post_error = ?, updated_at = ?
          WHERE id = ? AND NOT (status = 'approved' AND post_error IS NOT NULL)`,
      )
      .bind(message, nowIso(), orderId),
    auditStatement(db, orderId, actor, 'send_blocked', { reason: message }),
  ])
}

async function releaseClaim(db: Database, orderId: number): Promise<void> {
  await db
    .prepare(`UPDATE orders SET send_claimed_at = NULL, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), orderId)
    .run()
}

export interface SendResult {
  ok: boolean
  status: 'posted' | 'already_posted' | 'refused' | 'rejected' | 'uncertain' | 'in_flight'
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
              contact_name, contact_phone, delivery_notes
         FROM sites WHERE id = ?`,
    )
    .bind(order.siteId)
    .first<{
      code: string; name: string; address_1: string | null; address_2: string | null
      address_3: string | null; town: string | null; county: string | null
      postcode: string | null; country: string; contact_name: string | null
      contact_phone: string | null; delivery_notes: string | null
    }>()
  if (!site) {
    // Again, nothing claimed yet.
    return { ok: false, status: 'refused', message: 'That order has no site.' }
  }

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

  /**
   * A line nobody approved stops the send. It used to inherit the GM's requested
   * quantity — `line.qtyApproved ?? line.qtyRequested` — which silently turned "no
   * approver has looked at this" into "send what the GM asked for".
   *
   * It is reachable without touching the API: two pending requests per site are allowed
   * so that merging works, and merging adds lines to an order an approver may already
   * have open. Approving from that stale screen leaves the merged-in lines with
   * qty_approved NULL while the order flips to approved, and those lines were never
   * stock-checked or priced either.
   */
  const unapproved = lines.filter((line) => line.qtyApproved === null)
  if (unapproved.length > 0) {
    const names = unapproved.map((l) => l.productName).join(', ')
    const message = `${order.orderNumber} has lines nobody has approved: ${names}. `
      + 'It was most likely changed after it was signed off. Send it back through approval.'
    // No releaseClaim: nothing has been claimed yet at this point -- the claim is taken
    // inside postOrder, immediately before the create. Releasing here would clear a hold
    // another send is relying on, which is how an uncertain order becomes mergeable.
    await recordSendBlocked(db, orderId, actor, message)
    return { ok: false, status: 'refused', message }
  }

  const allocations = lines.map((line) => allocateLine({
    productId: line.productId,
    productName: line.productName,
    qtyApproved: line.qtyApproved!,
    skus: skusByProduct.get(line.productId) ?? [],
    rechargeUnitPrice: line.rechargeUnitPrice,
  }))

  const short = allocations.filter((a) => a.kind === 'short')
  if (short.length > 0) {
    const message = short.map((a) => (a.kind === 'short' ? a.message : '')).join(' ')
    // No releaseClaim: nothing has been claimed yet at this point -- the claim is taken
    // inside postOrder, immediately before the create. Releasing here would clear a hold
    // another send is relying on, which is how an uncertain order becomes mergeable.
    await recordSendBlocked(db, orderId, actor, message)
    return { ok: false, status: 'refused', message }
  }

  /**
   * An approval of zero on every line allocates nothing, and the assembled order would
   * carry no items at all. Mintsoft accepts that — every required field is present — so
   * Mercium would open a job, pick nothing, and bill the per-order fee, while the portal
   * marked it posted and refused to send it ever again. The site's stock would never go
   * and the GM would be told it had.
   *
   * Checked here, against the items actually assembled, rather than upstream: this is
   * the last point before the one irreversible call.
   */
  const itemCount = allocations.flatMap((a) => (a.kind === 'allocated' ? a.parts : [])).length
  if (itemCount === 0) {
    const message = `${order.orderNumber} has nothing to send — every line was approved at zero. `
      + 'Reject it instead, so the site knows, rather than sending Mercium an empty order.'
    // No releaseClaim: nothing has been claimed yet at this point -- the claim is taken
    // inside postOrder, immediately before the create. Releasing here would clear a hold
    // another send is relying on, which is how an uncertain order becomes mergeable.
    await recordSendBlocked(db, orderId, actor, message)
    return { ok: false, status: 'refused', message }
  }

  const toPost: OrderToPost = {
    reference: order.orderNumber,
    siteCode: site.code,
    companyName: site.name,
    contactName: site.contact_name,
    address1: site.address_1, address2: site.address_2, address3: site.address_3,
    town: site.town, county: site.county, postcode: site.postcode, country: site.country,
    phone: site.contact_phone,
    deliveryNotes: site.delivery_notes,
    requiredDate: order.requiredDate,
    comments: order.notes,
    // Not a choice about how the order ships -- Mercium makes that when they raise the
    // shipment. It is here because Mintsoft will not accept an order without one, and a
    // refusal at this point looks to a GM like the portal is broken.
    courierServiceId: settings.defaultCourierServiceId,
    clientId, warehouseId,
    lines: allocations.flatMap((a) => (a.kind === 'allocated' ? a.parts : []))
      .map((p) => ({ sku: p.sku, quantity: p.qty })),
  }

  /**
   * What the payload above was built from.
   *
   * Everything up to here is a read, and the claim is not taken until the moment before
   * the create. A merge can complete inside that window -- it takes the claim, writes,
   * and gives it back -- after which this send would claim successfully and post the
   * quantities it assembled before the merge. The absorbed half would ship to nobody,
   * and its lines are already gone.
   *
   * So the set is fingerprinted here and checked again once the claim is held.
   */
  const fingerprint = lines
    .map((l) => `${l.id}:${l.qtyApproved}`)
    .sort()
    .join('|')

  let changedUnderUs = false

  // The claim fires inside postOrder, once the lookup has said the order is absent and
  // immediately before the create. Not around the whole send: a retry has to be able to
  // run the lookup and attach an order a dead process already created.
  const outcome = await postOrder(client, toPost, async () => {
    if (!(await claimForSending(db, orderId))) return false

    const now = (await linesForOrder(db, orderId))
      .map((l) => `${l.id}:${l.qtyApproved}`)
      .sort()
      .join('|')
    if (now !== fingerprint) {
      // Something moved the lines while this send was assembling. Give the order back and
      // let the next attempt build from what is there now.
      changedUnderUs = true
      await releaseClaim(db, orderId)
      return false
    }
    return true
  })

  switch (outcome.kind) {
    case 'in_flight':
      if (changedUnderUs) {
        const message = `${order.orderNumber} changed while it was being sent — it was probably `
          + 'combined with another order for this site. Nothing was sent. Reload and send what is there now.'
        await auditStatement(db, orderId, actor, 'send_refused', { reason: 'lines changed mid-send' }).run()
        return { ok: false, status: 'in_flight', message }
      }
      await auditStatement(db, orderId, actor, 'send_refused', { reason: 'already being sent' }).run()
      return {
        ok: false,
        status: 'in_flight',
        message: `${order.orderNumber} is already being sent. Wait for that to finish rather than sending it again.`,
      }

    case 'created':
    case 'already_exists': {
      await db.batch([
        db.prepare(
          `UPDATE orders SET status = 'posted', mintsoft_order_id = ?, mintsoft_order_number = ?,
                  posted_at = ?, post_error = NULL, updated_at = ? WHERE id = ?`,
        ).bind(outcome.mintsoftOrderId, outcome.mintsoftOrderNumber, nowIso(), nowIso(), orderId),
        auditStatement(db, orderId, actor, outcome.kind === 'created' ? 'posted' : 'attached_existing', {
          mintsoftOrderId: outcome.mintsoftOrderId,
          mintsoftOrderNumber: outcome.mintsoftOrderNumber,
          lines: toPost.lines,
        }),
      ])
      // Say the number Mercium will say. The internal id is the fallback for the case
      // where Mintsoft created the order but did not echo a number for it.
      const named = outcome.mintsoftOrderNumber ?? `${outcome.mintsoftOrderId}`
      const warning = outcome.kind === 'created' ? outcome.warning : undefined
      return {
        ok: true,
        status: outcome.kind === 'created' ? 'posted' : 'already_posted',
        message: outcome.kind === 'created'
          ? (warning ? `Sent to Mercium, but: ${warning}` : `Sent to Mercium as order ${named}.`)
          : `Already in Mintsoft as order ${named}; attached rather than sent again.`,
        mintsoftOrderId: outcome.mintsoftOrderId,
      }
    }

    case 'rejected': {
      await db.batch([
        db.prepare(`UPDATE orders SET status = 'post_failed', post_error = ?, updated_at = ? WHERE id = ?`)
          .bind(outcome.reason, nowIso(), orderId),
        auditStatement(db, orderId, actor, 'post_rejected', { reason: outcome.reason }),
      ])
      // Mintsoft answered Success:false, so nothing was created and a retry is safe.
      await releaseClaim(db, orderId)
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
      // The claim is deliberately NOT released. The order may exist at Mercium, and
      // holding it is what stops a retry turning a maybe into a duplicate. It ages out
      // after CLAIM_HOLDS_MS, by which time the Order/Search lookup will find any order
      // that was in fact created.
      return { ok: false, status: 'uncertain', message: outcome.reason }
    }
  }
}

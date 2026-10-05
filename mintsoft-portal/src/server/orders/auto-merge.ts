/**
 * Signing an order off for a site that already has one waiting folds the two together.
 *
 * Ross's call, over offering it: Mercium charges a fee per order and delivers per order,
 * so two signed-off orders for one restaurant is money going out twice every time, and a
 * rule that depends on somebody noticing a card is a rule that gets missed. It is not
 * silent — the approver is told on screen what just happened, and the site's email names
 * the order the stock is actually coming on.
 *
 * The approval is never at risk. Every guard in mergeApprovedOrders exists because
 * combining in that state would cost money — an order that may already be at Mercium, two
 * different recharge months, a product priced two ways — and when one of them fires the
 * right outcome is the order staying signed off and unsent, exactly as it would have been
 * before this existed. The reason is carried back so the screen can say why the two did
 * not join, and the manual offer on the approval queue remains for a person to settle.
 */
import {
  awaitingSend, mergeApprovedOrders, OrderError, orderById,
  type MergedApproved,
} from '../db/orders.ts'
import type { Database } from '../db/repo.ts'
import type { Role } from '../db/types.ts'
import { allocateLine, rechargeTotals, type LineToApprove } from './approval.ts'
import { skusByProduct } from './stock.ts'

/**
 * Can the warehouse actually fill the combined order?
 *
 * Two orders are each approved against the same unreserved pool, so nothing stopped both
 * being signed off for stock only one of them can have. Separately they are two sendable
 * orders; combined they are one order the send will refuse as short — and there is no
 * route in this codebase that can reduce an approved quantity, so that order is stuck.
 *
 * So the combined set is checked here, before anything is written, and a short line
 * leaves the two orders exactly as they were.
 */
export async function combinedStockRefusal(
  db: Database, combined: { productId: number; qtyApproved: number }[],
): Promise<string | null> {
  const skus = await skusByProduct(db)
  const { results: names } = await db
    .prepare(`SELECT id, name FROM products`)
    .all<{ id: number; name: string }>()
  const nameFor = new Map((names ?? []).map((r) => [r.id, r.name]))

  const lines: LineToApprove[] = combined.map((l) => ({
    productId: l.productId,
    productName: nameFor.get(l.productId) ?? `Product ${l.productId}`,
    qtyApproved: l.qtyApproved,
    skus: skus.get(l.productId) ?? [],
    rechargeUnitPrice: null,   // not priced here; the fee and prices are handled above
  }))

  const short = lines.map(allocateLine).filter((a) => a.kind === 'short')
  if (short.length === 0) return null
  return 'Together these orders want more than the warehouse has: '
    + `${short.map((a) => a.message).join(' ')} They have been left as two orders.`
}

export type AutoMergeOutcome =
  /** The site had nothing else waiting. Nothing happened, and nothing needed to. */
  | { kind: 'nothing_to_join' }
  /** Folded in. `into` is the order number that survives and that will be sent. */
  | { kind: 'merged'; into: string; merged: MergedApproved }
  /**
   * There was something to join and a guard said no. The order is still approved and
   * still sendable on its own; `reason` is the guard's own words.
   */
  | { kind: 'held_back'; otherOrderNumber: string; reason: string }

/**
 * Folds a just-approved order into the site's oldest one already waiting to be sent.
 *
 * The oldest survives, so its number is the one that has been quoted for longest and the
 * one Mercium will see. One merge per approval: with this on, a site never reaches two
 * waiting orders in the first place, and a pile that predates it is the manual offer's job.
 */
export async function mergeIntoWaitingOrder(
  db: Database,
  { orderId, actor, actorRole, merciumOrderFee, passOrderFeeToFranchise }: {
    orderId: number; actor: string; actorRole: Role
    merciumOrderFee: number; passOrderFeeToFranchise: boolean
  },
): Promise<AutoMergeOutcome> {
  const order = await orderById(db, orderId)
  if (!order) return { kind: 'nothing_to_join' }

  // awaitingSend is already the right set -- approved or post_failed, nothing with a
  // Mintsoft id -- and already oldest first.
  const waiting = (await awaitingSend(db))
    .filter((o) => o.siteId === order.siteId && o.id !== orderId)
  const keep = waiting[0]
  if (!keep) return { kind: 'nothing_to_join' }

  try {
    const merged = await mergeApprovedOrders(db, {
      keepId: keep.id, mergeId: orderId, actor, actorRole,
      // The fee already snapshotted on the surviving order, not today's setting. Prices
      // here are fixed at sign-off and never re-read live.
      recomputeTotals: (combined) => {
        const totals = rechargeTotals(combined, {
          recharge: keep.recharge,
          // The fee snapshotted on the surviving order when it was signed off. Falling
          // back to the live setting only where there is no snapshot to honour, which on
          // a corporate order means the figure is discarded anyway.
          orderFee: keep.recharge ? (keep.orderFee ?? merciumOrderFee) : merciumOrderFee,
          passOrderFeeToFranchise: keep.recharge ? keep.orderFee !== null : passOrderFeeToFranchise,
        })
        return { total: totals?.total ?? null, orderFee: totals?.orderFee ?? null }
      },
      checkCombined: (combined) => combinedStockRefusal(db, combined),
    })
    return { kind: 'merged', into: keep.orderNumber, merged }
  } catch (err) {
    // A guard refusing is a normal outcome here, not a failed approval. Anything else is
    // a real fault and belongs upstairs.
    if (err instanceof OrderError) {
      return { kind: 'held_back', otherOrderNumber: keep.orderNumber, reason: err.message }
    }
    throw err
  }
}

/**
 * The one place that decides whether anything may be written to Mintsoft.
 *
 * The brief's hard rule: no write unless MINTSOFT_WRITES_ENABLED is true AND the order
 * has been approved by a user holding the approver role. Both conditions, checked in
 * one function, so there is a single thing to audit and a single thing to test.
 *
 * Nothing else in the codebase may call the Mintsoft order-create endpoint. This is
 * not a convention: the posting code takes its permission from here, and refuses
 * without it.
 */
import { canApprove } from '../db/types.ts'
import type { OrderStatus, Role } from '../db/types.ts'

export interface WriteDecision {
  allowed: boolean
  /** Plain English, suitable for the sync health screen and the audit trail. */
  reason: string
}

export interface OrderForWrite {
  id: number
  orderNumber: string
  status: OrderStatus
  /** Who signed it off, and what role they held at the time. */
  approvedByRole: Role | null
  approvedAt: string | null
  mintsoftOrderId: number | null
  /** When the order was handed to the warehouse, by whichever route. */
  postedAt?: string | null
}

/**
 * Does a valid sign-off stand behind this order?
 *
 * Split out of mayWriteToMintsoft because the second warehouse has no Mintsoft and no
 * API, so an order for it is fulfilled by emailing a pick list. MINTSOFT_WRITES_ENABLED
 * has nothing to say about that -- there is no Mintsoft write to enable -- but every
 * other condition applies with exactly the same force: sending a picker a list of stock
 * to pull off a shelf is as outward-facing and as hard to take back as creating an order
 * at Mercium. So the sign-off rules live here, in one place, and each route adds what is
 * specific to it. Nothing may send on a weaker test than this one.
 */
export function signOffStands(order: OrderForWrite): WriteDecision {
  // post_failed is an approved order whose send stopped -- Mintsoft refused it, or a
  // check before the send did. The approval still stands (approvedByRole and approvedAt
  // are checked below exactly as for 'approved'), and the awaiting-send list has always
  // offered these for retry; the gate used to refuse them anyway, which left "Only an
  // approved order may be sent. X is post_failed" as the only way out of the first
  // real send's failure. Anything that actually reached Mintsoft carries an id and is
  // refused by the caller.
  if (order.status !== 'approved' && order.status !== 'post_failed') {
    return {
      allowed: false,
      reason: `Only an approved order may be sent. ${order.orderNumber} is ${order.status}.`,
    }
  }

  // Status alone is not enough. An order could reach 'approved' through a bug or a
  // direct database edit; the sign-off has to be attributable to someone who held a
  // role entitled to give it. canApprove is the single definition of that set.
  if (!canApprove(order.approvedByRole)) {
    return {
      allowed: false,
      reason: order.approvedByRole === null
        ? `${order.orderNumber} is marked approved but nobody is recorded as approving it.`
        : `${order.orderNumber} was approved by a ${order.approvedByRole}, who may not sign off an order.`,
    }
  }

  if (!order.approvedAt) {
    return { allowed: false, reason: `${order.orderNumber} has no approval timestamp.` }
  }

  return { allowed: true, reason: `${order.orderNumber} is approved.` }
}

/**
 * May this order's pick list be emailed to the other warehouse?
 *
 * The same sign-off test as a Mintsoft write, minus the flag that governs Mintsoft, plus
 * the one thing that stands in for "already in Mintsoft as order N" on a route that
 * issues no order id: posted_at. Without that check a second press would email a second
 * pick list, and two identical pick lists a day apart is how a site ends up with twice
 * the stock and no record of why.
 */
export function mayEmailToWarehouse(order: OrderForWrite): WriteDecision {
  /**
   * Asked FIRST, ahead of the status test, purely so the answer is the useful one.
   *
   * A sent order is 'posted', so signOffStands would refuse it with "only an approved
   * order may be sent -- this is posted", which is true and tells the approver nothing
   * about what they should do. Naming the hand-off and its date answers the question they
   * actually have, which is whether the warehouse already knows.
   */
  if (order.postedAt) {
    return {
      allowed: false,
      reason: `${order.orderNumber} was already sent to the warehouse on ${order.postedAt}.`,
    }
  }

  const signOff = signOffStands(order)
  if (!signOff.allowed) return signOff

  return { allowed: true, reason: `${order.orderNumber} is approved and cleared to email.` }
}

/**
 * May this order be sent to Mintsoft?
 *
 * Deliberately returns a reason on refusal rather than just false: every refusal is
 * recorded, and "the flag is off" and "nobody approved this" need to be tellable apart
 * when someone asks why an order did not go.
 */
export function mayWriteToMintsoft(
  order: OrderForWrite,
  { writesEnabled }: { writesEnabled: boolean },
): WriteDecision {
  // The flag first: when writes are off, nothing else matters and the reason should
  // say so rather than naming some other objection the operator would then chase.
  if (!writesEnabled) {
    return { allowed: false, reason: 'Writes to Mintsoft are switched off (MINTSOFT_WRITES_ENABLED is not true).' }
  }

  const signOff = signOffStands(order)
  if (!signOff.allowed) return signOff

  // Already posted. Not an error, but not a reason to post again either.
  if (order.mintsoftOrderId !== null) {
    return {
      allowed: false,
      reason: `${order.orderNumber} is already in Mintsoft as order ${order.mintsoftOrderId}.`,
    }
  }

  return { allowed: true, reason: `${order.orderNumber} is approved and cleared to send.` }
}

/** Reads the flag the way the rest of the code should: strictly, and defaulting to off. */
export const writesEnabled = (raw: string | undefined): boolean => raw === 'true'

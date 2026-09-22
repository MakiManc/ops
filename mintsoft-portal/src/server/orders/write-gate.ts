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

  if (order.status !== 'approved') {
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

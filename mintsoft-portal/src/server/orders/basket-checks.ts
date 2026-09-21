/**
 * The checks a request has to pass before a GM can submit it.
 *
 * Mercium bills per order, so fewer and fuller orders is a design goal rather than a
 * preference. Most of these rules exist to serve that, and the rest exist to stop a
 * site ordering stock that is not there.
 *
 * Each check is either BLOCKING (the request cannot be submitted) or NEEDS A REASON
 * (it can, but the GM types why and the approver sees it). Nothing here is a silent
 * warning: a rule worth having is worth showing.
 */

export type CheckSeverity = 'blocks' | 'needs_reason' | 'note'

export interface BasketCheck {
  code: string
  severity: CheckSeverity
  /** Written for a GM on a phone, not for a developer. */
  message: string
  productId?: number
}

export interface BasketLine {
  productId: number
  productName: string
  qty: number
  /** Null means unknown, which is not the same as none. */
  available: number | null
  parLevel: number | null
  maxPerOrder: number | null
  /** Already sitting on this site's open request, if any. */
  qtyAlreadyInOpenRequest: number | null
}

export interface BasketContext {
  siteName: string
  /** When this site last had an order approved, for the minimum-gap rule. */
  lastOrderAt: string | null
  minDaysBetweenOrders: number
  /** What the GM typed to justify ordering inside the gap, if anything. */
  earlyOrderReason: string | null
  now: Date
}

const days = (from: string, to: Date) =>
  Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000)

/**
 * Checks one basket.
 *
 * Returns everything wrong at once rather than the first problem: a GM adjusting a
 * basket on a phone should see the whole picture, not discover a new objection after
 * each fix.
 */
export function checkBasket(lines: BasketLine[], context: BasketContext): BasketCheck[] {
  const checks: BasketCheck[] = []

  if (lines.length === 0) {
    checks.push({ code: 'empty', severity: 'blocks', message: 'There is nothing in this request yet.' })
  }

  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      checks.push({
        code: 'bad_qty', severity: 'blocks', productId: line.productId,
        message: `Enter how many ${line.productName} you need.`,
      })
      continue
    }

    // Over what is actually there. Blocking, because the warehouse cannot fill it.
    if (line.available !== null && line.qty > line.available) {
      checks.push({
        code: 'over_available', severity: 'blocks', productId: line.productId,
        message: `Only ${line.available} ${line.productName} available — you have asked for ${line.qty}.`,
      })
    }

    // Unknown stock is not a block: the approver re-checks against live stock at
    // sign-off anyway, and refusing to let a GM ask for something because our cache is
    // stale would be the portal's problem becoming theirs.
    if (line.available === null) {
      checks.push({
        code: 'unknown_stock', severity: 'note', productId: line.productId,
        message: `We do not currently know how many ${line.productName} are in stock. ` +
          'You can still ask for it, and it will be checked before sign-off.',
      })
    }

    if (line.maxPerOrder !== null && line.qty > line.maxPerOrder) {
      checks.push({
        code: 'over_max', severity: 'needs_reason', productId: line.productId,
        message: `${line.productName} is normally capped at ${line.maxPerOrder} per order and you have asked for ${line.qty}.`,
      })
    }

    if (line.parLevel !== null && line.parLevel > 0 && line.qty > line.parLevel) {
      checks.push({
        code: 'over_par', severity: 'needs_reason', productId: line.productId,
        message: `${line.productName} is above this site's usual level of ${line.parLevel}.`,
      })
    }

    if (line.qtyAlreadyInOpenRequest !== null && line.qtyAlreadyInOpenRequest > 0) {
      checks.push({
        code: 'already_requested', severity: 'note', productId: line.productId,
        message: `${line.qtyAlreadyInOpenRequest} ${line.productName} ${line.qtyAlreadyInOpenRequest === 1 ? 'is' : 'are'} already on this site's open request.`,
      })
    }
  }

  // The minimum gap. Mercium charges for every order, so ordering again inside the gap
  // costs money that a fuller single order would not.
  if (context.lastOrderAt && context.minDaysBetweenOrders > 0) {
    const since = days(context.lastOrderAt, context.now)
    if (since < context.minDaysBetweenOrders) {
      const wait = context.minDaysBetweenOrders - since
      checks.push({
        code: 'too_soon',
        severity: context.earlyOrderReason?.trim() ? 'note' : 'needs_reason',
        message: context.earlyOrderReason?.trim()
          ? `Ordering ${since} day${since === 1 ? '' : 's'} after the last one. Reason given, and the approver will see it.`
          : `${context.siteName} ordered ${since} day${since === 1 ? '' : 's'} ago, and orders are normally ` +
            `${context.minDaysBetweenOrders} days apart. Each order costs a delivery fee, so say why this one cannot wait ` +
            `${wait} more day${wait === 1 ? '' : 's'}.`,
      })
    }
  }

  return checks
}

export const blocksSubmission = (checks: BasketCheck[]): boolean =>
  checks.some((c) => c.severity === 'blocks' || c.severity === 'needs_reason')

export const blockingReasons = (checks: BasketCheck[]): string[] =>
  checks.filter((c) => c.severity === 'blocks' || c.severity === 'needs_reason').map((c) => c.message)

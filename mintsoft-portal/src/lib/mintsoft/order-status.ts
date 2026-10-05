/**
 * Mintsoft's own order statuses, by id.
 *
 * From /api/Order/Statuses, captured in Phase 0 (discovery/order_statuses.json). Held as
 * a constant rather than read per sync: the list is an enum that has not moved, and the
 * alternative is an extra API call every quarter of an hour to learn the same 23 words.
 *
 * The portal keeps its own lifecycle separately. This is Mercium's answer, and the point
 * of having it is that the two can disagree -- on 2026-10-05 the portal said two orders
 * were being picked when Mintsoft had one CANCELLED and one ONBACKORDER.
 */
export const MINTSOFT_ORDER_STATUS: Record<number, string> = {
  1: 'New', 2: 'Printed', 3: 'Cancelled', 4: 'Despatched', 5: 'Invoiced',
  6: 'Invoice failed', 7: 'Holding', 8: 'Failed', 9: 'On back order',
  10: 'Awaiting confirmation', 11: 'Awaiting documentation', 12: 'Awaiting payment',
  13: 'Query raised', 14: 'Pack and hold', 15: 'Awaiting picking', 16: 'Picking started',
  17: 'Picked', 18: 'Fraud risk', 19: 'Picking skipped', 20: 'Packed',
  21: 'Awaiting replen', 22: 'Processing', 23: 'Rebinned',
}

/**
 * Statuses a person needs to do something about.
 *
 * Not "anything that is not Despatched": an order sitting at New or Picked is simply on
 * its way through and saying so every time would train people to ignore the thing. These
 * are the ones where the order has stopped, or stopped being an order.
 */
export const MINTSOFT_STATUS_NEEDS_ATTENTION = new Set([
  3,   // Cancelled -- at Mercium's end, and the portal would still say "being picked"
  7,   // Holding
  8,   // Failed
  9,   // On back order -- Mercium cannot fill it
  13,  // Query raised -- Mercium are asking us something
  18,  // Fraud risk
  21,  // Awaiting replen -- waiting on stock that has not landed
])

export const mintsoftStatusName = (id: number | null): string | null =>
  id === null ? null : MINTSOFT_ORDER_STATUS[id] ?? `Status ${id}`

export const mintsoftStatusNeedsAttention = (id: number | null): boolean =>
  id !== null && MINTSOFT_STATUS_NEEDS_ATTENTION.has(id)

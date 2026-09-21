/**
 * What happens when an approver signs an order off.
 *
 * Phase 0 made this the load-bearing check rather than a formality. Mintsoft has no
 * soft-reservation concept: between two sites asking for the same bowls, it keeps
 * reporting the stock as free to both, and the portal is the only thing that knows one
 * of them already asked. So the stock is re-read here, against live figures, for every
 * line — whatever the basket said when the GM submitted it.
 *
 * Orders are placed against the primary SKU first. When one mapped line cannot cover a
 * quantity but the product as a whole can, the line is split across the other mapped
 * SKUs rather than failing — the duplicates exist precisely because stock arrived in
 * separate shipments, so a split is the normal case, not an exception.
 */

export interface MappedSku {
  mintsoftProductId: number
  sku: string
  isPrimary: boolean
  /** Live availability for this SKU. Null means unknown. */
  available: number | null
}

export interface LineToApprove {
  productId: number
  productName: string
  qtyApproved: number
  skus: MappedSku[]
  /** Snapshotted onto the line at approval. Null blocks a recharge order. */
  rechargeUnitPrice: number | null
}

export type LineAllocation =
  | { kind: 'allocated'; productId: number; parts: { sku: string; qty: number }[] }
  | { kind: 'short'; productId: number; productName: string; wanted: number; found: number | null; message: string }

/**
 * Works out which SKUs an approved line is ordered against.
 *
 * Fills from the primary first, then the others, largest first — using the biggest
 * remaining holdings keeps the number of separate lines down, which keeps the pick
 * simple at Mercium's end.
 */
export function allocateLine(line: LineToApprove): LineAllocation {
  if (line.skus.length === 0) {
    return {
      kind: 'short', productId: line.productId, productName: line.productName,
      wanted: line.qtyApproved, found: null,
      message: `${line.productName} is not mapped to any warehouse line, so it cannot be ordered.`,
    }
  }

  // An unknown figure on any mapped SKU makes the total unknowable, and approving
  // against an unknown total is how an order gets sent that cannot be filled.
  if (line.skus.some((s) => s.available === null)) {
    return {
      kind: 'short', productId: line.productId, productName: line.productName,
      wanted: line.qtyApproved, found: null,
      message: `Stock for ${line.productName} could not be read just now, so it cannot be approved yet. ` +
        'Try again once the next sync has run.',
    }
  }

  const total = line.skus.reduce((n, s) => n + (s.available ?? 0), 0)
  if (total < line.qtyApproved) {
    return {
      kind: 'short', productId: line.productId, productName: line.productName,
      wanted: line.qtyApproved, found: total,
      message: `${line.productName}: ${line.qtyApproved} approved but only ${total} in stock — ` +
        `${line.qtyApproved - total} short.`,
    }
  }

  const ordered = [...line.skus].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return (b.available ?? 0) - (a.available ?? 0)
  })

  const parts: { sku: string; qty: number }[] = []
  let remaining = line.qtyApproved
  for (const sku of ordered) {
    if (remaining <= 0) break
    const take = Math.min(remaining, sku.available ?? 0)
    if (take > 0) {
      parts.push({ sku: sku.sku, qty: take })
      remaining -= take
    }
  }

  return { kind: 'allocated', productId: line.productId, parts }
}

export interface ApprovalCheck {
  /** Whether the order can be approved at all. */
  ok: boolean
  allocations: LineAllocation[]
  /** Everything standing in the way, in words an approver can act on. */
  problems: string[]
  /** Lines whose quantity had to be split across more than one warehouse line. */
  splits: { productName: string; parts: { sku: string; qty: number }[] }[]
}

export interface RechargeContext {
  /** Franchise sites are recharged; corporate sites never are. */
  recharge: boolean
  orderFee: number
  passOrderFeeToFranchise: boolean
}

export interface RechargeTotals {
  lineTotal: number
  orderFee: number
  total: number
}

/**
 * Re-checks an order at sign-off and works out how it will be placed.
 *
 * Returns everything wrong at once. An approver working through a queue should see the
 * whole problem with an order, not fix one line and meet the next objection.
 */
export function checkApproval(lines: LineToApprove[], recharge: RechargeContext): ApprovalCheck {
  const allocations = lines.map(allocateLine)
  const problems = allocations
    .filter((a): a is Extract<LineAllocation, { kind: 'short' }> => a.kind === 'short')
    .map((a) => a.message)

  // A recharge order with an unpriced line would invoice a franchisee nothing for it.
  // Better to block and have someone set the price than to silently recharge at zero.
  if (recharge.recharge) {
    for (const line of lines) {
      if (line.rechargeUnitPrice === null) {
        problems.push(
          `${line.productName} has no recharge price set, and this site's orders are recharged. ` +
          'Set a price before approving, or remove the line.',
        )
      }
    }
  }

  const splits = allocations
    .filter((a): a is Extract<LineAllocation, { kind: 'allocated' }> => a.kind === 'allocated')
    .filter((a) => a.parts.length > 1)
    .map((a) => ({
      productName: lines.find((l) => l.productId === a.productId)?.productName ?? 'Unknown',
      parts: a.parts,
    }))

  return { ok: problems.length === 0, allocations, problems, splits }
}

/**
 * What a franchise site will be charged.
 *
 * Prices are snapshotted onto the line at approval, so a later price change never
 * alters what was invoiced for an order already placed.
 */
export function rechargeTotals(lines: LineToApprove[], context: RechargeContext): RechargeTotals | null {
  if (!context.recharge) return null   // corporate sites are never recharged

  const lineTotal = lines.reduce((sum, l) => sum + l.qtyApproved * (l.rechargeUnitPrice ?? 0), 0)
  const orderFee = context.passOrderFeeToFranchise ? context.orderFee : 0
  return {
    lineTotal: Math.round(lineTotal * 100) / 100,
    orderFee: Math.round(orderFee * 100) / 100,
    total: Math.round((lineTotal + orderFee) * 100) / 100,
  }
}

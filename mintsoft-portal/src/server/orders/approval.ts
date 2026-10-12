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
 *
 * A mapped line Mintsoft has no stock figure for does not block this on its own. It used
 * to, and that was the "Tea cups" bug: the catalogue reports a FLOOR when only some of a
 * product's lines can be read (sync/availability.ts rule 3, added in dae73f1), so a GM
 * saw "at least 577 free to order, from 7 of the 8 Mintsoft lines" and asked for 30 — and
 * this function refused the whole order because the eighth line read null. Seven lines
 * holding 577 between them can plainly cover 30, and an unreadable line can only ADD to a
 * total, never subtract from it. So the question is not "is every line readable" but "can
 * the readable ones cover what was approved".
 *
 * The refusal that remains is the one that is actually undecidable: the readable lines
 * cannot cover the quantity and there is an unreadable line that might have made up the
 * difference. That is a real wall, and it is worth being honest that no sync will move it
 * — the only way a line has no figure here is that it is absent from Mintsoft's stock feed
 * altogether, which is a mapping problem rather than a timing one.
 */
export function allocateLine(line: LineToApprove): LineAllocation {
  if (line.skus.length === 0) {
    return {
      kind: 'short', productId: line.productId, productName: line.productName,
      wanted: line.qtyApproved, found: null,
      message: `${line.productName} is not mapped to any warehouse line, so it cannot be ordered.`,
    }
  }

  // Nothing is being ordered, so there is no stock question to answer. This is also the
  // approver's way out of a product the warehouse cannot account for: zero the line and
  // the rest of the order goes. An order where EVERY line ends up at zero is caught at
  // send with its own message, so this cannot quietly despatch an empty order.
  if (line.qtyApproved === 0) {
    return { kind: 'allocated', productId: line.productId, parts: [] }
  }

  const readable = line.skus.filter((s) => s.available !== null)
  const unreadable = line.skus.length - readable.length
  const floor = readable.reduce((n, s) => n + (s.available ?? 0), 0)

  // No readable line at all means there is no floor, and a floor is the only thing that
  // could have justified going ahead. Same rule as availability.ts: a partial answer
  // beats no answer, but no answer is still no answer.
  if (readable.length === 0) {
    return {
      kind: 'short', productId: line.productId, productName: line.productName,
      wanted: line.qtyApproved, found: null,
      message: `${line.productName}: Mintsoft has no stock figure for `
        + `${line.skus.length === 1 ? 'the warehouse line' : `any of the ${line.skus.length} warehouse lines`} `
        + 'mapped to this product, so there is nothing to order against. Those lines are missing '
        + 'from the stock feed rather than out of date, so a sync will not fill them in — the '
        + 'mapping needs looking at.',
    }
  }

  if (floor < line.qtyApproved) {
    return {
      kind: 'short', productId: line.productId, productName: line.productName,
      wanted: line.qtyApproved, found: floor,
      message: unreadable === 0
        ? `${line.productName}: ${line.qtyApproved} approved but only ${floor} in stock — `
          + `${line.qtyApproved - floor} short.`
        // The shortfall is real but the total is a floor, so this does not claim the
        // warehouse is short — only that we cannot see enough to sign it off.
        : `${line.productName}: ${line.qtyApproved} approved but only ${floor} can be accounted for. `
          + `${unreadable} of its ${line.skus.length} warehouse lines ${unreadable === 1 ? 'is' : 'are'} `
          + 'missing from Mintsoft’s stock feed, so there may be more on the shelf that we cannot '
          + `see, and a sync will not fix that. Approve ${floor} or fewer, or get the mapping looked at.`,
    }
  }

  // Readable lines only. An unreadable one contributes nothing to the fill loop below in
  // any case (`s.available ?? 0` is 0, and a zero take is skipped), but leaving it out
  // here says so explicitly rather than relying on that.
  const ordered = [...readable].sort((a, b) => {
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
export function rechargeTotals(
  // Only the two fields it actually prices, so the same maths can be applied to a set of
  // already-approved lines -- which is what merging two signed-off orders needs.
  lines: Pick<LineToApprove, 'qtyApproved' | 'rechargeUnitPrice'>[],
  context: RechargeContext,
): RechargeTotals | null {
  if (!context.recharge) return null   // corporate sites are never recharged

  const lineTotal = lines.reduce((sum, l) => sum + l.qtyApproved * (l.rechargeUnitPrice ?? 0), 0)
  const orderFee = context.passOrderFeeToFranchise ? context.orderFee : 0
  return {
    lineTotal: Math.round(lineTotal * 100) / 100,
    orderFee: Math.round(orderFee * 100) / 100,
    total: Math.round((lineTotal + orderFee) * 100) / 100,
  }
}

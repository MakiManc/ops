/**
 * Working out what a site can actually order.
 *
 * Phase 0 established that Mintsoft publishes no availability figure anywhere in its
 * API. It gives OnHand, Allocated and StockLevel, and which of those means "free to
 * order" is not stated. The live run settled it — OnHand, with allocations already
 * deducted — but the figure still has to be derived, explained, and withheld when the
 * inputs genuinely do not support one.
 *
 * Four rules, all of them from discovery:
 *
 *   1. UNKNOWN IS NOT ZERO. If an input is missing, the answer is null, not 0. A GM
 *      seeing "0" stops ordering; a GM seeing "—" asks. Only one of those is honest
 *      when we genuinely do not know.
 *   2. SUM ACROSS LOCATIONS. Mintsoft's inventory feed carries a LocationId, so one
 *      product may arrive on several rows. Reading one row would show a single bin's
 *      stock as the whole holding.
 *   3. A PARTIAL ANSWER BEATS NO ANSWER, IF IT IS LABELLED. When a product is mapped to
 *      several Mintsoft lines and only some can be read, the total is the sum of those,
 *      presented as a floor. Mercium re-creates a product per shipment, so a popular
 *      item has seven or eight lines; one missing inventory record used to blank the
 *      whole product, which on screen is indistinguishable from a broken feed and stops
 *      a site ordering something we plainly hold. Understating is the safe direction —
 *      a site can only order against the floor — provided the basis says it is one.
 *      Rule 1 still governs the case where NOTHING can be read: no floor, no number.
 *   4. EXPLAIN THE NUMBER. Every figure carries a basis string, so anyone looking at a
 *      surprising number on screen can see what it was worked out from.
 */

/**
 * Which formula to use. Settled by discovery on 2026-09-21: 'on_hand' is correct, and
 * is the default. The other two remain selectable so the decision is reversible, but a
 * live read of all 334 Witham products showed both of them to be unsafe.
 *
 * Mintsoft's field names invite exactly the wrong reading. Across every product, with
 * no exceptions, StockLevel == OnHand + Allocated. So OnHand is what is FREE — Mintsoft
 * has already taken the allocations off — and StockLevel is the gross figure that still
 * includes them. Deducting Allocated from OnHand takes it off twice.
 */
export type AvailableFormula = 'on_hand' | 'on_hand_minus_allocated' | 'stock_level'

/** One row from Mintsoft's inventory feed, already narrowed to what we use. */
export interface StockRow {
  onHand?: number | null
  allocated?: number | null
  stockLevel?: number | null
}

export interface Availability {
  /** What a site may order. Null means unknown, and must render as an em dash. */
  available: number | null
  /** On-hand total across locations, or null if any location's figure is missing. */
  onHand: number | null
  /** Allocated total across locations, or null if any is missing. */
  allocated: number | null
  /** Plain English: how this number was arrived at, or why there isn't one. */
  basis: string
  /**
   * True when allocations exceed stock on hand. `available` is floored at zero — you
   * cannot order from a negative — but the position is real and the stock overview
   * should show it rather than round it away.
   */
  oversold: boolean
  /** How many inventory rows contributed, so "one bin" and "all of them" differ on screen. */
  rowsSeen: number
  /**
   * Mapped Mintsoft lines that could not be read — absent from the stock feed, or
   * present without a usable figure.
   *
   * When this is above zero and `available` is a number, that number is a FLOOR: at
   * least this much exists, possibly more. Understating is the safe direction, since a
   * site orders against it, but the screen has to say so rather than present a partial
   * total as a complete one.
   */
  linesUnknown: number
}

const UNKNOWN = (basis: string, rowsSeen: number, linesUnknown = 0): Availability =>
  ({ available: null, onHand: null, allocated: null, basis, oversold: false, rowsSeen, linesUnknown })

/**
 * Totals one field across a product's rows.
 *
 * Returns null if ANY row is missing the field. That is deliberate and worth being
 * clear about: if one of three locations does not report its count, the true total is
 * unknowable, and adding up the two we did get would produce a confident undercount.
 * A number that is quietly too low is worse than no number, because it gets ordered
 * against.
 */
function total(rows: StockRow[], field: keyof StockRow): number | null {
  let sum = 0
  for (const row of rows) {
    const value = row[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    sum += value
  }
  return sum
}

export function deriveAvailability(rows: StockRow[], formula: AvailableFormula): Availability {
  if (rows.length === 0) {
    // Absent from the feed is not the same as none in stock. Mintsoft's own docs warn
    // that products without an inventory record simply do not appear.
    return UNKNOWN('Not in the latest stock feed, so the level is unknown.', 0)
  }

  if (formula === 'stock_level') {
    const stockLevel = total(rows, 'stockLevel')
    if (stockLevel === null) {
      return UNKNOWN('Mintsoft did not report a stock level for every location.', rows.length)
    }
    return {
      available: Math.max(0, stockLevel),
      onHand: null,
      allocated: null,
      basis: rows.length === 1
        ? `Mintsoft reports ${stockLevel} free to order.`
        : `Mintsoft reports ${stockLevel} free to order, across ${rows.length} locations.`,
      oversold: stockLevel < 0,
      rowsSeen: rows.length,
      linesUnknown: 0,
    }
  }

  const onHand = total(rows, 'onHand')
  const allocated = total(rows, 'allocated')

  if (formula === 'on_hand') {
    if (onHand === null) {
      return UNKNOWN('Mintsoft did not report stock on hand for every location.', rows.length)
    }
    // Allocated is reported alongside, and worth showing, but it is NOT subtracted:
    // Mintsoft has already done that. It is carried here so the stock overview can say
    // "40 free, 300 spoken for" rather than leaving the difference unexplained.
    const across = rows.length === 1 ? '' : ` across ${rows.length} locations`
    return {
      available: Math.max(0, onHand),
      onHand,
      allocated,
      basis: allocated
        ? `${onHand} free to order${across}, with ${allocated} more held but already allocated.`
        : `${onHand} free to order${across}.`,
      // A negative OnHand would mean Mintsoft itself is reporting an impossible
      // position, which is worth surfacing rather than hiding behind the floor.
      oversold: onHand < 0,
      rowsSeen: rows.length,
      linesUnknown: 0,
    }
  }

  if (onHand === null && allocated === null) {
    return UNKNOWN('Mintsoft reported neither stock on hand nor allocations.', rows.length)
  }
  if (onHand === null) {
    return UNKNOWN('Mintsoft did not report stock on hand for every location.', rows.length)
  }
  if (allocated === null) {
    // We know what is in the building but not what is already promised, so we cannot
    // say what is free — and guessing "all of it" would oversell.
    return { ...UNKNOWN('Stock on hand is known, but allocations are not, so what is free cannot be worked out.', rows.length), onHand }
  }

  const free = onHand - allocated
  const across = rows.length === 1 ? '' : ` across ${rows.length} locations`
  return {
    available: Math.max(0, free),
    onHand,
    allocated,
    basis: free < 0
      ? `${onHand} on hand${across} with ${allocated} already allocated — more is allocated than is held.`
      : `${onHand} on hand${across} less ${allocated} allocated.`,
    oversold: free < 0,
    rowsSeen: rows.length,
    linesUnknown: 0,
  }
}

/**
 * Availability for a Maki product, which may map to several Mintsoft lines.
 *
 * Mapping many Mintsoft lines to one product is how the duplicates from past shipments
 * are hidden from GMs, so a product's stock is the sum of its mapped lines. If any one
 * line's figure is unknown, the product's total is unknown for the same reason a
 * missing location makes a line unknown.
 */
export function combineMappedLines(
  perLine: Availability[],
  { linesMissingFromFeed = 0 }: { linesMissingFromFeed?: number } = {},
): Availability {
  const totalLines = perLine.length + linesMissingFromFeed
  if (totalLines === 0) {
    return UNKNOWN('This product is not mapped to anything in Mintsoft yet.', 0)
  }

  const rowsSeen = perLine.reduce((n, a) => n + a.rowsSeen, 0)
  const known = perLine.filter((a) => a.available !== null)
  const linesUnknown = totalLines - known.length

  // Nothing readable at all. There is no floor to report, so this stays unknown.
  if (known.length === 0) {
    return UNKNOWN(
      totalLines === 1
        ? 'Mintsoft has no stock record for this product, so its level is unknown.'
        : `None of the ${totalLines} Mintsoft lines for this product reported a stock level, ` +
          'so the total is unknown.',
      rowsSeen,
      linesUnknown,
    )
  }

  // Some lines read, some did not. Sum what is known and say so.
  //
  // This is deliberately a floor rather than a refusal. A product mapped to seven
  // shipment lines, six of which report and one of which Mintsoft has no record for,
  // genuinely holds at least the six. Blanking the whole product to "—" because of the
  // seventh reads as a broken screen and stops a site ordering something we plainly
  // have. Understating is the safe direction — a site can only order against the floor
  // — so long as the screen is honest that it IS a floor.
  const available = known.reduce((n, a) => n + (a.available ?? 0), 0)

  // A total is only worth showing when every line that contributed reported it, and
  // only when nothing is missing entirely — otherwise "40 on hand" invites subtraction
  // against a number that is not the whole picture.
  const sumOrNull = (field: 'onHand' | 'allocated') =>
    linesUnknown > 0 || known.some((a) => a[field] === null)
      ? null
      : known.reduce((n, a) => n + (a[field] ?? 0), 0)

  const basis = linesUnknown === 0
    ? (perLine.length === 1
        ? perLine[0]!.basis
        : `${available} free to order, added up across ${perLine.length} Mintsoft lines for this product.`)
    : `At least ${available} free to order, from ${known.length} of the ${totalLines} Mintsoft ` +
      `lines for this product. ${linesUnknown === 1 ? 'The other line has' : `The other ${linesUnknown} lines have`} ` +
      'no stock record, so there may be more.'

  return {
    available,
    onHand: sumOrNull('onHand'),
    allocated: sumOrNull('allocated'),
    basis,
    oversold: known.some((a) => a.oversold),
    rowsSeen,
    linesUnknown,
  }
}


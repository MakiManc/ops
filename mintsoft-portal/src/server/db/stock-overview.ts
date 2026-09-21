/**
 * The stock overview an approver signs off against.
 *
 * Beyond what the catalogue shows, this adds the things that decide whether a request
 * should be approved: what other sites have already asked for, how long the stock will
 * last, and whether the underlying Mintsoft data is trustworthy for this product.
 */
import { combineMappedLines, deriveAvailability, type AvailableFormula, type StockRow } from '../sync/availability.ts'
import type { Database } from './repo.ts'

export interface StockOverviewItem {
  productId: number
  name: string
  category: string | null
  stockType: 'internal' | 'expansion'

  onHand: number | null
  allocated: number | null
  available: number | null
  availableBasis: string
  oversold: boolean
  stockSyncedAt: string | null

  /** Quantity already requested across all sites and not yet approved. */
  pendingDemand: number
  inboundQty: number | null
  inboundExpected: string | null

  /**
   * How long the stock will last at the recent rate, or null when we cannot say.
   * Null is the honest answer until there is enough order history to measure a rate.
   */
  weeksOfCover: number | null
  weeksOfCoverBasis: string

  mappedLines: number
  /** Things about this product's Mintsoft data that an approver should know. */
  flags: string[]
}

/** Weeks of history used to work out a consumption rate. */
const RATE_WINDOW_WEEKS = 12

export async function stockOverview(
  db: Database,
  formula: AvailableFormula,
  { now = new Date() }: { now?: Date } = {},
): Promise<StockOverviewItem[]> {
  const { results: products } = await db
    .prepare(
      `SELECT id, name, category, stock_type FROM products WHERE active = 1
        ORDER BY COALESCE(category, 'zzz'), name`,
    )
    .all<{ id: number; name: string; category: string | null; stock_type: 'internal' | 'expansion' }>()

  const { results: stock } = await db
    .prepare(
      `SELECT pmm.product_id, pmm.mintsoft_product_id, sc.on_hand, sc.allocated, sc.synced_at
         FROM product_mintsoft_map pmm
         JOIN stock_cache sc ON sc.mintsoft_product_id = pmm.mintsoft_product_id`,
    )
    .all<{ product_id: number; mintsoft_product_id: number; on_hand: number | null; allocated: number | null; synced_at: string }>()

  const { results: mapped } = await db
    .prepare(`SELECT product_id, COUNT(*) AS lines FROM product_mintsoft_map GROUP BY product_id`)
    .all<{ product_id: number; lines: number }>()

  // Requested but not yet signed off. Mintsoft knows nothing about this — it has no
  // soft-reservation concept — so it is ours to track and ours to show.
  const { results: pending } = await db
    .prepare(
      `SELECT ol.product_id, SUM(ol.qty_requested) AS qty
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id
        WHERE o.status = 'submitted'
        GROUP BY ol.product_id`,
    )
    .all<{ product_id: number; qty: number }>()

  const { results: inbound } = await db
    .prepare(
      `SELECT pmm.product_id, i.qty, i.expected_date
         FROM product_mintsoft_map pmm JOIN inbound i ON i.mintsoft_product_id = pmm.mintsoft_product_id
        WHERE i.qty IS NULL OR i.qty > 0`,
    )
    .all<{ product_id: number; qty: number | null; expected_date: string | null }>()

  // Consumption rate from what has actually been sent out, not from par levels — a par
  // level is an intention, and the question here is what really moves.
  const since = new Date(now.getTime() - RATE_WINDOW_WEEKS * 7 * 86_400_000)
    .toISOString().replace(/\.\d+Z$/, 'Z')
  const { results: usage } = await db
    .prepare(
      `SELECT ol.product_id,
              SUM(COALESCE(ol.qty_approved, ol.qty_requested)) AS qty,
              MIN(o.approved_at) AS first_at
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id
        WHERE o.status IN ('approved', 'posted', 'despatched') AND o.approved_at >= ?
        GROUP BY ol.product_id`,
    )
    .bind(since)
    .all<{ product_id: number; qty: number; first_at: string | null }>()

  const stockLines = new Map<number, Map<number, StockRow[]>>()
  const oldestSync = new Map<number, string>()
  for (const row of stock ?? []) {
    const lines = stockLines.get(row.product_id) ?? new Map<number, StockRow[]>()
    const rows = lines.get(row.mintsoft_product_id) ?? []
    rows.push({ onHand: row.on_hand, allocated: row.allocated })
    lines.set(row.mintsoft_product_id, rows)
    stockLines.set(row.product_id, lines)

    const current = oldestSync.get(row.product_id)
    if (!current || row.synced_at < current) oldestSync.set(row.product_id, row.synced_at)
  }

  const mappedCount = new Map((mapped ?? []).map((r) => [r.product_id, r.lines]))
  const pendingByProduct = new Map((pending ?? []).map((r) => [r.product_id, r.qty]))
  const usageByProduct = new Map((usage ?? []).map((r) => [r.product_id, r]))

  const inboundByProduct = new Map<number, { qty: number | null; expected: string | null }>()
  for (const row of inbound ?? []) {
    const current = inboundByProduct.get(row.product_id) ?? { qty: 0, expected: null }
    const qty = current.qty === null || row.qty === null ? null : current.qty + row.qty
    const expected = !current.expected || (row.expected_date && row.expected_date < current.expected)
      ? row.expected_date ?? current.expected
      : current.expected
    inboundByProduct.set(row.product_id, { qty, expected })
  }

  return (products ?? []).map((p) => {
    const lines = stockLines.get(p.id)
    const mappedLines = mappedCount.get(p.id) ?? 0
    const flags: string[] = []

    let availability
    if (mappedLines === 0) {
      availability = combineMappedLines([])
      flags.push('Not mapped to any Mintsoft line, so it cannot be ordered.')
    } else if (!lines || lines.size < mappedLines) {
      const missing = mappedLines - (lines?.size ?? 0)
      availability = {
        available: null, onHand: null, allocated: null, oversold: false,
        rowsSeen: lines ? [...lines.values()].flat().length : 0,
        basis: `${missing} of the ${mappedLines} mapped Mintsoft lines are missing from the stock feed.`,
      }
      flags.push(`${missing} mapped Mintsoft line(s) did not appear in the last stock sync.`)
    } else {
      availability = combineMappedLines([...lines.values()].map((rows) => deriveAvailability(rows, formula)))
    }

    if (mappedLines > 1) {
      flags.push(`${mappedLines} Mintsoft lines are combined into this product.`)
    }
    if (availability.oversold) {
      flags.push('More stock is allocated than is on hand.')
    }

    const pendingDemand = pendingByProduct.get(p.id) ?? 0
    const inb = inboundByProduct.get(p.id)

    // Weeks of cover, but only where the numbers support one.
    let weeksOfCover: number | null = null
    let weeksOfCoverBasis: string
    const rate = usageByProduct.get(p.id)
    if (availability.available === null) {
      weeksOfCoverBasis = 'Stock level is unknown, so cover cannot be worked out.'
    } else if (!rate || rate.qty <= 0) {
      // No history is not a rate of zero, which would read as infinite cover.
      weeksOfCoverBasis = `Nothing has been sent out in the last ${RATE_WINDOW_WEEKS} weeks, so there is no rate to measure against.`
    } else {
      const perWeek = rate.qty / RATE_WINDOW_WEEKS
      weeksOfCover = Math.round((availability.available / perWeek) * 10) / 10
      weeksOfCoverBasis =
        `${availability.available} in stock against ${rate.qty} sent out over ${RATE_WINDOW_WEEKS} weeks ` +
        `(about ${Math.round(perWeek * 10) / 10} a week).`
    }

    return {
      productId: p.id,
      name: p.name,
      category: p.category,
      stockType: p.stock_type,
      onHand: availability.onHand,
      allocated: availability.allocated,
      available: availability.available,
      availableBasis: availability.basis,
      oversold: availability.oversold,
      stockSyncedAt: oldestSync.get(p.id) ?? null,
      pendingDemand,
      inboundQty: inb?.qty ?? null,
      inboundExpected: inb?.expected ?? null,
      weeksOfCover,
      weeksOfCoverBasis,
      mappedLines,
      flags,
    }
  })
}

/** Mintsoft lines nobody has mapped, which is stock the portal cannot see. */
export async function unmappedLineCount(db: Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM mintsoft_products mp
        WHERE NOT EXISTS (SELECT 1 FROM product_mintsoft_map pmm
                           WHERE pmm.mintsoft_product_id = mp.mintsoft_product_id)`,
    )
    .first<{ n: number }>()
  return row?.n ?? 0
}

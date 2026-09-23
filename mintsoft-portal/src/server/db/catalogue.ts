/**
 * Reading the catalogue and the stock position.
 *
 * Stock is combined in TypeScript rather than SQL, deliberately. The rule that makes it
 * honest — a total is unknown if ANY contributing figure is unknown — is the opposite of
 * what SQL's SUM does, since SUM quietly skips NULLs and returns a confident undercount.
 * Rather than encode that inversion in every query, the rows are fetched and passed
 * through the availability module, which is tested against exactly these cases.
 */
import {
  combineMappedLines, deriveAvailability, type Availability, type AvailableFormula, type StockRow,
} from '../sync/availability.ts'
import type { Database } from './repo.ts'

export interface CatalogueItem {
  productId: number
  name: string
  category: string | null
  packSize: number | null
  unit: string | null
  imageUrl: string | null
  stockType: 'internal' | 'expansion'

  /** What the site may order. Null renders as an em dash, never as 0. */
  available: number | null
  availableBasis: string
  oversold: boolean

  /** Oldest reading that went into the figure, so the screen can show its age. */
  stockSyncedAt: string | null

  /** How many Mintsoft lines this one product hides. */
  mappedLines: number

  parLevel: number | null
  maxPerOrder: number | null

  /** Still on its way in, with the earliest date it is expected. */
  inboundQty: number | null
  inboundExpected: string | null

  /** Only ever populated for franchise sites; corporate sites never see a price. */
  rechargeUnitPrice: number | null
}

interface ProductRow {
  id: number
  name: string
  category: string | null
  pack_size: number | null
  unit: string | null
  image_url: string | null
  stock_type: 'internal' | 'expansion'
  recharge_unit_price: number | null
  par_level: number | null
  max_per_order: number | null
}

interface StockCacheRow {
  product_id: number
  mintsoft_product_id: number
  on_hand: number | null
  allocated: number | null
  synced_at: string
}

interface InboundRow {
  product_id: number
  qty: number | null
  expected_date: string | null
}

/**
 * The catalogue for one site.
 *
 * `showPrices` comes from the site's recharge flag, not from the caller — a corporate
 * site is never shown a price, and that is decided here rather than left to the screen.
 */
export async function catalogueForSite(
  db: Database,
  siteId: number,
  formula: AvailableFormula,
  { showPrices }: { showPrices: boolean },
): Promise<CatalogueItem[]> {
  const { results: products } = await db
    .prepare(
      `SELECT p.id, p.name, p.category, p.pack_size, p.unit, p.image_url, p.stock_type,
              p.recharge_unit_price, sp.par_level, sp.max_per_order
         FROM products p
         LEFT JOIN site_products sp ON sp.product_id = p.id AND sp.site_id = ?
        WHERE p.active = 1
        ORDER BY COALESCE(p.category, 'zzz'), p.name`,
    )
    .bind(siteId)
    .all<ProductRow>()

  // Every mapped line's stock rows, in one query rather than one per product.
  const { results: stock } = await db
    .prepare(
      `SELECT pmm.product_id, pmm.mintsoft_product_id, sc.on_hand, sc.allocated, sc.synced_at
         FROM product_mintsoft_map pmm
         JOIN stock_cache sc ON sc.mintsoft_product_id = pmm.mintsoft_product_id`,
    )
    .all<StockCacheRow>()

  const { results: mapped } = await db
    .prepare(`SELECT product_id, mintsoft_product_id FROM product_mintsoft_map`)
    .all<{ product_id: number; mintsoft_product_id: number }>()

  const { results: inbound } = await db
    .prepare(
      `SELECT pmm.product_id, i.qty, i.expected_date
         FROM product_mintsoft_map pmm
         JOIN inbound i ON i.mintsoft_product_id = pmm.mintsoft_product_id
        WHERE i.qty IS NULL OR i.qty > 0`,
    )
    .all<InboundRow>()

  // Group stock rows by product, then by Mintsoft line within it, because a line can
  // itself be split across warehouse locations.
  const linesByProduct = new Map<number, Map<number, StockRow[]>>()
  for (const row of stock ?? []) {
    const lines = linesByProduct.get(row.product_id) ?? new Map<number, StockRow[]>()
    const rows = lines.get(row.mintsoft_product_id) ?? []
    rows.push({ onHand: row.on_hand, allocated: row.allocated })
    lines.set(row.mintsoft_product_id, rows)
    linesByProduct.set(row.product_id, lines)
  }

  /**
   * When each product's figure was last READ, which is not the same as when its row was
   * last written.
   *
   * The stock sync no longer rewrites a product whose figures have not moved — doing so
   * cost tens of thousands of pointless writes a day and exhausted the database's daily
   * allowance, taking the whole portal down. So a row's synced_at now records when the
   * number last CHANGED, and using it here would tell a GM "stock read 6 hours ago"
   * about a figure confirmed four minutes ago. Every mapped product is read on every
   * run, so the last successful run is the honest answer for all of them.
   *
   * A product with no stock row at all still gets null: never read is not the same as
   * read and unchanged.
   */
  const lastRead = await db
    .prepare(`SELECT MAX(finished_at) AS at FROM sync_runs WHERE job = 'stock' AND status = 'ok'`)
    .first<{ at: string | null }>()

  const oldestSync = new Map<number, string>()
  for (const row of stock ?? []) {
    if (lastRead?.at) oldestSync.set(row.product_id, lastRead.at)
    else {
      const current = oldestSync.get(row.product_id)
      if (!current || row.synced_at < current) oldestSync.set(row.product_id, row.synced_at)
    }
  }

  const mappedCount = new Map<number, number>()
  for (const row of mapped ?? []) {
    mappedCount.set(row.product_id, (mappedCount.get(row.product_id) ?? 0) + 1)
  }

  const inboundByProduct = new Map<number, { qty: number | null; expected: string | null }>()
  for (const row of inbound ?? []) {
    const current = inboundByProduct.get(row.product_id) ?? { qty: 0, expected: null }
    // One unknown quantity makes the whole inbound figure unknown, same rule as stock.
    const qty = current.qty === null || row.qty === null ? null : current.qty + row.qty
    const expected = !current.expected || (row.expected_date && row.expected_date < current.expected)
      ? row.expected_date ?? current.expected
      : current.expected
    inboundByProduct.set(row.product_id, { qty, expected })
  }

  return (products ?? []).map((p) => {
    const lines = linesByProduct.get(p.id)
    const mappedLines = mappedCount.get(p.id) ?? 0

    let availability: Availability
    if (mappedLines === 0) {
      availability = combineMappedLines([])
    } else {
      // A mapped line can be absent from the stock feed entirely — Mintsoft simply has
      // no inventory record for it. combineMappedLines is told how many, so it can sum
      // the lines that did report and present the result as a floor.
      availability = combineMappedLines(
        [...(lines?.values() ?? [])].map((rows) => deriveAvailability(rows, formula)),
        { linesMissingFromFeed: mappedLines - (lines?.size ?? 0) },
      )
    }

    const inb = inboundByProduct.get(p.id)
    return {
      productId: p.id,
      name: p.name,
      category: p.category,
      packSize: p.pack_size,
      unit: p.unit,
      imageUrl: p.image_url,
      stockType: p.stock_type,
      available: availability.available,
      availableBasis: availability.basis,
      oversold: availability.oversold,
      stockSyncedAt: oldestSync.get(p.id) ?? null,
      mappedLines,
      parLevel: p.par_level,
      maxPerOrder: p.max_per_order,
      inboundQty: inb?.qty ?? null,
      inboundExpected: inb?.expected ?? null,
      rechargeUnitPrice: showPrices ? p.recharge_unit_price : null,
    }
  })
}

/**
 * A product's stock status, as a chip.
 *
 * Text as well as colour, never colour alone — the brief is explicit, and a red dot
 * beside a number means nothing to someone who cannot distinguish it from the green one.
 */
export type StockStatus = 'in_stock' | 'low' | 'out' | 'inbound' | 'unknown'

export function stockStatus(item: Pick<CatalogueItem, 'available' | 'parLevel' | 'inboundQty'>): StockStatus {
  // Unknown first: it outranks everything, because we cannot claim any of the others.
  if (item.available === null) return 'unknown'
  if (item.available > 0) {
    // "Low" only means something against a par level; without one there is no bar to be under.
    if (item.parLevel != null && item.parLevel > 0 && item.available < item.parLevel) return 'low'
    return 'in_stock'
  }
  // Out of stock. "Inbound" is a promise, so it is only made when we positively know
  // something is coming — an unknown inbound figure is not a reason to imply one.
  if (item.inboundQty !== null && item.inboundQty > 0) return 'inbound'
  return 'out'
}

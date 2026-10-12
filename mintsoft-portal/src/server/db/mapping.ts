/**
 * The mapping tool: turning Mintsoft's duplicate lines into one Maki product.
 *
 * Mintsoft's catalogue carries duplicates from the last seven to nine shipments — the
 * same bowl added afresh each time stock landed. We never merge or delete anything in
 * Mintsoft. Instead one Maki product points at many Mintsoft lines, their stock is
 * summed, and a GM sees one row.
 *
 * The suggestions here are only ever suggestions. Two lines that look identical can be
 * genuinely different items, so nothing is merged without someone choosing to.
 *
 * STOCK AWARENESS
 *
 * Three of Mintsoft's lines have no inventory record at all -- not zero, absent. Mapping
 * one into a product has consequences nobody could see from this screen: the product's
 * stock figure becomes a floor rather than a total, so it understates what the shelf
 * holds, and if the OTHER lines happen to hold nothing, every order for that product is
 * refused outright. That is how "Tea cups" came to be unorderable for three weeks with
 * 577 units sitting in Witham.
 *
 * So the lines carry their stock position here, and the tool says what mapping one will
 * do. It does not refuse: a line awaiting its first shipment legitimately has no record
 * yet, and this file's whole premise is that the person decides. It warns, it steers the
 * primary away from a line with no figure -- orders are placed against the primary first
 * -- and productsWithUnreadableLines surfaces the ones already mapped, because a guard
 * that only protects future mappings leaves today's three invisible.
 */
import { findDuplicates } from '../../lib/mintsoft/discovery-analysis.ts'
import type { Product } from '../../lib/mintsoft/types.ts'
import type { Database } from './repo.ts'

export interface MintsoftLine {
  mintsoftProductId: number
  sku: string
  name: string | null
  ean: string | null
  upc: string | null
  imageUrl: string | null
  discontinued: boolean | null
  syncedAt: string
  /** The Maki product this line already belongs to, if any. */
  mappedToProductId: number | null
  mappedToProductName: string | null
  /**
   * Whether Mintsoft holds an inventory record for this line at all.
   *
   * False is not "none in stock" -- it is "Mintsoft has never had a record of this", and
   * it is what makes a product's figure a floor once the line is mapped.
   */
  hasStockRecord: boolean
  /** Free to order on this line, or null when there is no usable figure. */
  available: number | null
}

interface LineRow {
  mintsoft_product_id: number
  sku: string
  name: string | null
  ean: string | null
  upc: string | null
  image_url: string | null
  discontinued: number | null
  synced_at: string
  product_id: number | null
  product_name: string | null
  stock_rows: number
  stock_rows_with_value: number
  stock_available: number | null
}

const toLine = (r: LineRow): MintsoftLine => ({
  mintsoftProductId: r.mintsoft_product_id,
  sku: r.sku,
  name: r.name,
  ean: r.ean,
  upc: r.upc,
  imageUrl: r.image_url,
  discontinued: r.discontinued == null ? null : r.discontinued === 1,
  syncedAt: r.synced_at,
  mappedToProductId: r.product_id,
  mappedToProductName: r.product_name,
  hasStockRecord: r.stock_rows > 0,
  // The same derivation as orders/stock.ts, so this screen and the approval guard agree
  // about what "no figure" means. Part of the picture missing is unknown, not low.
  available: usableFigure({ rows_seen: r.stock_rows, rows_with_value: r.stock_rows_with_value })
    ? r.stock_available
    : null,
})

// Correlated subqueries rather than a join: stock_cache holds a row per location, and
// joining would multiply the line rows and quietly break the mapped-to columns.
const STOCK_COLUMNS = `
         (SELECT COUNT(sc.id) FROM stock_cache sc
           WHERE sc.mintsoft_product_id = mp.mintsoft_product_id) AS stock_rows,
         (SELECT COUNT(sc.available) FROM stock_cache sc
           WHERE sc.mintsoft_product_id = mp.mintsoft_product_id) AS stock_rows_with_value,
         (SELECT SUM(sc.available) FROM stock_cache sc
           WHERE sc.mintsoft_product_id = mp.mintsoft_product_id) AS stock_available`

const LINE_SELECT = `
  SELECT mp.mintsoft_product_id, mp.sku, mp.name, mp.ean, mp.upc, mp.image_url,
         mp.discontinued, mp.synced_at, pmm.product_id, p.name AS product_name,
${STOCK_COLUMNS}
    FROM mintsoft_products mp
    LEFT JOIN product_mintsoft_map pmm ON pmm.mintsoft_product_id = mp.mintsoft_product_id
    LEFT JOIN products p ON p.id = pmm.product_id`

export async function allMintsoftLines(db: Database): Promise<MintsoftLine[]> {
  const { results } = await db.prepare(`${LINE_SELECT} ORDER BY mp.name, mp.sku`).all<LineRow>()
  return (results ?? []).map(toLine)
}

/** The work queue: lines nobody has mapped to a Maki product yet. */
export async function unmappedLines(db: Database): Promise<MintsoftLine[]> {
  const { results } = await db
    .prepare(`${LINE_SELECT} WHERE pmm.product_id IS NULL ORDER BY mp.name, mp.sku`)
    .all<LineRow>()
  return (results ?? []).map(toLine)
}

export interface Suggestion {
  /** Why these look like the same thing: shared name, SKU stem, or barcode. */
  signal: string
  key: string
  lines: MintsoftLine[]
  /** True when some of this cluster is already mapped — usually the useful case. */
  partiallyMapped: boolean
}

/**
 * Clusters of lines that look like the same product.
 *
 * Uses the same three signals the discovery run reports on, because they were chosen
 * against the real catalogue: the same name once shipment markers are stripped, a shared
 * SKU stem, and a shared barcode. No single one catches everything, which is why there
 * are three.
 *
 * A cluster where some lines are already mapped is surfaced rather than hidden: it
 * usually means a duplicate arrived after the mapping was done, which is exactly the
 * case that would otherwise go unnoticed.
 */
export async function duplicateSuggestions(db: Database): Promise<Suggestion[]> {
  const lines = await allMintsoftLines(db)
  const byId = new Map(lines.map((l) => [l.mintsoftProductId, l]))

  // findDuplicates works on Mintsoft's own Product shape, which is what it was tuned
  // against during discovery.
  const asProducts: Product[] = lines.map((l) => ({
    ID: l.mintsoftProductId, SKU: l.sku, Name: l.name ?? undefined,
    EAN: l.ean ?? undefined, UPC: l.upc ?? undefined,
    Weight: 0, DisCont: l.discontinued ?? undefined,
  }))

  const seen = new Set<string>()
  const suggestions: Suggestion[] = []

  for (const cluster of findDuplicates(asProducts).clusters) {
    const clusterLines = cluster.members
      .map((m) => (m.ID != null ? byId.get(m.ID) : undefined))
      .filter((l): l is MintsoftLine => Boolean(l))
    if (clusterLines.length < 2) continue

    // The same set of lines can surface under more than one signal; show it once.
    const fingerprint = clusterLines.map((l) => l.mintsoftProductId).sort((a, b) => a - b).join(',')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)

    const mapped = clusterLines.filter((l) => l.mappedToProductId !== null)
    // Nothing to suggest when the whole cluster already sits on one product.
    if (mapped.length === clusterLines.length &&
        new Set(mapped.map((l) => l.mappedToProductId)).size === 1) continue

    suggestions.push({
      signal: cluster.signal,
      key: cluster.key,
      lines: clusterLines,
      partiallyMapped: mapped.length > 0,
    })
  }

  // Biggest clusters first: they hide the most duplication from GMs.
  return suggestions.sort((a, b) => b.lines.length - a.lines.length)
}

export class MappingError extends Error {
  constructor(message: string) { super(message); this.name = 'MappingError' }
}

export interface NewProductInput {
  name: string
  category?: string | null
  stockType: 'internal' | 'expansion'
  packSize?: number | null
  unit?: string | null
  rechargeUnitPrice?: number | null
  mintsoftProductIds: number[]
  primaryMintsoftProductId: number
}

/**
 * Creates a Maki product from a set of Mintsoft lines.
 *
 * The product row and its mappings go in one batch, so it either all lands or none
 * does. A product created with only half its lines mapped would show half its stock --
 * the confident-undercount failure again -- and a product created with no mappings at
 * all would sit in the catalogue permanently unorderable.
 */
export interface MappingResult {
  productId: number
  /** How many lines are now mapped by this call. */
  lines: number
  /** What this did to the product's stock figure, if it is worth saying. */
  warning: string | null
}

export async function createProductFromLines(db: Database, input: NewProductInput): Promise<MappingResult> {
  const ids = [...new Set(input.mintsoftProductIds)]
  if (ids.length === 0) throw new MappingError('Choose at least one Mintsoft line to map.')
  if (!ids.includes(input.primaryMintsoftProductId)) {
    throw new MappingError('The primary SKU must be one of the lines being mapped.')
  }
  if (!input.name.trim()) throw new MappingError('Give the product a name.')

  const placeholders = ids.map(() => '?').join(', ')

  const { results: existing } = await db
    .prepare(
      `SELECT pmm.mintsoft_product_id, p.name
         FROM product_mintsoft_map pmm JOIN products p ON p.id = pmm.product_id
        WHERE pmm.mintsoft_product_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ mintsoft_product_id: number; name: string }>()

  if (existing?.length) {
    // The unique index would stop this anyway; saying which line and which product is
    // far more use than a constraint violation.
    const first = existing[0]!
    throw new MappingError(
      `Mintsoft line ${first.mintsoft_product_id} is already mapped to "${first.name}". ` +
      'Unmap it first, or add these lines to that product instead.',
    )
  }

  const { results: known } = await db
    .prepare(`SELECT mintsoft_product_id FROM mintsoft_products WHERE mintsoft_product_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ mintsoft_product_id: number }>()
  const knownIds = new Set((known ?? []).map((r) => r.mintsoft_product_id))
  const unknown = ids.filter((id) => !knownIds.has(id))
  if (unknown.length) {
    throw new MappingError(`These Mintsoft lines are not in the catalogue mirror: ${unknown.join(', ')}.`)
  }

  // The mappings reference the product by name rather than by a captured id, so the
  // insert and the mappings can travel in the same batch.
  const name = input.name.trim()
  await db.batch([
    db.prepare(
      `INSERT INTO products (name, category, stock_type, pack_size, unit, recharge_unit_price)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      name, input.category ?? null, input.stockType,
      input.packSize ?? null, input.unit ?? null, input.rechargeUnitPrice ?? null,
    ),
    ...ids.map((id) =>
      db.prepare(
        `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
         SELECT (SELECT MAX(id) FROM products), mintsoft_product_id, sku, ?
           FROM mintsoft_products WHERE mintsoft_product_id = ?`,
      ).bind(id === input.primaryMintsoftProductId ? 1 : 0, id),
    ),
  ])

  const created = await db
    .prepare(`SELECT id FROM products WHERE name = ? ORDER BY id DESC LIMIT 1`)
    .bind(name)
    .first<{ id: number }>()
  if (!created) throw new MappingError('Could not create the product.')

  return {
    productId: created.id,
    lines: ids.length,
    // Read after the write, so the warning describes the product as it now stands.
    warning: stockWarning(await stockPositionOf(db, ids), {
      primaryMintsoftProductId: input.primaryMintsoftProductId,
    }),
  }
}

/**
 * Whether a line's stock rows add up to a figure we may use.
 *
 * The one statement of the rule in this file, and the same one orders/stock.ts applies:
 * no rows at all is unknown, and rows where part of the picture is missing are unknown
 * too. Adding up the rows that did report would produce a confident undercount, which is
 * worse than no number because it gets ordered against.
 */
const usableFigure = (r: { rows_seen: number; rows_with_value: number }): boolean =>
  r.rows_seen > 0 && r.rows_with_value === r.rows_seen

/** The stock position of a set of Mintsoft lines, for the warning below. */
async function stockPositionOf(
  db: Database, mintsoftProductIds: number[],
): Promise<Pick<MintsoftLine, 'mintsoftProductId' | 'sku' | 'hasStockRecord' | 'available'>[]> {
  if (mintsoftProductIds.length === 0) return []
  const placeholders = mintsoftProductIds.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT mp.mintsoft_product_id, mp.sku,
${STOCK_COLUMNS}
         FROM mintsoft_products mp
        WHERE mp.mintsoft_product_id IN (${placeholders})`,
    )
    .bind(...mintsoftProductIds)
    .all<{
      mintsoft_product_id: number; sku: string
      stock_rows: number; stock_rows_with_value: number; stock_available: number | null
    }>()
  return (results ?? []).map((r) => ({
    mintsoftProductId: r.mintsoft_product_id,
    sku: r.sku,
    hasStockRecord: r.stock_rows > 0,
    available: usableFigure({ rows_seen: r.stock_rows, rows_with_value: r.stock_rows_with_value })
      ? r.stock_available
      : null,
  }))
}

/**
 * What mapping these lines will do to the product's stock figure, in words, or null when
 * there is nothing worth saying.
 *
 * Deliberately not an error. A line awaiting its first shipment has no inventory record
 * yet and is perfectly reasonable to map; the point is that the person doing it should
 * not have to know the availability rules to see what follows.
 *
 * It keys on whether a line yields a usable FIGURE, not on whether a row exists. Keying
 * on the row missed the case where every line has a row and none of them says anything --
 * which is the state the approval guard refuses outright, so staying silent about it was
 * the worst possible choice.
 */
export function stockWarning(
  lines: Pick<MintsoftLine, 'mintsoftProductId' | 'sku' | 'hasStockRecord' | 'available'>[],
  { primaryMintsoftProductId }: { primaryMintsoftProductId?: number } = {},
): string | null {
  const unreadable = lines.filter((l) => l.available === null)
  if (unreadable.length === 0) return null

  const names = unreadable.map((l) => l.sku).join(', ')
  const readable = lines.filter((l) => l.available !== null)
  const floor = readable.reduce((n, l) => n + (l.available ?? 0), 0)

  // No figure anywhere: the product has no floor, so it cannot be ordered at all until
  // one of these lines reports. The strongest thing to say, and the only case where
  // "orders will be refused" is true.
  if (readable.length === 0) {
    return `Mintsoft has no stock figure for ${names}`
      + `${lines.length === 1 ? ', the only line mapped to this product' : ', which is every line mapped to this product'}. `
      + 'Until one of them reports, this product will show no stock and orders for it will '
      + 'be refused. Map it if the shipment is still to land — it just will not be orderable yet.'
  }

  // There IS a floor, but it is zero: the readable lines are genuinely empty. Saying
  // "orders up to 0 are unaffected" here, as this once did, is nonsense -- nothing can be
  // ordered -- but it is a different problem from having no figure, and one the next
  // shipment fixes without anybody touching the mapping.
  const consequence = floor === 0
    ? `and the ${readable.length === 1 ? 'one line that does' : `${readable.length} lines that do`} `
      + 'currently holds nothing, so there is nothing to order yet. The real figure may be '
      + 'higher than zero and we cannot see it.'
    : `so this product will show at least ${floor} rather than a total — the real figure `
      + `may be higher and we cannot see it. Orders up to ${floor} are unaffected.`

  const isPrimary = primaryMintsoftProductId !== undefined
    && unreadable.some((l) => l.mintsoftProductId === primaryMintsoftProductId)

  return `Mintsoft has no stock figure for ${names}, ${consequence}`
    + (isPrimary
      // NOT "orders are placed against it first". They are not: allocateLine filters out
      // lines with no figure before it sorts by primary, so a primary with no figure has
      // no effect on allocation at all. The one real consequence is that the flag has to
      // be moved before the line can ever be unmapped.
      ? ` That line also holds the primary flag. It does not change which line an order is`
        + ' filled from — allocation skips lines with no figure — but the flag has to be'
        + ' moved to another line before this one could be unmapped.'
      : '')
}

export interface UnreadableLine {
  mintsoftProductId: number
  sku: string
  isPrimary: boolean
  /** False when Mintsoft has no inventory record at all; true when it has one that says nothing. */
  hasStockRecord: boolean
}

export interface ProductWithUnreadableLines {
  productId: number
  productName: string
  active: boolean
  mappedLines: number
  /** Lines with no usable stock figure: no row at all, or a row that does not give one. */
  unreadableLines: UnreadableLine[]
  /**
   * Lines that do have a figure.
   *
   * Carried, not just counted, because the screen offers to move the primary flag onto one
   * of them and cannot build that control out of a number.
   */
  readableLines: { mintsoftProductId: number; sku: string; available: number }[]
  /** What the readable lines come to — what a site can actually order today. */
  readableFloor: number
}

/**
 * Products mapped to a line with no usable stock figure.
 *
 * This is the half of the guard that pays for itself today. Three products are in this
 * state right now and nothing anywhere surfaced them: one of them, Tea cups, had four
 * orders signed off and shipped before a mapping change made it unorderable, and the
 * first anyone knew was a GM's order being refused. Warning on new mappings would not
 * have found any of them.
 *
 * The readable/unreadable split is decided in TypeScript rather than in SQL, by the same
 * `usable` predicate orders/stock.ts applies. The first version of this did it in SQL with
 * `JOIN stock_cache` and `COALESCE(SUM(available), 0)`, which counted a line as readable
 * because a ROW existed and summed across rows that carried no figure. That is the
 * confident undercount the whole availability module exists to prevent, and it made this
 * panel contradict the approval guard: a product whose only row carried no figure was
 * described here as "1 readable line holding nothing" while the guard refused it as having
 * no figure at all. Two statements of one rule is how the original bug happened; there is
 * now one.
 */
export async function productsWithUnreadableLines(db: Database): Promise<ProductWithUnreadableLines[]> {
  const { results } = await db
    .prepare(
      // Every line of every product that has at least one unreadable line, so both lists
      // can be built from one read.
      `WITH line_stock AS (
         SELECT pmm.product_id, pmm.mintsoft_product_id, pmm.sku, pmm.is_primary,
                (SELECT COUNT(sc.id) FROM stock_cache sc
                  WHERE sc.mintsoft_product_id = pmm.mintsoft_product_id) AS rows_seen,
                (SELECT COUNT(sc.available) FROM stock_cache sc
                  WHERE sc.mintsoft_product_id = pmm.mintsoft_product_id) AS rows_with_value,
                (SELECT SUM(sc.available) FROM stock_cache sc
                  WHERE sc.mintsoft_product_id = pmm.mintsoft_product_id) AS available
           FROM product_mintsoft_map pmm
       )
       SELECT p.id AS product_id, p.name AS product_name, p.active,
              ls.mintsoft_product_id, ls.sku, ls.is_primary,
              ls.rows_seen, ls.rows_with_value, ls.available
         FROM line_stock ls
         JOIN products p ON p.id = ls.product_id
        WHERE ls.product_id IN (
                SELECT product_id FROM line_stock
                 WHERE rows_seen = 0 OR rows_with_value < rows_seen)
        ORDER BY p.active DESC, p.name, ls.is_primary DESC, ls.sku`,
    )
    .all<{
      product_id: number; product_name: string; active: number
      mintsoft_product_id: number; sku: string; is_primary: number
      rows_seen: number; rows_with_value: number; available: number | null
    }>()

  const byProduct = new Map<number, ProductWithUnreadableLines>()
  for (const r of results ?? []) {
    const entry = byProduct.get(r.product_id) ?? {
      productId: r.product_id,
      productName: r.product_name,
      active: r.active === 1,
      mappedLines: 0,
      unreadableLines: [],
      readableLines: [],
      readableFloor: 0,
    }
    entry.mappedLines += 1

    if (usableFigure(r) && r.available !== null) {
      entry.readableLines.push({
        mintsoftProductId: r.mintsoft_product_id, sku: r.sku, available: r.available,
      })
      entry.readableFloor += r.available
    } else {
      entry.unreadableLines.push({
        mintsoftProductId: r.mintsoft_product_id,
        sku: r.sku,
        isPrimary: r.is_primary === 1,
        hasStockRecord: r.rows_seen > 0,
      })
    }
    byProduct.set(r.product_id, entry)
  }
  return [...byProduct.values()]
}

/** Adds further Mintsoft lines to a product that already exists. */
export async function addLinesToProduct(
  db: Database, productId: number, mintsoftProductIds: number[],
): Promise<MappingResult> {
  const ids = [...new Set(mintsoftProductIds)]
  if (ids.length === 0) throw new MappingError('Choose at least one Mintsoft line to add.')

  const product = await db.prepare(`SELECT id FROM products WHERE id = ?`).bind(productId).first<{ id: number }>()
  if (!product) throw new MappingError('That product no longer exists.')

  await db.batch(
    ids.map((id) =>
      db.prepare(
        `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
         SELECT ?, mintsoft_product_id, sku, 0 FROM mintsoft_products WHERE mintsoft_product_id = ?`,
      ).bind(productId, id),
    ),
  )

  // Every line the product now has, not just the new ones: the floor is the sum across
  // all of them, so adding a recordless line to a product that already holds plenty is
  // a far smaller thing to say than adding one to a product that holds nothing.
  const { results: all } = await db
    .prepare(`SELECT mintsoft_product_id, is_primary FROM product_mintsoft_map WHERE product_id = ?`)
    .bind(productId)
    .all<{ mintsoft_product_id: number; is_primary: number }>()
  const primary = (all ?? []).find((r) => r.is_primary === 1)?.mintsoft_product_id

  return {
    productId,
    lines: ids.length,
    warning: stockWarning(
      await stockPositionOf(db, (all ?? []).map((r) => r.mintsoft_product_id)),
      { primaryMintsoftProductId: primary },
    ),
  }
}

/**
 * Unmaps a line.
 *
 * Refuses to remove the primary without a replacement: a product with lines but no
 * primary has nowhere to send an order, and it would fail at the point of ordering
 * rather than here.
 */
export async function unmapLine(db: Database, mintsoftProductId: number): Promise<void> {
  const row = await db
    .prepare(`SELECT product_id, is_primary FROM product_mintsoft_map WHERE mintsoft_product_id = ?`)
    .bind(mintsoftProductId)
    .first<{ product_id: number; is_primary: number }>()
  if (!row) throw new MappingError('That line is not mapped to anything.')

  if (row.is_primary === 1) {
    const others = await db
      .prepare(`SELECT COUNT(*) AS n FROM product_mintsoft_map WHERE product_id = ? AND mintsoft_product_id != ?`)
      .bind(row.product_id, mintsoftProductId)
      .first<{ n: number }>()
    if ((others?.n ?? 0) > 0) {
      throw new MappingError('This is the primary SKU. Make another line primary first.')
    }
  }

  await db.prepare(`DELETE FROM product_mintsoft_map WHERE mintsoft_product_id = ?`).bind(mintsoftProductId).run()
}

/** Moves the primary flag, which decides which SKU an order is placed against first. */
export async function setPrimaryLine(db: Database, productId: number, mintsoftProductId: number): Promise<void> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM product_mintsoft_map WHERE product_id = ? AND mintsoft_product_id = ?`)
    .bind(productId, mintsoftProductId)
    .first<{ ok: number }>()
  if (!row) throw new MappingError('That line is not mapped to this product.')

  // Clear first: the partial unique index allows only one primary per product, so
  // setting the new one before clearing the old would be rejected.
  await db.batch([
    db.prepare(`UPDATE product_mintsoft_map SET is_primary = 0 WHERE product_id = ?`).bind(productId),
    db.prepare(`UPDATE product_mintsoft_map SET is_primary = 1 WHERE mintsoft_product_id = ?`).bind(mintsoftProductId),
  ])
}

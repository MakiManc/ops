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
})

const LINE_SELECT = `
  SELECT mp.mintsoft_product_id, mp.sku, mp.name, mp.ean, mp.upc, mp.image_url,
         mp.discontinued, mp.synced_at, pmm.product_id, p.name AS product_name
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
 * Written as one batch so it either all lands or none does. A product created with only
 * half its lines mapped would show half its stock, which is the confident-undercount
 * failure again.
 */
export async function createProductFromLines(db: Database, input: NewProductInput): Promise<number> {
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

  const created = await db
    .prepare(
      `INSERT INTO products (name, category, stock_type, pack_size, unit, recharge_unit_price)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      input.name.trim(), input.category ?? null, input.stockType,
      input.packSize ?? null, input.unit ?? null, input.rechargeUnitPrice ?? null,
    )
    .first<{ id: number }>()

  if (!created) throw new MappingError('Could not create the product.')

  await db.batch(
    ids.map((id) =>
      db.prepare(
        `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
         SELECT ?, mintsoft_product_id, sku, ? FROM mintsoft_products WHERE mintsoft_product_id = ?`,
      ).bind(created.id, id === input.primaryMintsoftProductId ? 1 : 0, id),
    ),
  )

  return created.id
}

/** Adds further Mintsoft lines to a product that already exists. */
export async function addLinesToProduct(
  db: Database, productId: number, mintsoftProductIds: number[],
): Promise<number> {
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
  return ids.length
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

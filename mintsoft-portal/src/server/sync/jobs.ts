/**
 * The sync jobs themselves.
 *
 * All reads, and all through the allow-listed client — Phase 0 found that around twenty
 * of Mintsoft's state-changing operations are exposed as GETs, so "we only read" is a
 * property of the endpoint list rather than of the verb.
 *
 * Nothing here deletes. A product that stops appearing in a feed keeps its row and its
 * old synced_at, and goes stale rather than vanishing — partly so a half-finished sync
 * cannot wipe the catalogue, and partly because "we have not heard about this lately"
 * is the truth, while deleting it would assert something we do not know.
 */
import type { MintsoftReadOnlyClient } from '../../lib/mintsoft/readonly-client.ts'
import type { ASN, BulkInventoryItem, Order, Product } from '../../lib/mintsoft/types.ts'
import type { Database } from '../db/repo.ts'
import { deriveAvailability, type AvailableFormula, type StockRow } from './availability.ts'
import { chunk, type SyncOutcome } from './runner.ts'

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

/** D1 allows up to 100 statements per batch; stay well inside it. */
const BATCH = 50

interface Scope { clientId?: number; warehouseId?: number }

/**
 * Stock.
 *
 * Reads /api/Product/Inventory/Bulk rather than /api/Product/StockLevels: discovery
 * found StockLevels returns neither Allocated nor Available, cannot be paged, and has
 * no since-filter. Bulk pages properly (Mintsoft documents max 500) and carries every
 * figure we need.
 */
export async function syncStock(
  db: Database,
  client: MintsoftReadOnlyClient,
  formula: AvailableFormula,
  scope: Scope = {},
): Promise<SyncOutcome> {
  const { items, truncated, serverCappedPageSizeAt } = await client.getAllPages<BulkInventoryItem>(
    '/api/Product/Inventory/Bulk',
    { ClientId: scope.clientId, WarehouseId: scope.warehouseId, Breakdown: false },
    { limit: 500 },
  )

  const syncedAt = nowIso()

  // Group by product, because each product's rows are replaced as a set.
  //
  // Upserting row by row looks equivalent and is not. Mintsoft's grain can change --
  // the same product might come back once with no location, then split across two --
  // and an upsert leaves the old shape behind alongside the new one. Every reader sums
  // those rows, so 100 units in the warehouse reads as 200. Replacing a product's rows
  // wholesale also drops a location that has emptied, which an upsert would leave
  // sitting there at its last known count.
  const byProduct = new Map<number, BulkInventoryItem[]>()
  for (const row of items) {
    if (row.ProductId == null) continue
    byProduct.set(row.ProductId, [...(byProduct.get(row.ProductId) ?? []), row])
  }

  /**
   * What is already cached, so a product whose stock has not moved can be left alone.
   *
   * Replacing every product's rows on every run cost a DELETE and an INSERT each — about
   * 63,000 row writes a day for roughly 330 products on a quarter-hourly cadence, nearly
   * all of it rewriting figures that had not changed. That exhausted D1's free daily
   * write allowance and took the portal down: sign-in, baskets, approvals and sends all
   * failed, because every one of them needs a write.
   *
   * The signature deliberately excludes synced_at. Including it would make every row
   * differ on every run, which is exactly the behaviour being removed.
   */
  const { results: cachedRows } = await db
    .prepare(
      `SELECT mintsoft_product_id, warehouse_id, location_id, on_hand, allocated,
              available, available_basis
         FROM stock_cache`,
    )
    .all<{
      mintsoft_product_id: number; warehouse_id: number | null; location_id: number | null
      on_hand: number | null; allocated: number | null
      available: number | null; available_basis: string | null
    }>()

  const signature = (parts: (string | number | null)[][]) =>
    parts.map((p) => p.join('\u0001')).sort().join('\u0002')

  const cachedByProduct = new Map<number, (string | number | null)[][]>()
  for (const r of cachedRows ?? []) {
    cachedByProduct.set(r.mintsoft_product_id, [
      ...(cachedByProduct.get(r.mintsoft_product_id) ?? []),
      [r.warehouse_id, r.location_id, r.on_hand, r.allocated, r.available, r.available_basis],
    ])
  }

  let written = 0
  let unchanged = 0
  const statements: ReturnType<Database['prepare']>[] = []
  const changedProducts: number[] = []

  for (const [productId, rows] of byProduct) {
    const incoming = rows.map((row) => {
      const derived = deriveAvailability(
        [{ onHand: row.OnHand, allocated: row.Allocated, stockLevel: row.StockLevel }],
        formula,
      )
      return [
        row.WarehouseId ?? null, row.LocationId ?? null,
        row.OnHand ?? null, row.Allocated ?? null,
        derived.available, derived.basis,
      ] as (string | number | null)[]
    })

    const before = cachedByProduct.get(productId)
    // A product absent from the cache has no signature, so it is always written.
    if (before && signature(before) === signature(incoming)) {
      unchanged++
      continue
    }
    changedProducts.push(productId)

    statements.push(
      db.prepare(`DELETE FROM stock_cache WHERE mintsoft_product_id = ?`).bind(productId),
    )
    for (const row of rows) {
      const derived = deriveAvailability(
        [{ onHand: row.OnHand, allocated: row.Allocated, stockLevel: row.StockLevel }],
        formula,
      )
      statements.push(
        db.prepare(
          `INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id,
                                    on_hand, allocated, available, available_basis, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          productId, row.WarehouseId ?? null, row.LocationId ?? null,
          row.OnHand ?? null, row.Allocated ?? null,
          derived.available, derived.basis, syncedAt,
        ),
      )
      written++
    }
  }

  // Chunk on product boundaries so a product's delete and its inserts always land in
  // the same batch. Splitting them could leave a product with no rows at all if the
  // run died between the two, which reads as "gone" rather than "unknown".
  let batchGroup: typeof statements = []
  const flush = async () => {
    if (batchGroup.length) { await db.batch(batchGroup); batchGroup = [] }
  }
  let index = 0
  for (const productId of changedProducts) {
    const size = (byProduct.get(productId)?.length ?? 0) + 1
    if (batchGroup.length + size > BATCH) await flush()
    batchGroup.push(...statements.slice(index, index + size))
    index += size
  }
  await flush()

  const notes: string[] = []
  if (truncated) notes.push('stopped at the page ceiling — some stock was not read')
  if (serverCappedPageSizeAt) notes.push(`Mintsoft capped pages at ${serverCappedPageSizeAt}`)
  // Worth showing on Sync Health: it is the difference between a healthy run and one
  // quietly burning the daily write allowance.
  if (unchanged) notes.push(`${unchanged} product(s) unchanged, so not rewritten`)

  return { rowsWritten: written, detail: notes.join('; ') || undefined }
}

/**
 * Inbound, from ASNs.
 *
 * Per line, what is still coming is QuantityExpected less QuantityReceieved — Mintsoft's
 * spelling, which our generated models match deliberately. The expected date is
 * ASN.EstimatedDelivery.
 */
export async function syncInbound(
  db: Database,
  client: MintsoftReadOnlyClient,
  scope: Scope = {},
): Promise<SyncOutcome> {
  const { items, truncated } = await client.getAllPages<ASN>(
    '/api/ASN/List',
    { ClientId: scope.clientId, WarehouseId: scope.warehouseId, IncludeASNItems: true },
    { limit: 100 },
  )

  const syncedAt = nowIso()
  const statements: ReturnType<Database['prepare']>[] = []
  let skippedWithoutItems = 0

  for (const asn of items) {
    if (asn.ID == null) continue
    // The ASN/List description says items are excluded while the endpoint also offers
    // IncludeASNItems. If they do not arrive, record that rather than reporting zero
    // inbound stock.
    if (!asn.Items?.length) { skippedWithoutItems++; continue }

    for (const item of asn.Items) {
      if (item.ProductId == null) continue
      const expected = item.QuantityExpected
      const received = item.QuantityReceieved   // sic: Mintsoft's spelling
      const outstanding = typeof expected === 'number'
        ? Math.max(0, expected - (typeof received === 'number' ? received : 0))
        : null

      statements.push(
        db.prepare(
          `INSERT INTO inbound (mintsoft_product_id, asn_id, qty, expected_date, synced_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (asn_id, mintsoft_product_id)
           DO UPDATE SET qty = excluded.qty, expected_date = excluded.expected_date,
                         synced_at = excluded.synced_at`,
        ).bind(item.ProductId, asn.ID, outstanding, asn.EstimatedDelivery ?? null, syncedAt),
      )
    }
  }

  for (const group of chunk(statements, BATCH)) await db.batch(group)

  const notes: string[] = []
  if (truncated) notes.push('stopped at the page ceiling — some ASNs were not read')
  if (skippedWithoutItems) {
    notes.push(`${skippedWithoutItems} ASN(s) arrived with no line items, so their contents are unknown`)
  }
  return { rowsWritten: statements.length, detail: notes.join('; ') || undefined }
}

/**
 * Mintsoft's catalogue, mirrored for the mapping tool.
 *
 * Product/List documents "Max 100" and silently returns 100 when asked for more, which
 * the client handles by detecting the cap rather than reading a full page as the end.
 */
export async function syncCatalogue(
  db: Database,
  client: MintsoftReadOnlyClient,
  scope: Scope = {},
): Promise<SyncOutcome> {
  const { items, truncated } = await client.getAllPages<Product>(
    '/api/Product/List', { ClientId: scope.clientId }, { limit: 100 },
  )

  const syncedAt = nowIso()

  /**
   * Skip products whose details have not changed.
   *
   * Same reasoning as the stock sync: an upsert that rewrites an identical row still
   * costs a write, and doing that hourly for every product spent thousands of the daily
   * allowance on nothing. A product's SKU, name, barcodes and image change rarely; its
   * stock, which does move, lives in a different table.
   *
   * last_updated comes from Mintsoft and is deliberately not compared: it is their
   * bookkeeping timestamp, and treating a change in it alone as a reason to rewrite
   * would put us back where we started.
   */
  const { results: known } = await db
    .prepare(
      `SELECT mintsoft_product_id, sku, name, ean, upc, image_url, discontinued, client_id
         FROM mintsoft_products`,
    )
    .all<Record<string, string | number | null>>()

  const fingerprint = (v: (string | number | null | undefined)[]) =>
    v.map((x) => (x === undefined ? null : x)).join('\u0001')

  const seen = new Map<number, string>()
  for (const r of known ?? []) {
    seen.set(Number(r.mintsoft_product_id), fingerprint([
      r.sku, r.name, r.ean, r.upc, r.image_url, r.discontinued, r.client_id,
    ]))
  }

  let unchanged = 0
  const statements = items
    .filter((p) => p.ID != null && p.SKU)
    .filter((p) => {
      const before = seen.get(p.ID!)
      const now = fingerprint([
        p.SKU, p.Name ?? null, p.EAN ?? null, p.UPC ?? null, p.ImageURL ?? null,
        p.DisCont == null ? null : (p.DisCont ? 1 : 0),   // sic: Mintsoft's spelling
        p.ClientId ?? null,
      ])
      if (before !== undefined && before === now) { unchanged++; return false }
      return true
    })
    .map((p) => db.prepare(
      `INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, ean, upc, image_url,
                                      discontinued, client_id, last_updated, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (mintsoft_product_id) DO UPDATE SET
         sku = excluded.sku, name = excluded.name, ean = excluded.ean, upc = excluded.upc,
         image_url = excluded.image_url, discontinued = excluded.discontinued,
         client_id = excluded.client_id, last_updated = excluded.last_updated,
         synced_at = excluded.synced_at`,
    ).bind(
      p.ID!, p.SKU, p.Name ?? null, p.EAN ?? null, p.UPC ?? null, p.ImageURL ?? null,
      p.DisCont == null ? null : (p.DisCont ? 1 : 0),   // sic: Mintsoft's spelling
      p.ClientId ?? null, p.LastUpdated ?? null, syncedAt,
    ))

  for (const group of chunk(statements, BATCH)) await db.batch(group)

  const notes: string[] = []
  if (truncated) notes.push('stopped at the page ceiling — some products were not read')
  if (unchanged) notes.push(`${unchanged} product(s) unchanged, so not rewritten`)

  return { rowsWritten: statements.length, detail: notes.join('; ') || undefined }
}

/**
 * Reads back what the warehouse has done with orders we sent.
 *
 * Only orders the portal posted and has not seen leave the building are checked, so the
 * 15-minute job stays small however long the order history gets.
 *
 * It stops at despatched. Mintsoft's order record carries a DespatchDate but nothing at
 * all to confirm a delivery -- the only DeliveryDate in the API is on the create models,
 * a date you ask for rather than one that happened -- so the portal does not claim one.
 */
export async function syncOrderStatus(
  db: Database,
  client: MintsoftReadOnlyClient,
  scope: Scope = {},
): Promise<SyncOutcome> {
  const { results: open } = await db
    .prepare(
      `SELECT id, order_number, mintsoft_order_id FROM orders
        WHERE status = 'posted' AND mintsoft_order_id IS NOT NULL`,
    )
    .all<{ id: number; order_number: string; mintsoft_order_id: number }>()

  if (!open?.length) return { rowsWritten: 0, detail: 'No orders are waiting on the warehouse.' }

  const syncedAt = nowIso()
  const statements: ReturnType<Database['prepare']>[] = []
  let despatched = 0
  const unreadable: string[] = []

  for (const order of open) {
    const { data, status } = await client.get<Order[]>('/api/Order/Search', {
      OrderNumber: order.order_number, exactMatch: true,
    })

    if (status !== 200 || !Array.isArray(data)) {
      // Not being able to read an order is not evidence about it. Say so rather than
      // leaving it looking checked.
      unreadable.push(order.order_number)
      continue
    }

    const match = data.find((o) => o.OrderNumber === order.order_number)
    if (!match) { unreadable.push(order.order_number); continue }

    if (match.DespatchDate) {
      despatched++
      statements.push(
        db.prepare(
          `UPDATE orders SET status = 'despatched', despatched_at = ?,
                  tracking_number = ?, tracking_url = ?, updated_at = ?
             WHERE id = ? AND status = 'posted'`,
        ).bind(
          match.DespatchDate,
          match.TrackingNumber ?? null,
          // Mintsoft computes the finished tracking link itself; there is no courier
          // template to assemble.
          match.TrackingURL ?? null,
          syncedAt, order.id,
        ),
        db.prepare(
          `INSERT INTO order_events (order_id, actor, event, detail, at) VALUES (?, 'system', 'despatched', ?, ?)`,
        ).bind(order.id, JSON.stringify({ despatchedAt: match.DespatchDate, tracking: match.TrackingNumber ?? null }), syncedAt),
      )
    } else if (match.TrackingNumber && match.TrackingURL) {
      // Tracking can appear before the despatch date does.
      statements.push(
        db.prepare(`UPDATE orders SET tracking_number = ?, tracking_url = ?, updated_at = ? WHERE id = ?`)
          .bind(match.TrackingNumber, match.TrackingURL, syncedAt, order.id),
      )
    }
  }

  for (const group of chunk(statements, BATCH)) await db.batch(group)

  const notes: string[] = []
  if (despatched) notes.push(`${despatched} order(s) have left the warehouse`)
  if (unreadable.length) {
    notes.push(`could not read ${unreadable.length} order(s) in Mintsoft: ${unreadable.slice(0, 5).join(', ')}`)
  }
  return { rowsWritten: despatched, detail: notes.join('; ') || undefined }
}

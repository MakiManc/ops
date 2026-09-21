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
import type { ASN, BulkInventoryItem, Product } from '../../lib/mintsoft/types.ts'
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
  const statements = items
    .filter((row) => row.ProductId != null)
    .map((row) => {
      // Availability is per inventory row here; rows for the same product are summed
      // when read, because the grain is product x warehouse x location.
      const stockRow: StockRow = {
        onHand: row.OnHand, allocated: row.Allocated, stockLevel: row.StockLevel,
      }
      const derived = deriveAvailability([stockRow], formula)
      return db
        .prepare(
          `INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id,
                                    on_hand, allocated, available, available_basis, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (mintsoft_product_id, ifnull(warehouse_id, -1), ifnull(location_id, -1))
           DO UPDATE SET on_hand = excluded.on_hand, allocated = excluded.allocated,
                         available = excluded.available, available_basis = excluded.available_basis,
                         synced_at = excluded.synced_at`,
        )
        .bind(
          row.ProductId!, row.WarehouseId ?? null, row.LocationId ?? null,
          row.OnHand ?? null, row.Allocated ?? null,
          derived.available, derived.basis, syncedAt,
        )
    })

  for (const group of chunk(statements, BATCH)) await db.batch(group)

  // Say so when a list was cut short. A quietly short sync looks like a warehouse that
  // has quietly emptied.
  const notes: string[] = []
  if (truncated) notes.push('stopped at the page ceiling — some stock was not read')
  if (serverCappedPageSizeAt) notes.push(`Mintsoft capped pages at ${serverCappedPageSizeAt}`)

  return { rowsWritten: statements.length, detail: notes.join('; ') || undefined }
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
  const statements = items
    .filter((p) => p.ID != null && p.SKU)
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

  return {
    rowsWritten: statements.length,
    detail: truncated ? 'stopped at the page ceiling — some products were not read' : undefined,
  }
}

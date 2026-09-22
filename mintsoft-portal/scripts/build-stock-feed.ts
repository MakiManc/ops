/**
 * Builds data/ops_command/mintsoft_stock.json from the live Mintsoft account. READ ONLY.
 *
 *   npm run feed:stock              # write the file
 *   npm run feed:stock -- --dry-run # print the summary, write nothing
 *
 * Phase 5. Puts Witham stock levels where the rest of the ops data system can see them,
 * on the same "a refresh is a commit" model as the other data/ops_command/ feeds: the
 * nightly workflow runs this and commits the result, and anything that reads the folder
 * picks it up without a deploy.
 *
 * The file carries no personal data. Stock levels, SKUs and product names only — no
 * orders, no addresses, no customers.
 *
 * Two things it refuses to do, both of which matter more than being up to date:
 *
 *   1. It will not report unknown as zero. A product Mintsoft holds no inventory record
 *      for is `free: null`, and is counted separately. Anything reading this to decide
 *      whether to reorder must be able to tell "none" from "no idea".
 *   2. It will not overwrite a good file with a thin one. If the catalogue comes back
 *      implausibly small the run fails instead of committing, on the same reasoning as
 *      the min_rows floors in feeds_manifest.json: a feed that silently shrinks looks
 *      like an answer.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import { skuStem } from '../src/lib/mintsoft/discovery-analysis.ts'
import type { BulkInventoryItem, Product } from '../src/lib/mintsoft/types.ts'

const OUT = new URL('../../data/ops_command/mintsoft_stock.json', import.meta.url).pathname
const CLIENT_ID = Number(process.env.MINTSOFT_CLIENT_ID ?? 10)
const WAREHOUSE_ID = Number(process.env.MINTSOFT_WAREHOUSE_ID ?? 5)

/**
 * The floor. Calibrated 21/09/2026, when the catalogue held 337 products.
 *
 * Deliberately generous: it is here to catch a truncated page walk or a permissions
 * change that returns almost nothing, not to notice Mercium discontinuing a line.
 */
const MIN_PRODUCTS = 200

interface FeedLine { sku: string; mintsoft_product_id: number; free: number | null; allocated: number | null }
interface FeedProduct {
  item_code: string
  name: string
  /** Free to order across every shipment line, or null if NO line could be read. */
  free: number | null
  allocated: number | null
  /** Lines with no inventory record. Above zero means `free` is a floor, not a total. */
  lines_unknown: number
  lines: FeedLine[]
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const client = new MintsoftReadOnlyClient({
    username: process.env.MINTSOFT_USERNAME,
    password: process.env.MINTSOFT_PASSWORD,
    apiKey: process.env.MINTSOFT_API_KEY,
    proxyAuth: process.env.MINTSOFT_PROXY_AUTH === 'true',
    throttleMs: 250,
  })

  const { items: products, truncated } = await client.getAllPages<Product>(
    '/api/Product/List', { ClientId: CLIENT_ID }, { limit: 100 },
  )
  if (truncated) throw new Error('The product walk hit its page cap, so the catalogue is incomplete.')
  if (products.length < MIN_PRODUCTS) {
    throw new Error(
      `Only ${products.length} products came back, below the floor of ${MIN_PRODUCTS}. ` +
      'Refusing to overwrite the committed feed with a thin one.',
    )
  }

  const { items: inventory } = await client.getAllPages<BulkInventoryItem>(
    '/api/Product/Inventory/Bulk',
    { ClientId: CLIENT_ID, WarehouseId: WAREHOUSE_ID, Breakdown: false },
    { limit: 500 },
  )

  // One product can hold several bin locations in the warehouse, so sum rather than
  // keep whichever came last.
  const invByProduct = new Map<number, { free: number; allocated: number }>()
  for (const row of inventory) {
    if (row.ProductId == null) continue
    const prev = invByProduct.get(row.ProductId) ?? { free: 0, allocated: 0 }
    // OnHand is free stock: discovery proved Mintsoft has already deducted allocations
    // (StockLevel === OnHand + Allocated across every product, no exceptions).
    invByProduct.set(row.ProductId, {
      free: prev.free + (row.OnHand ?? 0),
      allocated: prev.allocated + (row.Allocated ?? 0),
    })
  }

  // Group by item code, which is the SKU with the MRK<shipment> prefix stripped. Mercium
  // creates a product per shipment, so this is what collapses eight lines of chopsticks
  // into one thing a human recognises.
  const byItem = new Map<string, Product[]>()
  for (const p of products) {
    if (!p.SKU || p.ID == null) continue
    const code = skuStem(p.SKU)
    byItem.set(code, [...(byItem.get(code) ?? []), p])
  }

  const feedProducts: FeedProduct[] = []
  for (const [item_code, ps] of [...byItem.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines: FeedLine[] = ps.map((p) => {
      const inv = invByProduct.get(p.ID!)
      return {
        sku: p.SKU!, mintsoft_product_id: p.ID!,
        free: inv ? inv.free : null, allocated: inv ? inv.allocated : null,
      }
    })
    const readable = lines.filter((l) => l.free !== null)
    const linesUnknown = lines.length - readable.length
    // The shortest name in a cluster is the cleanest; the longer ones carry the
    // shipment marker that grouping exists to hide.
    const name = [...ps].sort((a, b) => (a.Name ?? '').length - (b.Name ?? '').length)[0]!.Name
      ?? ps[0]!.SKU!

    feedProducts.push({
      item_code, name,
      // Null only when nothing could be read. A partial total is reported, with
      // lines_unknown saying it is a floor — the same rule the portal's screens use.
      free: readable.length === 0 ? null : readable.reduce((n, l) => n + (l.free ?? 0), 0),
      allocated: readable.length === 0 ? null : readable.reduce((n, l) => n + (l.allocated ?? 0), 0),
      lines_unknown: linesUnknown,
      lines,
    })
  }

  const known = feedProducts.filter((p) => p.free !== null)
  const feed = {
    version: 1,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      system: 'Mintsoft',
      operator: 'Mercium',
      client_id: CLIENT_ID,
      warehouse_id: WAREHOUSE_ID,
      endpoints: ['/api/Product/List', '/api/Product/Inventory/Bulk'],
    },
    notes:
      'Free-to-order stock at Witham, grouped by item code. Mercium creates one Mintsoft ' +
      'product per shipment, so a product here may span several SKUs; `lines` carries them. ' +
      '`free` is OnHand, which Mintsoft reports net of allocations. null means unknown, ' +
      'never zero. Where lines_unknown > 0, `free` is a floor rather than a total. ' +
      'Read-only: written by mintsoft-portal/scripts/build-stock-feed.ts, no personal data.',
    counts: {
      mintsoft_lines: products.length,
      products: feedProducts.length,
      lines_with_inventory: invByProduct.size,
      products_unknown: feedProducts.length - known.length,
      products_in_stock: known.filter((p) => (p.free ?? 0) > 0).length,
      products_partial: feedProducts.filter((p) => p.lines_unknown > 0 && p.free !== null).length,
    },
    totals: {
      free_units: known.reduce((n, p) => n + (p.free ?? 0), 0),
      allocated_units: known.reduce((n, p) => n + (p.allocated ?? 0), 0),
    },
    products: feedProducts,
  }

  const json = JSON.stringify(feed, null, 1) + '\n'
  console.log(`${feed.counts.products} products from ${feed.counts.mintsoft_lines} Mintsoft lines`)
  console.log(`  ${feed.counts.products_in_stock} in stock, ${feed.counts.products_unknown} unknown, ` +
    `${feed.counts.products_partial} partial`)
  console.log(`  ${feed.totals.free_units} free units, ${feed.totals.allocated_units} allocated`)

  if (dryRun) { console.log('\n--dry-run: nothing written.'); return }

  // Compare ignoring the timestamp, so an unchanged warehouse produces no commit.
  if (existsSync(OUT)) {
    const strip = (t: string) => t.replace(/"generated_at": "[^"]*"/, '')
    if (strip(readFileSync(OUT, 'utf8')) === strip(json)) {
      console.log(`\nNo change since the last run. ${OUT} left alone.`)
      return
    }
  }
  writeFileSync(OUT, json)
  console.log(`\nWritten to ${OUT}`)
}

main().catch((err) => {
  console.error(`\nstock feed failed: ${(err as Error).message}\n`)
  process.exit(1)
})

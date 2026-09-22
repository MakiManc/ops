/**
 * Builds a local, clickable copy of the portal from LIVE Mintsoft data. READ ONLY.
 *
 *   npm run demo
 *
 * Writes seed/demo.sql: the real catalogue, the real Witham stock levels, and a set of
 * Maki products mapped onto their Mintsoft lines the way Francheska would map them. Then
 * `npm run demo:serve` applies it to a local D1 and starts the dev server over HTTPS.
 *
 * HTTPS is not optional locally. The session cookie is `__Host-` prefixed and `Secure`,
 * so a browser will refuse it over plain HTTP and every sign-in silently fails.
 *
 * Nothing here writes to Mintsoft. It reads, and it emits SQL for a local database.
 * MINTSOFT_WRITES_ENABLED is untouched, and a test order placed against this copy stays
 * in the local database.
 *
 * The products are generated, not curated: one Maki product per item code, with every
 * shipment line for that code mapped onto it. That is exactly the duplicate-hiding the
 * mapping tool does by hand, so the catalogue on screen is the real shape of the
 * problem rather than a tidy sample.
 */
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import { syncCatalogue, syncStock } from '../src/server/sync/jobs.ts'
import { skuStem } from '../src/lib/mintsoft/discovery-analysis.ts'
import type { Product } from '../src/lib/mintsoft/types.ts'
import type { Database } from '../src/server/db/repo.ts'

const CLIENT_ID = Number(process.env.MINTSOFT_CLIENT_ID ?? 10)
const WAREHOUSE_ID = Number(process.env.MINTSOFT_WAREHOUSE_ID ?? 5)
const OUT = new URL('../seed/demo.sql', import.meta.url).pathname
const MIGRATIONS = new URL('../migrations/', import.meta.url)

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const q = (v: unknown) =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`

class Stmt {
  private bound: unknown[] = []
  private readonly s: ReturnType<DatabaseSync['prepare']>
  constructor(s: ReturnType<DatabaseSync['prepare']>) { this.s = s }
  bind(...v: unknown[]) { this.bound = v; return this }
  async first<T>() { return (this.s.get(...(this.bound as never[])) as T) ?? null }
  async all<T>() { return { results: this.s.all(...(this.bound as never[])) as T[], success: true as const } }
  async run() { this.s.run(...(this.bound as never[])); return { success: true as const, results: [] } }
}

/**
 * A readable category, guessed from the name. Purely cosmetic: it groups the catalogue
 * on screen so it does not arrive as 90 unsorted rows.
 */
function categorise(name: string): string {
  const n = name.toLowerCase()
  if (/tee shirt|apron|cap|uniform|hoodie/.test(n)) return 'Uniform'
  if (/table|chair|planter|base|stool|bench|shelf/.test(n)) return 'Furniture'
  if (/sign|logo|poster|menu|board/.test(n)) return 'Signage'
  if (/chopstick|spoon|fork|strainer|ladle|tong/.test(n)) return 'Utensils'
  if (/bowl|plate|cup|ramekin|teapot|tea pot|glass|tub|tray|dish/.test(n)) return 'Tableware'
  if (/tube|bag|box|packaging|napkin|paper/.test(n)) return 'Packaging'
  return 'Other'
}

const isExpansion = (name: string) => /table|chair|planter|base|sign|shelf|bench/i.test(name)

async function main() {
  const client = new MintsoftReadOnlyClient({
    username: process.env.MINTSOFT_USERNAME,
    password: process.env.MINTSOFT_PASSWORD,
    apiKey: process.env.MINTSOFT_API_KEY,
    proxyAuth: process.env.MINTSOFT_PROXY_AUTH === 'true',
    throttleMs: 200,
  })

  console.log('\nBuilding a local copy from live Mintsoft data' + dim('  — read-only'))

  const sqlite = new DatabaseSync(':memory:')
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'))
  }
  const db = {
    prepare: (sql: string) => new Stmt(sqlite.prepare(sql)),
    async batch(stmts: Stmt[]) { for (const s of stmts) await s.run(); return [] },
  } as unknown as Database

  const scope = { clientId: CLIENT_ID, warehouseId: WAREHOUSE_ID }
  console.log('\nSyncing the catalogue and stock…')
  const cat = await syncCatalogue(db, client, scope)
  const stock = await syncStock(db, client, 'on_hand', scope)
  console.log(`  ${cat.rowsWritten} products, ${stock.rowsWritten} stock rows`)

  // Group the Mintsoft lines into Maki products, one per item code.
  const products = (await client.getAllPages<Product>(
    '/api/Product/List', { ClientId: CLIENT_ID }, { limit: 100 })).items
  const byStem = new Map<string, Product[]>()
  for (const p of products) {
    if (!p.SKU || !p.ID) continue
    const stem = skuStem(p.SKU)
    byStem.set(stem, [...(byStem.get(stem) ?? []), p])
  }

  // The shortest name in a cluster is almost always the cleanest: the longer ones carry
  // the shipment marker that the mapping is there to hide.
  const cleanest = (ps: Product[]) =>
    [...ps].sort((a, b) => (a.Name ?? '').length - (b.Name ?? '').length)[0]!.Name ?? ps[0]!.SKU!

  // No DELETEs: this is applied to a database `npm run demo:serve` has just created.
  //
  // It cannot clear one in place even if it wanted to. order_events is append-only by
  // trigger, and orders cascade into it, so a test order placed against the demo pins
  // its products permanently — which is the audit trail behaving exactly as designed.
  // Throwing the whole throwaway database away is honest; deleting audit rows is not.
  const lines: string[] = [
    '-- Generated by `npm run demo` from live Mintsoft data. Not committed.',
    '-- Applied to the fresh database that `npm run demo:serve` creates.',
  ]

  for (const r of sqlite.prepare(`SELECT * FROM mintsoft_products`).all() as Record<string, unknown>[]) {
    lines.push(
      `INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, ean, upc, image_url, ` +
      `discontinued, client_id, last_updated, synced_at) VALUES (` +
      [r.mintsoft_product_id, r.sku, r.name, r.ean, r.upc, r.image_url,
       r.discontinued, r.client_id, r.last_updated, r.synced_at].map(q).join(', ') + ');',
    )
  }

  let productId = 0
  const mapped: { id: number; name: string; count: number }[] = []
  for (const [, ps] of [...byStem.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = cleanest(ps)
    productId++
    const category = categorise(name)
    const stockType = isExpansion(name) ? 'expansion' : 'internal'
    // A price so the franchise recharge screens have something to show. Nominal.
    const price = stockType === 'expansion' ? 45 : 2.5
    lines.push(
      `INSERT INTO products (id, name, category, stock_type, pack_size, unit, ` +
      `recharge_unit_price, active) VALUES (` +
      [productId, name, category, stockType, 1, 'unit', price, 1].map(q).join(', ') + ');',
    )
    ps.forEach((p, n) => {
      lines.push(
        `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) ` +
        `VALUES (${productId}, ${p.ID}, ${q(p.SKU)}, ${n === 0 ? 1 : 0});`,
      )
    })
    mapped.push({ id: productId, name, count: ps.length })
  }

  for (const r of sqlite.prepare(`SELECT * FROM stock_cache`).all() as Record<string, unknown>[]) {
    lines.push(
      `INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, ` +
      `allocated, available, available_basis, synced_at) VALUES (` +
      [r.mintsoft_product_id, r.warehouse_id, r.location_id, r.on_hand,
       r.allocated, r.available, r.available_basis, r.synced_at].map(q).join(', ') + ');',
    )
  }

  // Par levels on the first 20 products of every site, so the "below par" cues on the
  // catalogue have something to fire on.
  lines.push(
    `INSERT INTO site_products (site_id, product_id, par_level) ` +
    `SELECT s.id, p.id, 24 FROM sites s JOIN products p ON p.id <= 20;`,
  )

  writeFileSync(OUT, lines.join('\n') + '\n')

  const multi = mapped.filter((m) => m.count > 1)
  console.log(`\n  ${mapped.length} Maki products built from ${products.length} Mintsoft lines.`)
  console.log(`  ${multi.length} of them merge more than one line — the duplicates, hidden.`)
  console.log(`\n  Largest merges:`)
  for (const m of [...multi].sort((a, b) => b.count - a.count).slice(0, 5)) {
    console.log(dim(`    ${String(m.count).padStart(2)} lines  ${m.name}`))
  }
  console.log(`\n  Written to seed/demo.sql (${lines.length} statements).`)
  console.log(`\n  Next: ${dim('npm run demo:serve')}`)
  console.log(dim('  That resets the local demo database, so any test order placed'))
  console.log(dim('  against a previous run is discarded with it.\n'))
}

main().catch((err) => {
  console.error(`\ndemo build failed: ${(err as Error).message}\n`)
  process.exit(1)
})

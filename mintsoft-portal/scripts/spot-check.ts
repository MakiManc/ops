/**
 * Phase 2's done criterion: ten spot-checked products match Mintsoft. READ ONLY.
 *
 *   npm run spot-check
 *
 * This is deliberately not a re-read of our own cache. It:
 *
 *   1. runs the REAL sync jobs against the live API, into a throwaway database built
 *      from the real migrations;
 *   2. maps ten Maki products onto their Mintsoft lines, using the real duplicate
 *      clusters so multi-line products are covered;
 *   3. reads back through the REAL portal query the GM screen uses;
 *   4. re-fetches from Mintsoft on a DIFFERENT endpoint and compares.
 *
 * Step 4 is the point. The sync reads /api/Product/Inventory/Bulk; the check reads
 * /api/Product/StockLevels, a separate endpoint with its own field (`Level`). Comparing
 * the cache against the feed that filled it would only prove the cache can store a
 * number. Comparing two independent endpoints proves the figure on screen is the figure
 * in the warehouse.
 *
 * The ten are chosen, not sampled: the cases that break are allocations, full
 * allocation, multi-line products and empty products, so all four are represented.
 */
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import { syncCatalogue, syncStock } from '../src/server/sync/jobs.ts'
import { stockOverview } from '../src/server/db/stock-overview.ts'
import { findDuplicates } from '../src/lib/mintsoft/discovery-analysis.ts'
import type { Product, StockLevel } from '../src/lib/mintsoft/types.ts'
import type { Database } from '../src/server/db/repo.ts'

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

const CLIENT_ID = Number(process.env.MINTSOFT_CLIENT_ID ?? 10)
const WAREHOUSE_ID = Number(process.env.MINTSOFT_WAREHOUSE_ID ?? 5)

// --- a D1 stand-in over node:sqlite, same shape the tests use -----------------
const MIGRATIONS = new URL('../migrations/', import.meta.url)
class Stmt {
  private bound: unknown[] = []
  // Spelled out rather than a constructor parameter property: Node's
  // --experimental-strip-types cannot compile those, and this script runs under it.
  private readonly s: ReturnType<DatabaseSync['prepare']>
  constructor(s: ReturnType<DatabaseSync['prepare']>) { this.s = s }
  bind(...v: unknown[]) { this.bound = v; return this }
  async first<T>() { return (this.s.get(...(this.bound as never[])) as T) ?? null }
  async all<T>() { return { results: this.s.all(...(this.bound as never[])) as T[], success: true as const } }
  async run() { this.s.run(...(this.bound as never[])); return { success: true as const, results: [] } }
}
function makeDb(): Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'))
  }
  const db = {
    sqlite,
    prepare: (sql: string) => new Stmt(sqlite.prepare(sql)),
    async batch(stmts: Stmt[]) { for (const s of stmts) await s.run(); return [] },
    async exec(sql: string) { sqlite.exec(sql); return { count: 0, duration: 0 } },
  }
  return db as unknown as Database & { sqlite: DatabaseSync }
}

/** Picks ten Mintsoft lines worth checking, grouped into Maki products. */
function chooseTen(products: Product[], live: StockLevel[]) {
  const levelBySku = new Map(live.filter((r) => r.WarehouseId === WAREHOUSE_ID).map((r) => [r.SKU!, r]))
  const clusters = findDuplicates(products).clusters
    .filter((c) => c.signal === 'shared-sku-stem' && c.count > 1)

  const chosen: { name: string; why: string; skus: string[] }[] = []
  const used = new Set<string>()
  const take = (name: string, why: string, skus: string[]) => {
    if (chosen.length >= 10 || skus.some((s) => used.has(s)) || !skus.length) return
    for (const s of skus) used.add(s)
    chosen.push({ name, why, skus })
  }

  const levelOf = (sku: string) => levelBySku.get(sku)?.Level ?? 0
  const grossOf = (sku: string) => levelBySku.get(sku)?.TotalStockLevel ?? 0

  // 1-3. Multi-line products: the duplicate clusters holding the most stock.
  for (const c of [...clusters].sort((a, b) =>
    b.members.reduce((n, m) => n + levelOf(m.SKU ?? ''), 0) -
    a.members.reduce((n, m) => n + levelOf(m.SKU ?? ''), 0)).slice(0, 3)) {
    take(c.members[0]!.Name ?? c.key, `${c.count} Mintsoft lines merged`, c.members.map((m) => m.SKU!))
  }
  // 4-6. Products carrying allocations — where the formula we corrected bites.
  for (const p of products.filter((p) => grossOf(p.SKU!) > levelOf(p.SKU!)).slice(0, 3)) {
    take(p.Name ?? p.SKU!, `${grossOf(p.SKU!) - levelOf(p.SKU!)} allocated`, [p.SKU!])
  }
  // 7. Fully allocated: held, but none of it free. Must read 0, never the gross figure.
  const full = products.find((p) => levelOf(p.SKU!) === 0 && grossOf(p.SKU!) > 0)
  if (full) take(full.Name ?? full.SKU!, 'fully allocated — nothing free', [full.SKU!])
  // 8-9. Plain single-line products with stock.
  for (const p of products.filter((p) => levelOf(p.SKU!) > 0).slice(0, 2)) {
    take(p.Name ?? p.SKU!, 'single line, in stock', [p.SKU!])
  }
  // 10. Genuinely empty: must read 0, and must not read "unknown".
  const empty = products.find((p) => levelBySku.has(p.SKU!) && levelOf(p.SKU!) === 0 && grossOf(p.SKU!) === 0)
  if (empty) take(empty.Name ?? empty.SKU!, 'no stock at all', [empty.SKU!])

  return chosen
}

async function main() {
  const client = new MintsoftReadOnlyClient({
    username: process.env.MINTSOFT_USERNAME,
    password: process.env.MINTSOFT_PASSWORD,
    apiKey: process.env.MINTSOFT_API_KEY,
    proxyAuth: process.env.MINTSOFT_PROXY_AUTH === 'true',
    throttleMs: 200,
  })

  console.log('\nPhase 2 spot check' + dim(`  — client ${CLIENT_ID}, warehouse ${WAREHOUSE_ID}, read-only`))

  const db = makeDb()
  const scope = { clientId: CLIENT_ID, warehouseId: WAREHOUSE_ID }

  console.log('\n1. Running the real sync jobs against the live API…')
  const cat = await syncCatalogue(db, client, scope)
  const stock = await syncStock(db, client, 'on_hand', scope)
  console.log(`   catalogue: ${cat.rowsWritten} products   stock: ${stock.rowsWritten} rows`)

  console.log('\n2. Re-reading Mintsoft on a different endpoint for the comparison…')
  const live = (await client.get<StockLevel[]>('/api/Product/StockLevels', { ...{
    ClientId: CLIENT_ID, WarehouseId: WAREHOUSE_ID } })).data ?? []
  const products = (await client.getAllPages<Product>(
    '/api/Product/List', { ClientId: CLIENT_ID }, { limit: 100 })).items
  console.log(`   ${live.length} stock rows, ${products.length} products`)

  const ten = chooseTen(products, live)
  console.log(`\n3. Mapping ${ten.length} Maki products onto their Mintsoft lines…`)
  const idBySku = new Map(products.map((p) => [p.SKU!, p.ID!]))
  ten.forEach((choice, i) => {
    db.sqlite.prepare(
      `INSERT INTO products (id, name, category, stock_type) VALUES (?, ?, 'Spot check', 'internal')`,
    ).run(i + 1, choice.name)
    choice.skus.forEach((sku, n) => {
      db.sqlite.prepare(
        `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
         VALUES (?, ?, ?, ?)`,
      ).run(i + 1, idBySku.get(sku)!, sku, n === 0 ? 1 : 0)
    })
  })

  console.log('\n4. Reading back through the portal query the stock screen uses,')
  console.log('   and comparing with StockLevels.Level summed over the same lines.\n')

  const overview = await stockOverview(db, 'on_hand')
  const levelBySku = new Map(live.filter((r) => r.WarehouseId === WAREHOUSE_ID).map((r) => [r.SKU!, r]))

  let passed = 0
  console.log(`   ${'#'.padEnd(3)}${'product'.padEnd(34)}${'portal'.padStart(8)}${'Mintsoft'.padStart(10)}  result`)
  console.log(`   ${'─'.repeat(3)}${'─'.repeat(34)}${'─'.repeat(8)}${'─'.repeat(10)}  ──────`)

  ten.forEach((choice, i) => {
    const row = overview.find((o) => o.productId === i + 1)
    const portal = row?.available ?? null
    const expected = choice.skus.reduce((n, sku) => n + (levelBySku.get(sku)?.Level ?? 0), 0)
    const match = portal === expected
    if (match) passed++
    console.log(
      `   ${String(i + 1).padEnd(3)}${choice.name.slice(0, 32).padEnd(34)}` +
      `${String(portal ?? '—').padStart(8)}${String(expected).padStart(10)}  ` +
      (match ? ok('match') : bad('MISMATCH')),
    )
    console.log(dim(`       ${choice.why}; ${choice.skus.length} line(s): ${choice.skus.join(', ')}`))
    if (row?.availableBasis) console.log(dim(`       basis: ${row.availableBasis}`))
  })

  console.log(`\n   ${passed}/${ten.length} match.`)

  // The honesty check. Mintsoft returns products with no inventory record at all, and
  // those must read as unknown rather than zero: a GM who sees "0" stops ordering, and
  // a GM who sees "—" asks. Getting this wrong is invisible on a normal day and
  // expensive on the day a product is genuinely missing from the feed.
  console.log('\n5. Products Mintsoft returns with no inventory record at all.')
  const inStockFeed = new Set(
    (await client.getAllPages<{ ProductId?: number }>('/api/Product/Inventory/Bulk',
      { ClientId: CLIENT_ID, WarehouseId: WAREHOUSE_ID, Breakdown: false }, { limit: 500 })
    ).items.map((r) => r.ProductId),
  )
  const unlisted = products.filter((p) => !inStockFeed.has(p.ID!)).slice(0, 3)

  let honest = 0
  if (unlisted.length === 0) {
    console.log(dim('   None today. Nothing to check.'))
  } else {
    unlisted.forEach((p, n) => {
      const productId = 100 + n
      db.sqlite.prepare(
        `INSERT INTO products (id, name, category, stock_type) VALUES (?, ?, 'Spot check', 'internal')`,
      ).run(productId, p.Name ?? p.SKU!)
      db.sqlite.prepare(
        `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
         VALUES (?, ?, ?, 1)`,
      ).run(productId, p.ID!, p.SKU!)
    })
    const after = await stockOverview(db, 'on_hand')
    unlisted.forEach((p, n) => {
      const row = after.find((o) => o.productId === 100 + n)
      const isUnknown = row?.available === null
      if (isUnknown) honest++
      console.log(
        `   ${(p.SKU ?? '').padEnd(18)}${String(row?.available ?? '—').padStart(6)}  ` +
        (isUnknown ? ok('unknown, correctly') : bad('reported a number it does not have')),
      )
    })
  }

  // A product whose mapped lines are PART readable. This is the case that decides
  // whether one missing inventory record can black out a product we plainly hold.
  console.log('\n6. A product mapped across readable and unreadable lines.')
  let floorOk = true
  const missingSku = unlisted[0]?.SKU
  const stem = missingSku ? missingSku.replace(/^MRK\d+[-\s]+/i, '') : null
  const siblings = stem
    ? products.filter((p) => p.SKU !== missingSku &&
        p.SKU!.replace(/^MRK\d+[-\s]+/i, '').toUpperCase() === stem.toUpperCase() &&
        inStockFeed.has(p.ID!))
    : []

  if (!missingSku || siblings.length === 0) {
    console.log(dim('   No product today has both a readable and an unreadable line.'))
  } else {
    const all = [...siblings.map((p) => p.SKU!), missingSku]
    // Sections 4 and 5 may already hold some of these lines, and a Mintsoft line maps
    // to at most one Maki product by design. Release them before remapping.
    for (const sku of all) {
      db.sqlite.prepare(`DELETE FROM product_mintsoft_map WHERE mintsoft_product_id = ?`)
        .run(idBySku.get(sku)!)
    }
    db.sqlite.prepare(
      `INSERT INTO products (id, name, category, stock_type) VALUES (200, ?, 'Spot check', 'internal')`,
    ).run(`${stem} (all shipments)`)
    for (const [n, sku] of all.entries()) {
      db.sqlite.prepare(
        `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
         VALUES (200, ?, ?, ?)`,
      ).run(idBySku.get(sku)!, sku, n === 0 ? 1 : 0)
    }
    const row = (await stockOverview(db, 'on_hand')).find((o) => o.productId === 200)
    const readable = siblings.reduce((n, p) => n + (levelBySku.get(p.SKU!)?.Level ?? 0), 0)
    floorOk = row?.available === readable && readable > 0

    console.log(`   ${all.length} lines: ${all.join(', ')}`)
    console.log(`   ${siblings.length} readable (${readable} units), 1 with no inventory record.`)
    console.log(`   portal shows: ${row?.available ?? '—'}  ` +
      (floorOk ? ok('the floor, correctly') : bad('not the floor')))
    console.log(dim(`   basis: ${row?.availableBasis}`))
    if (floorOk) {
      console.log(dim('   Before this rule changed, the whole product read "—" despite ' +
        `${readable} units being present and orderable.`))
    }
  }

  const honestOk = (unlisted.length === 0 || honest === unlisted.length) && floorOk
  if (!honestOk) {
    console.log('\n' + bad('An unreadable line was not handled correctly.'))
    console.log('   Either a product with no record reported a number, or a product with')
    console.log('   readable lines refused to report its floor.\n')
    process.exit(1)
  }
  if (passed === ten.length && ten.length === 10) {
    console.log('\n' + ok('Phase 2 criterion met.') + ' Ten products, two independent Mintsoft')
    console.log('   endpoints, one figure each — and the figures agree.\n')
  } else {
    console.log('\n' + bad(`${ten.length - passed} did not match.`) + ' The portal would show a GM a')
    console.log('   number the warehouse does not agree with.\n')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\n' + bad('spot check failed') + `: ${(err as Error).message}\n`)
  process.exit(1)
})

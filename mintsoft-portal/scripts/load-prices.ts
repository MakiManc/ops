/**
 * Loads prices/china-stock-prices.json into product_prices.
 *
 *   npm run prices              # show what it would change, write nothing
 *   npm run prices -- --apply   # write it
 *   npm run prices -- --local   # against the local database
 *
 * The JSON is built from the China Stock Price File by prices/build.py, which carries the
 * hand-written map between Mintsoft's product names and the supplier documents' and the
 * reasoning for every pairing. Read that file's header before changing a price.
 *
 * Writes only to our own database. It never touches Mintsoft.
 *
 * It matches on the product name, which is what the price file has to work with, and it
 * is strict about it: a name in the JSON that is no longer in the catalogue, and an
 * active product with no row in the JSON, are both reported rather than skipped. Either
 * means the catalogue has moved since the file was built and somebody needs to look --
 * silently leaving a product unpriced is how a report quietly stops adding up.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APPLY = process.argv.includes('--apply')
const LOCAL = process.argv.includes('--local')

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

interface Priced {
  product: string
  fileProduct: string
  match: 'exact' | 'alias'
  unitPrice: number
  currency: string
  unit: string | null
  spec: string | null
  docDate: string | null
  orderNo: string | null
  source: string | null
  distinctPrices: number
  lowest: number | null
  highest: number | null
  flags: string | null
  note: string | null
}
interface Unpriced { product: string; reason: string }
interface File {
  basis: 'supplier' | 'recharge' | 'landed'
  description: string
  sourceFile: string
  sourceSheet: string
  compiled: string
  priced: Priced[]
  unpriced: Unpriced[]
}

const file = JSON.parse(readFileSync(new URL('../prices/china-stock-prices.json', import.meta.url), 'utf8')) as File

const sql = (statement: string): unknown => {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'mintsoft-portal', LOCAL ? '--local' : '--remote', '--json', '--command', statement],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const parsed: unknown = JSON.parse(out.slice(out.indexOf('[')))
  return (Array.isArray(parsed) ? parsed[0] : parsed) as unknown
}

const q = (v: string | number | null) =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`

interface Product { id: number; name: string; active: number }
const products = (sql('SELECT id, name, active FROM products ORDER BY id') as { results: Product[] }).results

/**
 * Products by name, preferring the active one.
 *
 * Six names belong to two products each, an active one and a retired one left behind by
 * the catalogue mapping: "Black Chopsticks" is both 1 (active) and 92 (retired), "Chairs"
 * is 12 and 24, and so on. Keyed naively the last id wins, which for five of the six is
 * the retired row -- so the price would have been written against a product nothing reads
 * and the five active ones would have come out of this with no price and no reason for it.
 */
const byName = new Map<string, Product>()
for (const p of products) {
  const held = byName.get(p.name)
  if (!held || (!held.active && p.active)) byName.set(p.name, p)
}
const collisions = products.filter((p) => byName.get(p.name)?.id !== p.id)
if (collisions.length) {
  console.log(
    dim(`  ${collisions.length} product(s) share a name with another and did not get the price: `
      + collisions.map((p) => `${p.id} ${p.name}${p.active ? '' : ' (retired)'}`).join(', ')),
  )
}

console.log(`\n${file.sourceFile} — ${file.sourceSheet}, compiled ${file.compiled}`)
console.log(dim(`  ${file.description}`))
console.log(
  `\n${file.priced.length} priced, ${file.unpriced.length} without a price, `
  + `against ${products.filter((p) => p.active).length} active products.`
  + `${APPLY ? '' : dim('  (dry run — nothing will be written)')}\n`,
)

const statements: string[] = []
const seen = new Set<number>()
let missing = 0

const row = (
  product: string,
  price: number | null,
  reason: string | null,
  extra: Record<string, string | number | null>,
): void => {
  const p = byName.get(product)
  if (!p) {
    console.log(`${bad('?')} ${product}  is not in the catalogue any more — price not loaded`)
    missing++
    return
  }
  seen.add(p.id)
  const cols = {
    product_id: p.id, basis: file.basis, unit_price: price, gap_reason: reason,
    currency: 'GBP', ...extra,
  }
  const names = Object.keys(cols).join(', ')
  const values = Object.values(cols).map(q).join(', ')
  statements.push(
    `INSERT INTO product_prices (${names}) VALUES (${values})
       ON CONFLICT(product_id) DO UPDATE SET
         basis = excluded.basis, unit_price = excluded.unit_price,
         gap_reason = excluded.gap_reason, currency = excluded.currency,
         quoted_unit = excluded.quoted_unit, source_file = excluded.source_file,
         source_doc = excluded.source_doc, doc_date = excluded.doc_date,
         order_no = excluded.order_no, distinct_prices = excluded.distinct_prices,
         lowest = excluded.lowest, highest = excluded.highest,
         matched_by = excluded.matched_by, note = excluded.note,
         loaded_at = datetime('now')`.replace(/\s+/g, ' '),
  )
}

for (const p of file.priced) {
  // The file's own flag and the map's note are both worth carrying; a product can have
  // either, both or neither, and the report shows whatever there is.
  const note = [p.note, p.flags].filter(Boolean).join(' ') || null
  row(p.product, p.unitPrice, null, {
    quoted_unit: p.unit, source_file: file.sourceFile, source_doc: p.source,
    doc_date: p.docDate, order_no: p.orderNo, distinct_prices: p.distinctPrices,
    lowest: p.lowest, highest: p.highest, matched_by: p.match, note,
  })
  const spread = p.distinctPrices > 1 ? warn(`  ${p.distinctPrices} prices on record, ${p.lowest}–${p.highest}`) : ''
  const alias = p.match === 'alias' ? dim(`  ← ${p.fileProduct}`) : ''
  console.log(`${ok('·')} ${p.product.padEnd(52)} £${String(p.unitPrice).padEnd(8)}${alias}${spread}`)
}

for (const u of file.unpriced) {
  row(u.product, null, u.reason, {
    quoted_unit: null, source_file: file.sourceFile, source_doc: null, doc_date: null,
    order_no: null, distinct_prices: 1, lowest: null, highest: null,
    matched_by: 'exact', note: null,
  })
  console.log(`${warn('–')} ${u.product.padEnd(52)} ${dim(u.reason)}`)
}

const uncovered = products.filter((p) => p.active && !seen.has(p.id))
if (uncovered.length) {
  console.log(
    `\n${bad(String(uncovered.length))} active product(s) are in the catalogue but not in the price file. `
    + 'They will have no row at all, and the report will not be able to say why:',
  )
  for (const p of uncovered) console.log(`    ${p.name}`)
  console.log(dim('  Add each one to ALIAS or UNPRICED in prices/build.py and rebuild the JSON.'))
}

if (!APPLY) {
  console.log(`\n${dim(`${statements.length} statement(s) ready. Re-run with --apply to write them.`)}\n`)
  process.exit(uncovered.length || missing ? 1 : 0)
}

// One file rather than 93 `wrangler d1 execute` calls: those took minutes, and a run
// interrupted halfway would leave some products priced and the rest not, which the report
// would present as a set of real gaps.
const dir = mkdtempSync(join(tmpdir(), 'prices-'))
const path = join(dir, 'load-prices.sql')
try {
  writeFileSync(path, `${statements.map((s) => `${s};`).join('\n')}\n`, 'utf8')
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'mintsoft-portal', LOCAL ? '--local' : '--remote', '--file', path],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: 'inherit' },
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n${ok(`${statements.length} price row(s) written.`)}\n`)
if (uncovered.length || missing) process.exit(1)

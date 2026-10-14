/**
 * Re-attaches the Mintsoft lines Mercium created when they merged the shipment duplicates.
 *
 *   npm run remap              # show what it would do, write nothing
 *   npm run remap -- --apply   # do it
 *
 * WHAT HAPPENED
 *
 * Mintsoft used to carry a separate product per shipment -- MRK001-R-R, MRK004-R-R and so on
 * -- and the portal hid that by mapping many Mintsoft lines to one Maki product and summing
 * their stock. On 2026-10-14 Mercium began consolidating them: for each product they create
 * one new line holding the combined stock (RAM-MRK, 1821 ramekins) and zero the old ones.
 *
 * The new lines are not mapped to anything, so their stock is invisible to sites, while the
 * old mapped lines now read zero. The portal was telling restaurants there were no ramekins
 * with 1,821 of them on the shelf in Witham -- the exact failure the availability rules exist
 * to prevent, arriving from the warehouse rather than from our own code.
 *
 * HOW A LINE IS MATCHED, AND WHY NOT AUTOMATICALLY
 *
 * The consolidated SKU is usually an abbreviation that does NOT share a stem with the lines
 * it replaces: RAMEKIN went from R-R to RAM-MRK, the sushi plates from SPS-L to SPWWL-MRK,
 * the ToriPaitan bowl from TBT to TPWL-MRK. Stem matching gets four of ten, so it cannot be
 * trusted; and a wrong match here does not fail loudly, it tells a restaurant it may order
 * 1,821 of something it cannot have.
 *
 * So each line is matched one of two ways, both of them conservative:
 *
 *   MERGED_INTO   a reviewed table, keyed by the consolidated SKU. Each entry was read off
 *                 Mintsoft's own audit trail: Mercium zero the old lines for a product right
 *                 after creating its consolidated line, and those old lines are already
 *                 mapped, so the new line inherits the product that owned them. The evidence
 *                 for each is recorded beside it.
 *
 *   exact name    for anything not in the table, the line's Mintsoft name must normalise to
 *                 exactly one active product's name. "FOH KIMONO (M)NO APRON-MRK" matches
 *                 "FOH Kimono (M)No apron" and nothing else.
 *
 * Anything that matches neither is REPORTED AND LEFT ALONE. That is not a failure of this
 * script; it is the answer. The mapping screen shows unmapped lines, and a human decides.
 *
 * THE MERGE IS NOT FINISHED. Mercium were still working through the catalogue while this was
 * written -- a new consolidated line appeared ten minutes after the first snapshot. Re-run
 * this whenever they add more; it only ever acts on lines that are still unmapped.
 *
 * Writes only to our own database. It never calls Mintsoft and never writes to it.
 */
import { execFileSync } from 'node:child_process'

const APPLY = process.argv.includes('--apply')
const LOCAL = process.argv.includes('--local')

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

/**
 * Consolidated SKU -> the Maki product it belongs to, with how that was established.
 *
 * `zeroed` names the already-mapped SKUs Mercium emptied for that product in the same
 * session. That is the evidence: those lines belong to a known product, so the line that
 * took their stock belongs to the same one. Nothing here was matched on the name alone.
 */
const MERGED_INTO: Record<string, { product: string; zeroed?: string; stem?: string; note?: string }> = {
  'DONBURI - MRK': { product: 'Donburi Plates', zeroed: 'MRK005-DPD, MRK008-DPD, MRK010-DPD, MRK013-DPD' },
  'WSPWL-MRK': { product: 'Wooden side plate with logo', zeroed: 'MRK008/010/011/013-WSW-L' },
  'SPWWL-MRK': {
    product: 'Sushi plate wooden with logo',
    zeroed: 'MRK008/010/011/013-SPS-L',
    note: 'SPS-L, not SPS. The boat-shaped plate is a separate product on the SPS stem and was '
      + 'not part of this merge, so its lines stay where they are.',
  },
  'BCB-MRK': { product: 'Black Chopsticks', zeroed: 'MRK011113-BCB' },
  'RAM-MRK': { product: 'Ramekin', zeroed: 'MRK008/010/011/013-R-R' },
  'CHR-MRK': {
    product: 'Chairs',
    zeroed: 'MRK014-CHR',
    note: 'The ordinary chair, not "High Chairs - MRK008", which is on its own HCH stem.',
  },
  'RSHP-MRK': { product: 'Ramen spoon hard plastic', zeroed: 'MRK013-RSR-P' },
  'SRB-MRK': { product: 'Sushi Rice Box', zeroed: 'MRK010-SRS, MRK013-SRS' },
  'TPWL-MRK': { product: 'TORIPAITAN BOWL CERAMIC WHITE WITH LOGO(1400ML) - MRK002', zeroed: 'MRK008/010/013-TBT' },
  'DC-MRK': { product: 'Disposable chopsticks - MRK010', zeroed: 'MRK010 - DC, MRK014 - DC' },
  'M&R Hoodie(pink)- L': { product: 'M&R Hoodie(pink)- L - MRK010', zeroed: 'MRK010 - Hoodie - L' },
  'M&R Hoodie(pink)- XL': { product: 'M&R Hoodie(pink)- XL - MRK010', zeroed: 'MRK010 - Hoodie - XL' },
  'M&R Hoodie(pink)- XXL': { product: 'M&R Hoodie(pink)- XXL - MRK010', zeroed: 'MRK010 - Hoodie - XXL' },
  'M&R Hoodie (Black)- L': { product: 'M&R Hoodie (Black)- L - MRK010', zeroed: 'MRK010 - Hoodie(Black) - L' },
  'M&R Hoodie (Black)- XL': { product: 'M&R Hoodie (Black)- XL - MRK010', zeroed: 'MRK010 - Hoodie (Black) - XL' },
  'M&R Hoodie (Black)- XXL': { product: 'M&R Hoodie (Black)- XXL - MRK010', zeroed: 'MRK010 - Hoodie (Black) - XXL' },

  // The MRK014 shipment, which is not a merge at all -- just the next delivery, still using
  // the old per-shipment naming. These match their product's existing stem exactly.
  'MRK014-MHM': { product: 'MENU HOLDERS - MRK001', stem: 'MHM' },
  'MRK014-RTR - 900': {
    product: 'Round Table',
    stem: 'RTR-900',
    note: 'The 900mm round table. Not the 1100mm or the golden-rim variant, which are separate '
      + 'products on RTR-1100 and RTR-G.',
  },
  'MRK014-TDT': { product: 'Taiko Drum with Maki Logo', stem: 'TDT' },
  'MRK014-RTR-B': {
    product: 'Round Table Base',
    stem: 'RTR-B',
    note: 'RTR-B is unambiguous. A bare RTR is not -- it is used by both this product and '
      + '"Round Table Top (Copper)" -- so a bare RTR line must never be matched automatically.',
  },
  'MRK014-CHR': { product: 'Chairs', stem: 'CHR' },
}

const sql = (statement: string): unknown => {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'mintsoft-portal', LOCAL ? '--local' : '--remote', '--json', '--command', statement],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const parsed: unknown = JSON.parse(out.slice(out.indexOf('[')))
  return (Array.isArray(parsed) ? parsed[0] : parsed) as unknown
}

/** Case, punctuation and the shipment suffix. Nothing clever -- this decides stock. */
const norm = (s: string): string =>
  s.toLowerCase()
    .replace(/\s*-?\s*mrk\s*0*\d*\s*$/i, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

interface Line { mid: number; sku: string; name: string | null; available: number | null }
interface Product { id: number; name: string; active: number }

const lines = (sql(
  `SELECT sc.mintsoft_product_id AS mid, mp.sku, mp.name, SUM(sc.available) AS available
     FROM stock_cache sc
     LEFT JOIN mintsoft_products mp ON mp.mintsoft_product_id = sc.mintsoft_product_id
    WHERE sc.mintsoft_product_id NOT IN (SELECT mintsoft_product_id FROM product_mintsoft_map)
    GROUP BY sc.mintsoft_product_id
    ORDER BY available DESC`,
) as { results: Line[] }).results

const products = (sql('SELECT id, name, active FROM products') as { results: Product[] }).results
const active = products.filter((p) => p.active === 1)
const byName = new Map(active.map((p) => [p.name, p]))

/** Active products by normalised name, dropping any name two products share. */
const byNorm = new Map<string, Product | null>()
for (const p of active) {
  const k = norm(p.name)
  byNorm.set(k, byNorm.has(k) ? null : p)
}

console.log(`\n${lines.length} Mintsoft line(s) carry stock and are mapped to nothing.`
  + `${APPLY ? '' : dim('  (dry run — nothing will be written)')}\n`)

const statements: string[] = []
let mapped = 0, needsAHuman = 0, noStock = 0

for (const line of lines) {
  const qty = line.available ?? 0
  const label = `${String(line.mid).padEnd(6)}${(line.sku ?? '(not in the product mirror yet)').padEnd(26)}${String(qty).padStart(6)}`

  if (!line.sku) {
    // The product sync runs hourly and the stock sync quarter-hourly, so a line created in
    // between has stock here before it has a name. Nothing is wrong; it is just early.
    console.log(`${warn('?')} ${label}  ${dim('not in the product mirror yet — re-run after the next product sync')}`)
    needsAHuman++
    continue
  }

  const reviewed = MERGED_INTO[line.sku]
  const guess = reviewed ? byName.get(reviewed.product) : byNorm.get(norm(line.name ?? line.sku))
  const how = reviewed ? 'reviewed' : 'exact name'

  if (reviewed && !guess) {
    console.log(`${bad('!')} ${label}  ${bad(`the table names "${reviewed.product}", which is not an active product`)}`)
    needsAHuman++
    continue
  }
  if (!guess) {
    console.log(`${warn('?')} ${label}  ${dim(`"${line.name ?? ''}" matches no single active product — map it by hand`)}`)
    needsAHuman++
    continue
  }
  if (qty === 0) {
    // Mapping it is still right -- it is the same product and will carry stock again -- but
    // say so, because nothing on any screen changes today.
    noStock++
  }

  statements.push(
    `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
     SELECT ${guess.id}, mintsoft_product_id, sku, 0 FROM mintsoft_products
      WHERE mintsoft_product_id = ${line.mid}`.replace(/\s+/g, ' '),
  )
  mapped++
  const because = reviewed?.zeroed
    ? `; took the stock of ${reviewed.zeroed}`
    // The MRK014 lines are the next shipment rather than a merge, so nothing was replaced --
    // they simply carry this product's own SKU stem.
    : reviewed?.stem ? `; new shipment on this product's ${reviewed.stem} stem` : ''
  console.log(`${ok('·')} ${label}  → ${guess.name}  ${dim(`(${how}${because})`)}`)
  if (reviewed?.note) console.log(`    ${dim(reviewed.note)}`)
}

console.log(`\n${mapped} line(s) to map, ${needsAHuman} needing a human.`
  + (noStock ? `  ${dim(`${noStock} of them hold nothing today.`)}` : ''))

if (!APPLY) {
  console.log(dim('\nRe-run with --apply to write them.\n'))
  process.exit(0)
}

for (const statement of statements) sql(statement)
console.log(`\n${ok(`${statements.length} line(s) mapped.`)}\n`)

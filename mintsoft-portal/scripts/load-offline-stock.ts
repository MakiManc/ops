/**
 * Adds the stock held outside Mercium to the catalogue, on the email fulfilment route.
 *
 *   npm run offline-stock              # show what it would add, write nothing
 *   npm run offline-stock -- --apply   # write it
 *
 * WHERE THE LIST CAME FROM, AND WHY IT IS NOT THE LIST
 *
 * The source is https://forms.deanops.uk/api/inventory, behind the count sheet at
 * /inventory/count/. It is a STOCK COUNT, not a catalogue, and the difference decides
 * most of what follows. Specifically, on the copy read on 24 November 2026 it held 65
 * rows from a single count on 2026-11-03 by one person, and:
 *
 *   - 11 rows carry no usable item name: 4 are blank and 7 say "Unlabeled", with the
 *     description doing the work ("It looks like lid", "it looks like a wooden board").
 *     Nothing orderable can be built from those, so they are left out and listed.
 *
 *   - About a third of the named rows are equipment and fixtures, not stock: a toilet,
 *     two payment terminals, a POS terminal, gas stoves, an electric fryer, a pasta
 *     cooker, a sushi showcase, a stainless steel sink, a baby changing station. A GM
 *     ordering a toilet by the case is not a feature, so they are left out and listed.
 *
 *   - The quantities are one site's shelves on one day -- "Chopped Tomatoes: 1",
 *     "White Miso: 1 (sample from JFC)". They are NOT warehouse holdings available to
 *     21 sites, so no quantity from this file is imported anywhere. The email route
 *     tracks no stock figure in any case: that is the point of it.
 *
 *   - The locations are rooms in one building ("Dry store, Upstairs", "Freezer 1",
 *     "Upstairs secret store room"), with typo variants of each other. They describe
 *     where the counter walked, not a warehouse, so they are not imported either.
 *
 *   - Eight more look like MERCIUM stock counted where it stood, not a second
 *     warehouse's product line. Mercium's 103 products are China-imported durables and
 *     include no food, drink or takeaway packaging whatever; the count sheet overlaps
 *     them almost exactly on the durables. Those eight are listed for a decision rather
 *     than added, because a second "Cup" in another warehouse cannot be ordered beside
 *     "Blue Cups Round" and a GM cannot tell the two apart.
 *
 * So this script does not "load the list". It proposes a curated subset of it as
 * orderable products, prints every decision it made, and writes nothing until asked.
 * The three tables below are the decisions: edit them and re-run.
 *
 * NAME COLLISIONS ARE REPORTED, NEVER MERGED
 *
 * Several of these names already exist as Mercium products -- Ramen bowl above all. Two
 * products with the same name in different warehouses cannot go on one order, and a GM
 * choosing between two identical rows is a mistake waiting to happen. So a candidate
 * whose name already exists is skipped and reported for a human to name or merge. This
 * script never edits an existing product.
 *
 * Writes only to our own database. It never calls Mintsoft, and never emails anyone.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Candidate {
  /** The name as it will appear in the catalogue, tidied from the count sheet. */
  name: string
  /** What the count sheet called it, when that differs. Printed, not stored. */
  countedAs?: string
  category: string
  unit: 'Case' | 'Unit'
  note?: string
}

/**
 * The consumables worth putting in front of a GM.
 *
 * Units are taken from the count sheet with its typos corrected ("Caee", "Cae" -> Case).
 * Pack sizes are deliberately left unset: the count sheet records none, and a guessed
 * pack size is worse than an absent one -- it is the number a GM multiplies by.
 */
const ORDERABLE: Candidate[] = [
  // --- Ingredients and food -------------------------------------------------
  { name: 'Chopped Tomatoes', category: 'Ingredients', unit: 'Unit' },
  { name: 'Dark Soy Sauce', category: 'Ingredients', unit: 'Case' },
  { name: 'Dried mixed spices', category: 'Ingredients', unit: 'Unit' },
  { name: 'Gyoza Chicken', category: 'Frozen', unit: 'Case' },
  { name: 'Japanese Style Soy Sauce', category: 'Ingredients', unit: 'Case',
    countedAs: 'unit recorded as "Cae"' },
  { name: 'Kewpie Mayonnaise', category: 'Ingredients', unit: 'Unit' },
  { name: 'Rice Vinegar', category: 'Ingredients', unit: 'Case' },
  { name: 'Roasted Sesame Seeds', category: 'Ingredients', unit: 'Case' },
  { name: 'Shirakiku Edamame Regular', category: 'Frozen', unit: 'Case' },
  { name: 'Sliced boned and rolled pork belly', category: 'Frozen', unit: 'Unit',
    countedAs: 'name truncated in the count sheet' },
  { name: 'Spicy Bean Sauce', category: 'Ingredients', unit: 'Case' },
  { name: 'Sweet taro', category: 'Ingredients', unit: 'Case' },
  { name: 'White Miso', category: 'Ingredients', unit: 'Case',
    note: 'the counted stock was a sample from JFC, so confirm this is a real line before ordering' },

  // --- Drinks ---------------------------------------------------------------
  { name: 'Junmai Ginjo', category: 'Drinks', unit: 'Case' },
  { name: 'Wine', category: 'Drinks', unit: 'Case',
    note: 'the count sheet says only "Wine"; needs a real product name before a GM can order it' },

  // --- Packaging ------------------------------------------------------------
  { name: 'Burger box', category: 'Packaging', unit: 'Case' },
  { name: 'Colour grease paper', category: 'Packaging', unit: 'Case',
    countedAs: 'Color Grease Paper' },
  { name: 'EG-0.4L-PET takeaway box', category: 'Packaging', unit: 'Case',
    countedAs: 'EG-0.4L-PET' },
  { name: 'Sushi tray and party tray', category: 'Packaging', unit: 'Case',
    countedAs: 'Shushi tray and party tray' },
  { name: 'Takeaway Bottle', category: 'Packaging', unit: 'Case' },
  { name: 'Takeaway bowl', category: 'Packaging', unit: 'Case',
    countedAs: 'unit recorded as "Caee"' },
  { name: 'Takeaway cutlery', category: 'Packaging', unit: 'Case' },

  // --- Tableware ------------------------------------------------------------
  // Only the ones Mercium plainly does not stock. Everything else the count sheet lists
  // under this heading is in AMBIGUOUS below.
  { name: 'Wooden fork', category: 'Tableware', unit: 'Case' },

  // --- Smallwares -----------------------------------------------------------
  { name: 'Chopping board (white)', category: 'Smallwares', unit: 'Unit', countedAs: 'Chopping board' },
  { name: 'Kitchen timer', category: 'Smallwares', unit: 'Unit' },
  { name: 'Silicone mat', category: 'Smallwares', unit: 'Unit' },
]

/**
 * Counted items that look like stock Mercium ALREADY holds, so a human has to decide.
 *
 * This is the finding that shrank the list, and it is worth stating plainly: Mercium's
 * 103 products are China-imported durables -- tableware, furniture, signage, uniforms,
 * kitchen tools -- and no food, sauce, drink or takeaway packaging at all. The count
 * sheet overlaps Mercium almost exactly on the durables and not at all on the rest. The
 * likeliest reading is that these rows are MERCIUM stock sitting in a site's store room,
 * counted where it stood, rather than a second warehouse's product line.
 *
 * Adding them would create a near-duplicate under a vaguer name ("Cup" beside "Blue Cups
 * Round", "Tea pot" beside "CAST IRON TEA POT (900ML)"), and because the two would then
 * sit in different warehouses they could not go on one order. A GM choosing between
 * "Cup" and "Blue Cups Round" has been handed a trap.
 *
 * The exact-name check further down would not catch any of these, which is why they are
 * listed by hand. Resolving one means either deciding it IS the existing Mercium product
 * -- so nothing is added -- or giving it a name of its own and moving it to ORDERABLE.
 */
const AMBIGUOUS: { name: string; looksLike: string }[] = [
  { name: 'Cup', looksLike: 'Blue Cups Round / Blue Cups Sphere / Miso Soup Cups / Ceramic teacups / Tea cups' },
  { name: 'Glass (half pint)', looksLike: 'MAKI BIRU HALF PINT GLASSES - MRK001' },
  { name: 'Hoodie', looksLike: 'M&R Hoodie (Black) and (pink), L / XL / XXL' },
  { name: 'Plate', looksLike: 'White side plate / Donburi Plates / Round plate with gold coating' },
  { name: 'Ramen bowl', looksLike: 'Ramen Bowl Vegan / Ramen Bowl with logo orange line / TORIPAITAN BOWL CERAMIC' },
  { name: 'Sauce bowl', looksLike: 'Fresh Seal Bowl - MRK005 / RAMEKIN - MRK002' },
  { name: 'Serving plate', looksLike: 'SLATE SERVING PLATE - MRK011' },
  { name: 'Tea pot', looksLike: 'CAST IRON TEA POT (900ML) / Cast iron Tea Pot (600ml)' },
]

/**
 * Everything in the count sheet that is deliberately NOT a catalogue product, with why.
 *
 * Kept in the script rather than dropped silently, because "where did the toilet go" is
 * a reasonable question and the answer should be written down next to the decision.
 */
const NOT_ORDERABLE: { name: string; why: string }[] = [
  { name: 'Blender', why: 'equipment' },
  { name: 'Dojogo', why: 'payment terminal' },
  { name: 'Electric Fryer', why: 'equipment' },
  { name: 'Fridge rack', why: 'fixture' },
  { name: 'Gas Stoves', why: 'equipment' },
  { name: 'Halloween lights', why: 'one-off seasonal decoration' },
  { name: 'Horizontal changing station', why: 'fixture (baby changing unit)' },
  { name: 'Induction hub', why: 'equipment' },
  { name: 'Metal Designer stool', why: 'furniture' },
  { name: 'Pasta cooker', why: 'equipment' },
  { name: 'Payment Device', why: 'payment terminal' },
  { name: 'Pos terminal', why: 'equipment' },
  { name: 'Stainless steel sink', why: 'fixture' },
  { name: 'Steel soup pot', why: 'equipment' },
  { name: 'Sushi showcase', why: 'equipment' },
  { name: 'Toilet', why: 'fixture' },
  { name: 'Trash bin', why: 'equipment' },
  { name: '(4 rows with a blank item name)', why: 'no item name; descriptions only' },
  { name: '(7 rows named "Unlabeled")', why: 'no item name; descriptions only' },
]

const esc = (s: string) => s.replace(/'/g, "''")

function main(): void {
  const APPLY = process.argv.includes('--apply')
  const LOCAL = process.argv.includes('--local')

  const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
  const warn = (s: string) => `\x1b[33m${s}\x1b[0m`
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

  const sql = (statement: string): unknown => {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'mintsoft-portal', LOCAL ? '--local' : '--remote',
        '--json', '--command', statement],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    const parsed: unknown = JSON.parse(out.slice(out.indexOf('[')))
    return (Array.isArray(parsed) ? parsed[0] : parsed) as unknown
  }

  const existing = (sql(
    `SELECT id, name, supply_route FROM products`,
  ) as { results: { id: number; name: string; supply_route: string | null }[] }).results

  // Compared case-insensitively and without punctuation, because "Tea pot" and "Teapot"
  // are the same thing to everyone except a string comparison.
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const byKey = new Map(existing.map((p) => [key(p.name), p]))

  console.log('\nStock held outside Mercium, ordered by email rather than through Mintsoft.'
    + `${APPLY ? '' : dim('  (dry run — nothing will be written)')}\n`)

  const statements: string[] = []
  const collisions: { candidate: Candidate; existing: { id: number; name: string; supply_route: string | null } }[] = []
  const alreadyThere: Candidate[] = []
  const notes: Candidate[] = []

  for (const c of ORDERABLE) {
    const clash = byKey.get(key(c.name))
    if (clash) {
      // Already on this route from an earlier run: nothing to do and nothing to report.
      if (clash.supply_route === 'email') { alreadyThere.push(c); continue }
      collisions.push({ candidate: c, existing: clash })
      continue
    }
    statements.push(
      `INSERT INTO products (name, category, stock_type, unit, supply_route, active)`
      + ` VALUES ('${esc(c.name)}', '${esc(c.category)}', 'internal', '${esc(c.unit)}', 'email', 1)`,
    )
    if (c.note) notes.push(c)
    const was = c.countedAs ? dim(`  (${c.countedAs})`) : ''
    console.log(`${ok('+')} ${c.name.slice(0, 44).padEnd(46)}${c.category.padEnd(14)}${c.unit}${was}`)
  }

  if (alreadyThere.length > 0) {
    console.log(dim(`\n${alreadyThere.length} already on the email route from an earlier run.`))
  }

  if (collisions.length > 0) {
    console.log(`\n${warn(String(collisions.length))} name(s) already exist as Mercium products, so `
      + 'they are NOT added:')
    for (const { candidate, existing: e } of collisions) {
      console.log(`    ${candidate.name.slice(0, 44).padEnd(46)}`
        + dim(`already product #${e.id} "${e.name}" on the ${e.supply_route ?? 'mercium'} route`))
    }
    console.log(dim('    Two products of the same name in different warehouses cannot go on one'))
    console.log(dim('    order, and a GM cannot tell them apart. Rename one, or decide which'))
    console.log(dim('    warehouse holds it, then re-run.'))
  }

  if (notes.length > 0) {
    console.log(`\n${warn(String(notes.length))} added but worth a look:`)
    for (const c of notes) console.log(`    ${c.name.slice(0, 44).padEnd(46)}${dim(c.note!)}`)
  }

  console.log(`\n${warn(String(AMBIGUOUS.length))} counted item(s) look like stock Mercium already `
    + 'holds, so they are NOT added until somebody says which product they are:')
  for (const a of AMBIGUOUS) {
    console.log(`    ${a.name.slice(0, 24).padEnd(26)}${dim(`looks like  ${a.looksLike}`)}`)
  }

  console.log(`\n${dim(`${NOT_ORDERABLE.length} entries in the count sheet are equipment or unnamed, and left out:`)}`)
  for (const x of NOT_ORDERABLE) {
    console.log(dim(`    ${x.name.slice(0, 44).padEnd(46)}${x.why}`))
  }

  console.log(`\n${statements.length} product(s) to add, ${AMBIGUOUS.length} waiting on a decision, `
    + `${collisions.length} blocked by an exact name clash, ${alreadyThere.length} already there.`)
  console.log(dim('None of them carries a stock figure or a recharge price: this route tracks no'))
  console.log(dim('stock, and a franchise order containing one will warn at approval until a price'))
  console.log(dim('is set. Nothing here is sent to Mintsoft.'))

  if (statements.length === 0) {
    console.log()
    return
  }

  if (!APPLY) {
    console.log(dim('\nRe-run with --apply to write them.\n'))
    return
  }

  // One file rather than one wrangler call per product: a run interrupted halfway would
  // leave a partial catalogue, and a GM seeing half the list is worse than seeing none.
  const dir = mkdtempSync(join(tmpdir(), 'offline-stock-'))
  const path = join(dir, 'offline-stock.sql')
  try {
    writeFileSync(path, `${statements.map((s) => `${s};`).join('\n')}\n`, 'utf8')
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'mintsoft-portal', LOCAL ? '--local' : '--remote', '--file', path],
      { encoding: 'utf8', stdio: 'inherit', maxBuffer: 32 * 1024 * 1024 },
    )
    console.log(ok(`\nAdded ${statements.length} product(s).\n`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()

export { ORDERABLE, AMBIGUOUS, NOT_ORDERABLE }

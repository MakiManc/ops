/**
 * Sets what a franchise is charged for a product, from what it cost us.
 *
 *   npm run recharge              # show what it would change, write nothing
 *   npm run recharge -- --apply   # write it
 *
 * WHY THIS EXISTS
 *
 * Franchise sites are recharged and corporate sites never are, so the catalogue shows a
 * franchisee a price and checkApproval refuses to sign off any line that has not got one:
 * invoicing a franchisee nothing for a case of ramekins is worse than making someone set
 * a price first. Until the four MAF sites were added nothing had recharge = 1, the column
 * was never read, and it came to be empty -- migration 0012 cleared the seed's fake
 * 2.50/45 when the real supplier costs arrived in product_prices, and nothing put a real
 * recharge price in its place.
 *
 * THE RULE
 *
 * Supplier cost plus the markup, to the penny. Ross set it at 15% on 22 October 2026.
 *
 * Two things about that cost, both worth knowing before anyone reads a franchise invoice:
 *
 *   It is GOODS ONLY. The China Stock Price File's own Read me says so: supplier prices
 *   exclude shipping, quoted per CBM at GBP 200-210 with no per-product volume recorded
 *   anywhere, and they exclude UK VAT and duty. So 15% on top is not 15% of margin --
 *   freight and duty come out of it first.
 *
 *   28 of 93 products have no cost on record at all. They are left NULL rather than set
 *   to zero, so they keep blocking at approval. A franchise line priced at zero is an
 *   invoice that silently gives stock away; a line that refuses to approve is somebody
 *   being asked a question. The second is the right failure.
 *
 * Writes only to our own database. It never calls Mintsoft.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Ross, 22 October 2026. Change it here and re-run; the dry run shows every movement. */
export const MARKUP = 1.15

/**
 * Cost plus the markup, to the penny, rounding a half-penny up as money does.
 *
 * `Math.round(cost * MARKUP * 100) / 100` is the obvious way to write this and it is
 * wrong. 0.50 * 1.15 is exactly 0.575, but in binary floating point it comes out as
 * 0.5749999999999999, so times 100 is 57.49999999999999 and Math.round takes it DOWN to
 * 57. A 50p item would have been charged 57p rather than 58p, and so would every other
 * exact half-penny -- a systematic underprice on a franchise invoice, in the one
 * direction nobody ever queries.
 *
 * So the half is compared with a tolerance far finer than a penny and far coarser than
 * the representation error, and ties go up.
 */
export const charge = (cost: number, markup: number = MARKUP): number => {
  const scaled = cost * markup * 100
  const whole = Math.floor(scaled)
  return (scaled - whole >= 0.5 - 1e-9 ? whole + 1 : whole) / 100
}

interface Row {
  id: number
  name: string
  cost: number | null
  gap_reason: string | null
  current: number | null
}

function main(): void {
  const APPLY = process.argv.includes('--apply')
  const LOCAL = process.argv.includes('--local')

  const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
  const warn = (s: string) => `\x1b[33m${s}\x1b[0m`
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

  const sql = (statement: string): unknown => {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'mintsoft-portal', LOCAL ? '--local' : '--remote', '--json', '--command', statement],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    const parsed: unknown = JSON.parse(out.slice(out.indexOf('[')))
    return (Array.isArray(parsed) ? parsed[0] : parsed) as unknown
  }

  const rows = (sql(
    `SELECT p.id, p.name, pp.unit_price AS cost, pp.gap_reason,
            p.recharge_unit_price AS current
       FROM products p
       LEFT JOIN product_prices pp ON pp.product_id = p.id
      WHERE p.active = 1
      ORDER BY p.name`,
  ) as { results: Row[] }).results

  console.log(`\nRecharge price = supplier cost + ${Math.round((MARKUP - 1) * 100)}%.`
    + `${APPLY ? '' : dim('  (dry run — nothing will be written)')}\n`)

  const statements: string[] = []
  let priced = 0, unchanged = 0
  const cannotPrice = rows.filter((r) => r.cost === null)

  for (const r of rows) {
    if (r.cost === null) continue
    const to = charge(r.cost)
    if (r.current !== null && Math.abs(r.current - to) < 0.005) { unchanged++; continue }
    statements.push(
      `UPDATE products SET recharge_unit_price = ${to}, updated_at = datetime('now') WHERE id = ${r.id}`,
    )
    priced++
    const was = r.current === null ? 'unpriced' : `was £${r.current.toFixed(2)}`
    console.log(`${ok('·')} ${r.name.slice(0, 50).padEnd(52)}cost £${r.cost.toFixed(2).padStart(8)}`
      + `  → charge £${to.toFixed(2).padStart(8)}   ${dim(was)}`)
  }

  if (cannotPrice.length > 0) {
    console.log(`\n${warn(String(cannotPrice.length))} product(s) have no supplier cost, so they get no `
      + 'recharge price and a franchise order containing one is still refused at approval:')
    for (const r of cannotPrice) {
      console.log(`    ${r.name.slice(0, 50).padEnd(52)}${dim(r.gap_reason ?? 'not in the price file at all')}`)
    }
  }

  console.log(`\n${priced} price(s) to set, ${unchanged} already correct, `
    + `${cannotPrice.length} that cannot be priced.`)

  if (!APPLY) {
    console.log(dim('\nRe-run with --apply to write them.\n'))
    return
  }
  // One file rather than 65 wrangler calls: those took minutes, and a run interrupted
  // halfway would leave some products priced and the rest not -- which, on a franchise
  // site, is the difference between an order that approves and one that refuses.
  const dir = mkdtempSync(join(tmpdir(), 'recharge-'))
  const path = join(dir, 'recharge.sql')
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
  console.log(`\n${ok(`${statements.length} recharge price(s) written.`)}\n`)
}

/**
 * Run only when invoked, not when imported.
 *
 * The rounding above is the part worth testing, and a test has to import this module to
 * reach it. Without the guard that import runs the whole script -- every wrangler call,
 * and the writes too if --apply happened to be on the command line.
 */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()

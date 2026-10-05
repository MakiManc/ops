/**
 * Reconciles every order the portal has sent against what Mintsoft says. READ ONLY
 * against Mintsoft; the only writes are to our own database.
 *
 *   npm run backfill:orders            # show what it would change, write nothing
 *   npm run backfill:orders -- --apply # write it
 *
 * Why this exists. The quarter-hourly sync only ever looked at orders it still thought
 * were 'posted', and only wrote tracking when Mintsoft had both a number and a link. So
 * on 2026-10-05 the All orders page was wrong about half of what it showed:
 *
 *   - MR-M10-20260924-001 had been despatched on 2 October with a DPD consignment number.
 *     The portal still said "Mercium have it and are picking it".
 *   - Two more were despatched with tracking_url stored as "" and no number at all.
 *   - MR-M9-20260925-001 was CANCELLED at Mercium. The portal said it was being picked.
 *   - MR-M16-20261004-001 was ON BACK ORDER. The portal said it was being picked.
 *
 * The sync is fixed for all of that going forward. This is the one pass over the orders
 * that were already wrong, and it stays in the repo because it is the reconcile the
 * handover has listed as missing since Phase 4 -- worth running whenever the two systems
 * are suspected of having drifted.
 *
 * It never moves our own status backwards and never invents one. posted -> despatched is
 * the only transition it makes, because that is the only one the warehouse can tell us
 * about: Mintsoft has no "delivered", and a cancellation at their end is recorded as
 * their status rather than ours, so the portal's own lifecycle stays the thing the send
 * path and the write gate reason about.
 */
import { execFileSync } from 'node:child_process'
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import { MINTSOFT_ORDER_STATUS, mintsoftStatusNeedsAttention } from '../src/lib/mintsoft/order-status.ts'
import type { Order } from '../src/lib/mintsoft/types.ts'

const APPLY = process.argv.includes('--apply')
const LOCAL = process.argv.includes('--local')

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

/** Mintsoft sends "" where it means "none". */
const blank = (v: string | null | undefined): string | null =>
  v === null || v === undefined || String(v).trim() === '' ? null : String(v)

const sql = (statement: string): unknown => {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'mintsoft-portal', LOCAL ? '--local' : '--remote', '--json', '--command', statement],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const parsed: unknown = JSON.parse(out.slice(out.indexOf('[')))
  return (Array.isArray(parsed) ? parsed[0] : parsed) as unknown
}

interface Row {
  id: number; order_number: string; mintsoft_order_id: number; status: string
  tracking_number: string | null; tracking_url: string | null; mintsoft_status_id: number | null
}

const rows = (sql(
  `SELECT id, order_number, mintsoft_order_id, status, tracking_number, tracking_url, mintsoft_status_id
     FROM orders WHERE mintsoft_order_id IS NOT NULL ORDER BY id`,
) as { results: Row[] }).results

console.log(`\n${rows.length} order(s) have been sent to Mercium.${APPLY ? '' : dim('  (dry run — nothing will be written)')}\n`)

const client = new MintsoftReadOnlyClient({
  username: process.env.MINTSOFT_USERNAME,
  password: process.env.MINTSOFT_PASSWORD,
  apiKey: process.env.MINTSOFT_API_KEY,
  throttleMs: 150,
})

const quote = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)
const statements: string[] = []
let unreadable = 0
let attention = 0

for (const row of rows) {
  const res = await client.get<Order>(`/api/Order/${row.mintsoft_order_id}`)
  if (res.status !== 200 || !res.data) {
    // Not being able to read an order is not evidence about it, so nothing is written.
    console.log(`${bad('?')} ${row.order_number}  could not read Mintsoft order ${row.mintsoft_order_id} (HTTP ${res.status})`)
    unreadable++
    continue
  }
  const o = res.data
  const theirStatus = typeof o.OrderStatusId === 'number' ? o.OrderStatusId : null
  const tn = blank(o.TrackingNumber)
  const tu = blank(o.TrackingURL)
  const despatched = blank(o.DespatchDate)

  const sets: string[] = []
  const notes: string[] = []

  if (theirStatus !== null && theirStatus !== row.mintsoft_status_id) {
    sets.push(`mintsoft_status_id = ${theirStatus}`, `mintsoft_status_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
    notes.push(`Mercium: ${MINTSOFT_ORDER_STATUS[theirStatus] ?? theirStatus}`)
  }
  if (tn && tn !== row.tracking_number) { sets.push(`tracking_number = ${quote(tn)}`); notes.push(`tracking ${tn}`) }
  if (tu && tu !== row.tracking_url) { sets.push(`tracking_url = ${quote(tu)}`); notes.push('link') }
  // Blanks that were stored as "" are cleared, so "none" stops counting as a value.
  if (!tn && row.tracking_number === '') sets.push('tracking_number = NULL')
  if (!tu && row.tracking_url === '') { sets.push('tracking_url = NULL'); notes.push('cleared empty link') }

  // The one transition this makes. Never backwards, and never past despatched.
  if (despatched && row.status === 'posted') {
    sets.push(`status = 'despatched'`, `despatched_at = ${quote(despatched)}`)
    notes.push('posted → despatched')
  }

  const flag = mintsoftStatusNeedsAttention(theirStatus)
  if (flag) attention++

  if (sets.length === 0) {
    console.log(`${dim('·')} ${row.order_number}  ${dim('nothing to change')}`)
    continue
  }
  statements.push(
    `UPDATE orders SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ${row.id};`,
  )
  console.log(`${flag ? warn('!') : ok('→')} ${row.order_number}  ${notes.join(', ')}`)
}

console.log('')
if (unreadable) console.log(bad(`${unreadable} order(s) could not be read, and were left alone.`))
if (attention) {
  console.log(warn(`${attention} order(s) are at a Mercium status that has stopped them. They are`))
  console.log(warn('flagged on the orders page, and want a word with Mercium rather than a code change.'))
}

if (statements.length === 0) { console.log(ok('\nNothing to write.\n')); process.exit(0) }

if (!APPLY) {
  console.log(dim(`\n${statements.length} statement(s) would be written. Re-run with --apply.\n`))
  for (const st of statements) console.log(dim(`  ${st}`))
  console.log('')
  process.exit(0)
}

sql(statements.join('\n'))
console.log(ok(`\n${statements.length} order(s) updated.\n`))

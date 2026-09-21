/**
 * Checks Mintsoft credentials. READ ONLY, and prints no secret.
 *
 *   npm run check:credentials
 *
 * Mintsoft accepts one thing on the wire — an `ms-apikey` header — but there are three
 * ways to end up holding one, and they are not interchangeable. This checks whichever
 * are present, independently, and says what each is good for:
 *
 *   MINTSOFT_USERNAME + MINTSOFT_PASSWORD  the API user's login. Exchanged at POST
 *                                          /api/Auth for a key, and re-exchanged when
 *                                          that key expires. The only form that can
 *                                          drive the scheduled sync.
 *   MINTSOFT_API_KEY                       a key already minted. Dies 24 hours after it
 *                                          was issued and cannot be renewed here, so it
 *                                          suits a one-off run and nothing more.
 *   MINTSOFT_PROXY_AUTH=true               the key lives upstream and a proxy attaches
 *                                          it. Never enters this process at all.
 *
 * Each form is checked by reading /api/Client and /api/Warehouse — both on the client's
 * read allow-list, both harmless. Names are printed because "which clients can this user
 * see?" is the question that decides whether we are safely scoped to Maki & Ramen. No
 * other field is read, nothing is written, and nothing is dumped to disk.
 */
import {
  MintsoftReadOnlyClient,
  type AuthMode,
  type ClientOptions,
} from '../src/lib/mintsoft/readonly-client.ts'
import { inspectKeyShape } from '../src/lib/mintsoft/discovery-analysis.ts'
import type { Client, Warehouse } from '../src/lib/mintsoft/types.ts'

const BASE = 'https://api.mintsoft.co.uk'

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

interface Candidate {
  mode: AuthMode
  label: string
  source: string
  opts: ClientOptions
}

/** What is actually set in the environment. Values are read, never printed. */
function candidates(): { present: Candidate[]; absent: string[] } {
  const username = process.env.MINTSOFT_USERNAME
  const password = process.env.MINTSOFT_PASSWORD
  const apiKey = process.env.MINTSOFT_API_KEY
  const proxy = process.env.MINTSOFT_PROXY_AUTH === 'true'

  const present: Candidate[] = []
  const absent: string[] = []

  if (username && password) {
    present.push({
      mode: 'password',
      label: 'username + password',
      source: 'MINTSOFT_USERNAME / MINTSOFT_PASSWORD',
      opts: { username, password, throttleMs: 250 },
    })
  } else if (username || password) {
    absent.push(
      `username + password — only ${username ? 'MINTSOFT_USERNAME' : 'MINTSOFT_PASSWORD'} is set. ` +
        'Both are needed; a half-set pair is almost always a copy-paste that stopped early.',
    )
  } else {
    absent.push('username + password — MINTSOFT_USERNAME and MINTSOFT_PASSWORD are not set')
  }

  if (apiKey) {
    present.push({
      mode: 'key',
      label: 'pre-minted API key',
      source: 'MINTSOFT_API_KEY',
      opts: { apiKey, throttleMs: 250 },
    })
  } else {
    absent.push('pre-minted API key — MINTSOFT_API_KEY is not set')
  }

  if (proxy) {
    present.push({
      mode: 'proxy',
      label: 'proxy-attached key',
      source: 'MINTSOFT_PROXY_AUTH=true',
      opts: { proxyAuth: true, throttleMs: 250 },
    })
  } else {
    absent.push('proxy-attached key — MINTSOFT_PROXY_AUTH is not true')
  }

  return { present, absent }
}

/** Confirms the host answers at all, so a credential failure is not misread as an outage. */
async function reachability(): Promise<boolean> {
  process.stdout.write('  api.mintsoft.co.uk … ')
  try {
    const res = await fetch(`${BASE}/api/Client`, { headers: { Accept: 'application/json' } })
    // 401 is the right answer to an unauthenticated read: the host is up and enforcing.
    if (res.status === 401) {
      console.log(ok('reachable') + dim('  (HTTP 401 unauthenticated, as expected)'))
      return true
    }
    console.log(ok('reachable') + dim(`  (HTTP ${res.status} unauthenticated)`))
    return true
  } catch (err) {
    console.log(bad('unreachable') + dim(`  (${(err as Error).message})`))
    return false
  }
}

interface Result {
  candidate: Candidate
  passed: boolean
  notes: string[]
}

async function check(candidate: Candidate): Promise<Result> {
  const notes: string[] = []
  console.log(`\n${candidate.label}  ${dim(candidate.source)}`)

  const client = new MintsoftReadOnlyClient(candidate.opts)

  // Only the password form has an exchange to make. The other two already hold a key,
  // or never see one.
  if (candidate.mode === 'password') {
    process.stdout.write('  POST /api/Auth … ')
    try {
      await client.authenticate()
    } catch (err) {
      console.log(bad('failed') + dim(`  (${(err as Error).message})`))
      notes.push('The login was rejected. Check for a trailing space or newline on either value.')
      return { candidate, passed: false, notes }
    }
    const shape = client.describeKey(inspectKeyShape)
    console.log(
      ok('key issued') +
        dim(`  (${shape?.length ?? 0} chars, jwt=${shape?.looksLikeJwt ?? false}` +
          `${shape?.expiresAt ? `, expires ${shape.expiresAt}` : ''})`),
    )
  }

  process.stdout.write('  GET  /api/Client … ')
  const clientsRes = await client.get<Client[]>('/api/Client')
  const clients = clientsRes.data
  if (!Array.isArray(clients)) {
    // Mintsoft documents /api/Client as admin-only, so a 403 here is a scope answer, not
    // a credential failure. A 401 is the credential failing.
    const isAuth = clientsRes.status === 401
    console.log(
      (isAuth ? bad('rejected') : dim('refused')) + dim(`  (HTTP ${clientsRes.status})`),
    )
    if (isAuth) {
      notes.push(
        candidate.mode === 'password'
          ? 'Authenticated, then the key was refused — unexpected; worth raising with Mercium.'
          : 'The key was rejected. Mintsoft keys last 24 hours, so an old one reads exactly like this.',
      )
      return { candidate, passed: false, notes }
    }
    notes.push(
      `/api/Client is admin-only and returned HTTP ${clientsRes.status}. That is not a ` +
        'failure, but it means this run cannot confirm whether other clients are visible — ' +
        'pin MINTSOFT_CLIENT_ID before Phase 2 rather than assume we are alone.',
    )
  } else {
    console.log(ok('ok') + dim(`  (${clients.length} client(s) visible)`))
    for (const c of clients) console.log(`       · ${c.Name ?? '(unnamed)'}  ${dim(`id ${c.ID}`)}`)
    if (clients.length > 1) {
      notes.push(
        `${clients.length} clients are visible to this user. Every call must pin ` +
          'MINTSOFT_CLIENT_ID, or we risk reading another client\'s stock.',
      )
    }
  }

  process.stdout.write('  GET  /api/Warehouse … ')
  const whRes = await client.get<Warehouse[]>('/api/Warehouse')
  const warehouses = whRes.data
  if (!Array.isArray(warehouses)) {
    console.log(dim(`refused  (HTTP ${whRes.status})`))
  } else {
    console.log(ok('ok') + dim(`  (${warehouses.length} warehouse(s))`))
    for (const w of warehouses) console.log(`       · ${w.Name ?? '(unnamed)'}  ${dim(`id ${w.ID}`)}`)
  }

  if (candidate.mode === 'key') {
    notes.push(
      'This works, but a Mintsoft key expires 24 hours after it was issued and this ' +
        'client cannot renew it. Fine for a discovery run today; it cannot drive the sync.',
    )
  }
  if (candidate.mode === 'proxy') {
    notes.push(
      'This works and the key never enters the session. The same 24-hour expiry applies ' +
        'upstream, so it will need replacing tomorrow unless the login is supplied instead.',
    )
  }
  if (candidate.mode === 'password') {
    notes.push('This is the form the scheduled sync needs. Nothing else has to be supplied.')
  }

  return { candidate, passed: true, notes }
}

async function main() {
  console.log('\nMintsoft credential check' + dim('  — read-only, prints no secret'))
  console.log('\nReachability')
  const up = await reachability()

  const { present, absent } = candidates()

  if (present.length === 0) {
    console.log('\n' + bad('No credential is set.') + ' Nothing to check.\n')
    for (const a of absent) console.log(`  · ${a}`)
    console.log('\nSee DEPLOY.md — "Where the Mintsoft credentials go".\n')
    process.exit(1)
  }

  if (!up) {
    console.log('\n' + bad('The API is unreachable, so a credential cannot be checked.') + '\n')
    process.exit(1)
  }

  console.log(`\nChecking ${present.length} of 3 credential forms.`)
  for (const a of absent) console.log(dim(`  (skipped) ${a}`))

  const results: Result[] = []
  for (const c of present) results.push(await check(c))

  console.log('\nVerdict')
  for (const r of results) {
    console.log(`  ${r.passed ? ok('PASS') : bad('FAIL')}  ${r.candidate.label}`)
    for (const n of r.notes) console.log(`        ${n}`)
  }

  const passed = results.filter((r) => r.passed)
  const canSync = passed.some((r) => r.candidate.mode === 'password')
  console.log('')
  if (passed.length === 0) {
    console.log(bad('No credential worked.') + ' Nothing can read Mintsoft yet.')
  } else if (canSync) {
    console.log(ok('Ready.') + ' The login works, so discovery and the scheduled sync are both unblocked.')
  } else {
    console.log(
      ok('Ready for a one-off run.') +
        ' Discovery can run now, but the scheduled sync still needs\n  MINTSOFT_USERNAME and MINTSOFT_PASSWORD, because a key expires within 24 hours.',
    )
  }
  console.log(dim('  Writes remain off: MINTSOFT_WRITES_ENABLED is unchanged by this script.\n'))

  process.exit(passed.length === 0 ? 1 : 0)
}

main().catch((err) => {
  // Never print the error object wholesale: a thrown fetch error can carry the request.
  console.error('\n' + bad('check failed') + `: ${(err as Error).message}\n`)
  process.exit(1)
})

/**
 * The list of emails to paste into the Google OAuth consent screen's test users.
 *
 *   npm run testers
 *
 * Why this exists. Site logins are shared gmail accounts, and a gmail account belongs to
 * no Google organisation, so the consent screen cannot be Internal. If it also cannot be
 * published to In production, the only way in is External + Testing, where Google admits
 * nobody except the accounts named on the test user list. That list is maintained by
 * hand in the Cloud console — there is no API for it — and it is entirely separate from
 * the portal's own `users` table.
 *
 * So the two lists drift, silently, in the one direction that hurts: add a GM on Sites
 * and people and they are a valid portal user who Google will not let through the door.
 * The symptom is a sign-in failure that looks nothing like a missing account, because it
 * happens on Google's page before the portal is ever reached.
 *
 * This prints the list to paste, and — the point of it — names who is new since the last
 * time it was pasted, so a single added GM does not have to be spotted by eye among
 * twenty-four unchanged lines.
 *
 * Reads the deployed database through wrangler, which already holds the Cloudflare
 * credentials. READ ONLY.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

/** Google's cap on the test user list. Twenty-four sites is nowhere near it, but a
 *  franchise network that grows past it has a hard problem, not a slow one. */
const GOOGLE_TEST_USER_CAP = 100

const OUT = 'seed/google-test-users.txt'

/** Inactive people are deliberately excluded: someone switched off in the portal should
 *  not be handed a way past Google either. */
const QUERY = `SELECT email FROM users WHERE active = 1 ORDER BY email`

function emailsFromD1(): string[] {
  const local = process.argv.includes('--local')
  // stderr is left alone on purpose -- wrangler's proxy warning goes there, and merging
  // it into stdout would put a '[' in front of the JSON.
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'mintsoft-portal', local ? '--local' : '--remote', '--json', '--command', QUERY],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
  const parsed: unknown = JSON.parse(out.slice(out.indexOf('[')))
  const first = (Array.isArray(parsed) ? parsed[0] : (parsed as { result: unknown[] }).result?.[0]) as
    { results: { email: string }[] }
  return first.results.map((r) => r.email)
}

const emails = emailsFromD1()
const previous = existsSync(OUT)
  ? readFileSync(OUT, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  : []

const added = emails.filter((e) => !previous.includes(e))
const gone = previous.filter((e) => !emails.includes(e))

console.log(`\n${emails.length} active account(s). Paste all of them:\n`)
console.log(emails.join('\n'))

if (previous.length === 0) {
  console.log(dim(`\nFirst run — nothing to compare against. ${OUT} written; run this again after the next change to Sites and people.`))
} else if (added.length === 0 && gone.length === 0) {
  console.log(ok('\nUnchanged since the last run. Nothing to add in Google.'))
} else {
  if (added.length) {
    console.log(bad(`\nNEW since the last run — these ${added.length} cannot sign in until they are added in Google:`))
    console.log(added.map((e) => `  ${e}`).join('\n'))
  }
  if (gone.length) {
    // Not urgent and not a security hole: the portal turns them away on its own. Left
    // on the list they are only clutter, and clutter against a cap of 100.
    console.log(dim(`\nNo longer active in the portal (safe to remove from Google, in no hurry):`))
    console.log(gone.map((e) => `  ${e}`).join('\n'))
  }
}

if (emails.length > GOOGLE_TEST_USER_CAP) {
  console.log(bad(`\n${emails.length} accounts exceeds Google's limit of ${GOOGLE_TEST_USER_CAP} test users.`))
  console.log(bad('Testing status can no longer cover everyone. The consent screen has to be published to In production.'))
}

writeFileSync(OUT, `${emails.join('\n')}\n`)
console.log(dim(`\nWritten to ${OUT}. It is git-ignored — these are staff addresses.\n`))
console.log(dim('Paste into: Google Cloud console -> Google Auth Platform -> Audience -> Test users -> Add users.\n'))

/**
 * Everyone who may sign in, in the shape Google's test user box wants.
 *
 *   npm run testers
 *
 * Read this before using it, because the obvious reason to want it is the wrong one.
 * Google's test user list does NOT gate access to this portal and adding people to it
 * will not let anybody in. An app that asks only for name, email address and profile --
 * which is all Sign in with Google asks for, and all SignIn.tsx uses -- is exempt from
 * the Testing-status rules by Google's own documentation: its users "do not need to be
 * in the trusted user list". DEPLOY.md quotes the passage. What does gate access is the
 * audience being Internal rather than External, and no list can work around that.
 *
 * So this exists for two narrower jobs. One: if the portal ever asks for a real scope --
 * reading a calendar, sending mail as someone -- the exemption stops applying, Testing
 * status starts turning people away, and the list suddenly matters. Two: it is simply
 * the current roster in one pasteable block, which is worth having whether or not Google
 * ever wants it.
 *
 * Either way it names who is new since the last run, because nobody spots one changed
 * line among twenty-four unchanged ones.
 *
 * Reads the deployed database through wrangler, which already holds the Cloudflare
 * credentials. READ ONLY.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

/** Google's cap on the test user list, for the day the exemption above stops applying.
 *  Twenty-four sites is nowhere near it; a network that grows past it cannot use Testing
 *  status at all and has to publish. */
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
console.log(dim('If the list is wanted: Google Cloud console -> Google Auth Platform -> Audience -> Test users -> Add users.'))
console.log(dim('It is not what lets anyone in, though. See the header of this script, and DEPLOY.md.\n'))

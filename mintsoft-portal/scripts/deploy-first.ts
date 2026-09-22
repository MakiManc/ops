/**
 * First-time deploy of the portal to Cloudflare. Run once, then use DEPLOY.md.
 *
 *   npm run deploy:first
 *
 * Needs, in the environment:
 *   CLOUDFLARE_API_TOKEN    scopes: Account > Cloudflare Pages > Edit, Account > D1 > Edit
 *   CLOUDFLARE_ACCOUNT_ID
 *   GOOGLE_CLIENT_ID        the OAuth web client id
 *   SESSION_SECRET          openssl rand -base64 48
 *   MINTSOFT_USERNAME/PASSWORD   optional here; needed before the send path is used
 *
 * Everything is checked before anything is created, because a half-built project is
 * worse than none: you end up unsure which of the steps ran.
 *
 * ORDER MATTERS, and the old runbook had it wrong. GOOGLE_CLIENT_ID is baked into the
 * bundle at BUILD time as VITE_GOOGLE_CLIENT_ID. Building before it is known produces a
 * deployable site where every sign-in fails, and no amount of setting the secret
 * afterwards fixes it — the id has to be in the bundle. So: check, build, deploy.
 *
 * The one thing that genuinely cannot be done in advance is registering the deployed
 * URL as an authorised JavaScript origin on the Google client, because the URL does not
 * exist until the deploy finishes. This prints the exact value to paste.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PROJECT = 'mintsoft-portal'
const DB = 'mintsoft-portal'
const ok = (s: string) => `\x1b[32m${s}\x1b[0m`
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

const run = (args: string[], opts: { quiet?: boolean } = {}) => {
  const out = execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8', stdio: opts.quiet ? 'pipe' : ['pipe', 'pipe', 'inherit'],
  })
  return out
}

/** Everything that must be true before anything is created. */
function preflight(): string[] {
  const problems: string[] = []
  for (const [name, hint] of [
    ['CLOUDFLARE_API_TOKEN', 'dash.cloudflare.com/profile/api-tokens — Pages:Edit and D1:Edit'],
    ['CLOUDFLARE_ACCOUNT_ID', 'Workers & Pages → Overview, right-hand rail'],
    ['GOOGLE_CLIENT_ID', 'the OAuth web client id from the Google Cloud console'],
    ['SESSION_SECRET', "generate it: openssl rand -base64 48"],
  ] as const) {
    if (!process.env[name]) problems.push(`${name} is not set  ${dim(`(${hint})`)}`)
  }
  if (!existsSync('seed/sites.csv') || !existsSync('seed/users.csv')) {
    problems.push('seed/sites.csv and seed/users.csv are missing  ' +
      dim('(copy the .example.csv files and fill them in — see seed/README.md)'))
  }
  return problems
}

function main() {
  console.log('\nFirst-time deploy' + dim('  — checks everything before creating anything'))

  const problems = preflight()
  if (problems.length) {
    console.log('\n' + bad('Not ready:'))
    for (const p of problems) console.log(`  · ${p}`)
    console.log('\nNothing was created. Fix these and run again.\n')
    process.exit(1)
  }
  console.log(ok('\n  All inputs present.'))

  // 1. Database. Created only if wrangler.toml has no id yet, so a re-run is safe.
  const toml = readFileSync('wrangler.toml', 'utf8')
  const existing = /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(toml)
  if (existing) {
    console.log(`\n1. Database already configured ${dim(existing[1]!)}`)
  } else {
    console.log('\n1. Creating the D1 database…')
    const created = run(['d1', 'create', DB], { quiet: true })
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(created)?.[1]
    if (!id) {
      console.log(bad('  Could not read the database id from wrangler output.'))
      console.log(created)
      process.exit(1)
    }
    writeFileSync('wrangler.toml', toml.replace(/database_id\s*=\s*""/, `database_id = "${id}"`))
    console.log(ok(`  Created ${id}`) + dim('  — written into wrangler.toml, commit that.'))
  }

  console.log('\n2. Applying migrations…')
  run(['d1', 'migrations', 'apply', DB, '--remote'])

  console.log('\n3. Seeding sites and people…')
  execFileSync('node', ['--experimental-strip-types', '--no-warnings', 'scripts/seed.ts',
    '--out', 'seed/seed.sql'], { stdio: 'inherit' })
  run(['d1', 'execute', DB, '--remote', '--file', 'seed/seed.sql'])

  // 4. Build BEFORE deploying, with the client id in the bundle. This is the ordering
  // the old runbook had backwards.
  console.log('\n4. Building with the Google client id baked in…')
  execFileSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID },
  })

  console.log('\n5. Deploying…')
  const deployed = run(['pages', 'deploy', 'dist', '--project-name', PROJECT], { quiet: true })
  console.log(deployed)
  const url = /(https:\/\/[a-z0-9-]+\.pages\.dev)/.exec(deployed)?.[1]

  console.log('\n6. Setting secrets…')
  for (const name of ['SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'MINTSOFT_USERNAME', 'MINTSOFT_PASSWORD']) {
    const value = process.env[name]
    if (!value) { console.log(dim(`   ${name} — not set, skipped`)); continue }
    execFileSync('npx', ['wrangler', 'pages', 'secret', 'put', name, '--project-name', PROJECT],
      { input: value + '\n', stdio: ['pipe', 'ignore', 'inherit'] })
    console.log(ok(`   ${name} set`))
  }

  console.log('\n' + ok('Deployed.') + (url ? ` ${url}` : ''))
  console.log('\n' + bad('One step left, and sign-in fails until it is done:'))
  console.log('  Add this to the Google OAuth client\'s Authorised JavaScript origins:')
  console.log(`      ${url ?? 'https://<your-project>.pages.dev'}`)
  console.log(dim('  console.cloud.google.com → APIs & Services → Credentials → your web client'))
  console.log(dim('  It could not be done earlier: the URL does not exist until now.'))
  console.log(dim('\n  Writes to Mintsoft remain off. MINTSOFT_WRITES_ENABLED is "false" in wrangler.toml.\n'))
}

main()

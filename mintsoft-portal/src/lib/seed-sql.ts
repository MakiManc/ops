/**
 * Turns the sites and users CSVs into upsert SQL, validating as it goes.
 *
 * Separated from the CLI so the validation can be tested directly. These two files
 * decide who can sign in and which sites they can order for, so the checks here are
 * deliberately fussy: a wrong row is much cheaper to catch now than to notice when a
 * GM cannot order or an order goes to the wrong address.
 */
import { parseCsv, sqlNullable, sqlString } from './csv.ts'

export const SITE_COLUMNS = [
  'code', 'name', 'type', 'cluster', 'address_1', 'address_2', 'address_3',
  'town', 'county', 'postcode', 'contact_name', 'contact_phone', 'delivery_notes',
  'recharge', 'min_days_between_orders', 'active',
]
export const USER_COLUMNS = ['email', 'name', 'role', 'sites', 'active']

const SITE_TYPES = new Set(['restaurant', 'factory', 'franchise'])
const ROLES = new Set(['gm', 'approver', 'admin'])

export interface Problem { file: string; line: number; message: string }
export interface SeedResult { statements: string[]; problems: Problem[] }

const parseBool = (value: string, fallback: boolean): boolean | null => {
  const v = value.trim().toLowerCase()
  if (v === '') return fallback
  if (['1', 'true', 'yes', 'y'].includes(v)) return true
  if (['0', 'false', 'no', 'n'].includes(v)) return false
  return null
}

export function buildSeedSql(sitesText: string, usersText: string): SeedResult {
  const problems: Problem[] = []
  const fail = (file: string, line: number, message: string) => problems.push({ file, line, message })
  const statements: string[] = []
  const siteCodes = new Set<string>()

  // ---- sites ----
  const seenSites = new Map<string, number>()
  for (const { line, values } of parseCsv(sitesText, SITE_COLUMNS)) {
    const code = values.code!.toUpperCase()
    if (!code) { fail('sites.csv', line, 'code is required'); continue }
    if (seenSites.has(code)) {
      fail('sites.csv', line, `site code ${code} already used on line ${seenSites.get(code)}`)
      continue
    }
    seenSites.set(code, line)
    siteCodes.add(code)

    if (!values.name) fail('sites.csv', line, 'name is required')
    if (!SITE_TYPES.has(values.type!)) {
      fail('sites.csv', line, `type must be one of ${[...SITE_TYPES].join(', ')} (got "${values.type}")`)
    }

    const recharge = parseBool(values.recharge!, false)
    if (recharge === null) fail('sites.csv', line, `recharge must be yes or no (got "${values.recharge}")`)
    const active = parseBool(values.active!, true)
    if (active === null) fail('sites.csv', line, `active must be yes or no (got "${values.active}")`)

    // A franchise that is not recharged, or a corporate site that is, is almost always
    // a slip in the spreadsheet — and an expensive one in either direction.
    if (values.type === 'franchise' && recharge === false) {
      fail('sites.csv', line, `${code} is a franchise but recharge is no — franchise orders are always recharged`)
    }
    if (values.type !== 'franchise' && recharge === true) {
      fail('sites.csv', line, `${code} is not a franchise but recharge is yes — corporate sites are never recharged`)
    }

    let minDays = 'NULL'
    if (values.min_days_between_orders) {
      const n = Number(values.min_days_between_orders)
      if (!Number.isInteger(n) || n < 0) {
        fail('sites.csv', line, `min_days_between_orders must be a whole number of days (got "${values.min_days_between_orders}")`)
      } else minDays = String(n)
    }

    if (!values.postcode) {
      fail('sites.csv', line, `${code} has no postcode — orders cannot be delivered without one`)
    }

    statements.push(
      `INSERT INTO sites (code, name, type, cluster, address_1, address_2, address_3, town, county,
                    postcode, contact_name, contact_phone, delivery_notes, recharge,
                    min_days_between_orders, active)
VALUES (${sqlString(code)}, ${sqlString(values.name ?? '')}, ${sqlString(values.type ?? '')}, ${sqlNullable(values.cluster)},
        ${sqlNullable(values.address_1)}, ${sqlNullable(values.address_2)}, ${sqlNullable(values.address_3)},
        ${sqlNullable(values.town)}, ${sqlNullable(values.county)}, ${sqlNullable(values.postcode)},
        ${sqlNullable(values.contact_name)}, ${sqlNullable(values.contact_phone)}, ${sqlNullable(values.delivery_notes)},
        ${recharge ? 1 : 0}, ${minDays}, ${active ? 1 : 0})
ON CONFLICT (code) DO UPDATE SET
  name = excluded.name, type = excluded.type, cluster = excluded.cluster,
  address_1 = excluded.address_1, address_2 = excluded.address_2, address_3 = excluded.address_3,
  town = excluded.town, county = excluded.county, postcode = excluded.postcode,
  contact_name = excluded.contact_name, contact_phone = excluded.contact_phone,
  delivery_notes = excluded.delivery_notes, recharge = excluded.recharge,
  min_days_between_orders = excluded.min_days_between_orders, active = excluded.active,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');`,
    )
  }

  // ---- users ----
  const seenUsers = new Map<string, number>()
  for (const { line, values } of parseCsv(usersText, USER_COLUMNS)) {
    const email = values.email!.toLowerCase()
    if (!email) { fail('users.csv', line, 'email is required'); continue }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      fail('users.csv', line, `"${values.email}" does not look like an email address`)
      continue
    }
    if (seenUsers.has(email)) {
      fail('users.csv', line, `${email} already appears on line ${seenUsers.get(email)}`)
      continue
    }
    seenUsers.set(email, line)

    if (!values.name) fail('users.csv', line, `${email} has no name`)
    if (!ROLES.has(values.role!)) {
      fail('users.csv', line, `role must be one of ${[...ROLES].join(', ')} (got "${values.role}")`)
    }

    const active = parseBool(values.active!, true)
    if (active === null) fail('users.csv', line, `active must be yes or no (got "${values.active}")`)

    const rawCodes = (values.sites ?? '').split(/[;|]/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    const codes = [...new Set(rawCodes)]
    if (codes.length !== rawCodes.length) {
      // Trivially produced by copy-pasting in a spreadsheet, and the plain INSERT below
      // would abort the whole apply on a primary-key clash -- from a file this tool has
      // just called clean.
      const repeated = rawCodes.filter((c, i) => rawCodes.indexOf(c) !== i)
      fail('users.csv', line, `site ${[...new Set(repeated)].join(', ')} is listed more than once for ${email}`)
    }
    for (const code of codes) {
      if (!siteCodes.has(code)) fail('users.csv', line, `site ${code} is not in sites.csv`)
    }
    // A GM with no sites signs in successfully and sees an empty portal, which reads
    // as a broken app rather than as missing configuration.
    if (values.role === 'gm' && codes.length === 0) {
      fail('users.csv', line, `${email} is a GM with no sites — they would sign in and see nothing`)
    }
    if (values.role !== 'gm' && codes.length > 0) {
      fail('users.csv', line, `${email} is ${values.role} and is not site-scoped; leave sites blank`)
    }

    statements.push(
      `INSERT INTO users (email, name, role, active)
VALUES (${sqlString(email)}, ${sqlString(values.name ?? '')}, ${sqlString(values.role ?? '')}, ${active ? 1 : 0})
ON CONFLICT (email) DO UPDATE SET
  name = excluded.name, role = excluded.role, active = excluded.active,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');`,
    )
    // Replace the links rather than adding to them, so taking a site out of the CSV
    // actually takes the GM's access away.
    statements.push(
      `DELETE FROM user_sites WHERE user_id = (SELECT id FROM users WHERE email = ${sqlString(email)});`,
    )
    for (const code of codes) {
      statements.push(
        `INSERT OR IGNORE INTO user_sites (user_id, site_id)
SELECT u.id, s.id FROM users u, sites s WHERE u.email = ${sqlString(email)} AND s.code = ${sqlString(code)};`,
      )
    }
  }

  // ---- offboarding ----
  //
  // Removing someone from users.csv has to actually remove their access. The CSV is the
  // whole auth boundary -- there is no admin screen that writes to `users` -- and
  // seed/README.md promises that anyone not in the file cannot get in. Without this
  // sweep that promise was simply false: a GM who left kept an active row and their
  // site link, because the loop above only ever touches rows that are still listed.
  //
  // Deactivated rather than deleted, so the audit trail still resolves who did what.
  if (problems.length === 0 && seenUsers.size > 0) {
    const emails = [...seenUsers.keys()].map((e) => sqlString(e)).join(', ')
    statements.push(
      `-- Anyone not in users.csv loses access. Deactivated, not deleted, so past orders still name them.
UPDATE users SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE email NOT IN (${emails}) AND active = 1;`,
      `DELETE FROM user_sites WHERE user_id IN (SELECT id FROM users WHERE active = 0);`,
    )
  }
  if (problems.length === 0 && seenSites.size > 0) {
    const codes = [...seenSites.keys()].map((c) => sqlString(c)).join(', ')
    statements.push(
      `-- A site dropped from sites.csv is closed, not deleted: its order history stays.
UPDATE sites SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE code NOT IN (${codes}) AND active = 1;`,
    )
  }

  return { statements, problems }
}

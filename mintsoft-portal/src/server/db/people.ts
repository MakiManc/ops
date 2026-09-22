/**
 * Sites and people: who can sign in, and which sites they order for.
 *
 * Until now these rows arrived only through the seed CSVs, which meant adding one GM
 * needed a developer. This is the same job done from the portal.
 *
 * The validation deliberately mirrors src/lib/seed-sql.ts. If the two disagreed, a row
 * this screen accepted could be one the CSV path rejects, and the next re-seed would
 * fail on data the portal itself created.
 *
 * One rule here has no counterpart in the CSV path, because a full re-seed cannot hit
 * it: the last active administrator can never be removed, demoted or deactivated.
 * Google sign-in is the only way in and role comes from this table, so an empty admin
 * role locks every person out of the portal permanently, with no recovery short of
 * someone with database access. It is guarded in one place and tested.
 */
import type { Database } from './repo.ts'
import type { Role } from './types.ts'

export const SITE_TYPES = ['restaurant', 'factory', 'franchise'] as const
export const ROLES = ['gm', 'approver', 'admin'] as const

export type SiteType = (typeof SITE_TYPES)[number]

export class PeopleError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message)
    this.name = 'PeopleError'
  }
}

export interface SiteInput {
  code: string
  name: string
  type: string
  cluster?: string | null
  address1?: string | null
  address2?: string | null
  address3?: string | null
  town?: string | null
  county?: string | null
  postcode?: string | null
  contactName?: string | null
  contactPhone?: string | null
  deliveryNotes?: string | null
  minDaysBetweenOrders?: number | null
  active?: boolean
}

export interface UserInput {
  email: string
  name: string
  role: string
  siteIds?: number[]
  active?: boolean
}

const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

/**
 * Whether a site's orders are recharged. Derived, never taken from the caller: the seed
 * path treats a franchise that is not recharged, or a corporate site that is, as an
 * error in either direction, so there is no legitimate way to set it independently and
 * offering the choice would only create a way to get it wrong.
 */
export const rechargeFor = (type: string): boolean => type === 'franchise'

export function validateSite(input: SiteInput): void {
  const code = clean(input.code)?.toUpperCase()
  if (!code) throw new PeopleError('A site code is required, e.g. M9.', 'code')
  if (!/^[A-Z0-9-]+$/.test(code)) {
    throw new PeopleError(`Site code "${code}" should be letters, digits and hyphens only.`, 'code')
  }
  if (!clean(input.name)) throw new PeopleError('A site name is required.', 'name')
  if (!(SITE_TYPES as readonly string[]).includes(input.type)) {
    throw new PeopleError(`Type must be one of ${SITE_TYPES.join(', ')}.`, 'type')
  }
  // Same rule as the seed path: an order with nowhere to go is worse than no site.
  if (!clean(input.postcode)) {
    throw new PeopleError(`${code} needs a postcode — orders cannot be delivered without one.`, 'postcode')
  }
  const d = input.minDaysBetweenOrders
  if (d !== undefined && d !== null && (!Number.isInteger(d) || d < 0)) {
    throw new PeopleError('Minimum days between orders must be a whole number of days.', 'minDaysBetweenOrders')
  }
}

export function validateUser(input: UserInput): void {
  const email = clean(input.email)?.toLowerCase()
  if (!email) throw new PeopleError('An email address is required.', 'email')
  // Matches the CHECK on the table, which would otherwise fail with a constraint error
  // that tells the person nothing.
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new PeopleError(`"${input.email}" does not look like an email address.`, 'email')
  }
  if (!clean(input.name)) throw new PeopleError('A name is required.', 'name')
  if (!(ROLES as readonly string[]).includes(input.role)) {
    throw new PeopleError(`Role must be one of ${ROLES.join(', ')}.`, 'role')
  }
}

/** How many administrators could still sign in if this user changed as described. */
async function adminsRemaining(
  db: Database,
  excludingUserId: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`)
    .bind(excludingUserId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Refuses a change that would leave nobody able to administer the portal.
 * Called before any update that could drop an admin, never after.
 */
export async function assertNotLastAdmin(
  db: Database,
  userId: number,
  becoming: { role: string; active: boolean },
): Promise<void> {
  const current = await db
    .prepare(`SELECT role, active FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ role: string; active: number }>()
  if (!current) throw new PeopleError('That person no longer exists.')

  const wasAdmin = current.role === 'admin' && current.active === 1
  const staysAdmin = becoming.role === 'admin' && becoming.active
  if (!wasAdmin || staysAdmin) return

  if ((await adminsRemaining(db, userId)) === 0) {
    throw new PeopleError(
      'This is the only administrator left. Making someone else an administrator first '
        + 'keeps you able to get back in — there is no other way into the portal.',
      'role',
    )
  }
}

export interface SiteRow extends SiteInput {
  id: number
  recharge: boolean
  active: boolean
  gmCount: number
}

export async function listSites(db: Database): Promise<SiteRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.code, s.name, s.type, s.cluster, s.address_1, s.address_2, s.address_3,
              s.town, s.county, s.postcode, s.contact_name, s.contact_phone, s.delivery_notes,
              s.recharge, s.min_days_between_orders, s.active,
              (SELECT COUNT(*) FROM user_sites us JOIN users u ON u.id = us.user_id
                WHERE us.site_id = s.id AND u.active = 1) AS gm_count
         FROM sites s
        ORDER BY s.active DESC, s.code`,
    )
    .all<Record<string, string | number | null>>()

  return results.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    type: String(r.type),
    cluster: (r.cluster as string) ?? null,
    address1: (r.address_1 as string) ?? null,
    address2: (r.address_2 as string) ?? null,
    address3: (r.address_3 as string) ?? null,
    town: (r.town as string) ?? null,
    county: (r.county as string) ?? null,
    postcode: (r.postcode as string) ?? null,
    contactName: (r.contact_name as string) ?? null,
    contactPhone: (r.contact_phone as string) ?? null,
    deliveryNotes: (r.delivery_notes as string) ?? null,
    minDaysBetweenOrders: r.min_days_between_orders === null ? null : Number(r.min_days_between_orders),
    recharge: Number(r.recharge) === 1,
    active: Number(r.active) === 1,
    gmCount: Number(r.gm_count),
  }))
}

export interface PersonRow {
  id: number
  email: string
  name: string
  role: Role
  active: boolean
  lastSeenAt: string | null
  siteIds: number[]
}

export async function listPeople(db: Database): Promise<PersonRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.active, u.last_seen_at,
              (SELECT group_concat(us.site_id) FROM user_sites us WHERE us.user_id = u.id) AS site_ids
         FROM users u
        ORDER BY u.active DESC, u.role, u.name`,
    )
    .all<{
      id: number; email: string; name: string; role: Role; active: number
      last_seen_at: string | null; site_ids: string | null
    }>()

  return results.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    active: r.active === 1,
    lastSeenAt: r.last_seen_at,
    siteIds: r.site_ids ? r.site_ids.split(',').map(Number) : [],
  }))
}

const siteBindings = (input: SiteInput) => [
  clean(input.code)!.toUpperCase(), clean(input.name), input.type, clean(input.cluster),
  clean(input.address1), clean(input.address2), clean(input.address3), clean(input.town),
  clean(input.county), clean(input.postcode), clean(input.contactName), clean(input.contactPhone),
  clean(input.deliveryNotes), rechargeFor(input.type),
  input.minDaysBetweenOrders ?? null, (input.active ?? true) ? 1 : 0,
]

export async function createSite(db: Database, input: SiteInput): Promise<number> {
  validateSite(input)
  const code = clean(input.code)!.toUpperCase()
  const clash = await db.prepare(`SELECT id FROM sites WHERE code = ?`).bind(code).first<{ id: number }>()
  if (clash) throw new PeopleError(`Site code ${code} is already in use.`, 'code')

  const [c, n, t, cl, a1, a2, a3, tw, co, pc, cn, cp, dn, rc, md, ac] = siteBindings(input)
  await db
    .prepare(
      `INSERT INTO sites (code, name, type, cluster, address_1, address_2, address_3, town, county,
                          postcode, contact_name, contact_phone, delivery_notes, recharge,
                          min_days_between_orders, active)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(c, n, t, cl, a1, a2, a3, tw, co, pc, cn, cp, dn, rc ? 1 : 0, md, ac)
    .run()

  const row = await db.prepare(`SELECT id FROM sites WHERE code = ?`).bind(code).first<{ id: number }>()
  return row!.id
}

export async function updateSite(db: Database, id: number, input: SiteInput): Promise<void> {
  validateSite(input)
  const code = clean(input.code)!.toUpperCase()
  const clash = await db
    .prepare(`SELECT id FROM sites WHERE code = ? AND id <> ?`).bind(code, id)
    .first<{ id: number }>()
  if (clash) throw new PeopleError(`Site code ${code} is already in use.`, 'code')

  const [c, n, t, cl, a1, a2, a3, tw, co, pc, cn, cp, dn, rc, md, ac] = siteBindings(input)
  await db
    .prepare(
      `UPDATE sites SET code=?, name=?, type=?, cluster=?, address_1=?, address_2=?, address_3=?,
              town=?, county=?, postcode=?, contact_name=?, contact_phone=?, delivery_notes=?,
              recharge=?, min_days_between_orders=?, active=?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .bind(c, n, t, cl, a1, a2, a3, tw, co, pc, cn, cp, dn, rc ? 1 : 0, md, ac, id)
    .run()
}

async function setSites(db: Database, userId: number, siteIds: number[]): Promise<void> {
  await db.prepare(`DELETE FROM user_sites WHERE user_id = ?`).bind(userId).run()
  for (const siteId of [...new Set(siteIds)]) {
    const exists = await db.prepare(`SELECT id FROM sites WHERE id = ?`).bind(siteId).first<{ id: number }>()
    if (!exists) throw new PeopleError(`No site with id ${siteId}.`, 'siteIds')
    await db.prepare(`INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)`).bind(userId, siteId).run()
  }
}

export async function createPerson(db: Database, input: UserInput): Promise<number> {
  validateUser(input)
  const email = clean(input.email)!.toLowerCase()
  const clash = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: number }>()
  if (clash) throw new PeopleError(`${email} already has an account.`, 'email')

  await db
    .prepare(`INSERT INTO users (email, name, role, active) VALUES (?,?,?,?)`)
    .bind(email, clean(input.name), input.role, (input.active ?? true) ? 1 : 0)
    .run()
  const row = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: number }>()
  await setSites(db, row!.id, input.siteIds ?? [])
  return row!.id
}

export async function updatePerson(db: Database, id: number, input: UserInput): Promise<void> {
  validateUser(input)
  const email = clean(input.email)!.toLowerCase()
  const clash = await db
    .prepare(`SELECT id FROM users WHERE email = ? AND id <> ?`).bind(email, id)
    .first<{ id: number }>()
  if (clash) throw new PeopleError(`${email} already has an account.`, 'email')

  await assertNotLastAdmin(db, id, { role: input.role, active: input.active ?? true })

  await db
    .prepare(
      `UPDATE users SET email=?, name=?, role=?, active=?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?`,
    )
    .bind(email, clean(input.name), input.role, (input.active ?? true) ? 1 : 0, id)
    .run()

  // Site links are kept for every role, not just GMs. An approver demoted back to GM
  // gets their old sites, rather than silently losing them at the moment they start
  // mattering again.
  if (input.siteIds !== undefined) await setSites(db, id, input.siteIds)
}

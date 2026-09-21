/**
 * Route guards.
 *
 * Every API route goes through these. The browser decides what to *show*; only these
 * decide what a request is allowed to *do*. A GM who edits the JavaScript, or calls
 * the API directly with curl, meets exactly the same checks.
 *
 * The user is re-read from the database on every request rather than trusted from the
 * cookie, so deactivating someone or changing their role takes effect on their next
 * request instead of whenever their session happens to lapse.
 */
import type { Context, MiddlewareHandler, Next } from 'hono'
import { Repository } from '../db/repo.ts'
import type { AuthenticatedUser, Role } from '../db/types.ts'
import { readSessionCookie, verifySession } from './session.ts'

export interface Env {
  DB: D1Database
  SESSION_SECRET: string
  GOOGLE_CLIENT_ID: string
  MINTSOFT_WRITES_ENABLED?: string
}

export interface AppContext {
  Bindings: Env
  Variables: { user: AuthenticatedUser; repo: Repository }
}

/** Makes the repository available to handlers without each one constructing its own. */
export const withRepository: MiddlewareHandler<AppContext> = async (c, next) => {
  c.set('repo', new Repository(c.env.DB))
  await next()
}

/**
 * Requires a signed-in, still-active user.
 *
 * Responses say only "not signed in" — never whether the email was unknown, inactive,
 * or simply had a stale cookie. Those distinctions are useful to an attacker probing
 * for valid accounts and useless to a GM, who needs to sign in again either way.
 */
export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  const cookie = readSessionCookie(c.req.header('Cookie'))
  const session = await verifySession(cookie, c.env.SESSION_SECRET)
  if (!session) return c.json({ error: 'not_signed_in' }, 401)

  const user = await c.get('repo').findActiveUserById(session.userId)
  if (!user) return c.json({ error: 'not_signed_in' }, 401)

  c.set('user', user)
  await next()
}

/**
 * Requires one of the given roles.
 *
 * Roles do not nest: an admin is not implicitly an approver. Where a route should
 * serve both, both are named. Guessing at a hierarchy is how someone ends up able to
 * approve their own orders.
 */
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppContext> =>
  async (c, next) => {
    const user = c.get('user')
    if (!roles.includes(user.role)) return c.json({ error: 'forbidden' }, 403)
    await next()
  }

/**
 * Whether a user may act for a site.
 *
 * Approvers and admins are not site-scoped. A GM is limited to their linked sites,
 * and a GM with no links can reach nothing — deliberately, since an unlinked account
 * is one that has not been set up yet.
 */
export const canActForSite = (user: AuthenticatedUser, siteId: number): boolean =>
  user.role === 'gm' ? user.siteIds.includes(siteId) : true

/**
 * Guards a route whose site comes from the URL.
 *
 * A site the user cannot reach gets 404, not 403: a GM at M9 should not be able to
 * discover which other site ids exist by watching the status code change.
 */
export const requireSiteAccess = (param = 'siteId'): MiddlewareHandler<AppContext> =>
  async (c, next) => {
    const raw = c.req.param(param)
    const siteId = Number(raw)
    if (!raw || !Number.isInteger(siteId) || siteId <= 0) {
      return c.json({ error: 'bad_site' }, 400)
    }
    if (!canActForSite(c.get('user'), siteId)) return c.json({ error: 'not_found' }, 404)

    // A GM's links are already filtered to active sites, but approvers and admins are
    // not site-scoped at all, so this is where a closed or non-existent site is caught
    // for them. Same 404 either way: the status code must not reveal which case it was.
    const site = await c.get('repo').activeSiteExists(siteId)
    if (!site) return c.json({ error: 'not_found' }, 404)

    await next()
  }

/** Narrow helper so handlers can read the user without repeating the generics. */
export const currentUser = (c: Context<AppContext>): AuthenticatedUser => c.get('user')

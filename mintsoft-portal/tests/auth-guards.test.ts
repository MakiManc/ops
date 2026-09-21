import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { Env } from '../src/server/auth/middleware.ts'
import {
  buildSessionCookie, sessionCookieName, sessionTtlSeconds, signSession,
} from '../src/server/auth/session.ts'
import { FakeD1, seedRoles } from './helpers/d1.ts'

/**
 * Phase 1 is done when three test users each see only their role's screens. This is
 * that test, at the only layer where it counts.
 *
 * The browser hiding a button is a courtesy. These checks are the actual boundary: a
 * GM who edits the JavaScript, or calls the API with curl, meets exactly this.
 */

let db: FakeD1
let app: ReturnType<typeof createApp>
let env: Env

const SECRET = 'test-secret-not-a-real-one'

beforeEach(() => {
  db = new FakeD1()
  seedRoles(db)
  app = createApp()
  env = {
    DB: db as unknown as D1Database,
    SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  }
})

/** Signs in as a seeded user without going through Google. */
async function as(userId: number) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds
  const value = await signSession({ userId, expiresAt }, SECRET)
  return buildSessionCookie(value, sessionTtlSeconds).split(';')[0]!
}

const get = (path: string, cookie?: string) =>
  app.fetch(new Request(`https://portal.test${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  }), env)

const GM = 1, APPROVER = 2, ADMIN = 3, UNLINKED_GM = 4, DEACTIVATED = 5

describe('signed out', () => {
  it('refuses every protected route', async () => {
    for (const path of ['/api/me', '/api/sites', '/api/sites/1/catalogue',
                        '/api/approvals/queue', '/api/admin/settings']) {
      const res = await get(path)
      expect(res.status, `${path} must require sign-in`).toBe(401)
    }
  })

  it('does not leak whether an account exists', async () => {
    const res = await app.fetch(new Request('https://portal.test/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken: 'not.a.real.token' }),
    }), env)
    expect(res.status).toBe(401)
    // The same answer whether the token was junk, the email unknown, or the account
    // switched off — otherwise this endpoint enumerates staff emails.
    expect(await res.json()).toEqual({ error: 'sign_in_failed' })
  })
})

describe('a GM', () => {
  it('sees their own site and nothing else', async () => {
    const res = await get('/api/me', await as(GM))
    expect(res.status).toBe(200)
    const body = await res.json() as { user: { role: string }; sites: { code: string }[] }
    expect(body.user.role).toBe('gm')
    expect(body.sites.map((s) => s.code)).toEqual(['M9'])
  })

  it('can open the catalogue for their own site', async () => {
    expect((await get('/api/sites/1/catalogue', await as(GM))).status).toBe(200)
  })

  it('cannot reach another site, and is not told it exists', async () => {
    const res = await get('/api/sites/2/catalogue', await as(GM))
    // 404 rather than 403: a 403 would confirm site 2 is real, letting a GM map the estate.
    expect(res.status).toBe(404)
  })

  it('cannot reach the approval queue', async () => {
    expect((await get('/api/approvals/queue', await as(GM))).status).toBe(403)
  })

  it('cannot reach admin', async () => {
    expect((await get('/api/admin/settings', await as(GM))).status).toBe(403)
  })

  it('with no sites linked sees none, rather than all of them', async () => {
    const body = await (await get('/api/me', await as(UNLINKED_GM))).json() as { sites: unknown[] }
    // The dangerous bug here is an empty scope being read as "no filter".
    expect(body.sites).toEqual([])
    expect((await get('/api/sites/1/catalogue', await as(UNLINKED_GM))).status).toBe(404)
  })
})

describe('an approver', () => {
  it('can reach the approval queue', async () => {
    expect((await get('/api/approvals/queue', await as(APPROVER))).status).toBe(200)
  })

  it('sees every active site, since approvals are not site-scoped', async () => {
    const body = await (await get('/api/me', await as(APPROVER))).json() as { sites: { code: string }[] }
    expect(body.sites.map((s) => s.code).sort()).toEqual(['M19', 'M9', 'MAF1'])
  })

  it('cannot reach admin — the roles do not nest', async () => {
    expect((await get('/api/admin/settings', await as(APPROVER))).status).toBe(403)
  })
})

describe('an admin', () => {
  it('can reach admin settings', async () => {
    const res = await get('/api/admin/settings', await as(ADMIN))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      settings: { available_formula: 'on_hand_minus_allocated' },
    })
  })

  it('cannot approve orders just by being an admin', async () => {
    // Ross is both, but through two accounts' worth of rights, not one implying the
    // other. Silent role nesting is how someone ends up approving their own order.
    expect((await get('/api/approvals/queue', await as(ADMIN))).status).toBe(403)
  })
})

describe('sessions follow the database, not the cookie', () => {
  it('locks out a user deactivated after their cookie was issued', async () => {
    const cookie = await as(GM)
    expect((await get('/api/me', cookie)).status).toBe(200)

    db.exec(`UPDATE users SET active = 0 WHERE id = ${GM}`)

    // The cookie is still perfectly valid and correctly signed. It is worth nothing,
    // because the role and account state are read fresh on every request.
    expect((await get('/api/me', cookie)).status).toBe(401)
  })

  it('refuses a cookie for an account that was already inactive', async () => {
    expect((await get('/api/me', await as(DEACTIVATED))).status).toBe(401)
  })

  it('picks up a role change immediately', async () => {
    const cookie = await as(GM)
    expect((await get('/api/approvals/queue', cookie)).status).toBe(403)
    db.exec(`UPDATE users SET role = 'approver' WHERE id = ${GM}`)
    expect((await get('/api/approvals/queue', cookie)).status).toBe(200)
  })

  it('refuses a session signed with a different secret', async () => {
    const forged = await signSession(
      { userId: ADMIN, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, 'attackers-secret',
    )
    expect((await get('/api/admin/settings', `${sessionCookieName}=${forged}`)).status).toBe(401)
  })

  it('refuses a session whose payload was edited', async () => {
    const real = await signSession(
      { userId: GM, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, SECRET,
    )
    const [body, signature] = real.split('.') as [string, string]
    const tampered = btoa(JSON.stringify({ userId: ADMIN, expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect((await get('/api/admin/settings', `${sessionCookieName}=${tampered}.${signature}`)).status).toBe(401)
  })

  it('refuses an expired session', async () => {
    const stale = await signSession({ userId: ADMIN, expiresAt: Math.floor(Date.now() / 1000) - 1 }, SECRET)
    expect((await get('/api/admin/settings', `${sessionCookieName}=${stale}`)).status).toBe(401)
  })

  it('refuses junk in the cookie', async () => {
    for (const value of ['', 'nonsense', 'a.b.c', '....']) {
      expect((await get('/api/me', `${sessionCookieName}=${value}`)).status).toBe(401)
    }
  })
})

describe('site ids from the URL', () => {
  it('rejects a site id that is not a positive integer', async () => {
    const cookie = await as(GM)
    for (const bad of ['abc', '-1', '0', '1.5']) {
      const res = await get(`/api/sites/${bad}/catalogue`, cookie)
      expect([400, 404], `site id ${bad}`).toContain(res.status)
    }
  })
})

describe('the guard patterns cover what we think they cover', () => {
  /**
   * These pin behaviour we rely on but do not own. The middleware is attached by path
   * pattern, so if a future Hono version changed how ':siteId/*' matches, a route could
   * quietly fall outside its guard and nothing else in this suite would notice.
   */

  it('guards a site route with no trailing segment, not just deeper ones', async () => {
    // '/sites/:siteId/*' has to cover '/sites/1' itself, or a route added there later
    // would be unguarded the day someone writes it.
    const res = await get('/api/sites/2', await as(GM))
    expect(res.status).not.toBe(200)
  })

  it('cannot be dodged by changing the case of the path', async () => {
    const res = await get('/api/ADMIN/settings', await as(GM))
    expect(res.status).toBe(404)
  })

  it('cannot be dodged with a doubled slash', async () => {
    const res = await get('/api//admin/settings', await as(GM))
    expect(res.status).toBe(404)
  })

  it('cannot be dodged with a trailing slash', async () => {
    const res = await get('/api/admin/settings/', await as(GM))
    expect(res.status).not.toBe(200)
  })

  it('leaves no protected route reachable without a session', async () => {
    // A blunt sweep: every route the app registers, called with no cookie at all.
    for (const path of ['/api/me', '/api/sites', '/api/sites/1/catalogue',
                        '/api/approvals/queue', '/api/admin/settings']) {
      expect((await get(path)).status, path).toBe(401)
    }
  })
})

describe('closing a site', () => {
  it('stops its GM ordering for it, not just seeing it', async () => {
    const cookie = await as(GM)
    expect((await get('/api/sites/1/catalogue', cookie)).status).toBe(200)

    db.exec(`UPDATE sites SET active = 0 WHERE id = 1`)

    // Without the join to sites.active, the site list and the guard disagree: the site
    // disappears from every screen while still accepting requests for it.
    expect((await get('/api/sites/1/catalogue', cookie)).status).toBe(404)
    const body = await (await get('/api/me', cookie)).json() as { sites: unknown[] }
    expect(body.sites).toEqual([])
  })

  it('stops an approver reaching it too, even though they are not site-scoped', async () => {
    db.exec(`UPDATE sites SET active = 0 WHERE id = 1`)
    expect((await get('/api/sites/1/catalogue', await as(APPROVER))).status).toBe(404)
  })

  it('gives the same answer for a site that never existed', async () => {
    // The status code must not tell a caller which of the two it was.
    expect((await get('/api/sites/9999/catalogue', await as(APPROVER))).status).toBe(404)
  })
})

describe('a route added without a guard', () => {
  it('is refused rather than public, because authentication is opt-out', async () => {
    // The real risk is a route added in a later phase that nobody remembers to protect.
    // Opt-in guards fail silently and openly; opt-out fails loudly and closed.
    const res = await get('/api/some/route/nobody/guarded')
    expect(res.status).toBe(401)
  })

  it('still lets the sign-in endpoints through', async () => {
    const res = await app.fetch(new Request('https://portal.test/api/auth/google', {
      method: 'POST', body: JSON.stringify({ idToken: 'nope' }),
    }), env)
    // 401 from the token check, not from the session guard — it was reached.
    expect(await res.json()).toEqual({ error: 'sign_in_failed' })
  })

  it('lets sign-out through without a session', async () => {
    const res = await app.fetch(new Request('https://portal.test/api/auth/signout', { method: 'POST' }), env)
    expect(res.status).toBe(200)
  })
})

describe('the session cookie name', () => {
  it('uses the __Host- prefix, which browsers only accept from the exact host', () => {
    // Without it, a cookie set on a sibling subdomain can shadow the real session.
    expect(sessionCookieName).toBe('__Host-mrsession')
    expect(buildSessionCookie('x', 60)).toContain('Secure')
    expect(buildSessionCookie('x', 60)).toContain('Path=/')
    // A Domain attribute would make the browser reject a __Host- cookie outright.
    expect(buildSessionCookie('x', 60)).not.toContain('Domain=')
  })

  it('ignores the request entirely if two session cookies arrive', async () => {
    const good = (await as(ADMIN)).split('=').slice(1).join('=')
    const res = await get('/api/admin/settings', `${sessionCookieName}=forged; ${sessionCookieName}=${good}`)
    // Picking either one is worse than picking neither: one of them is not ours.
    expect(res.status).toBe(401)
  })
})

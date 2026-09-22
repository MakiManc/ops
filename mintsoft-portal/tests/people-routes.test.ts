/**
 * The sites-and-people endpoints. This screen decides who can sign in, so the guard on
 * it is the one that matters most in the product — an approver who could edit roles
 * could make themselves an administrator.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { Env } from '../src/server/auth/middleware.ts'
import { buildSessionCookie, sessionTtlSeconds, signSession } from '../src/server/auth/session.ts'
import { FakeD1, seedRoles } from './helpers/d1.ts'

let db: FakeD1
let app: ReturnType<typeof createApp>
let env: Env

const SECRET = 'test-secret-not-a-real-one'
const GM = 1, APPROVER = 2, ADMIN = 3

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

async function as(userId: number) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds
  return buildSessionCookie(await signSession({ userId, expiresAt }, SECRET), sessionTtlSeconds)
    .split(';')[0]!
}

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, ...rest } = init
  const headers = new Headers(rest.headers)
  if (cookie) headers.set('Cookie', cookie)
  if (rest.body) headers.set('Content-Type', 'application/json')
  return app.fetch(new Request(`https://portal.test${path}`, { ...rest, headers }), env)
}

describe('who may manage people', () => {
  it('only an administrator', async () => {
    expect((await call('/api/admin/people', { cookie: await as(ADMIN) })).status).toBe(200)
    expect((await call('/api/admin/people', { cookie: await as(APPROVER) })).status).toBe(403)
    expect((await call('/api/admin/people', { cookie: await as(GM) })).status).toBe(403)
    expect((await call('/api/admin/people')).status).toBe(401)
  })

  it('refuses an approver trying to promote themselves', async () => {
    const res = await call('/api/admin/people/2', {
      method: 'PATCH', cookie: await as(APPROVER),
      body: JSON.stringify({ email: 'approver@example.com', name: 'Francheska', role: 'admin' }),
    })
    expect(res.status).toBe(403)
    const row = db.sqlite.prepare(`SELECT role FROM users WHERE id = 2`).get() as { role: string }
    expect(row.role).toBe('approver')
  })
})

describe('creating and editing', () => {
  it('creates a site and a person, and lists them back', async () => {
    const admin = await as(ADMIN)
    const made = await call('/api/admin/sites', {
      method: 'POST', cookie: admin,
      body: JSON.stringify({ code: 'M21', name: 'Leeds', type: 'restaurant', postcode: 'LS1 1AA' }),
    })
    expect(made.status).toBe(200)
    const { id } = await made.json() as { id: number }

    expect((await call('/api/admin/people', {
      method: 'POST', cookie: admin,
      body: JSON.stringify({ email: 'leeds.gm@example.com', name: 'Leeds GM', role: 'gm', siteIds: [id] }),
    })).status).toBe(200)

    const { sites, people } = await (await call('/api/admin/people', { cookie: admin })).json() as
      { sites: { code: string }[]; people: { email: string; siteIds: number[] }[] }
    expect(sites.some((s) => s.code === 'M21')).toBe(true)
    expect(people.find((p) => p.email === 'leeds.gm@example.com')!.siteIds).toEqual([id])
  })

  it('answers a bad row with 400 and names the field, not a constraint error', async () => {
    const res = await call('/api/admin/sites', {
      method: 'POST', cookie: await as(ADMIN),
      body: JSON.stringify({ code: 'M22', name: 'No Postcode', type: 'restaurant' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; field: string }
    expect(body.field).toBe('postcode')
    expect(body.error).toMatch(/cannot be delivered/)
  })

  it('refuses to strand the portal without an administrator', async () => {
    const res = await call('/api/admin/people/3', {
      method: 'PATCH', cookie: await as(ADMIN),
      body: JSON.stringify({ email: 'admin@example.com', name: 'Ross', role: 'gm' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/only administrator left/)
    const row = db.sqlite.prepare(`SELECT role FROM users WHERE id = 3`).get() as { role: string }
    expect(row.role).toBe('admin')
  })
})

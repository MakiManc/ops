/**
 * The photo endpoints as a GM, an approver and an administrator meet them.
 *
 * Uploading is catalogue curation, so it sits behind /admin/* with the mapping tool.
 * Reading is not: every GM's catalogue needs the picture, so any signed-in user gets it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { Env } from '../src/server/auth/middleware.ts'
import { buildSessionCookie, sessionTtlSeconds, signSession } from '../src/server/auth/session.ts'
import { FakeD1, seedRoles } from './helpers/d1.ts'
import { MAX_BYTES } from '../src/server/db/photos.ts'

let db: FakeD1
let app: ReturnType<typeof createApp>
let env: Env

const SECRET = 'test-secret-not-a-real-one'
const GM = 1, APPROVER = 2, ADMIN = 3

beforeEach(() => {
  db = new FakeD1()
  seedRoles(db)
  db.exec(`
    INSERT INTO products (id, name, stock_type, active) VALUES
      (1, 'Black Chopsticks', 'internal', 1),
      (2, 'Donburi Plates', 'internal', 1);
  `)
  app = createApp()
  env = {
    DB: db as unknown as D1Database,
    SESSION_SECRET: SECRET,
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  }
})

async function as(userId: number) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds
  const value = await signSession({ userId, expiresAt }, SECRET)
  return buildSessionCookie(value, sessionTtlSeconds).split(';')[0]!
}

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, ...rest } = init
  const headers = new Headers(rest.headers)
  if (cookie) headers.set('Cookie', cookie)
  return app.fetch(new Request(`https://portal.test${path}`, { ...rest, headers }), env)
}

const upload = (productId: number, cookie: string, bytes: Uint8Array, type = 'image/webp') =>
  call(`/api/admin/photos/${productId}`, {
    method: 'PUT', cookie, body: bytes as unknown as BodyInit, headers: { 'Content-Type': type },
  })

const png = (size = 64) => new Uint8Array(size).fill(7)

describe('who may upload', () => {
  it('lets an administrator', async () => {
    expect((await upload(1, await as(ADMIN), png())).status).toBe(200)
  })

  it('refuses a GM and an approver — the browser hiding the screen is not the boundary', async () => {
    expect((await upload(1, await as(GM), png())).status).toBe(403)
    expect((await upload(1, await as(APPROVER), png())).status).toBe(403)
    expect((await call('/api/admin/photos', { cookie: await as(APPROVER) })).status).toBe(403)
  })

  it('refuses anyone signed out', async () => {
    expect((await call('/api/admin/photos/1', { method: 'PUT', body: png() as unknown as BodyInit }))
      .status).toBe(401)
  })
})

describe('uploading', () => {
  it('rejects a type a browser should never send, and says what is accepted', async () => {
    const res = await upload(1, await as(ADMIN), png(), 'image/gif')
    expect(res.status).toBe(400)
    const body = await res.json() as { reason: string; accepted: string[] }
    expect(body.reason).toBe('type')
    expect(body.accepted).toContain('image/webp')
  })

  it('rejects an unresized photo and names the limit', async () => {
    const res = await upload(1, await as(ADMIN), png(MAX_BYTES + 1))
    expect(res.status).toBe(400)
    const body = await res.json() as { reason: string; maxBytes: number }
    expect(body.reason).toBe('too_large')
    expect(body.maxBytes).toBe(MAX_BYTES)
  })

  it('404s on a product that does not exist, instead of storing an orphan', async () => {
    expect((await upload(999, await as(ADMIN), png())).status).toBe(404)
    const n = db.sqlite.prepare(`SELECT COUNT(*) AS n FROM product_photos`).get() as { n: number }
    expect(n.n).toBe(0)
  })
})

describe('serving', () => {
  it('gives the bytes to any signed-in user, GM included', async () => {
    await upload(1, await as(ADMIN), new Uint8Array([1, 2, 3, 4]))
    const res = await call('/api/photos/1', { cookie: await as(GM) })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4])
  })

  it('refuses a signed-out request — the catalogue is not public', async () => {
    await upload(1, await as(ADMIN), png())
    expect((await call('/api/photos/1')).status).toBe(401)
  })

  it('answers 304 to a browser that already has it', async () => {
    await upload(1, await as(ADMIN), png())
    const cookie = await as(GM)
    const first = await call('/api/photos/1', { cookie })
    const etag = first.headers.get('ETag')!

    const second = await call('/api/photos/1', { cookie, headers: { 'If-None-Match': etag } })
    expect(second.status).toBe(304)
    expect((await second.arrayBuffer()).byteLength).toBe(0)
  })

  it('gives a new etag once the photo is replaced', async () => {
    const admin = await as(ADMIN)
    await upload(1, admin, png(10))
    const before = (await call('/api/photos/1', { cookie: admin })).headers.get('ETag')
    await upload(1, admin, png(20))
    const after = (await call('/api/photos/1', { cookie: admin })).headers.get('ETag')
    expect(after).not.toBe(before)
  })

  it('404s for a product with no photo', async () => {
    expect((await call('/api/photos/2', { cookie: await as(GM) })).status).toBe(404)
  })
})

describe('the working list', () => {
  it('reports what is still missing', async () => {
    const admin = await as(ADMIN)
    await upload(1, admin, png(99))

    const res = await call('/api/admin/photos', { cookie: admin })
    const { rows } = await res.json() as {
      rows: { productId: number; byteSize: number | null; uploadedByName: string | null }[]
    }
    expect(rows).toHaveLength(2)
    expect(rows[0]!.productId).toBe(2)
    expect(rows[0]!.byteSize).toBeNull()
    expect(rows[1]!.byteSize).toBe(99)
    // Worth knowing who to ask when a photo looks wrong.
    expect(rows[1]!.uploadedByName).toBe('Ross')
  })
})

describe('deleting', () => {
  it('removes it and stops serving it', async () => {
    const admin = await as(ADMIN)
    await upload(1, admin, png())
    expect((await call('/api/admin/photos/1', { method: 'DELETE', cookie: admin })).status).toBe(200)
    expect((await call('/api/photos/1', { cookie: admin })).status).toBe(404)
  })

  it('refuses a GM', async () => {
    await upload(1, await as(ADMIN), png())
    expect((await call('/api/admin/photos/1', { method: 'DELETE', cookie: await as(GM) })).status)
      .toBe(403)
  })
})

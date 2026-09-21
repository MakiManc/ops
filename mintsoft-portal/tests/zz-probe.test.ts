import { describe, expect, it, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createApp } from '/home/user/ops/mintsoft-portal/src/server/app.ts'
import type { Env } from '/home/user/ops/mintsoft-portal/src/server/auth/middleware.ts'
import { buildSessionCookie, signSession, sessionTtlSeconds } from '/home/user/ops/mintsoft-portal/src/server/auth/session.ts'
import { FakeD1, seedRoles } from '/home/user/ops/mintsoft-portal/tests/helpers/d1.ts'

let db: FakeD1, app: any, env: Env
const SECRET = 'test-secret-not-a-real-one'
beforeEach(() => {
  db = new FakeD1(); seedRoles(db); app = createApp()
  env = { DB: db as any, SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'x' }
})
async function as(userId: number) {
  const v = await signSession({ userId, expiresAt: Math.floor(Date.now()/1000)+sessionTtlSeconds }, SECRET)
  return buildSessionCookie(v, sessionTtlSeconds).split(';')[0]!
}
const req = (path: string, cookie?: string, method='GET') =>
  app.fetch(new Request(`https://portal.test${path}`, { method, headers: cookie ? { Cookie: cookie } : {} }), env)

describe('probe: does /sites/:siteId/* guard /sites/:siteId itself?', () => {
  it('mimics app wiring in a bare Hono', async () => {
    const h = new Hono().basePath('/api')
    const hits: string[] = []
    h.use('/sites/:siteId/*', async (c, n) => { hits.push('mw:' + c.req.param('siteId')); await n() })
    h.get('/sites/:siteId', (c) => c.text('BARE-' + c.req.param('siteId')))
    h.get('/sites/:siteId/catalogue', (c) => c.text('CAT'))
    const r1 = await h.fetch(new Request('https://t/api/sites/2'))
    console.log('GET /api/sites/2 ->', r1.status, await r1.text(), 'hits=', JSON.stringify(hits))
    hits.length = 0
    const r2 = await h.fetch(new Request('https://t/api/sites/2/catalogue'))
    console.log('GET /api/sites/2/catalogue ->', r2.status, await r2.text(), 'hits=', JSON.stringify(hits))
    hits.length = 0
    const r3 = await h.fetch(new Request('https://t/api/sites/2/'))
    console.log('GET /api/sites/2/ ->', r3.status, 'hits=', JSON.stringify(hits))
  })
})

describe('probe: real app paths', () => {
  const paths = [
    '/api/me', '/api/me/', '/api/sites', '/api/sites/', '/api/sites/1/catalogue',
    '/api/sites/2/catalogue', '/api/sites/1/catalogue/', '/api/Sites/2/catalogue',
    '/api/sites/1/catalogue/../../2/catalogue', '/api/sites/%32/catalogue',
    '/api/sites/2%2Fcatalogue', '/api/sites/02/catalogue', '/api/sites/1%20/catalogue',
    '/api/sites/+2/catalogue', '/api/sites/2.0/catalogue', '/api/sites/2e0/catalogue',
    '/api/approvals/queue', '/api/admin/settings', '/api/sites/2/catalogue?x=1',
    '/api//sites/2/catalogue', '/api/sites//2/catalogue', '/api/sites/2/../1/catalogue',
  ]
  it('GM hitting everything', async () => {
    const c = await as(1)
    for (const p of paths) {
      const r = await req(p, c)
      let body = ''
      try { body = (await r.text()).slice(0, 120) } catch {}
      console.log(`GM ${p} -> ${r.status} ${body}`)
    }
  })
  it('signed out hitting everything', async () => {
    for (const p of paths) {
      const r = await req(p)
      console.log(`ANON ${p} -> ${r.status} ${(await r.text()).slice(0,80)}`)
    }
  })
  it('methods', async () => {
    const c = await as(1)
    for (const m of ['GET','POST','PUT','DELETE','HEAD','OPTIONS','PATCH']) {
      const r = await req('/api/admin/settings', c, m)
      console.log(`GM ${m} /api/admin/settings -> ${r.status}`)
    }
    for (const m of ['GET','POST','HEAD']) {
      const r = await req('/api/approvals/queue', undefined, m)
      console.log(`ANON ${m} /api/approvals/queue -> ${r.status}`)
    }
  })
})

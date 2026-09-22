import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { Env } from '../src/server/auth/middleware.ts'
import { buildSessionCookie, sessionCookieName, sessionTtlSeconds, signSession } from '../src/server/auth/session.ts'
import { FakeD1 } from './helpers/d1.ts'

/** The ordering flow, walked through the API with each role's own session. */

let db: FakeD1
let app: ReturnType<typeof createApp>
let env: Env
const SECRET = 'test-secret'
const GM = 1, APPROVER = 2, ADMIN = 3

beforeEach(() => {
  db = new FakeD1()
  db.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode)
      VALUES (1, 'M9', 'Leith Walk', 'restaurant', '1 St', 'Edinburgh', 'EH6 5AA'),
             (2, 'M19', 'Fountainbridge', 'restaurant', '2 Rd', 'Edinburgh', 'EH3 9QG');
    INSERT INTO sites (id, code, name, type, recharge, address_1, town, postcode)
      VALUES (3, 'MAF1', 'Franchise', 'franchise', 1, '3 Ln', 'London', 'SW1A 1AA');
    INSERT INTO users (id, email, name, role) VALUES
      (1, 'gm.m9@example.com', 'GM', 'gm'),
      (2, 'approver@example.com', 'Francheska', 'approver'),
      (3, 'admin@example.com', 'Ross', 'admin');
    INSERT INTO user_sites (user_id, site_id) VALUES (1, 1);
    INSERT INTO products (id, name, stock_type, recharge_unit_price) VALUES
      (1, 'Ramen Bowl', 'internal', 2.50), (2, 'Chopsticks', 'internal', NULL);
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (7001, 'BOWL-01', 'Ramen Bowl', '2026-09-21T10:00:00Z'),
      (7002, 'CHOP-01', 'Chopsticks', '2026-09-21T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES
      (1, 7001, 'BOWL-01', 1), (2, 7002, 'CHOP-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at) VALUES
      (7001, 1, 1, 100, 0, 100, '2026-09-21T10:00:00Z'),
      (7002, 1, 1, 500, 0, 500, '2026-09-21T10:00:00Z');
  `)
  app = createApp()
  env = { DB: db as unknown as D1Database, SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'x' }
})

async function as(userId: number) {
  const v = await signSession({ userId, expiresAt: Math.floor(Date.now() / 1000) + sessionTtlSeconds }, SECRET)
  return `${sessionCookieName}=${buildSessionCookie(v, sessionTtlSeconds).split('=').slice(1).join('=').split(';')[0]}`
}
const call = (path: string, cookie?: string, init: RequestInit = {}) =>
  app.fetch(new Request(`https://portal.test${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  }), env)
const post = (path: string, cookie: string, body: unknown) =>
  call(path, cookie, { method: 'POST', body: JSON.stringify(body) })

describe('a GM builds and submits a request', () => {
  it('starts empty', async () => {
    const body = await (await call('/api/sites/1/request', await as(GM))).json() as { request: null }
    expect(body.request).toBeNull()
  })

  it('adds items, which join one request', async () => {
    const cookie = await as(GM)
    await post('/api/sites/1/request/lines', cookie, { productId: 1, qty: 24 })
    await post('/api/sites/1/request/lines', cookie, { productId: 2, qty: 10 })
    const body = await (await call('/api/sites/1/request', cookie)).json() as
      { request: { orderNumber: string }; lines: unknown[] }
    expect(body.lines).toHaveLength(2)
    expect(body.request.orderNumber).toMatch(/^MR-M9-/)
  })

  it('reports a line over available without blocking the page', async () => {
    const cookie = await as(GM)
    await post('/api/sites/1/request/lines', cookie, { productId: 1, qty: 500 })
    const body = await (await call('/api/sites/1/request', cookie)).json() as
      { checks: { code: string; severity: string }[] }
    expect(body.checks.find((c) => c.code === 'over_available')?.severity).toBe('blocks')
  })

  it('submits with a name and reaches the approval queue', async () => {
    const cookie = await as(GM)
    await post('/api/sites/1/request/lines', cookie, { productId: 1, qty: 24 })
    const res = await post('/api/sites/1/request/submit', cookie, { requesterName: 'Alex' })
    expect(res.status).toBe(200)

    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { requesterName: string; siteCode: string } }[] }
    expect(queue.requests).toHaveLength(1)
    expect(queue.requests[0]!.order.requesterName).toBe('Alex')
  })

  it('refuses to submit without a name, because site logins are shared', async () => {
    const cookie = await as(GM)
    await post('/api/sites/1/request/lines', cookie, { productId: 1, qty: 24 })
    const res = await post('/api/sites/1/request/submit', cookie, { requesterName: '' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/your name/i)
  })

  it('cannot touch another site\'s request', async () => {
    expect((await call('/api/sites/2/request', await as(GM))).status).toBe(404)
    expect((await post('/api/sites/2/request/lines', await as(GM), { productId: 1, qty: 1 })).status).toBe(404)
  })
})

describe('the approval queue', () => {
  async function submitted(siteId = 1, qty = 24, productId = 1) {
    const cookie = await as(GM)
    if (siteId !== 1) {
      db.exec(`INSERT INTO user_sites (user_id, site_id) VALUES (1, ${siteId})`)
    }
    await post(`/api/sites/${siteId}/request/lines`, cookie, { productId, qty })
    await post(`/api/sites/${siteId}/request/submit`, cookie, { requesterName: 'Alex' })
  }

  it('shows the stock position and what other sites have asked for', async () => {
    await submitted(1, 24)
    await submitted(2, 30)
    const body = await (await call('/api/approvals/queue', await as(APPROVER))).json() as {
      requests: { order: { siteCode: string }; lines: { available: number; otherSitesPending: number }[] }[]
    }
    const m9 = body.requests.find((r) => r.order.siteCode === 'M9')!
    expect(m9.lines[0]!.available).toBe(100)
    // Mintsoft cannot see this; the approver is the only one who can.
    expect(m9.lines[0]!.otherSitesPending).toBe(30)
  })

  it('is closed to a GM', async () => {
    expect((await call('/api/approvals/queue', await as(GM))).status).toBe(403)
  })

  it('approves and records the sign-off', async () => {
    await submitted()
    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number } }[] }
    const orderId = queue.requests[0]!.order.id

    const res = await post(`/api/approvals/${orderId}/approve`, await as(APPROVER), {
      lines: [{ productId: 1, qtyApproved: 12 }],
    })
    expect(res.status).toBe(200)

    const detail = await (await call(`/api/orders/${orderId}`, await as(GM))).json() as
      { order: { status: string }; events: { event: string }[] }
    expect(detail.order.status).toBe('approved')
    expect(detail.events.map((e) => e.event)).toContain('approved')
  })

  it('refuses to approve more than is in stock, and says the shortfall', async () => {
    await submitted(1, 24)
    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number } }[] }
    const res = await post(`/api/approvals/${queue.requests[0]!.order.id}/approve`, await as(APPROVER), {
      lines: [{ productId: 1, qtyApproved: 5000 }],
    })
    expect(res.status).toBe(409)
    expect((await res.json() as { problems: string[] }).problems[0]).toMatch(/short/)
  })

  it('sends a request back with a reason the site can act on', async () => {
    await submitted()
    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number } }[] }
    const orderId = queue.requests[0]!.order.id
    await post(`/api/approvals/${orderId}/reject`, await as(APPROVER), { reason: 'Ordered last week' })

    const detail = await (await call(`/api/orders/${orderId}`, await as(GM))).json() as
      { order: { status: string; rejectedReason: string } }
    expect(detail.order).toMatchObject({ status: 'rejected', rejectedReason: 'Ordered last week' })
  })

  it('offers the other pending request for the same site as a merge candidate', async () => {
    const cookie = await as(GM)
    await post('/api/sites/1/request/lines', cookie, { productId: 1, qty: 10 })
    await post('/api/sites/1/request/submit', cookie, { requesterName: 'Alex' })
    await post('/api/sites/1/request/lines', cookie, { productId: 2, qty: 5 })
    await post('/api/sites/1/request/submit', cookie, { requesterName: 'Alex' })

    const body = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number }; mergeCandidates: { id: number }[] }[] }
    expect(body.requests).toHaveLength(2)
    expect(body.requests[0]!.mergeCandidates).toHaveLength(1)
  })

  it('merges them into one, so Mercium bills for one order', async () => {
    const cookie = await as(GM)
    await post('/api/sites/1/request/lines', cookie, { productId: 1, qty: 10 })
    await post('/api/sites/1/request/submit', cookie, { requesterName: 'Alex' })
    await post('/api/sites/1/request/lines', cookie, { productId: 2, qty: 5 })
    await post('/api/sites/1/request/submit', cookie, { requesterName: 'Alex' })

    const before = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number } }[] }
    const [keep, merge] = before.requests.map((r) => r.order.id) as [number, number]
    expect((await post(`/api/approvals/${keep}/merge/${merge}`, await as(APPROVER), {})).status).toBe(200)

    const after = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { lines: unknown[] }[] }
    expect(after.requests).toHaveLength(1)
    expect(after.requests[0]!.lines).toHaveLength(2)
  })
})

describe('a franchise order', () => {
  it('blocks approval when a line has no recharge price', async () => {
    db.exec(`INSERT INTO user_sites (user_id, site_id) VALUES (1, 3)`)
    const cookie = await as(GM)
    // Chopsticks has no recharge price set.
    await post('/api/sites/3/request/lines', cookie, { productId: 2, qty: 10 })
    await post('/api/sites/3/request/submit', cookie, { requesterName: 'Alex' })

    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number } }[] }
    const res = await post(`/api/approvals/${queue.requests[0]!.order.id}/approve`, await as(APPROVER), {
      lines: [{ productId: 2, qtyApproved: 10 }],
    })
    expect(res.status).toBe(409)
    expect((await res.json() as { problems: string[] }).problems[0]).toMatch(/no recharge price/)
  })

  it('works out the total, with the order fee, when prices are set', async () => {
    db.exec(`INSERT INTO user_sites (user_id, site_id) VALUES (1, 3)`)
    db.exec(`UPDATE settings SET mercium_order_fee = 12, pass_order_fee_to_franchise = 1 WHERE id = 1`)
    const cookie = await as(GM)
    await post('/api/sites/3/request/lines', cookie, { productId: 1, qty: 10 })
    await post('/api/sites/3/request/submit', cookie, { requesterName: 'Alex' })

    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number } }[] }
    const res = await post(`/api/approvals/${queue.requests[0]!.order.id}/approve`, await as(APPROVER), {
      lines: [{ productId: 1, qtyApproved: 10 }],
    })
    expect(await res.json()).toMatchObject({ recharge: { lineTotal: 25, orderFee: 12, total: 37 } })
  })
})

describe('my orders', () => {
  it('shows a GM only their own sites', async () => {
    const cookie = await as(GM)
    await post('/api/sites/1/request/lines', cookie, { productId: 1, qty: 5 })
    db.exec(`INSERT INTO orders (order_number, site_id, type, status) VALUES ('MR-M19-1', 2, 'replenishment', 'approved')`)
    const body = await (await call('/api/my-orders', cookie)).json() as { orders: { siteCode: string }[] }
    expect(body.orders.map((o) => o.siteCode)).toEqual(['M9'])
  })

  it('refuses to show another site\'s order by id', async () => {
    db.exec(`INSERT INTO orders (id, order_number, site_id, type, status) VALUES (99, 'MR-M19-1', 2, 'replenishment', 'approved')`)
    expect((await call('/api/orders/99', await as(GM))).status).toBe(404)
  })

  it('lets an approver see any order', async () => {
    db.exec(`INSERT INTO orders (id, order_number, site_id, type, status) VALUES (99, 'MR-M19-1', 2, 'replenishment', 'approved')`)
    expect((await call('/api/orders/99', await as(APPROVER))).status).toBe(200)
  })
})

describe('sending an approved order', () => {
  it('refuses when Mintsoft credentials are not configured', async () => {
    db.exec(`INSERT INTO orders (id, order_number, site_id, type, status, approved_by, approved_at)
             VALUES (50, 'MR-M9-20260921-050', 1, 'replenishment', 'approved', 2, '2026-09-21T10:00:00Z')`)
    const res = await post('/api/approvals/50/send', await as(APPROVER), {})
    expect(res.status).toBe(503)
    expect((await res.json() as { error: string }).error).toMatch(/credentials are not configured/)
  })

  it('is closed to a GM and to an admin', async () => {
    for (const user of [GM, ADMIN]) {
      expect((await post('/api/approvals/50/send', await as(user), {})).status).toBe(403)
    }
  })

  it('sends nothing when the writes flag is off, even with credentials', async () => {
    db.exec(`INSERT INTO orders (id, order_number, site_id, type, status, approved_by, approved_at)
             VALUES (51, 'MR-M9-20260921-051', 1, 'replenishment', 'approved', 2, '2026-09-21T10:00:00Z')`)
    const withCreds: Env = {
      ...env, MINTSOFT_USERNAME: 'u', MINTSOFT_PASSWORD: 'p', MINTSOFT_WRITES_ENABLED: 'false',
    }
    const res = await app.fetch(new Request('https://portal.test/api/approvals/51/send', {
      method: 'POST', headers: { Cookie: await as(APPROVER), 'Content-Type': 'application/json' }, body: '{}',
    }), withCreds)
    expect(res.status).toBe(409)
    expect((await res.json() as { message: string }).message).toMatch(/switched off/)
  })
})

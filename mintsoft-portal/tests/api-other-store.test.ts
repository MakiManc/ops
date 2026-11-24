/**
 * Approving an order for stock Mercium does not hold, through the API.
 *
 * This file exists because of a gap the unit tests could not see. tests/email-route.test.ts
 * drives sendApprovedOrder, which decides the route by asking the database directly — so it
 * passed while the APPROVE endpoint, which builds its own LineToApprove objects, was
 * dropping supplyRoute entirely. Every line then defaulted to Mercium, fell through to the
 * mapped-lines test and refused with "is not mapped to any warehouse line, so it cannot be
 * ordered": a true sentence about Mintsoft and the wrong conclusion, since nothing is ever
 * going to map it. No other-store order could be signed off at all.
 *
 * The lesson is that the route has to be checked at every seam where lines are rebuilt
 * from parts, not only where it was first implemented. These tests go through the real
 * routes for that reason.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { Env } from '../src/server/auth/middleware.ts'
import { buildSessionCookie, sessionCookieName, sessionTtlSeconds, signSession } from '../src/server/auth/session.ts'
import { FakeD1 } from './helpers/d1.ts'

let db: FakeD1
let app: ReturnType<typeof createApp>
let env: Env
const SECRET = 'test-secret'
const GM = 1, APPROVER = 2

beforeEach(() => {
  db = new FakeD1()
  db.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode)
      VALUES (1, 'M9', 'Leith Walk', 'restaurant', '1 St', 'Edinburgh', 'EH6 5AA');
    INSERT INTO users (id, email, name, role) VALUES
      (1, 'gm.m9@example.com', 'GM', 'gm'),
      (2, 'approver@example.com', 'Francheska', 'approver');
    INSERT INTO user_sites (user_id, site_id) VALUES (1, 1);

    -- One of each: a mapped Mercium product, and other-store stock mapped to nothing and
    -- carrying no stock row, which is exactly how that warehouse's products exist.
    INSERT INTO products (id, name, stock_type, unit, supply_route) VALUES
      (1, 'Ramen Bowl Vegan', 'internal', 'Case', 'mercium'),
      (2, 'Ramen bowl (ceramic)', 'internal', 'Case', 'email');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (7001, 'BOWL-01', 'Ramen Bowl Vegan', '2026-11-24T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES
      (1, 7001, 'BOWL-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at)
      VALUES (7001, 1, 1, 100, 0, 100, '2026-11-24T10:00:00Z');
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

/** Builds and submits a request for one product, returning its order id. */
async function submit(productId: number, qty: number): Promise<number> {
  const added = await post('/api/sites/1/request/lines', await as(GM), { productId, qty })
  expect(added.status).toBeLessThan(300)
  const sent = await post('/api/sites/1/request/submit', await as(GM), { requesterName: 'Site GM' })
  expect(sent.status).toBeLessThan(300)
  const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
    { requests: { order: { id: number } }[] }
  return queue.requests[0]!.order.id
}

describe('an other-store order', () => {
  it('can be approved, even though Mintsoft has no stock figure for it', async () => {
    const orderId = await submit(2, 4)

    const res = await post(`/api/approvals/${orderId}/approve`, await as(APPROVER), {
      lines: [{ productId: 2, qtyApproved: 4 }],
    })

    const body = await res.json() as { ok?: boolean; problems?: string[] }
    // The regression this file was written for: "is not mapped to any warehouse line".
    expect(body.problems ?? []).toEqual([])
    expect(res.status).toBe(200)
  })

  it('is told apart from a Mercium order in the queue', async () => {
    await submit(2, 4)
    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { supplyRoute?: string }; lines: { supplyRoute?: string }[] }[] }

    // Both the order and its lines carry the route, so the screen can say which building
    // this is for before anybody signs it off.
    expect(queue.requests[0]!.order.supplyRoute).toBe('email')
    expect(queue.requests[0]!.lines[0]!.supplyRoute).toBe('email')
  })

  it('still refuses a Mercium line that really is unmapped', async () => {
    // The guard must keep working where it was right: a Mercium product with no mapped
    // line genuinely cannot be ordered, and the route must not become a way past that.
    db.exec(`INSERT INTO products (id, name, stock_type, supply_route) VALUES (3, 'Unmapped Thing', 'internal', 'mercium')`)
    const orderId = await submit(3, 2)

    const res = await post(`/api/approvals/${orderId}/approve`, await as(APPROVER), {
      lines: [{ productId: 3, qtyApproved: 2 }],
    })
    const body = await res.json() as { problems?: string[] }
    expect(body.problems?.join(' ')).toMatch(/not mapped to any warehouse line/)
  })
})

describe('a basket', () => {
  it('refuses to mix the two warehouses, naming both sides', async () => {
    await post('/api/sites/1/request/lines', await as(GM), { productId: 2, qty: 4 })
    const res = await post('/api/sites/1/request/lines', await as(GM), { productId: 1, qty: 2 })

    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json() as { error?: string }
    expect(body.error).toMatch(/two different warehouses/)
    expect(body.error).toMatch(/Ramen Bowl Vegan/)
    expect(body.error).toMatch(/Ramen bowl \(ceramic\)/)
  })
})

/**
 * The per-order fee, which only one of the two warehouses charges.
 *
 * mercium_order_fee is what Mercium charge to raise and pick an order, and it is the
 * whole reason the portal consolidates orders at all. That makes it easy to forget that
 * the fee stops at the warehouse boundary: an other-store order never reaches Mercium,
 * so putting their fee on a franchise invoice for one would be billing for work nobody
 * did.
 */
describe('the Mercium order fee', () => {
  beforeEach(() => {
    db.exec(`
      UPDATE settings SET mercium_order_fee = 12.5, pass_order_fee_to_franchise = 1 WHERE id = 1;
      INSERT INTO sites (id, code, name, type, recharge, address_1, town, postcode)
        VALUES (9, 'MAF9', 'Franchise', 'franchise', 1, '9 Ln', 'London', 'SW1A 1AA');
      INSERT INTO user_sites (user_id, site_id) VALUES (1, 9);
      UPDATE products SET recharge_unit_price = 3.00 WHERE id IN (1, 2);
    `)
  })

  const approveAt = async (siteId: number, productId: number) => {
    await post(`/api/sites/${siteId}/request/lines`, await as(GM), { productId, qty: 2 })
    await post(`/api/sites/${siteId}/request/submit`, await as(GM), { requesterName: 'Site GM' })
    const queue = await (await call('/api/approvals/queue', await as(APPROVER))).json() as
      { requests: { order: { id: number; siteCode: string } }[] }
    const mine = queue.requests.find((r) => r.order.siteCode === `MAF${siteId}`)!
    const res = await post(`/api/approvals/${mine.order.id}/approve`, await as(APPROVER), {
      lines: [{ productId, qtyApproved: 2 }],
    })
    expect(res.status).toBe(200)
    return await db.prepare(`SELECT order_fee, recharge_total FROM orders WHERE id = ?`)
      .bind(mine.order.id).first<{ order_fee: number | null; recharge_total: number | null }>()
  }

  it('is not charged on an other-store order', async () => {
    const row = await approveAt(9, 2)
    // 2 x 3.00 and no fee: Mercium never saw this order.
    expect(row!.order_fee).toBe(0)
    expect(row!.recharge_total).toBe(6)
  })

  it('is still charged on a Mercium order', async () => {
    const row = await approveAt(9, 1)
    expect(row!.order_fee).toBe(12.5)
    expect(row!.recharge_total).toBe(18.5)
  })
})

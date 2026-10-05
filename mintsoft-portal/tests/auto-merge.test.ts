/**
 * Signing an order off joins it to one the site already has waiting.
 *
 * Ross asked for this to happen rather than be offered: Mercium charges a fee per order
 * and delivers per order, so two signed-off orders for one restaurant is money going out
 * twice, and a rule that depends on somebody noticing a card is a rule that gets missed.
 *
 * The half worth testing hardest is the other half — the cases where combining would
 * cost money and the right answer is to leave two orders alone WITHOUT losing the
 * approval that was just given.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { Env } from '../src/server/auth/middleware.ts'
import { buildSessionCookie, sessionCookieName, sessionTtlSeconds, signSession } from '../src/server/auth/session.ts'
import { linesForOrder, orderById } from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database
let app: ReturnType<typeof createApp>
let env: Env
const SECRET = 'test-secret'
const GM = 1, APPROVER = 2

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode) VALUES
      (1, 'M19', 'Fountainbridge', 'restaurant', '1 St', 'Edinburgh', 'EH3 9QG');
    INSERT INTO users (id, email, name, role) VALUES
      (1, 'gm@example.com', 'GM', 'gm'), (2, 'approver@example.com', 'Francheska', 'approver');
    INSERT INTO user_sites (user_id, site_id) VALUES (1, 1);
    INSERT INTO products (id, name, stock_type) VALUES
      (1, 'Ramen Bowl', 'internal'), (2, 'Chopsticks', 'internal');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (7001, 'BOWL-01', 'Ramen Bowl', '2026-10-05T10:00:00Z'),
      (7002, 'CHOP-01', 'Chopsticks', '2026-10-05T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES
      (1, 7001, 'BOWL-01', 1), (2, 7002, 'CHOP-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at) VALUES
      (7001, 1, 1, 100, 0, 100, '2026-10-05T10:00:00Z'),
      (7002, 1, 1, 100, 0, 100, '2026-10-05T10:00:00Z');
  `)
  app = createApp()
  env = { DB: fake as unknown as D1Database, SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'x' }
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

/** A GM raises and submits a request, and the approver signs it off as asked. */
async function raiseAndApprove(productId: number, qty: number): Promise<{ orderId: number; autoMerge: unknown }> {
  const gm = await as(GM)
  await post('/api/sites/1/request/lines', gm, { productId, qty })
  const basket = await (await call('/api/sites/1/request', gm)).json() as { request: { id: number } }
  await post(`/api/sites/1/request/submit`, gm, { requesterName: 'GM' })

  const approver = await as(APPROVER)
  const res = await post(`/api/approvals/${basket.request.id}/approve`, approver, {
    lines: [{ productId, qtyApproved: qty }],
  })
  const body = await res.json() as { autoMerge?: unknown; error?: string }
  expect(res.status, JSON.stringify(body)).toBe(200)
  return { orderId: basket.request.id, autoMerge: body.autoMerge }
}

describe('a second sign-off for the same site', () => {
  it('joins the first, so one order goes to Mercium', async () => {
    const first = await raiseAndApprove(1, 20)
    expect(first.autoMerge).toEqual({ kind: 'nothing_to_join' })

    const second = await raiseAndApprove(2, 10)
    expect(second.autoMerge).toMatchObject({ kind: 'merged' })

    // The first keeps its number, because it is the one quoted for longest.
    const kept = await orderById(db, first.orderId)
    const absorbed = await orderById(db, second.orderId)
    expect(kept?.status).toBe('approved')
    expect(absorbed?.status).toBe('cancelled')
    expect(absorbed?.mergedIntoOrderNumber).toBe(kept?.orderNumber)

    const lines = await linesForOrder(db, first.orderId)
    expect(lines).toHaveLength(2)
    expect(lines.filter((l) => l.qtyApproved === null)).toEqual([])
  })

  it('adds the quantities when it is the same product twice', async () => {
    const first = await raiseAndApprove(1, 20)
    await raiseAndApprove(1, 15)

    const lines = await linesForOrder(db, first.orderId)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.qtyApproved).toBe(35)
  })

  it('leaves one order waiting, not two', async () => {
    await raiseAndApprove(1, 20)
    await raiseAndApprove(2, 10)

    const body = await (await call('/api/approvals/awaiting-send', await as(APPROVER))).json() as
      { orders: unknown[]; doubledUp: unknown[] }
    expect(body.orders).toHaveLength(1)
    expect(body.doubledUp).toEqual([])
  })

  it('tells the site the number the stock is actually coming on', async () => {
    const first = await raiseAndApprove(1, 20)
    const gm = await as(GM)
    await post('/api/sites/1/request/lines', gm, { productId: 2, qty: 10 })
    const basket = await (await call('/api/sites/1/request', gm)).json() as { request: { id: number } }
    await post('/api/sites/1/request/submit', gm, { requesterName: 'GM' })

    const res = await post(`/api/approvals/${basket.request.id}/approve`, await as(APPROVER), {
      lines: [{ productId: 2, qtyApproved: 10 }],
    })
    const body = await res.json() as { autoMerge: { kind: string; into: string } }
    // The email subject and body are built from this, so an order number that no longer
    // exists never reaches the GM.
    expect(body.autoMerge.into).toBe((await orderById(db, first.orderId))?.orderNumber)
  })
})

describe('when combining would cost money, the approval still stands', () => {
  it('keeps both orders when together they want more than the warehouse has', async () => {
    const first = await raiseAndApprove(1, 60)
    // 60 + 60 against 100 on hand. Separately both are sendable; combined, neither is.
    const second = await raiseAndApprove(1, 60)

    expect(second.autoMerge).toMatchObject({ kind: 'held_back' })
    expect((second.autoMerge as { reason: string }).reason).toMatch(/more than the warehouse has/)

    // Both still signed off, both still sendable, nothing lost.
    expect((await orderById(db, first.orderId))?.status).toBe('approved')
    expect((await orderById(db, second.orderId))?.status).toBe('approved')
    const body = await (await call('/api/approvals/awaiting-send', await as(APPROVER))).json() as
      { orders: unknown[]; doubledUp: { siteCode: string }[] }
    expect(body.orders).toHaveLength(2)
    // And the pair is surfaced, so a person can decide what to do about it.
    expect(body.doubledUp.map((d) => d.siteCode)).toEqual(['M19'])
  })

  it('keeps both when the first may already be at Mercium', async () => {
    const first = await raiseAndApprove(1, 20)
    // The uncertain state: a send went out and no reply came back.
    fake.exec(`UPDATE orders SET post_error = 'The portal lost contact before it heard back.' WHERE id = ${first.orderId}`)

    const second = await raiseAndApprove(2, 10)
    expect(second.autoMerge).toMatchObject({ kind: 'held_back' })
    expect((second.autoMerge as { reason: string }).reason).toMatch(/may already be with Mercium/)
    expect((await orderById(db, second.orderId))?.status).toBe('approved')
  })
})

describe('the order that was absorbed', () => {
  it('cannot be re-ordered through the API, however stale the screen', async () => {
    await raiseAndApprove(1, 20)
    const second = await raiseAndApprove(2, 10)

    const res = await post(`/api/orders/${second.orderId}/reorder`, await as(GM), {})
    const body = await res.json() as { error: string }
    expect(res.status).toBe(400)
    // Hiding the button is not enough: a GM whose screen loaded before the merge has one.
    expect(body.error).toMatch(/already on its way/)
  })
})

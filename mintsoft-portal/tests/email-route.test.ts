/**
 * The warehouse that has no WMS.
 *
 * Some Maki stock is not at Mercium, so there is no Mintsoft order to create for it and
 * no API to create one with. Those orders are fulfilled by emailing a pick list, which
 * makes the email the order rather than a note about one — and that moves the whole risk
 * of this route onto a single question: can an order ever be marked fulfilled when
 * nobody was actually told to pick it?
 *
 * Most of what follows is that question asked in each of the ways it can go wrong. The
 * portal has no email key configured in production at the time of writing, so the first
 * test is not hypothetical: it is the live state of the system.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { orderById } from '../src/server/db/orders.ts'
import { addToBasket } from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import type { MintsoftWriteClient } from '../src/server/orders/post.ts'
import { sendApprovedOrder } from '../src/server/orders/send.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database
const ACTOR = 'ross@example.com'
const RECIPIENTS = 'ross@makiramen.com,ramenhq97@gmail.com'

/** Every Resend call this test run made, with the body it carried. */
let emails: { to: string[]; subject: string; text: string }[]
/** What the stubbed Resend answers with. */
let resend: { mode: 'ok' | 'http500' | 'network' }

beforeEach(() => {
  emails = []
  resend = { mode: 'ok' }
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    if (!String(url).includes('api.resend.com')) throw new Error(`unexpected fetch to ${url}`)
    const body = JSON.parse(init.body) as { to: string[]; subject: string; text: string }
    emails.push(body)
    if (resend.mode === 'network') throw new Error('socket hang up')
    if (resend.mode === 'http500') return new Response('', { status: 500 })
    return new Response(JSON.stringify({ id: 'e_1' }), { status: 200 })
  })

  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode)
      VALUES (1, 'M9', 'Maki Leith Walk', 'restaurant', '1 Example St', 'Edinburgh', 'EH6 5AA');
    INSERT INTO users (id, email, name, role) VALUES (2, '${ACTOR}', 'Ross', 'approver');

    -- One product in each warehouse. The offline one is deliberately mapped to nothing
    -- and carries no stock row, because that is exactly how these products exist.
    INSERT INTO products (id, name, stock_type, unit, supply_route) VALUES
      (1, 'Ramen Bowl',    'internal', 'Case', 'mercium'),
      (2, 'Kewpie Mayonnaise', 'internal', 'Case', 'email'),
      (3, 'White Miso',    'internal', 'Unit', 'email');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (7001, 'BOWL-01', 'Ramen Bowl', '2026-11-20T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES
      (1, 7001, 'BOWL-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at)
      VALUES (7001, 1, 1, 50, 0, 50, '2026-11-20T10:00:00Z');

    UPDATE settings SET email_route_recipients = '${RECIPIENTS}' WHERE id = 1;

    INSERT INTO orders (id, order_number, site_id, type, status, approved_by, approved_at, requester_name, required_date)
      VALUES (1, 'MR-M9-20261124-001', 1, 'replenishment', 'approved', 2, '2026-11-24T11:00:00Z', 'Nilesh', '2026-11-28');
    INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved) VALUES
      (1, 2, 6, 6),
      (1, 3, 2, 2);
  `)
})

/** Fails the test if Mintsoft is touched at all. */
function noMintsoft(): MintsoftWriteClient {
  return {
    async get<T>() { throw new Error('Mintsoft was read for an email-route order') as never & T },
    async putOrder() { throw new Error('Mintsoft was written for an email-route order') },
  }
}

/**
 * Takes the environment explicitly rather than defaulting a key argument.
 *
 * `send(undefined)` against a default parameter re-applies the default, so the very test
 * that exists to prove a missing key stops the send was quietly running WITH a key — and
 * passing, because the email it was asserting against did go out. Hence `send({})`.
 */
const send = (emailEnv: { RESEND_API_KEY?: string } = { RESEND_API_KEY: 'rs_test' }) =>
  sendApprovedOrder(db, noMintsoft(), {
    orderId: 1, actor: ACTOR, writesEnabled: true, clientId: 42, warehouseId: 1,
    emailEnv: { PORTAL_URL: 'https://mintsoft-portal.pages.dev', ...emailEnv },
  })

describe('an order for stock Mercium does not hold', () => {
  it('is never marked sent when the portal has no email key', async () => {
    // The whole feature rests on this. Email is the only way this order reaches anyone,
    // so a missing key has to stop it dead rather than leave it looking despatched.
    const result = await send({})

    expect(emails).toHaveLength(0)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('not_configured')
    expect(result.message).toMatch(/RESEND_API_KEY/)
    expect(result.message).toMatch(/[Nn]othing has been sent/)

    const after = await orderById(db, 1)
    expect(after!.status).not.toBe('posted')
    expect(after!.postedAt).toBeNull()
  })

  it('is never marked sent when nobody is configured to receive it', async () => {
    fake.exec(`UPDATE settings SET email_route_recipients = '' WHERE id = 1`)

    const result = await send()

    expect(emails).toHaveLength(0)
    expect(result.status).toBe('not_configured')
    expect(result.message).toMatch(/no recipients are configured/)
    expect((await orderById(db, 1))!.postedAt).toBeNull()
  })

  it('emails the pick list and only then marks it sent', async () => {
    const result = await send()

    expect(result.ok).toBe(true)
    expect(result.status).toBe('posted')
    expect(result.route).toBe('email')

    expect(emails).toHaveLength(1)
    const email = emails[0]!
    expect(email.to).toEqual(['ross@makiramen.com', 'ramenhq97@gmail.com'])
    expect(email.subject).toContain('MR-M9-20261124-001')

    // The quantities actually approved, with their units, and the site to send them to.
    expect(email.text).toMatch(/6 x Kewpie Mayonnaise \(Case\)/)
    expect(email.text).toMatch(/2 x White Miso \(Unit\)/)
    expect(email.text).toContain('Maki Leith Walk')
    expect(email.text).toContain('EH6 5AA')
    expect(email.text).toContain('2026-11-28')
    // Says plainly that there is no Mintsoft order, so a picker does not go looking.
    expect(email.text).toMatch(/not held at Mercium/)

    const after = await orderById(db, 1)
    expect(after!.status).toBe('posted')
    expect(after!.postedAt).not.toBeNull()
    // No Mintsoft order exists, and the reconcile job selects on this column — leaving it
    // null is what stops it hunting for a despatch that will never be reported.
    expect(after!.mintsoftOrderId).toBeNull()
  })

  it('records who was told to pick it', async () => {
    await send()
    const { results } = await db
      .prepare(`SELECT event, detail FROM order_events WHERE order_id = 1 AND event = 'posted'`)
      .all<{ event: string; detail: string }>()
    expect(results).toHaveLength(1)
    // "Who was told to pick this" is the question asked when stock does not turn up, and
    // nothing else in the system would answer it.
    const detail = JSON.parse(results[0]!.detail) as { route: string; recipients: string[] }
    expect(detail.route).toBe('email')
    expect(detail.recipients).toEqual(['ross@makiramen.com', 'ramenhq97@gmail.com'])
  })

  it('does not email a second pick list once one has gone', async () => {
    await send()
    const second = await send()

    // Two identical pick lists a day apart is how a site ends up with twice the stock.
    expect(emails).toHaveLength(1)
    expect(second.ok).toBe(false)
    expect(second.status).toBe('already_posted')
    expect(second.message).toMatch(/already sent to the warehouse/)
  })

  it('treats a lost connection as uncertain rather than failed', async () => {
    resend.mode = 'network'
    const result = await send()

    expect(result.status).toBe('uncertain')
    const after = await orderById(db, 1)
    // Deliberately not post_failed: a failure invites a retry, and the email may well
    // have been accepted before the socket died.
    expect(after!.status).toBe('approved')
    expect(after!.postError).toMatch(/Could not reach Resend/)
    // The claim is held, which is what actually stops the retry.
    const row = await db.prepare(`SELECT send_claimed_at FROM orders WHERE id = 1`)
      .first<{ send_claimed_at: string | null }>()
    expect(row!.send_claimed_at).not.toBeNull()
  })

  it('reports a refusal from the email service as safe to retry', async () => {
    resend.mode = 'http500'
    const result = await send()

    expect(result.status).toBe('rejected')
    expect(result.message).toMatch(/safe to try again/)
    const after = await orderById(db, 1)
    expect(after!.status).toBe('post_failed')
    expect(after!.postedAt).toBeNull()
    // Given back, so the retry the message invites can actually happen.
    const row = await db.prepare(`SELECT send_claimed_at FROM orders WHERE id = 1`)
      .first<{ send_claimed_at: string | null }>()
    expect(row!.send_claimed_at).toBeNull()
  })

  it('will not email an empty pick list', async () => {
    fake.exec(`UPDATE order_lines SET qty_approved = 0 WHERE order_id = 1`)
    const result = await send()

    expect(emails).toHaveLength(0)
    expect(result.message).toMatch(/nothing to send/)
  })

  it('will not send quantities nobody approved', async () => {
    fake.exec(`UPDATE order_lines SET qty_approved = NULL WHERE product_id = 3`)
    const result = await send()

    expect(emails).toHaveLength(0)
    expect(result.message).toMatch(/nobody has approved/)
  })
})

describe('an order that spans both warehouses', () => {
  it('cannot be built in the first place', async () => {
    fake.exec(`
      INSERT INTO orders (id, order_number, site_id, type, status)
        VALUES (2, 'MR-M9-20261124-002', 1, 'replenishment', 'draft');
      INSERT INTO order_lines (order_id, product_id, qty_requested) VALUES (2, 2, 4);
    `)

    await expect(addToBasket(db, {
      siteId: 1, productId: 1, qty: 3, actor: ACTOR, availableNow: 50,
    })).rejects.toThrow(/two different warehouses/)

    // The refusal names both sides, because the catalogue gives no hint that two products
    // on one screen live in different buildings.
    await expect(addToBasket(db, {
      siteId: 1, productId: 1, qty: 3, actor: ACTOR, availableNow: 50,
    })).rejects.toThrow(/Ramen Bowl/)

    // And nothing was added.
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM order_lines WHERE order_id = 2`)
      .first<{ n: number }>()
    expect(row!.n).toBe(1)
  })

  it('is refused at send if a product changed warehouse after sign-off', async () => {
    // Moving an item between warehouses is an ordinary thing to do, and it can happen
    // while an order sits signed off and waiting.
    fake.exec(`INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved) VALUES (1, 1, 3, 3)`)

    const result = await send()

    expect(emails).toHaveLength(0)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/two different warehouses/)
    expect((await orderById(db, 1))!.postedAt).toBeNull()
  })
})

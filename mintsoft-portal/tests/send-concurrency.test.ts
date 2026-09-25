/**
 * Two people pressing Send at the same moment.
 *
 * Found by an adversarial review of the write path, on the day writes were to be turned
 * on for the first time. Every guard before the PUT was a READ — the write gate's
 * "already has a mintsoft_order_id" check, and the Order/Search lookup — and nothing
 * wrote to the orders row in between. So:
 *
 *   Francheska presses Send        Lincoln presses Send
 *   reads order, id is NULL        reads order, id is NULL
 *   gate passes                    gate passes
 *   Search says absent             Search says absent
 *   PUT -> Mercium order A         PUT -> Mercium order B
 *
 * Mintsoft has no idempotency, so Mercium picks, ships and bills both. These tests hold
 * the line that exactly one PUT leaves the building.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { orderById } from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import type { MintsoftWriteClient } from '../src/server/orders/post.ts'
import { sendApprovedOrder } from '../src/server/orders/send.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database
const ACTOR = 'francheska@example.com'
const OTHER = 'lincoln@example.com'

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode)
      VALUES (1, 'M9', 'Maki Leith Walk', 'restaurant', '1 Example St', 'Edinburgh', 'EH6 5AA');
    INSERT INTO users (id, email, name, role) VALUES
      (2, '${ACTOR}', 'Francheska', 'approver'),
      (4, '${OTHER}', 'Lincoln', 'approver');
    INSERT INTO products (id, name, stock_type) VALUES (1, 'Ramen Bowl', 'internal');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at)
      VALUES (7001, 'BOWL-01', 'Ramen Bowl', '2026-09-21T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
      VALUES (1, 7001, 'BOWL-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at)
      VALUES (7001, 1, 1, 50, 0, 50, '2026-09-21T10:00:00Z');
    INSERT INTO orders (id, order_number, site_id, type, status, approved_by, approved_at)
      VALUES (1, 'MR-M9-20260921-001', 1, 'replenishment', 'approved', 2, '2026-09-21T11:00:00Z');
    INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved)
      VALUES (1, 1, 10, 10);
  `)
})

/** Counts PUTs across every caller, which is the number Mercium would actually receive. */
function sharedClient(opts: { search?: unknown[]; put?: unknown } = {}) {
  const puts: unknown[] = []
  const client: MintsoftWriteClient = {
    async get<T>() {
      return { data: (opts.search ?? []) as T, status: 200, ms: 1, raw: '' }
    },
    async putOrder(body) {
      puts.push(body)
      return { data: (opts.put ?? [{ Success: true, OrderId: 8811 }]) as never, status: 200, raw: '' }
    },
  }
  return { client, puts }
}

const send = (client: MintsoftWriteClient, actor: string) =>
  sendApprovedOrder(db, client, {
    orderId: 1, actor, writesEnabled: true, clientId: 42, warehouseId: 1,
  })

describe('two sends racing', () => {
  it('lets exactly one through, however many press the button', async () => {
    const { client, puts } = sharedClient()

    const results = await Promise.all([
      send(client, ACTOR), send(client, OTHER), send(client, ACTOR),
    ])

    // The number that matters: what Mercium receives.
    expect(puts).toHaveLength(1)
    expect(results.filter((r) => r.status === 'posted')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'in_flight')).toHaveLength(2)
  })

  it('tells the loser to wait rather than to try again', async () => {
    const { client } = sharedClient()
    const [, second] = await Promise.all([send(client, ACTOR), send(client, OTHER)])
    const loser = second.status === 'in_flight' ? second : null
    // "Failed" invites a retry, and a retry is the duplicate.
    expect(loser?.message).toMatch(/already being sent/)
    expect(loser?.message).not.toMatch(/failed|error/i)
  })

  it('records the id once, not twice', async () => {
    const { client } = sharedClient()
    await Promise.all([send(client, ACTOR), send(client, OTHER)])
    expect((await orderById(db, 1))?.mintsoftOrderId).toBe(8811)
  })
})

describe('giving the order back', () => {
  it('releases the claim when Mintsoft itself refuses, so it can be retried', async () => {
    const { client } = sharedClient({ put: [{ Success: false, Message: 'No CourierService Specified!' }] })
    const result = await send(client, ACTOR)
    expect(result.status).toBe('rejected')

    const row = fake.sqlite.prepare(`SELECT send_claimed_at FROM orders WHERE id = 1`)
      .get() as { send_claimed_at: string | null }
    // Mintsoft said Success:false, so nothing exists there and a retry is safe.
    expect(row.send_claimed_at).toBeNull()
  })

  it('keeps the claim when the connection dropped mid-create, because the order may exist', async () => {
    // The dangerous one: the lookup said absent, so we claimed and sent — and then the
    // reply never arrived. Mercium may well have it.
    const client: MintsoftWriteClient = {
      async get<T>() { return { data: [] as T, status: 200, ms: 1, raw: '' } },
      async putOrder() { throw new Error('socket hang up') },
    }
    const result = await send(client, ACTOR)
    expect(result.status).toBe('uncertain')

    const row = fake.sqlite.prepare(`SELECT send_claimed_at FROM orders WHERE id = 1`)
      .get() as { send_claimed_at: string | null }
    // Held, so a blind retry cannot turn a maybe into a second pallet.
    expect(row.send_claimed_at).not.toBeNull()
  })

  it('never claims when the lookup could not answer, because nothing was created', async () => {
    // A 404 means "absent OR not visible to this key". We do not create on that, so
    // there is nothing to protect and the retry should be free to look again.
    const client: MintsoftWriteClient = {
      async get<T>() { return { data: null as T, status: 404, ms: 1, raw: '' } },
      async putOrder() { throw new Error('should never be called') },
    }
    expect((await send(client, ACTOR)).status).toBe('uncertain')

    const row = fake.sqlite.prepare(`SELECT send_claimed_at FROM orders WHERE id = 1`)
      .get() as { send_claimed_at: string | null }
    expect(row.send_claimed_at).toBeNull()
  })

  it('does not strand an order forever: a stale claim can be taken again', async () => {
    // A process that died mid-send, twenty minutes ago.
    fake.exec(`UPDATE orders SET send_claimed_at = '2020-01-01T00:00:00Z' WHERE id = 1`)
    const { client, puts } = sharedClient()

    const result = await send(client, OTHER)
    expect(result.status).toBe('posted')
    expect(puts).toHaveLength(1)
  })

  it('still refuses a fresh claim held by someone else', async () => {
    fake.exec(`UPDATE orders SET send_claimed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`)
    const { client, puts } = sharedClient()

    expect((await send(client, OTHER)).status).toBe('in_flight')
    expect(puts).toHaveLength(0)
  })
})

describe('the claim does not replace the lookup', () => {
  it('still attaches an order that already exists at Mercium rather than creating a second', async () => {
    // The crash-window case: a previous process created it but died before recording.
    const { client, puts } = sharedClient({
      search: [{ ID: 9999, OrderNumber: 'MRK-9999', ExternalOrderReference: 'MR-M9-20260921-001' }],
    })
    const result = await send(client, ACTOR)

    expect(puts).toHaveLength(0)
    expect(result.mintsoftOrderId).toBe(9999)
    expect((await orderById(db, 1))?.mintsoftOrderId).toBe(9999)
  })
})

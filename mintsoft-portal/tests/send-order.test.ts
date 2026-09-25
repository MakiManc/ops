import { beforeEach, describe, expect, it } from 'vitest'
import { eventsForOrder, orderById } from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import type { MintsoftWriteClient } from '../src/server/orders/post.ts'
import { sendApprovedOrder } from '../src/server/orders/send.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * The end of the line: an approved order reaching Mercium. Every route to Mintsoft's
 * create endpoint goes through here, and here goes through the write gate first.
 */

let fake: FakeD1
let db: Database
const ACTOR = 'francheska@example.com'

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode)
      VALUES (1, 'M9', 'Maki Leith Walk', 'restaurant', '1 Example St', 'Edinburgh', 'EH6 5AA');
    INSERT INTO users (id, email, name, role) VALUES
      (1, 'gm@example.com', 'GM', 'gm'),
      (2, '${ACTOR}', 'Francheska', 'approver'),
      (3, 'ross@example.com', 'Ross', 'admin');
    INSERT INTO products (id, name, stock_type) VALUES (1, 'Ramen Bowl', 'internal');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at)
      VALUES (7001, 'BOWL-01', 'Ramen Bowl', '2026-09-21T10:00:00Z'),
             (7002, 'BOWL-02', 'Ramen Bowl v2', '2026-09-21T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
      VALUES (1, 7001, 'BOWL-01', 1), (1, 7002, 'BOWL-02', 0);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at)
      VALUES (7001, 1, 1, 20, 0, 20, '2026-09-21T10:00:00Z'),
             (7002, 1, 1, 50, 0, 50, '2026-09-21T10:00:00Z');
    INSERT INTO orders (id, order_number, site_id, type, status, approved_by, approved_at)
      VALUES (1, 'MR-M9-20260921-001', 1, 'replenishment', 'approved', 2, '2026-09-21T11:00:00Z');
    INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved)
      VALUES (1, 1, 30, 30);
  `)
})

function stub(opts: { search?: unknown[]; searchStatus?: number; put?: unknown; putThrows?: Error } = {}) {
  const puts: unknown[] = []
  const client: MintsoftWriteClient = {
    async get<T>() {
      return { data: (opts.search ?? []) as T, status: opts.searchStatus ?? 200, ms: 1, raw: '' }
    },
    async putOrder(body) {
      puts.push(body)
      if (opts.putThrows) throw opts.putThrows
      return {
        data: (opts.put ?? [{ Success: true, OrderId: 8811, OrderNumber: 'MRK-8811' }]) as never,
        status: 200, raw: '',
      }
    },
  }
  return { client, puts }
}

const send = (client: MintsoftWriteClient, writesEnabled = true) =>
  sendApprovedOrder(db, client, {
    orderId: 1, actor: ACTOR, writesEnabled, clientId: 42, warehouseId: 1,
  })

describe('the gate', () => {
  it('sends nothing at all when writes are switched off', async () => {
    const { client, puts } = stub()
    const result = await send(client, false)
    expect(result.status).toBe('refused')
    expect(result.message).toMatch(/switched off/)
    expect(puts).toHaveLength(0)
    // The refusal is recorded, because "why did this not go" gets asked.
    expect((await eventsForOrder(db, 1)).map((e) => e.event)).toContain('send_refused')
  })

  it('sends an order approved by an admin — an admin may sign off too', async () => {
    fake.exec(`UPDATE orders SET approved_by = 3 WHERE id = 1`)   // user 3 is the admin
    const { client, puts } = stub()
    expect((await send(client)).ok).toBe(true)
    expect(puts).toHaveLength(1)
  })

  it('still refuses an order approved by a GM', async () => {
    fake.exec(`UPDATE orders SET approved_by = 1 WHERE id = 1`)   // user 1 is a GM
    const { client, puts } = stub()
    expect((await send(client)).status).toBe('refused')
    expect(puts).toHaveLength(0)
  })

  it('refuses an order that was never approved', async () => {
    fake.exec(`UPDATE orders SET status = 'submitted' WHERE id = 1`)
    const { client, puts } = stub()
    expect((await send(client)).status).toBe('refused')
    expect(puts).toHaveLength(0)
  })
})

describe('a clean send', () => {
  it('posts the order and records the Mintsoft id', async () => {
    const { client, puts } = stub()
    const result = await send(client)
    expect(result).toMatchObject({ ok: true, status: 'posted', mintsoftOrderId: 8811 })
    expect(puts).toHaveLength(1)

    const order = await orderById(db, 1)
    expect(order).toMatchObject({ status: 'posted', mintsoftOrderId: 8811 })
    expect((await eventsForOrder(db, 1)).map((e) => e.event)).toContain('posted')
  })

  it("records the number Mintsoft gave it, which is the one Mercium will quote", async () => {
    const { client } = stub()
    const result = await send(client)
    expect(result.message).toContain('MRK-8811')

    const { results } = await db.prepare(`SELECT mintsoft_order_number FROM orders WHERE id = 1`)
      .all<{ mintsoft_order_number: string | null }>()
    expect(results[0]?.mintsoft_order_number).toBe('MRK-8811')
  })

  it('still records the send when Mintsoft reports success but echoes no number', async () => {
    // Success and an id, no OrderNumber. The order exists; falling over here would
    // strand a real order over a missing label.
    const { client } = stub({ put: [{ Success: true, OrderId: 8811 }] })
    const result = await send(client)
    expect(result).toMatchObject({ ok: true, status: 'posted', mintsoftOrderId: 8811 })
    const { results } = await db.prepare(`SELECT mintsoft_order_number FROM orders WHERE id = 1`)
      .all<{ mintsoft_order_number: string | null }>()
    expect(results[0]?.mintsoft_order_number).toBeNull()
  })

  it('splits the line across warehouse SKUs when the primary cannot cover it', async () => {
    const { client, puts } = stub()
    await send(client)
    const body = puts[0] as { OrderItems: { SKU: string; Quantity: number }[] }
    // 30 wanted, 20 on the primary, so 10 comes from the duplicate.
    expect(body.OrderItems).toEqual([
      { SKU: 'BOWL-01', Quantity: 20 },
      { SKU: 'BOWL-02', Quantity: 10 },
    ])
  })

  it('sends the site\'s delivery address', async () => {
    const { client, puts } = stub()
    await send(client)
    expect(puts[0]).toMatchObject({
      CompanyName: 'Maki Leith Walk', Address1: '1 Example St',
      Town: 'Edinburgh', PostCode: 'EH6 5AA', CourierServiceId: 169,
    })
  })
})

describe('when stock has moved since approval', () => {
  it('blocks rather than sending an order the warehouse cannot fill', async () => {
    fake.exec(`UPDATE stock_cache SET available = 2 WHERE mintsoft_product_id IN (7001, 7002)`)
    const { client, puts } = stub()
    const result = await send(client)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/26 short/)
    expect(puts).toHaveLength(0)
    expect((await orderById(db, 1))!.status).toBe('post_failed')
  })

  it('blocks when a mapped SKU has no stock reading at all', async () => {
    fake.exec(`DELETE FROM stock_cache WHERE mintsoft_product_id = 7002`)
    const { client, puts } = stub()
    // Unknown is not zero, and an unknown total must not be ordered against.
    expect((await send(client)).ok).toBe(false)
    expect(puts).toHaveLength(0)
  })
})

describe('when Mintsoft refuses', () => {
  it('records the refusal and its reason', async () => {
    const { client } = stub({ put: [{ Success: false, Message: 'SKU BOWL-01 is discontinued' }] })
    const result = await send(client)
    expect(result.status).toBe('rejected')
    expect((await orderById(db, 1))!.postError).toMatch(/discontinued/)
    expect((await orderById(db, 1))!.status).toBe('post_failed')
  })
})

describe('when we do not know whether it went', () => {
  it('does not mark the order failed, because failed invites a retry', async () => {
    const { client } = stub({ putThrows: new Error('socket hang up') })
    const result = await send(client)
    expect(result.status).toBe('uncertain')

    const order = await orderById(db, 1)
    // Still approved: the next attempt re-runs the lookup, which is what the order
    // number exists for. Marking it failed would invite a duplicate.
    expect(order!.status).toBe('approved')
    expect(order!.postError).toMatch(/may or may not have been created/)
    expect((await eventsForOrder(db, 1)).map((e) => e.event)).toContain('post_uncertain')
  })

  it('attaches the existing order when the retry finds it', async () => {
    const first = stub({ putThrows: new Error('socket hang up') })
    await send(first.client)

    const second = stub({ search: [{ OrderNumber: 'MRK-8811', ExternalOrderReference: 'MR-M9-20260921-001', ID: 8811 }] })
    const result = await send(second.client)

    expect(result).toMatchObject({ ok: true, status: 'already_posted', mintsoftOrderId: 8811 })
    expect(second.puts).toHaveLength(0)   // no second order
    expect((await orderById(db, 1))!.status).toBe('posted')
  })

  it('refuses to send again once the order is attached', async () => {
    const { client } = stub()
    await send(client)
    const again = stub()
    const result = await send(again.client)
    expect(result.status).toBe('already_posted')
    expect(again.puts).toHaveLength(0)
  })
})

/**
 * Mintsoft refuses an order that carries no courier service:
 *
 *   "No CourierService Specified! Either use CourierService or CourierServiceId"
 *
 * Phase 3's live test order hit exactly that, which is why one is still sent. What
 * changed is what it means. It used to be a choice, with a per-site column above an
 * account default; nobody at Maki was ever in a position to make that choice, and the
 * data agreed -- all 23 sites left it NULL, so the fallback carried every order anyway.
 * Mercium decides how a thing ships, when they raise the shipment. This value only has
 * to get the order through the door.
 */
describe('the courier service, which Mintsoft will not accept an order without', () => {
  const courierOf = (puts: unknown[]) =>
    (puts[0] as Record<string, unknown> | undefined)?.CourierServiceId

  it('is the account default, the same one for every site', async () => {
    const { client, puts } = stub()
    await send(client)
    // 169 is DPD Next Day - Parcel: 44 of the account's 50 most recent orders used it.
    expect(courierOf(puts)).toBe(169)
  })

  it('is never absent, whatever the site looks like', async () => {
    const { client, puts } = stub()
    await send(client)
    expect(courierOf(puts)).toBeDefined()
    expect(courierOf(puts)).not.toBeNull()
  })

  it('cannot be varied per site any more, because that column is gone', async () => {
    const { results } = await fake.prepare(`SELECT name FROM pragma_table_info('sites')`)
      .all<{ name: string }>()
    expect(results.map((c) => c.name)).not.toContain('default_courier_service_id')
  })
})

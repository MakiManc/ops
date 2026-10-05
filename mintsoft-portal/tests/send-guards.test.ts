/**
 * The two ways a bad order could have reached Mercium.
 *
 * Both were found by an adversarial review on the day writes were to be turned on, and
 * both were reachable without touching the API — through the merge feature and through
 * the approval screen's own default button.
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

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type, address_1, town, postcode)
      VALUES (1, 'M9', 'Maki Leith Walk', 'restaurant', '1 Example St', 'Edinburgh', 'EH6 5AA');
    INSERT INTO users (id, email, name, role) VALUES (2, '${ACTOR}', 'Francheska', 'approver');
    INSERT INTO products (id, name, stock_type) VALUES
      (1, 'Ramen Bowl', 'internal'), (2, 'Chilli Oil', 'internal');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (7001, 'BOWL-01', 'Ramen Bowl', '2026-09-21T10:00:00Z'),
      (7002, 'OIL-01', 'Chilli Oil', '2026-09-21T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES
      (1, 7001, 'BOWL-01', 1), (2, 7002, 'OIL-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, available, synced_at) VALUES
      (7001, 1, 1, 50, 0, 50, '2026-09-21T10:00:00Z'),
      (7002, 1, 1, 50, 0, 50, '2026-09-21T10:00:00Z');
    INSERT INTO orders (id, order_number, site_id, type, status, approved_by, approved_at)
      VALUES (1, 'MR-M9-20260921-001', 1, 'replenishment', 'approved', 2, '2026-09-21T11:00:00Z');
  `)
})

function stub() {
  const puts: unknown[] = []
  const client: MintsoftWriteClient = {
    async get<T>() { return { data: [] as T, status: 200, ms: 1, raw: '' } },
    async putOrder(body) {
      puts.push(body)
      return { data: [{ Success: true, OrderId: 8811 }] as never, status: 200, raw: '' }
    },
  }
  return { client, puts }
}

const send = () => sendApprovedOrder(db, stubbed.client, {
  orderId: 1, actor: ACTOR, writesEnabled: true, clientId: 42, warehouseId: 1,
})
let stubbed: ReturnType<typeof stub>
beforeEach(() => { stubbed = stub() })

describe('a line nobody approved', () => {
  // Reachable through merging: two pending requests per site are allowed so merging
  // works, and merging adds lines to an order an approver may already have open.
  beforeEach(() => {
    fake.exec(`
      INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved) VALUES
        (1, 1, 10, 10),
        (1, 2, 40, NULL);   -- merged in after the approver loaded the screen
    `)
  })

  it('is never sent at the quantity the GM asked for', async () => {
    const result = await send()
    expect(stubbed.puts).toHaveLength(0)
    expect(result.ok).toBe(false)
    // The old code did `qtyApproved ?? qtyRequested`, silently shipping 40.
    expect(result.message).toMatch(/nobody has approved/)
    expect(result.message).toMatch(/Chilli Oil/)
  })

  it('says what to do, and leaves a record of why it stopped', async () => {
    await send()
    expect((await orderById(db, 1))?.status).toBe('post_failed')
    expect((await orderById(db, 1))?.postError).toMatch(/Send it back through approval/)
  })

  it('sends normally once every line has been approved', async () => {
    fake.exec(`UPDATE order_lines SET qty_approved = 40 WHERE order_id = 1 AND product_id = 2`)
    const result = await send()
    expect(result.ok).toBe(true)
    expect(stubbed.puts).toHaveLength(1)
    const items = (stubbed.puts[0] as { OrderItems: { SKU: string; Quantity: number }[] }).OrderItems
    expect(items).toHaveLength(2)
  })
})

describe('an order approved at zero on every line', () => {
  // The approval screen pre-fills each box with min(requested, available), so for a
  // wholly out-of-stock request the obvious button approves nothing at all.
  beforeEach(() => {
    fake.exec(`INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved)
               VALUES (1, 1, 12, 0)`)
  })

  it('is never created at Mercium as an empty order', async () => {
    const result = await send()
    expect(stubbed.puts).toHaveLength(0)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/nothing to send/)
  })

  it('suggests rejecting it, so the site is actually told', async () => {
    const result = await send()
    // An empty order would have been billed a per-order fee, picked nothing, and left
    // the GM believing their stock was on the way.
    expect(result.message).toMatch(/Reject it instead/)
    expect((await orderById(db, 1))?.mintsoftOrderId).toBeNull()
  })

  it('still sends when at least one line has a quantity', async () => {
    fake.exec(`INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved)
               VALUES (1, 2, 5, 5)`)
    const result = await send()
    expect(result.ok).toBe(true)
    const items = (stubbed.puts[0] as { OrderItems: unknown[] }).OrderItems
    // Only the line with a quantity; the zero one carries nothing to pick.
    expect(items).toHaveLength(1)
  })
})

/**
 * The way an uncertain order could be laundered into a mergeable one.
 *
 * A send whose reply never arrives leaves the order 'approved' with post_error set and
 * the claim held: it may already be at Mercium, and that pair is the only record saying
 * so. Merging such an order moves its lines onto a different reference, the duplicate
 * lookup finds nothing, and the same stock is picked twice.
 *
 * The hole was that a SECOND press which tripped one of the pre-send guards used to
 * overwrite post_error and demote the order to 'post_failed' — which reads as "Mintsoft
 * refused it, nothing was created", exactly the state merging treats as safe. One
 * blocked retry turned a maybe into a duplicate.
 */
describe('a blocked retry on an order that may already be at Mercium', () => {
  beforeEach(() => {
    fake.exec(`
      INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved) VALUES
        (1, 1, 10, 10),
        (1, 2, 40, NULL);   -- enough to trip the unapproved-line guard
      UPDATE orders SET post_error = 'The portal lost contact before it heard back.' WHERE id = 1;
    `)
  })

  it('refuses the send, as it should', async () => {
    const result = await send()
    expect(result.ok).toBe(false)
    expect(stubbed.puts).toHaveLength(0)
  })

  it('leaves the order approved, not post_failed, so it is still treated as uncertain', async () => {
    await send()
    const row = fake.sqlite.prepare(`SELECT status, post_error FROM orders WHERE id = 1`)
      .get() as { status: string; post_error: string }
    expect(row.status).toBe('approved')
    expect(row.post_error).toMatch(/lost contact/)
  })

  it('does not release a claim it never took', async () => {
    fake.exec(`UPDATE orders SET send_claimed_at = '2099-01-01T00:00:00Z' WHERE id = 1`)
    await send()
    const row = fake.sqlite.prepare(`SELECT send_claimed_at FROM orders WHERE id = 1`)
      .get() as { send_claimed_at: string | null }
    // The hold is what stops a retry turning a maybe into a duplicate.
    expect(row.send_claimed_at).toBe('2099-01-01T00:00:00Z')
  })
})

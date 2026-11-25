/**
 * Sites whose code an order number cannot carry.
 *
 * Order numbers are MR-<code>-<yyyymmdd>-<seq> and that number is the idempotency key
 * against Mintsoft, so buildOrderNumber only accepts [A-Z0-9]. Four real sites have codes
 * it cannot take — "M1/2", "MAKI NORI", "MAKI PROPERTY" and "AAHQ-GLASGOW" — and for each
 * of them creating the first draft threw a plain Error, which the API turned into a bare
 * "server_error" 500 under the Add button.
 *
 * They had placed no orders at all between them since the portal opened, and nobody knew:
 * the failure named nothing, so it read as the portal being down rather than a site
 * setting nobody had filled in. A GM at M1/2 found it by trying to order a hoodie.
 *
 * Two things are tested here, because fixing only the first would leave the trap set for
 * the next site someone adds with a space in its code.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { addToBasket, OrderError } from '../src/server/db/orders.ts'
import type { Database } from '../src/server/db/repo.ts'
import { buildOrderNumber } from '../src/server/orders/order-number.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, order_code, name, type, address_1, town, postcode) VALUES
      (1, 'M1/2',  'M1AND2', 'M1TOO Ltd',        'restaurant', '1 St', 'Edinburgh', 'EH1 1AA'),
      (2, 'M12',   NULL,     'Maki Newcastle',   'restaurant', '2 St', 'Newcastle', 'NE1 1AA'),
      (3, 'M9',    NULL,     'Maki Manchester',  'restaurant', '3 St', 'Manchester', 'M1 1AA'),
      (4, 'BAD CODE', NULL,  'Unconfigured',     'restaurant', '4 St', 'Leeds', 'LS1 1AA');
    INSERT INTO users (id, email, name, role) VALUES (1, 'gm@example.com', 'GM', 'gm');
    INSERT INTO products (id, name, stock_type, supply_route) VALUES
      (1, 'Hoodie', 'internal', 'email');
  `)
})

const add = (siteId: number) => addToBasket(db, {
  siteId, productId: 1, qty: 1, actor: 'gm@example.com', availableNow: null,
})

describe('a site whose code an order number cannot carry', () => {
  it('can order once it has an order code', async () => {
    const order = await add(1)
    expect(order.orderNumber).toMatch(/^MR-M1AND2-\d{8}-001$/)
  })

  it('does not take a code that belongs to another site', async () => {
    // The tempting automatic fix — strip the punctuation — turns "M1/2" into "M12", which
    // is Maki Newcastle. The two would share an order-number prefix, so their sequences
    // would interleave and an Order/Search lookup could match the wrong site's order.
    const m1and2 = await add(1)
    const m12 = await add(2)
    expect(m1and2.orderNumber.startsWith('MR-M12-')).toBe(false)
    expect(m12.orderNumber).toMatch(/^MR-M12-\d{8}-001$/)
    // Both are at sequence 001: neither has counted the other's orders.
    expect(m1and2.orderNumber.endsWith('-001')).toBe(true)
  })

  it('tells the GM what is wrong instead of failing as a server error', async () => {
    // The trap that caught four sites: a code with a space and no order_code set.
    await expect(add(4)).rejects.toBeInstanceOf(OrderError)
    await expect(add(4)).rejects.toThrow(/cannot be used in an order number/)
    // An OrderError is what the API turns into a 400 with words; anything else is a 500
    // reading "server_error", which is what a GM actually saw.
  })

  it('adds nothing when it refuses', async () => {
    await expect(add(4)).rejects.toThrow()
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE site_id = 4`)
      .first<{ n: number }>()
    expect(row!.n).toBe(0)
  })

  it('leaves an ordinary site exactly as it was', async () => {
    const order = await add(3)
    expect(order.orderNumber).toMatch(/^MR-M9-\d{8}-001$/)
  })
})

describe('buildOrderNumber itself', () => {
  it('still refuses anything that is not a letter or a digit', async () => {
    // Kept strict on purpose: this number is the only thing that lets a retry ask
    // Mintsoft "did this already go?", so a stray character in it is not a small problem.
    for (const code of ['M1/2', 'MAKI NORI', 'AAHQ-GLASGOW', 'M1.2']) {
      expect(() => buildOrderNumber(code, new Date('2026-11-25'), 1)).toThrow()
    }
  })
})

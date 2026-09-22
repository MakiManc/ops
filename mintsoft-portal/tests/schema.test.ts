import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The schema carries several rules that the rest of the portal depends on. Testing
 * them here means they hold even if a future query forgets them — a constraint that
 * is only honoured by convention is not a constraint.
 *
 * D1 is SQLite, so running the real migration against SQLite exercises the actual
 * CHECKs, partial indexes and triggers rather than a description of them.
 */
/**
 * Every migration in order, not just the first. Naming one file meant a later
 * migration that changed a constraint left this suite asserting the old one -- which
 * is exactly what happened when the one-open-request index was narrowed to drafts.
 */
const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url)
const MIGRATION = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'))
  .join('\n')

let db: DatabaseSync

const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[]))
const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...(args as never[])) as T

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(MIGRATION)
  run(`INSERT INTO sites (id, code, name, type) VALUES (1, 'M9', 'Leith Walk', 'restaurant')`)
  run(`INSERT INTO sites (id, code, name, type, recharge) VALUES (2, 'MAF1', 'Franchise One', 'franchise', 1)`)
  run(`INSERT INTO products (id, name, stock_type) VALUES (1, 'Ramen Bowl', 'internal')`)
})

describe('unknown stock is not zero', () => {
  it('lets every stock quantity be unknown', () => {
    run(`INSERT INTO stock_cache (mintsoft_product_id, synced_at) VALUES (5001, '2026-09-21T10:00:00Z')`)
    const row = one<{ on_hand: null; allocated: null; available: null }>(
      `SELECT on_hand, allocated, available FROM stock_cache WHERE mintsoft_product_id = 5001`,
    )
    // If any of these defaulted to 0, a product absent from Mintsoft's feed would
    // render as "out of stock" rather than "we don't know".
    expect(row.on_hand).toBeNull()
    expect(row.allocated).toBeNull()
    expect(row.available).toBeNull()
  })

  it('always records when a figure was last synced', () => {
    expect(() => run(`INSERT INTO stock_cache (mintsoft_product_id) VALUES (5002)`))
      .toThrow(/NOT NULL constraint failed: stock_cache.synced_at/)
  })

  it('keeps one row per product per warehouse per location, so sums are not double counted', () => {
    const at = '2026-09-21T10:00:00Z'
    run(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, synced_at) VALUES (1, 1, 10, 5, ?)`, at)
    run(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, synced_at) VALUES (1, 1, 11, 7, ?)`, at)
    expect(one<{ total: number }>(`SELECT SUM(on_hand) AS total FROM stock_cache WHERE mintsoft_product_id = 1`).total).toBe(12)
    // The same location twice would be the same stock counted twice.
    expect(() => run(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, synced_at) VALUES (1, 1, 10, 5, ?)`, at))
      .toThrow(/UNIQUE constraint failed/)
  })

  it('treats a missing warehouse and location as one grain, not many', () => {
    const at = '2026-09-21T10:00:00Z'
    run(`INSERT INTO stock_cache (mintsoft_product_id, on_hand, synced_at) VALUES (2, 4, ?)`, at)
    expect(() => run(`INSERT INTO stock_cache (mintsoft_product_id, on_hand, synced_at) VALUES (2, 4, ?)`, at))
      .toThrow(/UNIQUE constraint failed/)
  })
})

describe('order states', () => {
  const order = (status: string, site = 1) =>
    run(`INSERT INTO orders (order_number, site_id, type, status) VALUES (?, ?, 'replenishment', ?)`,
      `MR-X-20260921-${Math.random().toString(36).slice(2, 8)}`, site, status)

  it('accepts every state the portal actually uses', () => {
    for (const s of ['draft', 'submitted', 'approved', 'posted', 'despatched', 'rejected', 'cancelled', 'post_failed']) {
      // Only drafts collide on the one-open-basket index, so vary the site for those.
      expect(() => order(s, s === 'draft' ? 2 : 1)).not.toThrow()
      if (s === 'draft') run(`DELETE FROM orders WHERE site_id = 2`)
    }
  })

  it('rejects a delivered state, because Mintsoft cannot tell us a box arrived', () => {
    expect(() => order('delivered')).toThrow(/CHECK constraint failed/)
  })

  it('rejects a state nobody defined', () => {
    expect(() => order('in_transit')).toThrow(/CHECK constraint failed/)
  })
})

describe('one open basket per site', () => {
  const open = (site: number, number: string, status = 'draft') =>
    run(`INSERT INTO orders (order_number, site_id, type, status) VALUES (?, ?, 'replenishment', ?)`, number, site, status)

  it('refuses a second draft for the same site', () => {
    // Mercium bills per order, so items join the open basket rather than starting another.
    open(1, 'MR-M9-20260921-001', 'draft')
    expect(() => open(1, 'MR-M9-20260921-002', 'draft')).toThrow(/UNIQUE constraint failed/)
  })

  it('allows a new draft while an earlier request is with the approver', () => {
    // Otherwise a site is blocked until sign-off, and the approver's merge -- which
    // exists precisely to consolidate two pending requests -- could never be reached.
    open(1, 'MR-M9-20260921-001', 'submitted')
    expect(() => open(1, 'MR-M9-20260921-002', 'draft')).not.toThrow()
  })

  it('allows two requests to be pending at once, for the approver to merge', () => {
    open(1, 'MR-M9-20260921-001', 'submitted')
    expect(() => open(1, 'MR-M9-20260921-002', 'submitted')).not.toThrow()
  })

  it('lets a site open a new basket once the previous one has moved on', () => {
    open(1, 'MR-M9-20260921-001', 'draft')
    run(`UPDATE orders SET status = 'approved' WHERE order_number = 'MR-M9-20260921-001'`)
    expect(() => open(1, 'MR-M9-20260921-002', 'draft')).not.toThrow()
  })

  it('does not stop a different site opening one', () => {
    open(1, 'MR-M9-20260921-001')
    expect(() => open(2, 'MR-MAF1-20260921-001')).not.toThrow()
  })
})

describe('posting an order is idempotent at the schema level', () => {
  it('refuses to attach one Mintsoft order to two portal orders', () => {
    run(`INSERT INTO orders (order_number, site_id, type, status, mintsoft_order_id) VALUES ('MR-M9-20260921-001', 1, 'replenishment', 'posted', 8811)`)
    expect(() => run(`INSERT INTO orders (order_number, site_id, type, status, mintsoft_order_id) VALUES ('MR-M9-20260921-002', 1, 'replenishment', 'posted', 8811)`))
      .toThrow(/UNIQUE constraint failed: orders.mintsoft_order_id/)
  })

  it('refuses to reuse an order number', () => {
    run(`INSERT INTO orders (order_number, site_id, type, status) VALUES ('MR-M9-20260921-001', 1, 'replenishment', 'approved')`)
    expect(() => run(`INSERT INTO orders (order_number, site_id, type, status) VALUES ('MR-M9-20260921-001', 2, 'replenishment', 'approved')`))
      .toThrow(/UNIQUE constraint failed: orders.order_number/)
  })

  it('allows many orders that have not been posted yet', () => {
    run(`INSERT INTO orders (order_number, site_id, type, status) VALUES ('MR-M9-1', 1, 'replenishment', 'approved')`)
    expect(() => run(`INSERT INTO orders (order_number, site_id, type, status) VALUES ('MR-M9-2', 1, 'replenishment', 'approved')`)).not.toThrow()
  })
})

describe('the audit trail is append-only', () => {
  beforeEach(() => {
    run(`INSERT INTO orders (id, order_number, site_id, type, status) VALUES (1, 'MR-M9-20260921-001', 1, 'replenishment', 'submitted')`)
    run(`INSERT INTO order_events (order_id, actor, event) VALUES (1, 'gm@example.com', 'submitted')`)
  })

  it('refuses to change a recorded event', () => {
    expect(() => run(`UPDATE order_events SET event = 'approved' WHERE order_id = 1`))
      .toThrow(/append-only/)
  })

  it('refuses to delete a recorded event', () => {
    expect(() => run(`DELETE FROM order_events WHERE order_id = 1`)).toThrow(/append-only/)
  })

  it('still accepts new events', () => {
    expect(() => run(`INSERT INTO order_events (order_id, actor, event) VALUES (1, 'ross@example.com', 'approved')`)).not.toThrow()
    expect(one<{ n: number }>(`SELECT COUNT(*) AS n FROM order_events`).n).toBe(2)
  })
})

describe('catalogue mapping hides duplicates safely', () => {
  it('refuses to map one Mintsoft line to two Maki products', () => {
    run(`INSERT INTO products (id, name, stock_type) VALUES (2, 'Other Bowl', 'internal')`)
    run(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku) VALUES (1, 7001, 'BOWL-01')`)
    // Otherwise the same warehouse stock would count towards two products at once.
    expect(() => run(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku) VALUES (2, 7001, 'BOWL-01')`))
      .toThrow(/UNIQUE constraint failed/)
  })

  it('allows many Mintsoft lines for one product, which is the whole point', () => {
    run(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES (1, 7001, 'BOWL-01', 1)`)
    expect(() => run(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku) VALUES (1, 7002, 'BOWL-02')`)).not.toThrow()
    expect(one<{ n: number }>(`SELECT COUNT(*) AS n FROM product_mintsoft_map WHERE product_id = 1`).n).toBe(2)
  })

  it('allows only one primary SKU per product', () => {
    run(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES (1, 7001, 'BOWL-01', 1)`)
    expect(() => run(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES (1, 7002, 'BOWL-02', 1)`))
      .toThrow(/UNIQUE constraint failed/)
  })
})

describe('recharge pricing', () => {
  it('lets a product be unpriced, which blocks recharge rather than charging zero', () => {
    expect(one<{ p: null }>(`SELECT recharge_unit_price AS p FROM products WHERE id = 1`).p).toBeNull()
  })

  it('refuses a negative price', () => {
    expect(() => run(`UPDATE products SET recharge_unit_price = -1 WHERE id = 1`)).toThrow(/CHECK constraint failed/)
  })

  it('keeps the price snapshot on the line, not a live lookup', () => {
    run(`INSERT INTO orders (id, order_number, site_id, type, status, recharge) VALUES (1, 'MR-MAF1-1', 2, 'replenishment', 'approved', 1)`)
    run(`INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved, recharge_unit_price) VALUES (1, 1, 10, 10, 2.50)`)
    run(`UPDATE products SET recharge_unit_price = 9.99 WHERE id = 1`)
    // A later price change must never alter what a franchise was charged.
    expect(one<{ p: number }>(`SELECT recharge_unit_price AS p FROM order_lines WHERE order_id = 1`).p).toBe(2.5)
  })
})

describe('users and sign-in', () => {
  it('stores emails lowercase so the allow-list cannot be bypassed by casing', () => {
    expect(() => run(`INSERT INTO users (email, name, role) VALUES ('GM@Example.com', 'Shouty', 'gm')`))
      .toThrow(/CHECK constraint failed/)
  })

  it('accepts only the three real roles', () => {
    run(`INSERT INTO users (email, name, role) VALUES ('a@example.com', 'A', 'gm')`)
    expect(() => run(`INSERT INTO users (email, name, role) VALUES ('b@example.com', 'B', 'superuser')`))
      .toThrow(/CHECK constraint failed/)
  })

  it('refuses a duplicate email', () => {
    run(`INSERT INTO users (email, name, role) VALUES ('a@example.com', 'A', 'gm')`)
    expect(() => run(`INSERT INTO users (email, name, role) VALUES ('a@example.com', 'A again', 'admin')`))
      .toThrow(/UNIQUE constraint failed/)
  })
})

describe('settings', () => {
  it('holds exactly one row', () => {
    expect(one<{ n: number }>(`SELECT COUNT(*) AS n FROM settings`).n).toBe(1)
    expect(() => run(`INSERT INTO settings (id) VALUES (2)`)).toThrow(/CHECK constraint failed/)
  })

  it('defaults to the formula discovery settled on, not one that double-deducts', () => {
    const s = one<{ available_formula: string }>(`SELECT available_formula FROM settings WHERE id = 1`)
    // Mintsoft's OnHand already excludes allocations, proven across all 334 products.
    expect(s.available_formula).toBe('on_hand')
    expect(() => run(`UPDATE settings SET available_formula = 'vibes' WHERE id = 1`)).toThrow(/CHECK constraint failed/)
  })
})

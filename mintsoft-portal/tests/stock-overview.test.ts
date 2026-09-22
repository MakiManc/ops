import { beforeEach, describe, expect, it } from 'vitest'
import { stockOverview, unmappedLineCount } from '../src/server/db/stock-overview.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * What an approver signs off against. The figures here decide whether a request is
 * approved, so "we don't know" has to stay visible rather than becoming a number.
 */

let fake: FakeD1
let db: Database
const NOW = new Date('2026-09-21T12:00:00Z')

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type) VALUES (1, 'M9', 'Leith', 'restaurant'), (2, 'M19', 'Fountain', 'restaurant');
    INSERT INTO products (id, name, stock_type) VALUES (1, 'Ramen Bowl', 'internal');
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (7001, 'BOWL-01', 'Ramen Bowl', '2026-09-21T10:00:00Z'),
      (7002, 'BOWL-02', 'Ramen Bowl v2', '2026-09-21T10:00:00Z');
  `)
})

const map = (mintsoftId: number, primary = 0) =>
  fake.exec(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
             VALUES (1, ${mintsoftId}, 'SKU-${mintsoftId}', ${primary})`)

const stock = (mintsoftId: number, onHand: number | null, allocated: number | null) =>
  fake.exec(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, synced_at)
             VALUES (${mintsoftId}, 1, 1, ${onHand ?? 'NULL'}, ${allocated ?? 'NULL'}, '2026-09-21T10:00:00Z')`)

const read = () => stockOverview(db, 'on_hand_minus_allocated', { now: NOW })

describe('the headline figures', () => {
  it('shows on hand, allocated and free', async () => {
    map(7001, 1); stock(7001, 50, 8)
    const [item] = await read()
    expect(item).toMatchObject({ onHand: 50, allocated: 8, available: 42 })
  })

  it('flags a product whose allocations exceed its stock', async () => {
    map(7001, 1); stock(7001, 5, 9)
    const [item] = await read()
    expect(item!.oversold).toBe(true)
    expect(item!.flags).toContainEqual(expect.stringContaining('More stock is allocated'))
  })
})

describe('demand the warehouse cannot see', () => {
  it('counts what other sites have asked for but not had signed off', async () => {
    map(7001, 1); stock(7001, 100, 0)
    fake.exec(`
      INSERT INTO orders (id, order_number, site_id, type, status) VALUES
        (1, 'MR-M9-1', 1, 'replenishment', 'submitted'),
        (2, 'MR-M19-1', 2, 'replenishment', 'submitted');
      INSERT INTO order_lines (order_id, product_id, qty_requested) VALUES (1, 1, 20), (2, 1, 30);
    `)
    // Mintsoft has no soft-reservation concept, so it still reports all 100 as free.
    // Only the portal knows 50 is already spoken for.
    const [item] = await read()
    expect(item!.available).toBe(100)
    expect(item!.pendingDemand).toBe(50)
  })

  it('ignores requests that are still drafts or already decided', async () => {
    map(7001, 1); stock(7001, 100, 0)
    fake.exec(`
      INSERT INTO orders (id, order_number, site_id, type, status) VALUES
        (1, 'MR-M9-1', 1, 'replenishment', 'draft'),
        (2, 'MR-M19-1', 2, 'replenishment', 'approved');
      INSERT INTO order_lines (order_id, product_id, qty_requested) VALUES (1, 1, 20), (2, 1, 30);
    `)
    expect((await read())[0]!.pendingDemand).toBe(0)
  })
})

describe('weeks of cover', () => {
  const approvedOrder = (id: number, qty: number, approvedAt: string) =>
    fake.exec(`
      INSERT INTO orders (id, order_number, site_id, type, status, approved_at)
        VALUES (${id}, 'MR-M9-${id}', 1, 'replenishment', 'approved', '${approvedAt}');
      INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved)
        VALUES (${id}, 1, ${qty}, ${qty});
    `)

  it('works it out from what has actually been sent', async () => {
    map(7001, 1); stock(7001, 120, 0)
    approvedOrder(1, 60, '2026-08-01T00:00:00Z')
    approvedOrder(2, 60, '2026-09-01T00:00:00Z')
    const [item] = await read()
    // 120 sent over 12 weeks is 10 a week; 120 in stock is 12 weeks of cover.
    expect(item!.weeksOfCover).toBe(12)
    expect(item!.weeksOfCoverBasis).toContain('about 10 a week')
  })

  it('says there is no rate rather than implying endless cover', async () => {
    map(7001, 1); stock(7001, 120, 0)
    // No history is not a consumption rate of zero, which would divide into infinity.
    const [item] = await read()
    expect(item!.weeksOfCover).toBeNull()
    expect(item!.weeksOfCoverBasis).toMatch(/no rate to measure against/)
  })

  it('cannot give cover when the stock level itself is unknown', async () => {
    map(7001, 1); stock(7001, null, null)
    approvedOrder(1, 120, '2026-08-01T00:00:00Z')
    const [item] = await read()
    expect(item!.weeksOfCover).toBeNull()
    expect(item!.weeksOfCoverBasis).toMatch(/Stock level is unknown/)
  })

  it('ignores history older than the window', async () => {
    map(7001, 1); stock(7001, 120, 0)
    approvedOrder(1, 500, '2025-01-01T00:00:00Z')
    expect((await read())[0]!.weeksOfCover).toBeNull()
  })
})

describe('flags an approver needs to see', () => {
  it('says when a product hides several Mintsoft lines', async () => {
    map(7001, 1); map(7002); stock(7001, 10, 0); stock(7002, 5, 0)
    expect((await read())[0]!.flags).toContainEqual(expect.stringContaining('2 Mintsoft lines are combined'))
  })

  it('says when a mapped line went missing from the stock feed', async () => {
    map(7001, 1); map(7002); stock(7001, 10, 0)   // 7002 absent
    const [item] = await read()
    // The 10 we can see are shown, as a floor, and the flag says why it is a floor.
    // An approver deciding on a request needs both halves of that.
    expect(item!.available).toBe(10)
    expect(item!.flags).toContainEqual(expect.stringContaining('did not appear in the last stock sync'))
    expect(item!.flags).toContainEqual(expect.stringContaining('minimum'))
    expect(item!.availableBasis).toMatch(/At least 10/)
  })

  it('says when a product is mapped to nothing and therefore cannot be ordered', async () => {
    const [item] = await read()
    expect(item!.flags).toContainEqual(expect.stringContaining('cannot be ordered'))
  })

  it('counts Mintsoft lines nobody has mapped, which is stock the portal cannot see', async () => {
    map(7001, 1)
    expect(await unmappedLineCount(db)).toBe(1)
    map(7002)
    expect(await unmappedLineCount(db)).toBe(0)
  })
})

/**
 * Not rewriting what has not changed.
 *
 * The stock sync replaced every product's rows on every run — a DELETE and an INSERT
 * each, about 63,000 row writes a day for ~330 products on a quarter-hourly cadence,
 * almost all of it rewriting figures that had not moved. That exhausted D1's free daily
 * write allowance and took the whole portal down: sign-in, baskets, approvals and sends
 * all failed, because every one of them needs a write. The error surfaced as "that
 * account cannot sign in", which is why it looked like an auth problem for an hour.
 *
 * So the property under test is not "the cache is correct" — the other sync tests cover
 * that — it is "a run that changes nothing writes nothing".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import { syncCatalogue, syncStock } from '../src/server/sync/jobs.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
})

const stub = (pages: Record<string, unknown[]>): MintsoftReadOnlyClient => ({
  async getAllPages<T>(path: string) {
    return { items: (pages[path] ?? []) as T[], pages: 1, truncated: false }
  },
} as unknown as MintsoftReadOnlyClient)

const stockPage = (items: unknown[]) => stub({ '/api/Product/Inventory/Bulk': items })
const run = (items: unknown[]) => syncStock(db, stockPage(items), 'on_hand')

const ITEMS = [
  { ProductId: 7001, WarehouseId: 5, OnHand: 40, Allocated: 5, StockLevel: 45 },
  { ProductId: 7002, WarehouseId: 5, OnHand: 12, Allocated: 0, StockLevel: 12 },
]

describe('the stock sync', () => {
  it('writes everything the first time', async () => {
    const out = await run(ITEMS)
    expect(out.rowsWritten).toBe(2)
  })

  it('writes NOTHING when a second run brings identical figures', async () => {
    await run(ITEMS)
    const second = await run(ITEMS)
    // The whole fix. Before this, the second run cost 2 deletes and 2 inserts.
    expect(second.rowsWritten).toBe(0)
    expect(second.detail).toMatch(/2 product\(s\) unchanged/)
  })

  it('leaves the cached figures intact when it skips', async () => {
    await run(ITEMS)
    await run(ITEMS)
    const cached = fake.sqlite
      .prepare(`SELECT mintsoft_product_id, on_hand, allocated, available FROM stock_cache
                 ORDER BY mintsoft_product_id`)
      .all() as { mintsoft_product_id: number; on_hand: number; available: number }[]
    expect(cached).toHaveLength(2)
    expect(cached[0]).toMatchObject({ mintsoft_product_id: 7001, on_hand: 40, available: 40 })
  })

  it('writes only the product that moved', async () => {
    await run(ITEMS)
    const moved = await run([
      { ...ITEMS[0], OnHand: 38 },   // sold two
      ITEMS[1],                      // unchanged
    ])
    expect(moved.rowsWritten).toBe(1)
    expect(moved.detail).toMatch(/1 product\(s\) unchanged/)

    const row = fake.sqlite
      .prepare(`SELECT on_hand FROM stock_cache WHERE mintsoft_product_id = 7001`)
      .get() as { on_hand: number }
    expect(row.on_hand).toBe(38)
  })

  it('writes a product it has never seen', async () => {
    await run(ITEMS)
    const out = await run([...ITEMS, { ProductId: 7003, WarehouseId: 5, OnHand: 1, Allocated: 0, StockLevel: 1 }])
    expect(out.rowsWritten).toBe(1)
  })

  it('still replaces a product wholesale when its shape changes', async () => {
    // The grain can change: one row with no location, then two across locations. An
    // upsert would leave the old row beside the new ones and every reader sums them,
    // so 40 units would read as 80. Skipping must not weaken that.
    await run([{ ProductId: 7001, WarehouseId: 5, LocationId: null, OnHand: 40, Allocated: 0, StockLevel: 40 }])
    await run([
      { ProductId: 7001, WarehouseId: 5, LocationId: 1, OnHand: 25, Allocated: 0, StockLevel: 25 },
      { ProductId: 7001, WarehouseId: 5, LocationId: 2, OnHand: 15, Allocated: 0, StockLevel: 15 },
    ])
    const cached = fake.sqlite
      .prepare(`SELECT on_hand FROM stock_cache WHERE mintsoft_product_id = 7001`)
      .all() as { on_hand: number }[]
    expect(cached).toHaveLength(2)
    expect(cached.reduce((a, r) => a + r.on_hand, 0)).toBe(40)
  })

  it('notices a change that leaves the totals the same', async () => {
    // 40 on hand with 5 allocated, then 45 with 10: available is unchanged at 40 under
    // some formulas, but the underlying figures differ and must be stored.
    await run([{ ProductId: 7001, WarehouseId: 5, OnHand: 40, Allocated: 5, StockLevel: 45 }])
    const out = await run([{ ProductId: 7001, WarehouseId: 5, OnHand: 45, Allocated: 10, StockLevel: 55 }])
    expect(out.rowsWritten).toBe(1)
  })
})

describe('the catalogue sync', () => {
  const PRODUCTS = [
    { ID: 7001, SKU: 'MRK005-BCB', Name: 'Black Chopsticks', ClientId: 10 },
    { ID: 7002, SKU: 'MRK005-DPD', Name: 'Donburi Plates', ClientId: 10 },
  ]
  const catalogue = (items: unknown[]) =>
    syncCatalogue(db, stub({ '/api/Product/List': items }))

  it('writes everything the first time', async () => {
    expect((await catalogue(PRODUCTS)).rowsWritten).toBe(2)
  })

  it('writes nothing when nothing about the products changed', async () => {
    await catalogue(PRODUCTS)
    const second = await catalogue(PRODUCTS)
    expect(second.rowsWritten).toBe(0)
    expect(second.detail).toMatch(/2 product\(s\) unchanged/)
  })

  it('writes the one product that was renamed', async () => {
    await catalogue(PRODUCTS)
    const out = await catalogue([
      { ...PRODUCTS[0], Name: 'Black Chopsticks (24cm)' },
      PRODUCTS[1],
    ])
    expect(out.rowsWritten).toBe(1)
    const row = fake.sqlite
      .prepare(`SELECT name FROM mintsoft_products WHERE mintsoft_product_id = 7001`)
      .get() as { name: string }
    expect(row.name).toBe('Black Chopsticks (24cm)')
  })

  it('ignores a change to Mintsoft\'s own bookkeeping timestamp', async () => {
    // LastUpdated moves for reasons that do not concern us. Treating it as a change
    // would put every product back in the write path and undo the saving.
    await catalogue(PRODUCTS.map((p) => ({ ...p, LastUpdated: '2026-01-01T00:00:00Z' })))
    const out = await catalogue(PRODUCTS.map((p) => ({ ...p, LastUpdated: '2026-09-23T12:00:00Z' })))
    expect(out.rowsWritten).toBe(0)
  })
})

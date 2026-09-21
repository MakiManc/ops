import { beforeEach, describe, expect, it } from 'vitest'
import type { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import { syncCatalogue, syncInbound, syncStock } from '../src/server/sync/jobs.ts'
import { lastSuccessfulSyncs, runSync } from '../src/server/sync/runner.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * The sync jobs are where wrong data would enter the portal. Everything downstream --
 * what a GM is shown, what an approver signs off -- is only as honest as these.
 */

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
})

/** A Mintsoft client that serves canned pages, so the real paging logic still runs. */
function stubClient(pages: Record<string, unknown[]>): MintsoftReadOnlyClient {
  return {
    async getAllPages<T>(path: string) {
      return { items: (pages[path] ?? []) as T[], pages: 1, truncated: false }
    },
  } as unknown as MintsoftReadOnlyClient
}

const rows = (sql: string) => fake.sqlite.prepare(sql).all() as Record<string, unknown>[]

describe('stock sync', () => {
  it('writes what is free, with an explanation attached', async () => {
    const client = stubClient({
      '/api/Product/Inventory/Bulk': [
        { ProductId: 7001, WarehouseId: 1, LocationId: 10, OnHand: 12, Allocated: 2, StockLevel: 10 },
      ],
    })
    const out = await syncStock(db, client, 'on_hand_minus_allocated')
    expect(out.rowsWritten).toBe(1)

    const [row] = rows(`SELECT on_hand, allocated, available, available_basis, synced_at FROM stock_cache`)
    expect(row).toMatchObject({ on_hand: 12, allocated: 2, available: 10 })
    expect(row!.available_basis).toBe('12 on hand less 2 allocated.')
    // Every figure carries the time it was read, because the screens must show it.
    expect(row!.synced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps a product split across locations as separate rows', async () => {
    const client = stubClient({
      '/api/Product/Inventory/Bulk': [
        { ProductId: 7001, WarehouseId: 1, LocationId: 10, OnHand: 10, Allocated: 1 },
        { ProductId: 7001, WarehouseId: 1, LocationId: 11, OnHand: 5, Allocated: 2 },
      ],
    })
    await syncStock(db, client, 'on_hand_minus_allocated')
    // Collapsing them here would lose stock; they are summed at read time instead.
    expect(rows(`SELECT COUNT(*) AS n FROM stock_cache`)[0]).toEqual({ n: 2 })
    expect(rows(`SELECT SUM(on_hand) AS t FROM stock_cache`)[0]).toEqual({ t: 15 })
  })

  it('records unknown rather than zero when Mintsoft omits allocations', async () => {
    const client = stubClient({
      '/api/Product/Inventory/Bulk': [{ ProductId: 7002, OnHand: 9, Allocated: null }],
    })
    await syncStock(db, client, 'on_hand_minus_allocated')
    const [row] = rows(`SELECT on_hand, allocated, available FROM stock_cache`)
    expect(row).toMatchObject({ on_hand: 9, allocated: null, available: null })
  })

  it('refreshes an existing row rather than adding a second', async () => {
    const first = stubClient({ '/api/Product/Inventory/Bulk': [{ ProductId: 7001, OnHand: 5, Allocated: 0 }] })
    const second = stubClient({ '/api/Product/Inventory/Bulk': [{ ProductId: 7001, OnHand: 8, Allocated: 1 }] })
    await syncStock(db, first, 'on_hand_minus_allocated')
    await syncStock(db, second, 'on_hand_minus_allocated')
    expect(rows(`SELECT COUNT(*) AS n FROM stock_cache`)[0]).toEqual({ n: 1 })
    expect(rows(`SELECT available FROM stock_cache`)[0]).toEqual({ available: 7 })
  })

  it('skips a row with no product id rather than writing a mystery', async () => {
    const client = stubClient({ '/api/Product/Inventory/Bulk': [{ OnHand: 5 }, { ProductId: 1, OnHand: 2, Allocated: 0 }] })
    expect((await syncStock(db, client, 'on_hand_minus_allocated')).rowsWritten).toBe(1)
  })
})

describe('inbound sync', () => {
  it('records what is still coming, not what was ordered', async () => {
    const client = stubClient({
      '/api/ASN/List': [{
        ID: 55, EstimatedDelivery: '2026-11-01T00:00:00Z',
        // QuantityReceieved is Mintsoft's spelling; matching it is deliberate.
        Items: [{ ProductId: 7001, QuantityExpected: 100, QuantityReceieved: 40 }],
      }],
    })
    await syncInbound(db, client)
    expect(rows(`SELECT qty, expected_date FROM inbound`)[0])
      .toMatchObject({ qty: 60, expected_date: '2026-11-01T00:00:00Z' })
  })

  it('treats a fully received line as nothing still inbound', async () => {
    const client = stubClient({
      '/api/ASN/List': [{ ID: 55, Items: [{ ProductId: 7001, QuantityExpected: 100, QuantityReceieved: 100 }] }],
    })
    await syncInbound(db, client)
    expect(rows(`SELECT qty FROM inbound`)[0]).toEqual({ qty: 0 })
  })

  it('never reports a negative inbound when more arrived than expected', async () => {
    const client = stubClient({
      '/api/ASN/List': [{ ID: 55, Items: [{ ProductId: 7001, QuantityExpected: 10, QuantityReceieved: 12 }] }],
    })
    await syncInbound(db, client)
    expect(rows(`SELECT qty FROM inbound`)[0]).toEqual({ qty: 0 })
  })

  it('records unknown when the expected quantity is missing', async () => {
    const client = stubClient({ '/api/ASN/List': [{ ID: 55, Items: [{ ProductId: 7001 }] }] })
    await syncInbound(db, client)
    expect(rows(`SELECT qty FROM inbound`)[0]).toEqual({ qty: null })
  })

  it('says so when an ASN arrives with no lines, rather than reporting nothing inbound', async () => {
    // The spec contradicts itself on whether ASN/List returns items, so this is a real
    // possibility and must not read as "nothing is coming".
    const client = stubClient({ '/api/ASN/List': [{ ID: 55, Items: [] }] })
    const out = await syncInbound(db, client)
    expect(out.rowsWritten).toBe(0)
    expect(out.detail).toMatch(/no line items/)
  })
})

describe('catalogue sync', () => {
  it('mirrors Mintsoft products, including its own spelling of discontinued', async () => {
    const client = stubClient({
      '/api/Product/List': [
        { ID: 7001, SKU: 'BOWL-01', Name: 'Ramen Bowl', EAN: '5012345678900', ImageURL: 'https://x/1.jpg', DisCont: false },
        { ID: 7002, SKU: 'BOWL-02', Name: 'Ramen Bowl v2', DisCont: true },
      ],
    })
    const out = await syncCatalogue(db, client)
    expect(out.rowsWritten).toBe(2)
    expect(rows(`SELECT sku, name, discontinued FROM mintsoft_products ORDER BY sku`)).toEqual([
      { sku: 'BOWL-01', name: 'Ramen Bowl', discontinued: 0 },
      { sku: 'BOWL-02', name: 'Ramen Bowl v2', discontinued: 1 },
    ])
  })

  it('leaves discontinued unknown when Mintsoft does not say', async () => {
    const client = stubClient({ '/api/Product/List': [{ ID: 7001, SKU: 'BOWL-01' }] })
    await syncCatalogue(db, client)
    expect(rows(`SELECT discontinued FROM mintsoft_products`)[0]).toEqual({ discontinued: null })
  })

  it('skips a product with no SKU rather than mirroring a line we cannot order', async () => {
    const client = stubClient({ '/api/Product/List': [{ ID: 7001 }, { ID: 7002, SKU: 'OK' }] })
    expect((await syncCatalogue(db, client)).rowsWritten).toBe(1)
  })
})

describe('recording the runs', () => {
  it('marks a successful run and what it wrote', async () => {
    const result = await runSync(db, 'stock', async () => ({ rowsWritten: 42 }))
    expect(result.ok).toBe(true)
    expect(rows(`SELECT job, status, rows_written FROM sync_runs`)[0])
      .toMatchObject({ job: 'stock', status: 'ok', rows_written: 42 })
  })

  it('records a failure instead of throwing, so one bad job does not stop the others', async () => {
    const result = await runSync(db, 'inbound', async () => { throw new Error('Mintsoft returned 500') })
    expect(result.ok).toBe(false)
    expect(rows(`SELECT status, detail FROM sync_runs`)[0])
      .toMatchObject({ status: 'failed', detail: 'Mintsoft returned 500' })
  })

  it('opens the row before the work, so a job that dies is distinguishable from one that never ran', async () => {
    // Without this, a crashed job and a job nobody scheduled look identical.
    let observed: unknown
    await runSync(db, 'catalogue', async () => {
      observed = rows(`SELECT status FROM sync_runs`)[0]
      return { rowsWritten: 0 }
    })
    expect(observed).toEqual({ status: 'running' })
  })

  it('reports when each job last succeeded, ignoring failures since', async () => {
    await runSync(db, 'stock', async () => ({ rowsWritten: 1 }))
    await runSync(db, 'stock', async () => { throw new Error('later failure') })
    const last = await lastSuccessfulSyncs(db)
    // A failing job must not look fresh just because it ran recently.
    expect(last.stock).toBeTruthy()
    expect(Object.keys(last)).toEqual(['stock'])
  })
})

describe('when Mintsoft changes the shape of what it reports', () => {
  it('replaces a product\'s rows rather than stacking a new grain on the old', async () => {
    // First sync: one row, no location breakdown.
    await syncStock(db, stubClient({
      '/api/Product/Inventory/Bulk': [{ ProductId: 7001, WarehouseId: 1, LocationId: null, OnHand: 100, Allocated: 0 }],
    }), 'on_hand_minus_allocated')

    // Second sync: the same 100 units, now split across two locations.
    await syncStock(db, stubClient({
      '/api/Product/Inventory/Bulk': [
        { ProductId: 7001, WarehouseId: 1, LocationId: 10, OnHand: 60, Allocated: 0 },
        { ProductId: 7001, WarehouseId: 1, LocationId: 11, OnHand: 40, Allocated: 0 },
      ],
    }), 'on_hand_minus_allocated')

    // Upserting would leave the old no-location row beside the two new ones, and every
    // reader sums them: 100 units in the warehouse reading as 200.
    expect(rows(`SELECT COUNT(*) AS n FROM stock_cache`)[0]).toEqual({ n: 2 })
    expect(rows(`SELECT SUM(on_hand) AS t FROM stock_cache`)[0]).toEqual({ t: 100 })
  })

  it('drops a location that has emptied instead of leaving its last count behind', async () => {
    await syncStock(db, stubClient({
      '/api/Product/Inventory/Bulk': [
        { ProductId: 7001, WarehouseId: 1, LocationId: 10, OnHand: 60, Allocated: 0 },
        { ProductId: 7001, WarehouseId: 1, LocationId: 11, OnHand: 40, Allocated: 0 },
      ],
    }), 'on_hand_minus_allocated')

    await syncStock(db, stubClient({
      '/api/Product/Inventory/Bulk': [{ ProductId: 7001, WarehouseId: 1, LocationId: 10, OnHand: 60, Allocated: 0 }],
    }), 'on_hand_minus_allocated')

    expect(rows(`SELECT SUM(on_hand) AS t FROM stock_cache`)[0]).toEqual({ t: 60 })
  })

  it('leaves a product absent from the feed alone, so it goes stale rather than vanishing', async () => {
    await syncStock(db, stubClient({
      '/api/Product/Inventory/Bulk': [
        { ProductId: 7001, OnHand: 10, Allocated: 0 },
        { ProductId: 7002, OnHand: 20, Allocated: 0 },
      ],
    }), 'on_hand_minus_allocated')

    await syncStock(db, stubClient({
      '/api/Product/Inventory/Bulk': [{ ProductId: 7001, OnHand: 15, Allocated: 0 }],
    }), 'on_hand_minus_allocated')

    // 7002 keeps its row and its old timestamp: we have not heard about it, which is
    // not the same as it being gone.
    expect(rows(`SELECT COUNT(*) AS n FROM stock_cache WHERE mintsoft_product_id = 7002`)[0]).toEqual({ n: 1 })
  })
})

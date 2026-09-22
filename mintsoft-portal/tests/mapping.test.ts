import { beforeEach, describe, expect, it } from 'vitest'
import {
  addLinesToProduct, createProductFromLines, duplicateSuggestions, MappingError,
  setPrimaryLine, unmapLine, unmappedLines,
} from '../src/server/db/mapping.ts'
import { catalogueForSite } from '../src/server/db/catalogue.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * Mapping is how Mintsoft's shipment duplicates become one product a GM can order.
 * Getting it wrong either hides stock (a line left unmapped) or double-counts it (a
 * line mapped twice), so the constraints matter as much as the suggestions.
 */

let fake: FakeD1
let db: Database

const line = (id: number, sku: string, name: string, extra: { ean?: string } = {}) =>
  fake.exec(`INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, ean, synced_at)
             VALUES (${id}, '${sku}', '${name}', ${extra.ean ? `'${extra.ean}'` : 'NULL'}, '2026-09-21T10:00:00Z')`)

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`INSERT INTO sites (id, code, name, type) VALUES (1, 'M9', 'Leith Walk', 'restaurant')`)
})

describe('suggesting duplicates', () => {
  it('spots the same product added again on later shipments', async () => {
    line(7001, 'BOWL-01', 'Ramen Bowl')
    line(7002, 'BOWL-02', 'Ramen Bowl (shipment 8)')
    line(7003, 'BOWL-03', 'Ramen Bowl v3')
    line(9001, 'TABLE-OAK', 'Oak Table')

    const suggestions = await duplicateSuggestions(db)
    expect(suggestions.length).toBeGreaterThan(0)
    const ids = suggestions[0]!.lines.map((l) => l.mintsoftProductId).sort()
    expect(ids).toEqual([7001, 7002, 7003])
    // The unrelated expansion product must not be swept in.
    expect(suggestions.flatMap((s) => s.lines.map((l) => l.mintsoftProductId))).not.toContain(9001)
  })

  it('spots a renamed duplicate by its barcode', async () => {
    line(7001, 'PLATE-A', 'Side Plate', { ean: '5012345678900' })
    line(7002, 'PLATE-B', 'Plate, Side 18cm', { ean: '5012345678900' })
    const signals = (await duplicateSuggestions(db)).map((s) => s.signal)
    expect(signals).toContain('same-barcode')
  })

  it('surfaces a new duplicate of something already mapped', async () => {
    line(7001, 'BOWL-01', 'Ramen Bowl')
    line(7002, 'BOWL-02', 'Ramen Bowl v2')
    await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })
    // This is the case that otherwise goes unnoticed: a later shipment adds a duplicate
    // after the mapping was done, and its stock silently stops counting.
    const suggestions = await duplicateSuggestions(db)
    expect(suggestions.some((s) => s.partiallyMapped)).toBe(true)
  })

  it('stops suggesting a cluster once it is all on one product', async () => {
    line(7001, 'BOWL-01', 'Ramen Bowl')
    line(7002, 'BOWL-02', 'Ramen Bowl v2')
    await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })
    expect(await duplicateSuggestions(db)).toEqual([])
  })

  it('does not suggest a single line as its own duplicate', async () => {
    line(7001, 'BOWL-01', 'Ramen Bowl')
    expect(await duplicateSuggestions(db)).toEqual([])
  })
})

describe('creating a product from lines', () => {
  beforeEach(() => { line(7001, 'BOWL-01', 'Ramen Bowl'); line(7002, 'BOWL-02', 'Ramen Bowl v2') })

  it('maps every chosen line and marks one primary', async () => {
    const id = await createProductFromLines(db, {
      name: 'Ramen Bowl', category: 'Crockery', stockType: 'internal', packSize: 12,
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7002,
    })
    const rows = fake.sqlite.prepare(
      `SELECT mintsoft_product_id, sku, is_primary FROM product_mintsoft_map WHERE product_id = ? ORDER BY mintsoft_product_id`,
    ).all(id)
    expect(rows).toEqual([
      { mintsoft_product_id: 7001, sku: 'BOWL-01', is_primary: 0 },
      { mintsoft_product_id: 7002, sku: 'BOWL-02', is_primary: 1 },
    ])
  })

  it('makes the duplicates show as one product with one stock figure', async () => {
    await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })
    fake.exec(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, synced_at) VALUES
      (7001, 1, 1, 10, 1, '2026-09-21T10:00:00Z'), (7002, 1, 1, 6, 0, '2026-09-21T10:00:00Z')`)

    const catalogue = await catalogueForSite(db, 1, 'on_hand_minus_allocated', { showPrices: false })
    expect(catalogue).toHaveLength(1)
    expect(catalogue[0]!.available).toBe(15)
    expect(catalogue[0]!.mappedLines).toBe(2)
  })

  it('refuses to map a line that already belongs to another product, and says where', async () => {
    await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })
    // Mapping one line to two products would count its stock twice.
    await expect(createProductFromLines(db, {
      name: 'Another Bowl', stockType: 'internal',
      mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })).rejects.toThrow(/already mapped to "Ramen Bowl"/)
  })

  it('refuses a primary that is not among the lines being mapped', async () => {
    await expect(createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001], primaryMintsoftProductId: 7002,
    })).rejects.toThrow(MappingError)
  })

  it('refuses a line that is not in the catalogue mirror', async () => {
    await expect(createProductFromLines(db, {
      name: 'Ghost', stockType: 'internal',
      mintsoftProductIds: [9999], primaryMintsoftProductId: 9999,
    })).rejects.toThrow(/not in the catalogue mirror/)
  })

  it('refuses an empty selection or a blank name', async () => {
    await expect(createProductFromLines(db, {
      name: 'X', stockType: 'internal', mintsoftProductIds: [], primaryMintsoftProductId: 1,
    })).rejects.toThrow(/at least one/)
    await expect(createProductFromLines(db, {
      name: '  ', stockType: 'internal', mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })).rejects.toThrow(/name/)
  })

  it('creates nothing at all when the mapping is rejected', async () => {
    await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal', mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })
    await expect(createProductFromLines(db, {
      name: 'Half-made', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7002,
    })).rejects.toThrow()
    // A product created with only some of its lines would show only some of its stock.
    expect(fake.sqlite.prepare(`SELECT COUNT(*) AS n FROM products WHERE name = 'Half-made'`).get())
      .toEqual({ n: 0 })
  })
})

describe('adjusting an existing mapping', () => {
  let productId: number

  beforeEach(async () => {
    line(7001, 'BOWL-01', 'Ramen Bowl'); line(7002, 'BOWL-02', 'Ramen Bowl v2'); line(7003, 'BOWL-03', 'Ramen Bowl v3')
    productId = await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })
  })

  it('adds a newly-arrived duplicate to the existing product', async () => {
    expect(await addLinesToProduct(db, productId, [7003])).toBe(1)
    expect(fake.sqlite.prepare(`SELECT COUNT(*) AS n FROM product_mintsoft_map WHERE product_id = ?`).get(productId))
      .toEqual({ n: 3 })
  })

  it('moves the primary without ever leaving two', async () => {
    await setPrimaryLine(db, productId, 7002)
    expect(fake.sqlite.prepare(
      `SELECT mintsoft_product_id FROM product_mintsoft_map WHERE product_id = ? AND is_primary = 1`,
    ).all(productId)).toEqual([{ mintsoft_product_id: 7002 }])
  })

  it('refuses to unmap the primary while other lines remain', async () => {
    // A product with lines but no primary has nowhere to send an order, and would fail
    // at the point of ordering rather than here.
    await expect(unmapLine(db, 7001)).rejects.toThrow(/Make another line primary first/)
  })

  it('allows unmapping the last line, primary or not', async () => {
    await unmapLine(db, 7002)
    await expect(unmapLine(db, 7001)).resolves.toBeUndefined()
  })

  it('puts an unmapped line back on the work queue', async () => {
    expect((await unmappedLines(db)).map((l) => l.mintsoftProductId)).toEqual([7003])
    await unmapLine(db, 7002)
    expect((await unmappedLines(db)).map((l) => l.mintsoftProductId).sort()).toEqual([7002, 7003])
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import {
  addLinesToProduct, createProductFromLines, duplicateSuggestions, MappingError,
  productsWithUnreadableLines, setPrimaryLine, stockWarning, unmapLine, unmappedLines,
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

/**
 * Stock for a line. Calling it is what Mintsoft having an inventory record MEANS here --
 * a line with no stock() call is the real condition, absent rather than zero, which is
 * the whole thing this guard is about.
 */
const stock = (
  mintsoftProductId: number, available: number | null,
  { onHand = available, location = 1 }: { onHand?: number | null; location?: number } = {},
) =>
  fake.exec(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id,
                                      on_hand, allocated, available, available_basis, synced_at)
             VALUES (${mintsoftProductId}, 1, ${location}, ${onHand ?? 'NULL'}, 0,
                     ${available ?? 'NULL'}, 'test', '2026-10-12T10:00:00Z')`)

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
    const { productId: id } = await createProductFromLines(db, {
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
    productId = (await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })).productId
  })

  it('adds a newly-arrived duplicate to the existing product', async () => {
    expect((await addLinesToProduct(db, productId, [7003])).lines).toBe(1)
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

/**
 * Mapping a line Mintsoft has no inventory record for.
 *
 * Absent is not zero. Mapping such a line turns the product's stock figure into a floor,
 * and if the other lines hold nothing it stops the product being orderable at all. That
 * was invisible from this screen and it is what made "Tea cups" unorderable for three
 * weeks with 577 units in Witham.
 *
 * Nothing here blocks. A line whose first shipment has not landed legitimately has no
 * record yet, and the mapping tool's premise is that the person decides. It tells them.
 */
describe('mapping a line with no stock record', () => {
  it('says nothing when every line has a figure', () => {
    expect(stockWarning([
      { mintsoftProductId: 1, sku: 'A', hasStockRecord: true, available: 40 },
      { mintsoftProductId: 2, sku: 'B', hasStockRecord: true, available: 2 },
    ])).toBeNull()
  })

  it('says the figure becomes a floor, and what is still orderable', () => {
    const warning = stockWarning([
      { mintsoftProductId: 1, sku: 'MRK001-TCT', hasStockRecord: true, available: 577 },
      { mintsoftProductId: 2, sku: 'MRK010-TCT', hasStockRecord: false, available: null },
    ])
    expect(warning).toMatch(/no stock figure for MRK010-TCT/)
    expect(warning).toMatch(/show at least 577 rather than a total/)
    // The reassuring half matters as much: this is not a reason to abandon the mapping.
    expect(warning).toMatch(/Orders up to 577 are unaffected/)
  })

  it('warns harder when nothing readable is left, because then it cannot be ordered', () => {
    const warning = stockWarning([
      { mintsoftProductId: 1, sku: 'ONLY-LINE', hasStockRecord: false, available: null },
    ])
    expect(warning).toMatch(/the only line mapped to this product/)
    expect(warning).toMatch(/orders for it will be refused/)
    // And still not a refusal: the shipment may simply not have landed.
    expect(warning).toMatch(/Map it if the shipment is still to land/)
  })

  it('calls out a recordless line chosen as the primary', () => {
    // Orders fill from the primary first, and unmapping a primary needs another line
    // promoted first, so this is the choice worth steering before it is made.
    const lines = [
      { mintsoftProductId: 1, sku: 'STS-30', hasStockRecord: false, available: null },
      { mintsoftProductId: 2, sku: 'STS', hasStockRecord: true, available: 2 },
    ]
    const warned = stockWarning(lines, { primaryMintsoftProductId: 1 })
    expect(warned).toMatch(/also holds the primary flag/)
    expect(warned).toMatch(/moved to another line before this one could be unmapped/)
    // It must NOT claim orders are placed against it first. allocateLine filters out
    // lines with no figure BEFORE it sorts by primary, so a primary with no figure has no
    // effect on allocation at all, and saying otherwise sends someone chasing nothing.
    expect(warned).toMatch(/does not change which line an order is filled from/)
    // Not mentioned when the primary is a line that has a figure.
    expect(stockWarning(lines, { primaryMintsoftProductId: 2 })).not.toMatch(/primary/)
  })

  it('warns on create, having actually written the mapping', async () => {
    line(7001, 'BOWL-01', 'Ramen Bowl'); line(7002, 'BOWL-02', 'Ramen Bowl v2')
    stock(7001, 100)   // 7002 deliberately has no stock row at all

    const result = await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })
    // The product exists. A warning is not a failure.
    expect(result.productId).toBeGreaterThan(0)
    expect(result.lines).toBe(2)
    expect(result.warning).toMatch(/no stock figure for BOWL-02/)
    expect(fake.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM product_mintsoft_map WHERE product_id = ?`,
    ).get(result.productId)).toEqual({ n: 2 })
  })

  it('judges an added line against everything the product already has', async () => {
    // Adding a recordless line to a product holding 100 is a much smaller thing to say
    // than adding one to a product holding nothing, so the warning weighs the whole set.
    line(7001, 'BOWL-01', 'Ramen Bowl'); line(7002, 'BOWL-02', 'Ramen Bowl v2')
    stock(7001, 100)
    const { productId } = await createProductFromLines(db, {
      name: 'Ramen Bowl', stockType: 'internal',
      mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })

    const added = await addLinesToProduct(db, productId, [7002])
    expect(added.lines).toBe(1)
    expect(added.warning).toMatch(/show at least 100 rather than a total/)
    // The existing line is the primary and does have a figure, so no primary nag.
    expect(added.warning).not.toMatch(/primary/)
  })

  it('treats a row with no usable figure the same as no row at all', async () => {
    // A stock row whose available is NULL is "part of the picture missing", which the
    // approval guard also reads as unknown. The two must not drift apart.
    line(7001, 'BOWL-01', 'Ramen Bowl')
    stock(7001, null, { onHand: null })
    const [mapped] = await unmappedLines(db)
    expect(mapped?.hasStockRecord).toBe(true)   // a row exists...
    expect(mapped?.available).toBeNull()        // ...but it says nothing
  })

  it('carries each line’s stock position into the picker', async () => {
    line(7001, 'BOWL-01', 'Ramen Bowl'); line(7002, 'BOWL-02', 'Ramen Bowl v2')
    stock(7001, 42)
    const lines = await unmappedLines(db)
    expect(lines.find((l) => l.sku === 'BOWL-01')).toMatchObject({ hasStockRecord: true, available: 42 })
    expect(lines.find((l) => l.sku === 'BOWL-02')).toMatchObject({ hasStockRecord: false, available: null })
  })

  it('does not multiply lines when a product has stock in several locations', async () => {
    // stock_cache holds a row per location. A join here would duplicate the line and
    // quietly corrupt the mapped-to columns, which is why those are subqueries.
    line(7001, 'BOWL-01', 'Ramen Bowl')
    stock(7001, 10, { location: 1 }); stock(7001, 32, { location: 2 })
    const lines = await unmappedLines(db)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ hasStockRecord: true, available: 42 })
  })
})

describe('finding the products already mapped to a recordless line', () => {
  /** Builds a product from lines, where `null` stock means no inventory record at all. */
  const product = async (name: string, lines: [number, string, number | null][], primaryIndex = 0) => {
    for (const [id, sku, available] of lines) {
      line(id, sku, `${name} ${sku}`)
      if (available !== null) stock(id, available)
    }
    return (await createProductFromLines(db, {
      name, stockType: 'internal',
      mintsoftProductIds: lines.map((l) => l[0]),
      primaryMintsoftProductId: lines[primaryIndex]![0],
    })).productId
  }

  it('says nothing when every mapped line has a record', async () => {
    await product('Ramekin', [[7001, 'RAM-01', 100], [7002, 'RAM-02', 20]])
    expect(await productsWithUnreadableLines(db)).toEqual([])
  })

  it('reports the Tea cups shape: a floor, still orderable', async () => {
    // The live one. 8 lines, one absent, 577 across the rest.
    await product('Tea cups', [
      [1212, 'MRK001-TCT', 0], [1263, 'MRK002-TCT', 10], [1418, 'MRK004-TCT', 56],
      [1503, 'MRK005-TCT', 28], [1536, 'MRK008-TCT', 157], [1585, 'MRK010-TCT', null],
      [1618, 'MRK011-TCT', 250], [1657, 'MRK013-TCT', 76],
    ])
    const [found] = await productsWithUnreadableLines(db)
    expect(found).toMatchObject({
      productName: 'Tea cups', active: true, mappedLines: 8, readableFloor: 577,
    })
    expect(found?.readableLines).toHaveLength(7)
    expect(found?.unreadableLines).toEqual([
      { mintsoftProductId: 1585, sku: 'MRK010-TCT', isPrimary: false, hasStockRecord: false },
    ])
    // The readable lines are carried, not just counted: the screen offers to move the
    // primary onto one of them and cannot build that control out of a number.
    expect(found?.readableLines.map((l) => l.sku)).toEqual([
      'MRK001-TCT', 'MRK002-TCT', 'MRK004-TCT', 'MRK005-TCT', 'MRK008-TCT',
      'MRK011-TCT', 'MRK013-TCT',
    ])
  })

  it('reports the SAKURA shape, where the absent line is the primary', async () => {
    await product('Sakura planters', [[1308, 'STS-30', null], [1309, 'STS', 2]], 0)
    const [found] = await productsWithUnreadableLines(db)
    expect(found).toMatchObject({ readableFloor: 2 })
    expect(found?.readableLines).toHaveLength(1)
    // Worth flagging on its own: orders are placed against the primary first.
    expect(found?.unreadableLines[0]).toMatchObject({ sku: 'STS-30', isPrimary: true })
  })

  it('reports the Round Table Base shape as unorderable, not merely a floor', async () => {
    // Readable lines hold nothing, so there is no floor to order against and the
    // approval guard refuses outright. A different sentence is owed to the reader.
    await product('Round Table Base', [
      [1501, 'RTR-01', 0], [1502, 'RTR-02', 0], [1570, 'MRK008-RTR', null],
    ])
    const [found] = await productsWithUnreadableLines(db)
    // Two readable lines, both empty. Not the same as having no figure: the next
    // shipment fixes this one without anybody touching the mapping.
    expect(found).toMatchObject({ readableFloor: 0 })
    expect(found?.readableLines).toHaveLength(2)
  })

  it('distinguishes no readable row from readable rows totalling zero', async () => {
    // Both floors are 0. Only one of them is unorderable -- the other genuinely holds
    // none, which a sync can change tomorrow.
    await product('All absent', [[8001, 'A-01', null], [8002, 'A-02', null]])
    const [found] = await productsWithUnreadableLines(db)
    expect(found).toMatchObject({ readableFloor: 0, mappedLines: 2 })
    expect(found?.readableLines).toHaveLength(0)
    expect(found?.unreadableLines).toHaveLength(2)
  })

  it('groups several recordless lines under one product', async () => {
    await product('Patchy', [[9001, 'P-01', 5], [9002, 'P-02', null], [9003, 'P-03', null]])
    const found = await productsWithUnreadableLines(db)
    expect(found).toHaveLength(1)
    expect(found[0]?.unreadableLines.map((l) => l.sku)).toEqual(['P-02', 'P-03'])
    expect(found[0]).toMatchObject({ mappedLines: 3, readableFloor: 5 })
    expect(found[0]?.readableLines).toHaveLength(1)
  })

  it('puts the catalogue products first, since a retired one costs nobody an order', async () => {
    await product('Live one', [[9001, 'L-01', 5], [9002, 'L-02', null]])
    const retired = await product('Retired one', [[9101, 'R-01', 5], [9102, 'R-02', null]])
    fake.exec(`UPDATE products SET active = 0 WHERE id = ${retired}`)
    const found = await productsWithUnreadableLines(db)
    expect(found.map((p) => [p.productName, p.active]))
      .toEqual([['Live one', true], ['Retired one', false]])
  })
})

/**
 * The cases that let the first version of this guard contradict the approval guard.
 *
 * It decided readable/unreadable in SQL, counting a line as readable because a stock ROW
 * existed and summing available across rows that carried no figure. So a product whose
 * only row said nothing was described here as "1 readable line holding nothing" while
 * allocateLine refused it as having no figure at all -- two statements of one rule, which
 * is exactly how the Tea cups bug happened. These pin the single rule.
 */
describe('a row that exists but gives no figure', () => {
  const rowWithoutFigure = (id: number, sku: string) => {
    line(id, sku, `Line ${sku}`)
    stock(id, null, { onHand: null })
  }

  it('is unreadable, not readable-and-empty', async () => {
    line(7001, 'HAS-FIGURE', 'Readable'); stock(7001, 40)
    rowWithoutFigure(7002, 'NO-FIGURE')
    const { productId } = await createProductFromLines(db, {
      name: 'Mixed', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })
    expect(productId).toBeGreaterThan(0)

    const [found] = await productsWithUnreadableLines(db)
    expect(found?.unreadableLines).toEqual([
      // hasStockRecord is true -- there IS a row -- but it yields no figure, so the line
      // counts as unreadable all the same. The two are different facts.
      { mintsoftProductId: 7002, sku: 'NO-FIGURE', isPrimary: false, hasStockRecord: true },
    ])
    expect(found?.readableLines.map((l) => l.sku)).toEqual(['HAS-FIGURE'])
    expect(found?.readableFloor).toBe(40)
  })

  it('leaves a product with no floor when it is the only kind of line there is', async () => {
    rowWithoutFigure(7001, 'NO-FIGURE-1'); rowWithoutFigure(7002, 'NO-FIGURE-2')
    await createProductFromLines(db, {
      name: 'Nothing readable', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })

    const [found] = await productsWithUnreadableLines(db)
    // Not "2 readable lines holding nothing", which is what the SQL version said.
    expect(found?.readableLines).toHaveLength(0)
    expect(found?.unreadableLines).toHaveLength(2)
    expect(found?.readableFloor).toBe(0)
  })

  it('never sums a figure across rows where one of them is missing it', async () => {
    // Two locations, one reporting 10 and one reporting nothing. The true total is
    // unknowable; answering 10 is the confident undercount the whole availability module
    // exists to prevent, because it gets ordered against.
    line(7001, 'SPLIT', 'Two locations')
    stock(7001, 10, { location: 1 })
    stock(7001, null, { onHand: null, location: 2 })
    await createProductFromLines(db, {
      name: 'Split', stockType: 'internal',
      mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })

    const [found] = await productsWithUnreadableLines(db)
    expect(found?.readableFloor).toBe(0)
    expect(found?.readableLines).toHaveLength(0)
    expect((await unmappedLines(db)).length).toBe(0)
  })

  it('warns about it, where it used to say nothing at all', () => {
    // Every line has a record, none has a figure. The approval guard refuses this
    // outright, so silence was the worst available answer.
    expect(stockWarning([
      { mintsoftProductId: 1, sku: 'A', hasStockRecord: true, available: null },
      { mintsoftProductId: 2, sku: 'B', hasStockRecord: true, available: null },
    ])).toMatch(/no stock figure for A, B, which is every line mapped to this product/)
  })

  it('does not claim orders are unaffected when the floor is zero', () => {
    // "Orders up to 0 are unaffected" is nonsense: nothing can be ordered. But it is a
    // different problem from having no figure, and the next shipment fixes it.
    const warning = stockWarning([
      { mintsoftProductId: 1, sku: 'EMPTY', hasStockRecord: true, available: 0 },
      { mintsoftProductId: 2, sku: 'ABSENT', hasStockRecord: false, available: null },
    ])
    expect(warning).toMatch(/one line that does currently holds nothing, so there is nothing to order yet/)
    expect(warning).not.toMatch(/Orders up to 0 are unaffected/)
    expect(warning).not.toMatch(/at least 0/)
  })
})

describe('adding a line to a product that already has an unreadable one', () => {
  it('warns about the existing line, not only a newly-added bad one', async () => {
    // Only the opposite direction was covered -- adding a BAD line to a good product. This
    // is the SAKURA remedy loop: the product already carries the unreadable line, and the
    // admin maps a good one alongside it. Staying silent here would tell the admin the
    // problem was solved when the floor is still a floor.
    line(7001, 'ABSENT', 'No record at all')          // no stock() call: no record
    line(7002, 'GOOD', 'Reports properly'); stock(7002, 60)
    const { productId } = await createProductFromLines(db, {
      name: 'Planters', stockType: 'internal',
      mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
    })

    const added = await addLinesToProduct(db, productId, [7002])
    expect(added.lines).toBe(1)
    expect(added.warning).toMatch(/no stock figure for ABSENT/)
    expect(added.warning).toMatch(/show at least 60 rather than a total/)
    // The existing line holds the primary flag, and that is the one fact worth stating.
    expect(added.warning).toMatch(/also holds the primary flag/)
  })

  it('reports the remedy loop as complete once the flag has moved and the line is gone', async () => {
    // The two-step the panel offers: promote a readable line, then unmap the unreadable
    // one. If that does not actually clear the product from the panel, the advice is a
    // dead end and the admin has no way to tell they are finished.
    line(7001, 'ABSENT', 'No record'); line(7002, 'GOOD', 'Reports'); stock(7002, 60)
    const { productId } = await createProductFromLines(db, {
      name: 'Planters', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })
    expect(await productsWithUnreadableLines(db)).toHaveLength(1)

    await setPrimaryLine(db, productId, 7002)
    await unmapLine(db, 7001)

    expect(await productsWithUnreadableLines(db)).toEqual([])
    // And the product is left whole: one line, which is the primary.
    expect(fake.sqlite.prepare(
      `SELECT mintsoft_product_id, is_primary FROM product_mintsoft_map WHERE product_id = ?`,
    ).all(productId)).toEqual([{ mintsoft_product_id: 7002, is_primary: 1 }])
  })

  it('refuses to unmap the unreadable line before the flag has moved', async () => {
    // Which is why the panel says the flag must move first rather than offering Unmap.
    line(7001, 'ABSENT', 'No record'); line(7002, 'GOOD', 'Reports'); stock(7002, 60)
    await createProductFromLines(db, {
      name: 'Planters', stockType: 'internal',
      mintsoftProductIds: [7001, 7002], primaryMintsoftProductId: 7001,
    })
    await expect(unmapLine(db, 7001)).rejects.toThrow(/Make another line primary first/)
  })
})

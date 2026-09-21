import { beforeEach, describe, expect, it } from 'vitest'
import { importParLevels, parLevels, parLevelsCsv, reorderInto } from '../src/server/db/admin.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * Par levels are maintained as a spreadsheet, because twenty-odd sites against a few
 * dozen products is a grid rather than a form. The risk is a half-applied import.
 */

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type) VALUES (1, 'M9', 'Leith Walk', 'restaurant'), (2, 'M19', 'Fountain', 'restaurant');
    INSERT INTO products (id, name, stock_type) VALUES (1, 'Ramen Bowl', 'internal'), (2, 'Chopsticks', 'internal');
  `)
})

const HEADER = 'site_code,product_name,par_level,max_per_order,min_days_between_orders'
const read = () => fake.sqlite.prepare(
  `SELECT s.code, p.name, sp.par_level, sp.max_per_order FROM site_products sp
     JOIN sites s ON s.id = sp.site_id JOIN products p ON p.id = sp.product_id ORDER BY s.code, p.name`,
).all()

describe('exporting', () => {
  it('gives a complete grid, including combinations nobody has set yet', async () => {
    const rows = await parLevels(db)
    // Two sites by two products: the export is something to fill in, not only what
    // somebody already touched.
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.parLevel === null)).toBe(true)
  })

  it('writes a CSV that round-trips', async () => {
    fake.exec(`INSERT INTO site_products (site_id, product_id, par_level, max_per_order) VALUES (1, 1, 48, 96)`)
    const csv = parLevelsCsv(await parLevels(db))
    expect(csv.split('\n')[0]).toBe(HEADER)
    expect(csv).toContain('M9,Ramen Bowl,48,96,')

    const result = await importParLevels(db, csv)
    expect(result.problems).toEqual([])
    expect(read()).toContainEqual({ code: 'M9', name: 'Ramen Bowl', par_level: 48, max_per_order: 96 })
  })
})

describe('importing', () => {
  it('applies the numbers', async () => {
    const result = await importParLevels(db, `${HEADER}\nM9,Ramen Bowl,48,96,14`)
    expect(result.applied).toBe(1)
    expect(read()[0]).toMatchObject({ par_level: 48, max_per_order: 96 })
  })

  it('treats a blank cell as no limit, so a limit can be removed', async () => {
    fake.exec(`INSERT INTO site_products (site_id, product_id, par_level, max_per_order) VALUES (1, 1, 48, 96)`)
    await importParLevels(db, `${HEADER}\nM9,Ramen Bowl,48,,`)
    // The alternative reading -- blank means leave alone -- would make a limit
    // impossible to remove.
    expect(read()[0]).toMatchObject({ par_level: 48, max_per_order: null })
  })

  it('removes the row entirely when every limit is blank', async () => {
    fake.exec(`INSERT INTO site_products (site_id, product_id, par_level) VALUES (1, 1, 48)`)
    const result = await importParLevels(db, `${HEADER}\nM9,Ramen Bowl,,,`)
    expect(result.cleared).toBe(1)
    expect(read()).toHaveLength(0)
  })

  it('writes nothing at all when any row is wrong', async () => {
    const csv = `${HEADER}\nM9,Ramen Bowl,48,96,14\nM99,Ramen Bowl,10,,`
    const result = await importParLevels(db, csv)
    expect(result.problems[0]!.message).toMatch(/No active site with code "M99"/)
    // A partial apply leaves half the estate on new numbers and half on old, with
    // nothing on screen to say which is which.
    expect(result.applied).toBe(0)
    expect(read()).toHaveLength(0)
  })

  it('points at the line and says what is wrong', async () => {
    const result = await importParLevels(db, `${HEADER}\nM9,Ramen Bowl,lots,,`)
    expect(result.problems[0]).toMatchObject({ line: 2 })
    expect(result.problems[0]!.message).toMatch(/whole number or left blank/)
  })

  it('refuses a product it does not recognise', async () => {
    const result = await importParLevels(db, `${HEADER}\nM9,Ramen Bowls,48,,`)
    expect(result.problems[0]!.message).toMatch(/No active product called "Ramen Bowls"/)
  })

  it('refuses a max of zero, which would stop a site ordering at all', async () => {
    const result = await importParLevels(db, `${HEADER}\nM9,Ramen Bowl,48,0,`)
    expect(result.problems[0]!.message).toMatch(/would stop this site ordering it at all/)
  })

  it('refuses a negative number', async () => {
    expect((await importParLevels(db, `${HEADER}\nM9,Ramen Bowl,-5,,`)).problems).toHaveLength(1)
  })

  it('refuses a sheet whose header is wrong, rather than guessing the columns', async () => {
    const result = await importParLevels(db, 'site,product,par\nM9,Ramen Bowl,48')
    expect(result.problems[0]!.message).toMatch(/missing column/)
  })

  it('reports every bad row at once', async () => {
    const csv = `${HEADER}\nM99,Ramen Bowl,48,,\nM9,Nope,10,,\nM9,Ramen Bowl,lots,,`
    expect((await importParLevels(db, csv)).problems).toHaveLength(3)
  })
})

describe('reordering', () => {
  beforeEach(() => {
    fake.exec(`
      INSERT INTO orders (id, order_number, site_id, type, status) VALUES (1, 'MR-M9-1', 1, 'replenishment', 'despatched');
      INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved) VALUES (1, 1, 48, 24), (1, 2, 200, 200);
    `)
  })

  it('copies what was approved, not what was asked for', async () => {
    // The approved figure is the one that turned out to be right.
    expect(await reorderInto(db, { fromOrderId: 1, siteId: 1 }))
      .toEqual([{ productId: 1, qty: 24 }, { productId: 2, qty: 200 }])
  })

  it('leaves out a line that was approved at zero', async () => {
    fake.exec(`UPDATE order_lines SET qty_approved = 0 WHERE product_id = 1`)
    expect(await reorderInto(db, { fromOrderId: 1, siteId: 1 })).toEqual([{ productId: 2, qty: 200 }])
  })

  it('leaves out a product that has since been retired', async () => {
    fake.exec(`UPDATE products SET active = 0 WHERE id = 2`)
    expect(await reorderInto(db, { fromOrderId: 1, siteId: 1 })).toEqual([{ productId: 1, qty: 24 }])
  })

  it('will not reorder another site\'s order', async () => {
    expect(await reorderInto(db, { fromOrderId: 1, siteId: 2 })).toEqual([])
  })
})

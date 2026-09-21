import { beforeEach, describe, expect, it } from 'vitest'
import { catalogueForSite, stockStatus } from '../src/server/db/catalogue.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * The catalogue is what a GM orders against, so every figure on it has to be either
 * right or visibly absent. These tests are mostly about the second half of that.
 */

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
  fake.exec(`
    INSERT INTO sites (id, code, name, type) VALUES (1, 'M9', 'Leith Walk', 'restaurant');
    INSERT INTO sites (id, code, name, type, recharge) VALUES (2, 'MAF1', 'Franchise', 'franchise', 1);
    INSERT INTO products (id, name, stock_type, pack_size, unit, recharge_unit_price)
      VALUES (1, 'Ramen Bowl', 'internal', 12, 'each', 2.50);
  `)
})

const map = (productId: number, mintsoftId: number) =>
  fake.exec(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku)
             VALUES (${productId}, ${mintsoftId}, 'SKU-${mintsoftId}')`)

const stock = (mintsoftId: number, onHand: number | null, allocated: number | null, location = 1, at = '2026-09-21T10:00:00Z') =>
  fake.exec(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, synced_at)
             VALUES (${mintsoftId}, 1, ${location}, ${onHand ?? 'NULL'}, ${allocated ?? 'NULL'}, '${at}')`)

const read = (siteId = 1, showPrices = false) =>
  catalogueForSite(db, siteId, 'on_hand_minus_allocated', { showPrices })

describe('combining the duplicate Mintsoft lines', () => {
  it('shows three shipment duplicates as one product with one number', async () => {
    map(1, 7001); map(1, 7002); map(1, 7003)
    stock(7001, 12, 2); stock(7002, 5, 0); stock(7003, 4, 1)

    const [item] = await read()
    expect(item!.available).toBe(18)
    expect(item!.mappedLines).toBe(3)
  })

  it('sums a line that is split across warehouse locations', async () => {
    map(1, 7001)
    stock(7001, 10, 1, 10); stock(7001, 5, 2, 11)
    expect((await read())[0]!.available).toBe(12)
  })

  it('will not report a total when a mapped line is missing from the stock feed', async () => {
    map(1, 7001); map(1, 7002)
    stock(7001, 12, 2)   // 7002 never arrived in the feed
    const [item] = await read()
    // Summing only the line we have would be a confident undercount, which is exactly
    // what a site would then order against.
    expect(item!.available).toBeNull()
    expect(item!.availableBasis).toMatch(/1 of the 2 Mintsoft lines/)
  })

  it('will not report a total when one line has an unknown figure', async () => {
    map(1, 7001); map(1, 7002)
    stock(7001, 12, 2); stock(7002, null, null)
    expect((await read())[0]!.available).toBeNull()
  })

  it('says plainly when a product is mapped to nothing yet', async () => {
    const [item] = await read()
    expect(item!.available).toBeNull()
    expect(item!.mappedLines).toBe(0)
    expect(item!.availableBasis).toMatch(/not mapped to anything/)
  })
})

describe('showing how old a figure is', () => {
  it('reports the oldest reading that went into the number', async () => {
    map(1, 7001); map(1, 7002)
    stock(7001, 5, 0, 1, '2026-09-21T10:00:00Z')
    stock(7002, 5, 0, 1, '2026-09-20T08:00:00Z')
    // The figure is only as fresh as its stalest input, and the banner keys off this.
    expect((await read())[0]!.stockSyncedAt).toBe('2026-09-20T08:00:00Z')
  })

  it('has no timestamp at all when there is no stock reading', async () => {
    map(1, 7001)
    expect((await read())[0]!.stockSyncedAt).toBeNull()
  })
})

describe('inbound', () => {
  it('shows what is still coming and when', async () => {
    map(1, 7001)
    stock(7001, 0, 0)
    fake.exec(`INSERT INTO inbound (mintsoft_product_id, asn_id, qty, expected_date, synced_at)
               VALUES (7001, 55, 200, '2026-11-01T00:00:00Z', '2026-09-21T10:00:00Z')`)
    const [item] = await read()
    expect(item!.inboundQty).toBe(200)
    expect(item!.inboundExpected).toBe('2026-11-01T00:00:00Z')
  })

  it('reports the earliest arrival when two shipments are coming', async () => {
    map(1, 7001)
    fake.exec(`INSERT INTO inbound (mintsoft_product_id, asn_id, qty, expected_date, synced_at) VALUES
      (7001, 55, 100, '2026-11-01T00:00:00Z', '2026-09-21T10:00:00Z'),
      (7001, 56, 50, '2026-10-15T00:00:00Z', '2026-09-21T10:00:00Z')`)
    const [item] = await read()
    expect(item!.inboundQty).toBe(150)
    expect(item!.inboundExpected).toBe('2026-10-15T00:00:00Z')
  })

  it('reports unknown inbound rather than a partial total', async () => {
    map(1, 7001)
    fake.exec(`INSERT INTO inbound (mintsoft_product_id, asn_id, qty, expected_date, synced_at) VALUES
      (7001, 55, 100, '2026-11-01T00:00:00Z', '2026-09-21T10:00:00Z'),
      (7001, 56, NULL, NULL, '2026-09-21T10:00:00Z')`)
    expect((await read())[0]!.inboundQty).toBeNull()
  })
})

describe('prices', () => {
  it('never shows a price to a corporate site', async () => {
    // Corporate sites are not recharged, so a price on screen is both wrong and alarming.
    expect((await read(1, false))[0]!.rechargeUnitPrice).toBeNull()
  })

  it('shows the price to a franchise site', async () => {
    expect((await read(2, true))[0]!.rechargeUnitPrice).toBe(2.5)
  })
})

describe('par levels come from the site, not the product', () => {
  it('uses the par level set for this site', async () => {
    fake.exec(`INSERT INTO site_products (site_id, product_id, par_level, max_per_order) VALUES (1, 1, 24, 48)`)
    const [item] = await read(1)
    expect(item!.parLevel).toBe(24)
    expect(item!.maxPerOrder).toBe(48)
  })

  it('leaves them unset for a site that has none', async () => {
    fake.exec(`INSERT INTO site_products (site_id, product_id, par_level) VALUES (1, 1, 24)`)
    const [item] = await read(2)
    expect(item!.parLevel).toBeNull()
  })
})

describe('the status chip', () => {
  const chip = (available: number | null, parLevel: number | null = null, inboundQty: number | null = null) =>
    stockStatus({ available, parLevel, inboundQty })

  it('is unknown when we do not know, which outranks everything else', () => {
    expect(chip(null)).toBe('unknown')
    expect(chip(null, 10, 500)).toBe('unknown')
  })

  it('is low only when there is a par level to be under', () => {
    expect(chip(5, 10)).toBe('low')
    expect(chip(5, null)).toBe('in_stock')
    expect(chip(5, 0)).toBe('in_stock')
  })

  it('is in stock at or above par', () => {
    expect(chip(10, 10)).toBe('in_stock')
  })

  it('is out when there is none and nothing is known to be coming', () => {
    expect(chip(0)).toBe('out')
    expect(chip(0, 10, 0)).toBe('out')
  })

  it('promises inbound only when something is positively known to be coming', () => {
    expect(chip(0, 10, 200)).toBe('inbound')
    // An unknown inbound figure is not a reason to tell a GM stock is on its way.
    expect(chip(0, 10, null)).toBe('out')
  })
})

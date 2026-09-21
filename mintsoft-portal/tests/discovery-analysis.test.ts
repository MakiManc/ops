import { describe, expect, it } from 'vitest'
import {
  compareToSpec, fieldReport, findDuplicates, inspectKeyShape, normaliseName, reconcileStock,
  redact, skuStem,
} from '../src/lib/mintsoft/discovery-analysis.ts'
import type { BulkInventoryItem, Product, StockLevel } from '../src/lib/mintsoft/types.ts'

describe('redact', () => {
  it('replaces personal values but keeps the field names', () => {
    const out = redact({ OrderNumber: 'MR-M9-20260921-001', FirstName: 'Ada', PostCode: 'EH1 1AA' })
    // Discovering field names is the point of the dump; the values are what must not persist.
    expect(out.OrderNumber).toBe('MR-M9-20260921-001')
    expect(out.FirstName).toBe('<redacted:string>')
    expect(out.PostCode).toBe('<redacted:string>')
  })

  it('redacts inside nested objects and arrays', () => {
    const out = redact({ Orders: [{ Email: 'gm@example.com', Items: [{ SKU: 'CHOP-1' }] }] })
    expect(out.Orders[0]!.Email).toBe('<redacted:string>')
    expect(out.Orders[0]!.Items[0]!.SKU).toBe('CHOP-1')
  })

  it('leaves empty and absent personal fields alone rather than inventing a value', () => {
    const out = redact({ Address2: '', Address3: null })
    expect(out.Address2).toBe('')
    expect(out.Address3).toBeNull()
  })
})

describe('duplicate detection', () => {
  it('strips shipment and version suffixes from a SKU to find the stem', () => {
    expect(skuStem('BOWL-RAMEN-01')).toBe('BOWL-RAMEN')
    expect(skuStem('bowl-ramen-v2')).toBe('BOWL-RAMEN')
    expect(skuStem('CHOPSTICK_SHP7')).toBe('CHOPSTICK')
  })

  it('normalises names so shipment markers do not split one product into many', () => {
    expect(normaliseName('Ramen Bowl (shipment 7)')).toBe('ramen bowl')
    expect(normaliseName('Ramen  Bowl v2')).toBe('ramen bowl')
  })

  it('clusters the duplicate lines Mintsoft accumulated across shipments', () => {
    const products = [
      { ID: 1, SKU: 'BOWL-01', Name: 'Ramen Bowl' },
      { ID: 2, SKU: 'BOWL-02', Name: 'Ramen Bowl (shipment 8)' },
      { ID: 3, SKU: 'BOWL-03', Name: 'Ramen Bowl v3' },
      { ID: 9, SKU: 'TABLE-OAK', Name: 'Oak Table' },
    ] as Product[]

    const dup = findDuplicates(products)
    expect(dup.productsInvolved).toBe(3)
    // The standalone expansion product must not be swept into a cluster.
    expect(dup.clusters.flatMap((c) => c.members.map((m) => m.ID))).not.toContain(9)
  })

  it('treats a shared barcode as a duplicate signal in its own right', () => {
    const products = [
      { ID: 1, SKU: 'PLATE-A', Name: 'Side Plate', EAN: '5012345678900' },
      { ID: 2, SKU: 'PLATE-B', Name: 'Plate, Side 18cm', EAN: '5012345678900' },
    ] as Product[]
    const signals = findDuplicates(products).clusters.map((c) => c.signal)
    expect(signals).toContain('same-barcode')
  })
})

describe('reconcileStock — settling what "available" means', () => {
  const stock = [
    { ProductId: 1, SKU: 'A', Level: 8, TotalStockLevel: 10 },
    { ProductId: 2, SKU: 'B', Level: 3, TotalStockLevel: 5 },
  ] as StockLevel[]
  const bulk = [
    { ProductId: 1, SKU: 'A', StockLevel: 8, OnHand: 10, Allocated: 2 },
    { ProductId: 2, SKU: 'B', StockLevel: 3, OnHand: 5, Allocated: 2 },
  ] as BulkInventoryItem[]

  it('identifies the formula that actually holds across live rows', () => {
    const r = reconcileStock(stock, bulk)
    expect(r.overlappingProducts).toBe(2)
    expect(r.verdict['StockLevel.Level === Bulk.OnHand - Bulk.Allocated']).toBe('2/2 (100%)')
    expect(r.verdict['StockLevel.TotalStockLevel === Bulk.OnHand']).toBe('2/2 (100%)')
  })

  it('reports a formula that does not hold, instead of rounding it up to true', () => {
    const r = reconcileStock(stock, bulk)
    expect(r.verdict['StockLevel.Level === Bulk.OnHand']).toBe('0/2 (0%)')
  })

  it('never counts a missing number as a match — unknown is not zero', () => {
    // A row where Allocated is absent must be skipped, not read as Allocated = 0.
    const r = reconcileStock(
      [{ ProductId: 1, Level: 10 }] as StockLevel[],
      [{ ProductId: 1, OnHand: 10 }] as BulkInventoryItem[],
    )
    expect(r.verdict['StockLevel.Level === Bulk.OnHand - Bulk.Allocated'])
      .toBe('not testable — no overlapping rows')
  })

  it('says so plainly when the two endpoints share no products at all', () => {
    const r = reconcileStock(stock, [{ ProductId: 99, StockLevel: 1 }] as BulkInventoryItem[])
    expect(r.overlappingProducts).toBe(0)
    expect(r.verdict['StockLevel.Level === Bulk.StockLevel']).toMatch(/not testable/)
  })
})

describe('fieldReport', () => {
  it('distinguishes a populated field from one that is always null', () => {
    const report = fieldReport([
      { SKU: 'A', Allocated: null },
      { SKU: 'B', Allocated: null },
    ])
    expect(report.SKU).toEqual({ populatedPct: 100, types: 'string' })
    // A field present in the payload but never populated is not a field we can rely on.
    expect(report.Allocated).toEqual({ populatedPct: 0, types: 'always-null' })
  })

  it('reports partial population rather than implying a field is always there', () => {
    const report = fieldReport([{ ImageURL: 'https://x/1.jpg' }, {}, {}, {}])
    expect(report.ImageURL!.populatedPct).toBe(25)
  })
})

describe('inspectKeyShape', () => {
  it('reads the expiry out of the key when Mintsoft issues a JWT', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1789000000 })).toString('base64url')
    const shape = inspectKeyShape(`header.${payload}.signature`)
    expect(shape.looksLikeJwt).toBe(true)
    expect(shape.expiresAt).toBe(new Date(1789000000 * 1000).toISOString())
  })

  it('treats an opaque key as opaque instead of guessing a lifetime', () => {
    const shape = inspectKeyShape('a1b2c3d4e5f6')
    expect(shape.looksLikeJwt).toBe(false)
    expect(shape.expiresAt).toBeNull()
  })

  it('does not crash on something that merely looks like a JWT', () => {
    expect(inspectKeyShape('not.a.jwt').expiresAt).toBeNull()
  })
})

describe('compareToSpec — how far the published spec can be trusted', () => {
  it('flags a field the API sends that the spec never declares', () => {
    const r = compareToSpec('StockLevel', [{ ProductId: 1, SomeNewField: 'surprise' }])
    expect(r.undocumentedFields).toEqual(['SomeNewField'])
  })

  it('flags a declared field the API never actually sends', () => {
    const r = compareToSpec('StockLevel', [{ ProductId: 1 }])
    // The spec promises these; this run saw none of them.
    expect(r.declaredButNeverSent).toContain('TotalStockLevel')
    expect(r.declaredButNeverSent).toContain('Level')
  })

  it('separates "present but always null" from "never sent at all"', () => {
    const r = compareToSpec('StockLevel', [{ Level: null }, { Level: null }])
    expect(r.declaredButAlwaysNull).toEqual(['Level'])
    expect(r.declaredButNeverSent).not.toContain('Level')
  })

  it('reports nothing surprising when the API matches its spec', () => {
    const r = compareToSpec('StockLevel', [{ ProductId: 1, Level: 5 }])
    expect(r.undocumentedFields).toEqual([])
    expect(r.declaredButAlwaysNull).toEqual([])
  })

  it('treats an unknown model as fully undocumented rather than silently passing it', () => {
    const r = compareToSpec('NotAModel', [{ Anything: 1 }])
    expect(r.undocumentedFields).toEqual(['Anything'])
  })
})

/**
 * Pure analysis helpers used by Phase 0 discovery.
 *
 * These are separated from scripts/discover.ts so they can be tested without
 * credentials and without touching the network — which matters, because the live
 * discovery run cannot be exercised in CI.
 */
import { SPEC_FIELDS } from './types.ts'
import type { BulkInventoryItem, Product, StockLevel } from './types.ts'

/** Order fields that carry personal data. Names kept, values replaced. */
export const PII_FIELDS = new Set([
  'FirstName', 'LastName', 'Title', 'CompanyName', 'Address1', 'Address2', 'Address3',
  'Town', 'County', 'PostCode', 'Email', 'Phone', 'Mobile', 'GiftMessages',
  'ContactName', 'ContactNumber', 'ContactEmail',
  'AddressLine1', 'AddressLine2', 'AddressLine3', 'Postcode',
])

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        PII_FIELDS.has(k) && v !== null && v !== undefined && v !== ''
          ? `<redacted:${typeof v}>`
          : redact(v),
      ]),
    ) as T
  }
  return value
}

/**
 * Records which fields an endpoint actually returned and how often they were populated.
 * A field that is present but always null is as good as absent, and the portal needs to
 * know the difference before it trusts a number.
 */
export function fieldReport(rows: Record<string, unknown>[]) {
  const seen = new Map<string, { present: number; nonNull: number; types: Set<string> }>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    for (const [k, v] of Object.entries(row)) {
      const e = seen.get(k) ?? { present: 0, nonNull: 0, types: new Set<string>() }
      e.present++
      if (v !== null && v !== undefined) {
        e.nonNull++
        e.types.add(Array.isArray(v) ? 'array' : typeof v)
      }
      seen.set(k, e)
    }
  }
  const total = rows.length || 1
  return Object.fromEntries(
    [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, e]) => [k, {
        populatedPct: Math.round((e.nonNull / total) * 100),
        types: [...e.types].sort().join('|') || 'always-null',
      }]),
  )
}

/** Strips the trailing shipment/version marker that turns one product into many lines. */
export const skuStem = (sku: string) =>
  sku.trim().toUpperCase().replace(/[\s_-]*(v|ver|rev|batch|shp|shipment)?[\s_-]*\d{1,4}$/i, '')

export const normaliseName = (name: string) =>
  name.toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(v|ver|rev|batch|shipment|shp)\s*\d{1,4}\b/gi, ' ')
    .replace(/\b(new|old|copy|duplicate|dup)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export function findDuplicates(products: Product[]) {
  const byName = new Map<string, Product[]>()
  const byStem = new Map<string, Product[]>()
  const byBarcode = new Map<string, Product[]>()

  for (const p of products) {
    if (p.Name) {
      const k = normaliseName(p.Name)
      if (k) byName.set(k, [...(byName.get(k) ?? []), p])
    }
    if (p.SKU) {
      const k = skuStem(p.SKU)
      if (k && k.length >= 3) byStem.set(k, [...(byStem.get(k) ?? []), p])
    }
    for (const code of [p.EAN, p.UPC]) {
      if (code && code.trim()) byBarcode.set(code.trim(), [...(byBarcode.get(code.trim()) ?? []), p])
    }
  }

  const clusters = (m: Map<string, Product[]>, signal: string) =>
    [...m.entries()]
      .filter(([, ps]) => ps.length > 1)
      .map(([key, ps]) => ({
        signal,
        key,
        count: ps.length,
        members: ps.map((p) => ({ ID: p.ID, SKU: p.SKU, Name: p.Name, DisCont: p.DisCont })),
      }))
      .sort((a, b) => b.count - a.count)

  const all = [
    ...clusters(byName, 'same-normalised-name'),
    ...clusters(byStem, 'shared-sku-stem'),
    ...clusters(byBarcode, 'same-barcode'),
  ]
  const affected = new Set<number>()
  for (const c of all) for (const m of c.members) if (m.ID != null) affected.add(m.ID)

  return {
    clusterCount: all.length,
    productsInvolved: affected.size,
    /** Everything, for the Phase 2 mapping tool to consume. */
    clusters: all,
    examples: all.slice(0, 15),
  }
}

/**
 * The single most important question in discovery: what does "available to order" mean?
 *
 * The spec has no Available field anywhere. StockLevel exposes Level / TotalStockLevel;
 * BulkInventoryItem exposes StockLevel / OnHand / Allocated. Which of those is free stock
 * is not knowable from the spec, so we test the candidate identities against live data and
 * report how often each holds. The portal must not show a stock figure until this is settled.
 */
export function reconcileStock(stock: StockLevel[], bulk: BulkInventoryItem[]) {
  // BulkInventoryItem carries a LocationId, so a product can appear on several rows --
  // one per warehouse location. Keying a map on ProductId would silently keep whichever
  // row happened to come last, and every figure downstream would be one bin's worth of
  // stock presented as the whole. So group first, then sum.
  const rowsByProduct = new Map<number, BulkInventoryItem[]>()
  for (const b of bulk) {
    if (b.ProductId == null) continue
    rowsByProduct.set(b.ProductId, [...(rowsByProduct.get(b.ProductId) ?? []), b])
  }

  /** Sums a field across a product's rows, or undefined if no row carries it. */
  const total = (rows: BulkInventoryItem[], field: keyof BulkInventoryItem) => {
    const values = rows
      .map((r) => r[field])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined
  }

  const multiRowProducts = [...rowsByProduct.values()].filter((rows) => rows.length > 1).length

  const hypotheses: Record<string, { tested: number; held: number }> = {
    'StockLevel.Level === Bulk.StockLevel': { tested: 0, held: 0 },
    'StockLevel.Level === Bulk.OnHand': { tested: 0, held: 0 },
    'StockLevel.Level === Bulk.OnHand - Bulk.Allocated': { tested: 0, held: 0 },
    'StockLevel.TotalStockLevel === Bulk.OnHand': { tested: 0, held: 0 },
    'StockLevel.TotalStockLevel === Bulk.StockLevel': { tested: 0, held: 0 },
    'Bulk.StockLevel === Bulk.OnHand - Bulk.Allocated': { tested: 0, held: 0 },
  }
  const test = (name: string, left?: number | null, right?: number | null) => {
    const h = hypotheses[name]
    if (!h) return
    if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right)) return
    h.tested++
    if (left === right) h.held++
  }

  const samples: unknown[] = []
  for (const s of stock) {
    const rows = s.ProductId != null ? rowsByProduct.get(s.ProductId) : undefined
    if (!rows?.length) continue

    const onHand = total(rows, 'OnHand')
    const allocated = total(rows, 'Allocated')
    const stockLevel = total(rows, 'StockLevel')
    const free = onHand != null && allocated != null ? onHand - allocated : undefined

    test('StockLevel.Level === Bulk.StockLevel', s.Level, stockLevel)
    test('StockLevel.Level === Bulk.OnHand', s.Level, onHand)
    test('StockLevel.Level === Bulk.OnHand - Bulk.Allocated', s.Level, free)
    test('StockLevel.TotalStockLevel === Bulk.OnHand', s.TotalStockLevel, onHand)
    test('StockLevel.TotalStockLevel === Bulk.StockLevel', s.TotalStockLevel, stockLevel)
    test('Bulk.StockLevel === Bulk.OnHand - Bulk.Allocated', stockLevel, free)

    if (samples.length < 25) {
      samples.push({
        ProductId: s.ProductId, SKU: s.SKU, bulkRows: rows.length,
        StockLevel_Level: s.Level, StockLevel_Total: s.TotalStockLevel,
        Bulk_StockLevel: stockLevel, Bulk_OnHand: onHand, Bulk_Allocated: allocated,
        Bulk_OnOrder: total(rows, 'OnOrder'), Bulk_InTransit: total(rows, 'InTransit'),
        Bulk_AwaitingReplen: total(rows, 'AwaitingReplen'),
      })
    }
  }

  const verdict = Object.fromEntries(
    Object.entries(hypotheses).map(([k, v]) => [
      k,
      v.tested === 0
        ? 'not testable — no overlapping rows'
        : `${v.held}/${v.tested} (${Math.round((v.held / v.tested) * 100)}%)`,
    ]),
  )
  const overlappingProducts = hypotheses['StockLevel.Level === Bulk.StockLevel']?.tested ?? 0
  return {
    overlappingProducts,
    /** If this is above zero, every stock figure must be a sum across locations. */
    productsWithMultipleBulkRows: multiRowProducts,
    verdict,
    samples,
  }
}

export function inspectKeyShape(key: string) {
  const parts = key.split('.')
  const payload = parts.length === 3 ? parts[1] : undefined
  const shape = { length: key.length, looksLikeJwt: parts.length === 3, expiresAt: null as string | null }
  if (payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
      if (typeof claims.exp === 'number') shape.expiresAt = new Date(claims.exp * 1000).toISOString()
    } catch { /* opaque token that merely looks like a JWT */ }
  }
  return shape
}


/**
 * Compares what the API actually returned against what its published spec declares.
 *
 * The brief asked for typed models written from real responses. Ours are generated from
 * Mintsoft's spec, which is more reliable than hand-typing but is still a document rather
 * than the thing itself. This is the reconciliation: any field the live API sends that the
 * spec does not declare is a real finding, and any declared field that never arrives is
 * one we should not have built on.
 */
export function compareToSpec(
  model: string,
  rows: Record<string, unknown>[],
): {
  model: string
  rowsSeen: number
  undocumentedFields: string[]
  declaredButNeverSent: string[]
  declaredButAlwaysNull: string[]
} {
  const declared = new Set(SPEC_FIELDS[model] ?? [])
  const seen = new Set<string>()
  const everPopulated = new Set<string>()

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    for (const [k, v] of Object.entries(row)) {
      seen.add(k)
      if (v !== null && v !== undefined) everPopulated.add(k)
    }
  }

  return {
    model,
    rowsSeen: rows.length,
    // Mintsoft sends it, the spec never mentions it. Worth knowing before we rely on it.
    undocumentedFields: [...seen].filter((k) => !declared.has(k)).sort(),
    // The spec promises it, the API never sent it. Do not build on these.
    declaredButNeverSent: [...declared].filter((k) => !seen.has(k)).sort(),
    // Present in every payload but never carrying a value — as good as absent.
    declaredButAlwaysNull: [...seen].filter((k) => declared.has(k) && !everPopulated.has(k)).sort(),
  }
}

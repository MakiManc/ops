/**
 * Phase 0 — Mintsoft discovery. READ ONLY.
 *
 *   MINTSOFT_USERNAME=... MINTSOFT_PASSWORD=... npm run discover
 *
 * Authenticates, reads a representative slice of the Maki & Ramen account, writes the raw
 * responses to ./discovery/ (git-ignored) and an analysis to ./discovery/SUMMARY.json, then
 * prints a report. DISCOVERY.md is written from that summary.
 *
 * What this script will not do, by construction:
 *   - write anything to Mintsoft (the client it uses implements no write verbs)
 *   - create an ASN, or touch any client other than the one the credentials belong to
 *   - print, log or dump the credentials or the API key
 *   - commit anything: ./discovery/ is git-ignored, because these dumps contain real
 *     warehouse data and third-party delivery addresses
 *
 * Personal data in the order dump is redacted at the point of writing: field NAMES are
 * kept (discovering them is the whole point) but their VALUES are replaced.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import {
  compareToSpec, fieldReport, findDuplicates, inspectKeyShape, reconcileStock, redact,
} from '../src/lib/mintsoft/discovery-analysis.ts'
import type {
  ASN, BulkInventoryItem, Client, CourierService, Order, OrderStatus, Product, StockLevel, Warehouse,
} from '../src/lib/mintsoft/types.ts'

const OUT = new URL('../discovery/', import.meta.url)
const dir = OUT.pathname

function dump(name: string, data: unknown, { pii = false } = {}) {
  writeFileSync(`${dir}${name}.json`, JSON.stringify(pii ? redact(data) : data, null, 2))
}


/**
 * Probes the two ways of asking "does an order with this number already exist?".
 *
 * This is the check Phase 3's idempotent posting depends on, and the spec cannot describe
 * it: GET /api/Order/GetOrderId declares its 200 body as a bare untyped object with no
 * properties at all, so there is no way to know from the document whether it returns a
 * number, an object, or something else. Its 404 is worse — Mintsoft's own description is
 * "Order not found or not accessible", which is two very different situations behind one
 * status code, and only one of them means it is safe to create the order.
 *
 * GET /api/Order/Search takes the same order number, returns a properly typed Order[],
 * and hands back the order itself rather than just an id. It looks like the better check.
 * This probe establishes which to trust, using orders that already exist — it creates
 * nothing.
 */
async function probeOrderLookup(
  client: MintsoftReadOnlyClient,
  knownOrderNumber: string | undefined,
  scope: { ClientId?: number; WarehouseId?: number },
) {
  // A number that cannot exist, to see what "definitely absent" looks like.
  const absent = 'MR-DISCOVERY-PROBE-00000000-000'

  const shapeOf = (raw: string) => {
    const body = raw.trim()
    if (body === '') return { kind: 'empty' as const }
    try {
      const parsed: unknown = JSON.parse(body)
      if (Array.isArray(parsed)) {
        const first = parsed[0]
        return {
          kind: 'array' as const,
          length: parsed.length,
          firstElementKeys: first && typeof first === 'object' ? Object.keys(first).sort() : null,
        }
      }
      if (parsed && typeof parsed === 'object') {
        return { kind: 'object' as const, keys: Object.keys(parsed).sort() }
      }
      return { kind: typeof parsed, isNumeric: typeof parsed === 'number' }
    } catch {
      return { kind: 'not-json' as const, first80: body.slice(0, 80) }
    }
  }

  const probe = async (label: string, path: string, query: Record<string, string | number | boolean | undefined>) => {
    const { status, raw } = await client.get(path, query)
    // Shape and status only. The body can contain a delivery address; we never keep it.
    return { label, path, status, shape: shapeOf(raw) }
  }

  const results = [
    await probe('GetOrderId / absent', '/api/Order/GetOrderId', { orderNumber: absent, ...scope }),
    await probe('Search / absent', '/api/Order/Search', { OrderNumber: absent, exactMatch: true }),
  ]

  if (knownOrderNumber) {
    results.unshift(
      await probe('GetOrderId / existing', '/api/Order/GetOrderId', { orderNumber: knownOrderNumber, ...scope }),
      await probe('Search / existing', '/api/Order/Search', { OrderNumber: knownOrderNumber, exactMatch: true }),
    )
  }

  return {
    testedWithExistingOrder: Boolean(knownOrderNumber),
    results,
    note:
      'Phase 3 must be able to tell "this order already exists" from "this order does not ' +
      'exist" from "I could not tell". Only the first two are safe to act on. A 404 from ' +
      'GetOrderId means not-found OR not-accessible, so it is not on its own permission to ' +
      'create the order again.',
  }
}

async function main() {
  const username = process.env.MINTSOFT_USERNAME
  const password = process.env.MINTSOFT_PASSWORD
  if (!username || !password) {
    console.error(
      'MINTSOFT_USERNAME and MINTSOFT_PASSWORD must be set.\n' +
      'Set them in your shell for a one-off run, or in .dev.vars (git-ignored) for repeat runs.\n' +
      'They are never written to ./discovery/ or to any log.',
    )
    process.exit(1)
  }

  mkdirSync(dir, { recursive: true })
  const startedAt = new Date().toISOString()
  const client = new MintsoftReadOnlyClient({
    username, password, throttleMs: Number(process.env.DISCOVER_THROTTLE_MS ?? 250),
    onLog: (e) => console.log(`  ${String(e.status).padEnd(3)} ${String(e.ms).padStart(5)}ms  ${e.path}`),
  })

  console.log('\nAuthenticating…')
  await client.authenticate()
  // The key itself never leaves the client; only this description of it does.
  const keyShape = client.describeKey(inspectKeyShape) ?? { length: 0, looksLikeJwt: false, expiresAt: null }
  console.log(`  key acquired (${keyShape.length} chars, jwt=${keyShape.looksLikeJwt}` +
    `${keyShape.expiresAt ? `, expires ${keyShape.expiresAt}` : ''})`)

  console.log('\nWho are we? (clients and warehouses this user can see)')
  const clients = (await client.get<Client[]>('/api/Client')).data ?? []
  const warehouses = (await client.get<Warehouse[]>('/api/Warehouse')).data ?? []
  dump('clients', clients, { pii: true })
  dump('warehouses', warehouses, { pii: true })
  console.log(`  ${clients.length} client(s), ${warehouses.length} warehouse(s)`)

  // If more than one client is visible, every later call MUST pin ClientId or we risk
  // reading — and one day writing to — somebody else's stock.
  const clientIds = clients.map((c) => c.ID).filter((id): id is number => id != null)
  const pinnedClientId = process.env.MINTSOFT_CLIENT_ID
    ? Number(process.env.MINTSOFT_CLIENT_ID)
    : clientIds.length === 1 ? clientIds[0] : undefined
  const pinnedWarehouseId = process.env.MINTSOFT_WAREHOUSE_ID
    ? Number(process.env.MINTSOFT_WAREHOUSE_ID)
    : undefined
  if (clientIds.length > 1 && !pinnedClientId) {
    console.warn(`  ! ${clientIds.length} clients visible and none pinned — ` +
      'set MINTSOFT_CLIENT_ID before Phase 2.')
  }
  const scope = { ClientId: pinnedClientId, WarehouseId: pinnedWarehouseId }

  console.log('\nProducts…')
  const products = await client.getAllPages<Product>('/api/Product/List', { ClientId: scope.ClientId })
  dump('products', products.items)
  console.log(`  ${products.items.length} products over ${products.pages} page(s)` +
    `${products.truncated ? ' (TRUNCATED — raise maxPages)' : ''}`)

  console.log('\nStock levels (without and with Breakdown)…')
  const stockPlain = (await client.get<StockLevel[]>('/api/Product/StockLevels', { ...scope, Breakdown: false })).data ?? []
  const stockBreak = (await client.get<StockLevel[]>('/api/Product/StockLevels', { ...scope, Breakdown: true })).data ?? []
  dump('stock_levels', stockPlain)
  dump('stock_levels_breakdown', stockBreak)
  console.log(`  ${stockPlain.length} rows plain, ${stockBreak.length} rows with breakdown`)

  console.log('\nBulk inventory…')
  const bulk = await client.getAllPages<BulkInventoryItem>('/api/Product/Inventory/Bulk', { ...scope, Breakdown: false })
  const bulkBreak = (await client.get<BulkInventoryItem[]>('/api/Product/Inventory/Bulk', { ...scope, Breakdown: true, PageNo: 1, Limit: 50 })).data ?? []
  dump('inventory_bulk', bulk.items)
  dump('inventory_bulk_breakdown', bulkBreak)
  console.log(`  ${bulk.items.length} rows over ${bulk.pages} page(s)`)

  console.log('\nInbound ASNs (with items)…')
  const asns = await client.getAllPages<ASN>('/api/ASN/List', { ...scope, IncludeASNItems: true }, { limit: 100, maxPages: 10 })
  dump('asns', asns.items, { pii: true })
  console.log(`  ${asns.items.length} ASNs`)

  console.log('\nReference data…')
  const orderStatuses = (await client.get<OrderStatus[]>('/api/Order/Statuses')).data ?? []
  const couriers = (await client.get<CourierService[]>('/api/Courier/Services')).data ?? []
  dump('order_statuses', orderStatuses)
  dump('courier_services', couriers)
  console.log(`  ${orderStatuses.length} order statuses, ${couriers.length} courier services`)

  console.log('\nLast 50 orders (addresses redacted on write)…')
  const orders = (await client.get<Order[]>('/api/Order/List', {
    ...scope, PageNo: 1, Limit: 50, IncludeOrderItems: true,
  })).data ?? []
  dump('orders_recent', orders, { pii: true })
  console.log(`  ${orders.length} orders`)

  console.log('\nProbing how to check whether an order already exists…')
  const orderLookup = await probeOrderLookup(client, orders.find((o) => o.OrderNumber)?.OrderNumber, scope)
  for (const r of orderLookup.results) {
    console.log(`  ${String(r.status).padEnd(3)} ${r.label.padEnd(24)} ${JSON.stringify(r.shape).slice(0, 90)}`)
  }

  // ---- analysis -----------------------------------------------------------------

  const duplicates = findDuplicates(products.items)
  const stockSemantics = reconcileStock(stockPlain, bulk.items)
  const timings = client.log.filter((l) => l.status === 200).map((l) => l.ms).sort((a, b) => a - b)
  const rateLimited = client.log.filter((l) => l.status === 429)

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    apiKey: { ...keyShape, reauthsDuringRun: client.reauthCount },
    scope: { pinnedClientId: pinnedClientId ?? null, pinnedWarehouseId: pinnedWarehouseId ?? null },
    clients: {
      count: clients.length,
      otherClientsVisible: clients.length > 1,
      list: clients.map((c) => ({ ID: c.ID, Name: c.Name, Code: c.Code, ShortName: c.ShortName, Active: c.Active })),
    },
    warehouses: warehouses.map((w) => ({ ID: (w as { ID?: number }).ID, Name: w.Name, Code: w.Code, Active: w.Active })),
    counts: {
      products: products.items.length,
      productsTruncated: products.truncated,
      stockLevelRows: stockPlain.length,
      bulkInventoryRows: bulk.items.length,
      asns: asns.items.length,
      orderStatuses: orderStatuses.length,
      courierServices: couriers.length,
      recentOrders: orders.length,
    },
    /** The answer to "real response field names", measured rather than assumed. */
    observedFields: {
      Product: fieldReport(products.items as unknown as Record<string, unknown>[]),
      StockLevel: fieldReport(stockPlain as unknown as Record<string, unknown>[]),
      StockLevelWithBreakdown: fieldReport(stockBreak as unknown as Record<string, unknown>[]),
      BulkInventoryItem: fieldReport(bulk.items as unknown as Record<string, unknown>[]),
      ASN: fieldReport(asns.items as unknown as Record<string, unknown>[]),
      ASNItem: fieldReport(asns.items.flatMap((a) => a.Items ?? []) as unknown as Record<string, unknown>[]),
      Order: fieldReport(orders as unknown as Record<string, unknown>[]),
      OrderStatus: fieldReport(orderStatuses as unknown as Record<string, unknown>[]),
      CourierService: fieldReport(couriers as unknown as Record<string, unknown>[]),
    },
    /**
     * Where the published spec and the live API disagree. This is the answer to
     * "write typed models from real responses": the models come from the spec, and this
     * says how far the spec can be trusted.
     */
    specVsReality: [
      compareToSpec('Product', products.items as unknown as Record<string, unknown>[]),
      compareToSpec('StockLevel', stockPlain as unknown as Record<string, unknown>[]),
      compareToSpec('BulkInventoryItem', bulk.items as unknown as Record<string, unknown>[]),
      compareToSpec('ASN', asns.items as unknown as Record<string, unknown>[]),
      compareToSpec('ASNItem', asns.items.flatMap((a) => a.Items ?? []) as unknown as Record<string, unknown>[]),
      compareToSpec('Order', orders as unknown as Record<string, unknown>[]),
      compareToSpec('OrderStatus', orderStatuses as unknown as Record<string, unknown>[]),
      compareToSpec('CourierService', couriers as unknown as Record<string, unknown>[]),
    ].filter((r) => r.rowsSeen > 0),
    orderLookup,
    stockSemantics,
    duplicates: { ...duplicates, clusters: undefined, exampleClusters: duplicates.examples },
    orderStatusValues: orderStatuses.map((s) => ({ ID: s.ID, Name: s.Name, ExternalName: s.ExternalName })),
    courierServiceValues: couriers.map((c) => ({
      ID: c.ID, Name: c.Name, ActiveB: c.ActiveB, hasTrackingURL: Boolean(c.TrackingURL),
    })),
    breakdownTypeValues: [...new Set(
      stockBreak.flatMap((s) => (s.Breakdown ?? []).map((b) => b.Type)).filter(Boolean),
    )],
    /**
     * How heavy each endpoint actually is. Product.List nests OrderItems and several other
     * collections, so a full catalogue pull could be far larger than it looks — this is
     * what decides whether the hourly sync can pull everything or must go incremental.
     */
    payloadSizes: Object.entries(
      client.log.filter((l) => l.status === 200).reduce<Record<string, { calls: number; bytes: number }>>(
        (acc, l) => {
          const e = acc[l.path] ?? { calls: 0, bytes: 0 }
          e.calls++; e.bytes += l.bytes
          acc[l.path] = e
          return acc
        }, {}),
    ).map(([path, e]) => ({
      path, calls: e.calls, totalKb: Math.round(e.bytes / 1024), avgKbPerCall: Math.round(e.bytes / e.calls / 1024),
    })).sort((a, b) => b.totalKb - a.totalKb),
    /** Whether Mintsoft actually populates the product photo we hoped to reuse. */
    productImages: {
      withImageUrl: products.items.filter((p) => p.ImageURL?.trim()).length,
      ofTotal: products.items.length,
      sampleUrl: products.items.find((p) => p.ImageURL?.trim())?.ImageURL ?? null,
      note: 'If populated, check one URL loads in a browser without the ms-apikey header ' +
        'before the catalogue relies on it.',
    },
    rateLimits: {
      requests: client.log.length,
      rateLimitedResponses: rateLimited.length,
      observedAny429: rateLimited.length > 0,
      latencyMs: timings.length
        ? { min: timings.at(0), median: timings.at(Math.floor(timings.length / 2)), max: timings.at(-1) }
        : null,
      note: 'The published spec documents no 429 and no rate-limit headers. Anything here is empirical.',
    },
    requestLog: client.log,
  }

  dump('SUMMARY', summary)
  // The full duplicate set is large; keep it out of the summary but on disk for Phase 2.
  dump('duplicate_clusters', duplicates.clusters)

  console.log('\n' + '─'.repeat(72))
  console.log('DISCOVERY COMPLETE')
  console.log('─'.repeat(72))
  console.log(`Clients visible      : ${clients.length}${clients.length > 1 ? '  ** more than Maki — pin ClientId **' : ''}`)
  console.log(`Warehouses visible   : ${warehouses.length}`)
  console.log(`Products             : ${products.items.length}`)
  console.log(`Duplicate clusters   : ${duplicates.clusterCount} (${duplicates.productsInvolved} products involved)`)
  console.log(`Order statuses       : ${orderStatuses.map((s) => `${s.ID}=${s.Name}`).join(', ')}`)
  console.log(`429s seen            : ${rateLimited.length}`)
  const undocumented = summary.specVsReality.filter((r) => r.undocumentedFields.length)
  if (undocumented.length) {
    console.log('\nFields the live API sent that its spec does not document:')
    for (const r of undocumented) console.log(`  ${r.model}: ${r.undocumentedFields.join(', ')}`)
  }
  console.log(`Key re-auths needed  : ${client.reauthCount}`)
  console.log('\n"Available" hypothesis test (which field is free stock):')
  for (const [k, v] of Object.entries(stockSemantics.verdict)) console.log(`  ${v.padEnd(18)} ${k}`)
  console.log(`\nRaw dumps + SUMMARY.json in ./discovery/ (git-ignored).`)
}

main().catch((err) => {
  // Never print the error object wholesale: a fetch error can carry request details.
  console.error(`\nDiscovery failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  process.exit(1)
})

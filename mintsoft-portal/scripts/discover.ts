/**
 * Phase 0 — Mintsoft discovery. READ ONLY.
 *
 *   MINTSOFT_USERNAME=... MINTSOFT_PASSWORD=... npm run discover
 *
 * A pre-minted MINTSOFT_API_KEY, or MINTSOFT_PROXY_AUTH=true, works here too — this run
 * is short enough to finish inside a key's 24-hour life. Only the sync needs the login.
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
import {
  MintsoftReadOnlyClient, resolveAuthMode,
  type AuthMode, type ClientOptions,
} from '../src/lib/mintsoft/readonly-client.ts'
import {
  compareToSpec, fieldReport, findDuplicates, inspectKeyShape, reconcileStock, redact,
} from '../src/lib/mintsoft/discovery-analysis.ts'
import type {
  ASN, BulkInventoryItem, Client, CourierService, InventoryPreOrderBreakdown, Order, OrderStatus,
  Product, StockLevel, Warehouse,
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


/**
 * Asks Mintsoft directly whether a handful of products are orderable.
 *
 * InventoryPreOrderBreakdown is the one model in the API that states a view rather than a
 * raw count: OutOfStock is Mintsoft's own judgement, and ETAForNewOrders is its own answer
 * to "when can I have more". Neither can be derived from the stock feeds, and the spec
 * never defines what Allocated means, so this is the closest thing to a second opinion on
 * the availability question.
 *
 * It is per-product, so it is far too expensive to drive a catalogue. A sample is enough
 * to tell us whether it agrees with whichever formula the reconciliation picks.
 */
async function probeOrderability(client: MintsoftReadOnlyClient, productIds: number[]) {
  const rows = []
  for (const id of productIds) {
    const { data, status } = await client.get<InventoryPreOrderBreakdown[]>(
      `/api/Product/${id}/Inventory/PreOrderBreakdown/All`,
    )
    if (!Array.isArray(data)) {
      rows.push({ ProductId: id, status, note: 'no data' })
      continue
    }
    for (const r of data) {
      rows.push({
        ProductId: r.ProductId ?? id,
        SKU: r.SKU,
        WarehouseId: r.WarehouseId,
        StockLevel: r.StockLevel,
        OutOfStock: r.OutOfStock,
        PreOrderable: r.PreOrderable,
        OnOrder: r.OnOrder,
        RequiredByBackOrder: r.RequiredByBackOrder,
        AvailableForPreOrder: r.AvailableForPreOrder,
        ETAForNewOrders: r.ETAForNewOrders,
      })
    }
  }
  return {
    sampled: productIds.length,
    rows,
    note:
      'OutOfStock and ETAForNewOrders are Mintsoft stating a view, not a raw count. If ' +
      'OutOfStock disagrees with the formula the reconciliation picks, trust this and ' +
      're-open the question.',
  }
}

async function main() {
  // Any of the three credential forms will do for a read-only run. resolveAuthMode
  // rejects none-supplied and more-than-one-supplied, so a failure below always names
  // one credential rather than leaving it ambiguous which was at fault.
  const credential: ClientOptions = {
    username: process.env.MINTSOFT_USERNAME,
    password: process.env.MINTSOFT_PASSWORD,
    apiKey: process.env.MINTSOFT_API_KEY,
    proxyAuth: process.env.MINTSOFT_PROXY_AUTH === 'true',
  }
  let authMode: AuthMode
  try {
    authMode = resolveAuthMode(credential)
  } catch (err) {
    console.error(
      `${(err as Error).message}\n\n` +
      'Set them in your shell for a one-off run, or in .dev.vars (git-ignored) for repeat\n' +
      'runs. See DEPLOY.md — "Where the Mintsoft credentials go". Run `npm run\n' +
      'check:credentials` first if you want to confirm one works before a full run.\n' +
      'Credentials are never written to ./discovery/ or to any log.',
    )
    process.exit(1)
  }

  mkdirSync(dir, { recursive: true })
  const startedAt = new Date().toISOString()
  const client = new MintsoftReadOnlyClient({
    ...credential, throttleMs: Number(process.env.DISCOVER_THROTTLE_MS ?? 250),
    onLog: (e) => console.log(`  ${String(e.status).padEnd(3)} ${String(e.ms).padStart(5)}ms  ${e.path}`),
  })

  console.log(`\nAuthenticating… (${authMode})`)
  if (authMode === 'password') await client.authenticate()
  // The key itself never leaves the client; only this description of it does. In proxy
  // mode there is no key here to describe, which is the point of that mode.
  const keyShape = client.describeKey(inspectKeyShape) ?? { length: 0, looksLikeJwt: false, expiresAt: null }
  console.log(authMode === 'proxy'
    ? '  no key in this process — the proxy attaches one upstream'
    : `  key in hand (${keyShape.length} chars, jwt=${keyShape.looksLikeJwt}` +
      `${keyShape.expiresAt ? `, expires ${keyShape.expiresAt}` : ''})`)

  console.log('\nWho are we? (clients and warehouses this user can see)')
  // GET /api/Client is documented "Available to Admin users only", so this call may well
  // be refused. A refusal is not the same as "no other clients exist", and reporting it as
  // an empty list would answer the cross-client question with a reassuring lie. Keep the
  // status so the summary can say "could not check" instead.
  const clientsRes = await client.get<Client[]>('/api/Client')
  const warehousesRes = await client.get<Warehouse[]>('/api/Warehouse')
  const clients = clientsRes.data ?? []
  const warehouses = warehousesRes.data ?? []
  const couldListClients = Array.isArray(clientsRes.data)
  const couldListWarehouses = Array.isArray(warehousesRes.data)
  dump('clients', clients, { pii: true })
  dump('warehouses', warehouses, { pii: true })
  console.log(
    couldListClients
      ? `  ${clients.length} client(s), ${couldListWarehouses ? `${warehouses.length} warehouse(s)` : 'warehouses: could not list'}`
      : `  clients: could not list (HTTP ${clientsRes.status} — /api/Client is admin-only), ` +
        `${couldListWarehouses ? `${warehouses.length} warehouse(s)` : 'warehouses: could not list'}`,
  )
  if (!couldListClients) {
    console.warn('  ! Cannot confirm whether other clients are visible. Pin MINTSOFT_CLIENT_ID.')
  }

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
  // Product/List documents "Default 100 - Max 100".
  const products = await client.getAllPages<Product>('/api/Product/List', { ClientId: scope.ClientId }, { limit: 100 })
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
  // Inventory/Bulk documents "Default 100 - Max 500".
  const bulk = await client.getAllPages<BulkInventoryItem>('/api/Product/Inventory/Bulk', { ...scope, Breakdown: false }, { limit: 500 })
  const bulkBreak = (await client.get<BulkInventoryItem[]>('/api/Product/Inventory/Bulk', { ...scope, Breakdown: true, PageNo: 1, Limit: 50 })).data ?? []
  dump('inventory_bulk', bulk.items)
  dump('inventory_bulk_breakdown', bulkBreak)
  console.log(`  ${bulk.items.length} rows over ${bulk.pages} page(s)`)

  console.log('\nInbound ASNs (with items)…')
  const asns = await client.getAllPages<ASN>('/api/ASN/List', { ...scope, IncludeASNItems: true }, { limit: 100, maxPages: 20 })
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

  console.log('\nAsking Mintsoft whether a sample of products is orderable…')
  const sampleIds = products.items.map((p) => p.ID).filter((id): id is number => id != null).slice(0, 8)
  const orderability = await probeOrderability(client, sampleIds)
  console.log(`  sampled ${orderability.sampled} product(s), ${orderability.rows.length} row(s)`)

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
      // null, not false: "we could not check" is a different answer from "no".
      couldList: couldListClients,
      count: couldListClients ? clients.length : null,
      otherClientsVisible: couldListClients ? clients.length > 1 : null,
      listRefusedWithStatus: couldListClients ? null : clientsRes.status,
      list: clients.map((c) => ({ ID: c.ID, Name: c.Name, Code: c.Code, ShortName: c.ShortName, Active: c.Active })),
    },
    couldListWarehouses,
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
    orderability,
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
  console.log(`Clients visible      : ${couldListClients
    ? `${clients.length}${clients.length > 1 ? '  ** more than Maki — pin ClientId **' : ''}`
    : `— (refused with HTTP ${clientsRes.status}; not the same as none)`}`)
  console.log(`Warehouses visible   : ${couldListWarehouses ? warehouses.length : '—'}`)
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

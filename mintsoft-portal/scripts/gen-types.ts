/**
 * Regenerates src/lib/mintsoft/types.ts from the live Mintsoft Swagger spec.
 *
 * Read-only: fetches the public spec, writes one local file. Needs no credentials.
 *   npm run gen:types
 *
 * We generate rather than hand-write because Mintsoft's field casing is unforgiving
 * and a few names are genuinely surprising (`Username` not `UserName`, `DisCont`
 * not `Discontinued`, and `QuantityReceieved` — their typo, which we must match).
 */
import { writeFileSync } from 'node:fs'

const SPEC_URL = 'https://api.mintsoft.co.uk/swagger/docs/v1'
const OUT = new URL('../src/lib/mintsoft/types.ts', import.meta.url)

/** The models the portal actually touches. Their dependencies are pulled in automatically. */
const SEED = [
  'MintsoftAuthRequest', 'Product', 'ProductCategory', 'StockLevel', 'StockLevelBreakdown',
  'BulkInventoryItem', 'InventoryItem', 'InventoryPreOrderBreakdown', 'ASN', 'ASNItem', 'ASNStatus', 'Order', 'OrderItem',
  'OrderStatus', 'OrderShipment', 'OrderShipmentTrackingEvent', 'CourierService',
  'NewOrderWithItems', 'NewOrderItem', 'NewOrderResult', 'NewOrderResultItems', 'Client', 'Warehouse',
]

const SCALARS: Record<string, string> = {
  integer: 'number', number: 'number', string: 'string', boolean: 'boolean', object: 'unknown',
}

type Schema = { $ref?: string; type?: string; format?: string; items?: Schema }
type Definition = { required?: string[]; properties?: Record<string, Schema> }

const refName = (ref: string) => ref.split('/').pop()!

function tsType(s: Schema): string {
  if (s.$ref) return refName(s.$ref)
  if (s.type === 'array') {
    const it = s.items ?? {}
    return (it.$ref ? refName(it.$ref) : SCALARS[it.type ?? ''] ?? 'unknown') + '[]'
  }
  return SCALARS[s.type ?? ''] ?? 'unknown'
}

function dependencies(def: Definition): string[] {
  return Object.values(def.properties ?? {}).flatMap((p) => {
    if (p.$ref) return [refName(p.$ref)]
    if (p.type === 'array' && p.items?.$ref) return [refName(p.items.$ref)]
    return []
  })
}

const res = await fetch(SPEC_URL)
if (!res.ok) throw new Error(`Could not fetch the Mintsoft spec: HTTP ${res.status}`)
const spec = (await res.json()) as {
  info?: { version?: string; 'x-swagger-net-version'?: string }
  definitions: Record<string, Definition>
}
const defs = spec.definitions

// Transitive closure over SEED, so the emitted file compiles on its own.
const needed = new Set<string>()
const stack = [...SEED]
while (stack.length) {
  const name = stack.pop()!
  const def = defs[name]
  if (needed.has(name) || !def) continue
  needed.add(name)
  stack.push(...dependencies(def))
}

const missing = SEED.filter((n) => !defs[n])
if (missing.length) {
  throw new Error(`The spec no longer defines: ${missing.join(', ')} — the API has changed shape.`)
}

const version = spec.info?.['x-swagger-net-version'] ?? 'unknown'
const lines: string[] = [
  '// Mintsoft API models.',
  '//',
  `// GENERATED from ${SPEC_URL} (x-swagger-net-version ${version}).`,
  '// Do not hand-edit — run `npm run gen:types`.',
  '//',
  '// Field names and casing are verbatim from the spec. Mintsoft is case-sensitive and',
  '// several names are easy to get wrong, including one the API itself misspells',
  '// (`ASNItem.QuantityReceieved`). Matching their spelling is deliberate.',
  '//',
  '// Almost every property is optional: the spec marks very few fields required, so the',
  '// API may omit any of them. Treat a missing number as unknown, never as 0 — the portal',
  '// renders unknown stock as an em dash, and a silent 0 would read as "out of stock".',
  '',
]

const fieldsByModel: Record<string, string[]> = {}

for (const name of [...needed].sort()) {
  const def = defs[name]
  if (!def) continue
  const required = new Set(def.required ?? [])
  const keys = Object.keys(def.properties ?? {})
  fieldsByModel[name] = keys
  lines.push(`export interface ${name} {`)
  for (const [key, schema] of Object.entries(def.properties ?? {})) {
    const optional = required.has(key) ? '' : '?'
    const comment = schema.format === 'date-time' ? ' // date-time' : ''
    lines.push(`  ${key}${optional}: ${tsType(schema)};${comment}`)
  }
  lines.push('}', '')
}

// The same field names, available at runtime. Discovery compares what the live API
// actually returns against this, so a field Mintsoft sends but does not document shows
// up as a finding instead of being silently dropped by the type system.
lines.push(
  '/** Field names each model declares, per the published spec. Generated alongside the types. */',
  'export const SPEC_FIELDS: Record<string, readonly string[]> = {',
  ...Object.entries(fieldsByModel).map(
    ([model, keys]) => `  ${model}: [${keys.map((k) => `'${k}'`).join(', ')}],`,
  ),
  '}',
  '',
)

writeFileSync(OUT, lines.join('\n'))
console.log(`Wrote ${needed.size} models to src/lib/mintsoft/types.ts`)

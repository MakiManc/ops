import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Phase 0 is read-only, and the hard rules say no write to Mintsoft happens before
 * Phase 3 — and then only behind MINTSOFT_WRITES_ENABLED and an approver check.
 *
 * These tests assert that as a property of the source, not as a promise. If someone
 * later adds a write to the discovery path, CI fails here rather than in the warehouse.
 */
const client = readFileSync(new URL('../src/lib/mintsoft/readonly-client.ts', import.meta.url), 'utf8')
const script = readFileSync(new URL('../scripts/discover.ts', import.meta.url), 'utf8')

describe('the discovery client cannot write to Mintsoft', () => {
  it('issues no HTTP verb other than GET, plus the single POST to /api/Auth', () => {
    const methods = [...client.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1])
    expect(methods).toEqual(['POST']) // the auth exchange, and nothing else
    expect(client).toContain("fetch(`${BASE}/api/Auth`")
  })

  it('names none of the Mintsoft write endpoints', () => {
    // The endpoints that would change warehouse state. None may appear in the read path.
    const forbidden = [
      '/api/Order\'', '/api/ASN\'', '/api/Product\'',
      'BulkOnHandStockUpdate', 'StockMovement', 'BulkStockMovement',
      'WarehouseTransfer', 'MarkDespatched', 'Cancel', 'BookIn', 'Items/Receive',
    ]
    for (const endpoint of forbidden) {
      expect(client + script, `discovery must not reference ${endpoint}`).not.toContain(endpoint)
    }
  })

  it('exposes no method that could be mistaken for a write', () => {
    const methodNames = [...client.matchAll(/^\s{2}(?:async\s+)?(\w+)[(<]/gm)].map((m) => m[1])
    for (const name of methodNames) {
      expect(name).not.toMatch(/^(put|post|patch|delete|create|update|remove|send)/i)
    }
  })
})

describe('credentials and personal data stay out of the dumps', () => {
  it('never puts the password or the API key into the request log', () => {
    // The auth log entry records an empty query and an explicit redaction note.
    expect(client).toContain("query: {}, // never record credentials")
    expect(client).toContain("note: res.ok ? 'key redacted' : 'auth failed'")
  })

  it('does not interpolate the password into any string', () => {
    expect(client).not.toMatch(/\$\{.*[Pp]assword.*\}/)
    expect(script).not.toMatch(/console\.(log|error|warn)\([^)]*[Pp]assword/)
  })

  it('writes every address-bearing dump through the redactor', () => {
    // clients, warehouses, ASNs and orders can all carry a real address.
    for (const call of ['clients', 'warehouses', 'asns', 'orders_recent']) {
      const re = new RegExp(`dump\\('${call}',[^)]*\\{ pii: true \\}`)
      expect(script, `${call} dump must be redacted`).toMatch(re)
    }
  })

  it('keeps the discovery output folder git-ignored', () => {
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
    expect(ignore).toMatch(/^discovery\/$/m)
  })
})

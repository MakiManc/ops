import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_READ_PATHS, DisallowedEndpointError, MintsoftReadOnlyClient,
} from '../src/lib/mintsoft/readonly-client.ts'

/**
 * Phase 0 is read-only, and no write reaches Mintsoft before Phase 3 — and then only
 * behind MINTSOFT_WRITES_ENABLED and an approver check.
 *
 * The guarantee is an allow-list rather than "we only use GET", because GET is not a
 * safe verb on this API: Mintsoft exposes Cancel, BookIn, Confirm and the whole Mark*
 * family as GETs. These tests exercise the refusal, so a mistake fails in CI rather than
 * in Mercium's warehouse.
 */

const client = () => new MintsoftReadOnlyClient({ username: 'u', password: 'p', throttleMs: 0 })

afterEach(() => vi.restoreAllMocks())

describe('the allow-list', () => {
  it('refuses a state-changing endpoint even though it is a GET', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // Every one of these is a GET in Mintsoft's own spec, and every one changes state.
    for (const path of [
      '/api/Order/123/MarkDespatched',
      '/api/Order/123/Cancel',
      '/api/ASN/9/BookIn',
      '/api/ASN/9/Confirm',
      '/api/WarehouseTransfer/4/Confirm',
    ]) {
      await expect(client().get(path)).rejects.toThrow(DisallowedEndpointError)
    }
    // Nothing reached the network — not even an auth call.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses before authenticating, so a bad path cannot even spend a credential', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(client().get('/api/Product')).rejects.toThrow(DisallowedEndpointError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('allows the read endpoints discovery actually needs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return new Response(url.pathname === '/api/Auth' ? '"k"' : '[]', { status: 200 })
    })
    for (const path of ALLOWED_READ_PATHS) {
      await expect(client().get(path)).resolves.toMatchObject({ status: 200 })
    }
  })

  it('lists only endpoints that read, and names no write', () => {
    // A tripwire on the list itself: if someone adds a Mark*/Cancel/BookIn path, say so.
    for (const path of ALLOWED_READ_PATHS) {
      expect(path).not.toMatch(/Mark|Cancel|BookIn|PartBook|Confirm|Receive|Update|Delete|Split/i)
    }
  })

  it('is frozen, so it cannot be widened at runtime', () => {
    expect(Object.isFrozen(ALLOWED_READ_PATHS)).toBe(true)
  })
})

describe('the client implements no write verb', () => {
  const source = readFileSync(new URL('../src/lib/mintsoft/readonly-client.ts', import.meta.url), 'utf8')

  it('issues no HTTP method other than the single POST to /api/Auth', () => {
    const methods = [...source.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1])
    expect(methods).toEqual(['POST'])
    expect(source).toContain("fetch(`${BASE}/api/Auth`")
  })

  it('exposes no method that could be mistaken for a write', () => {
    const methodNames = [...source.matchAll(/^\s{2}(?:async\s+)?(\w+)[(<]/gm)].map((m) => m[1])
    for (const name of methodNames) {
      expect(name).not.toMatch(/^(put|post|patch|delete|create|update|remove|send)/i)
    }
  })
})

describe('credentials and personal data stay out of the dumps', () => {
  const source = readFileSync(new URL('../src/lib/mintsoft/readonly-client.ts', import.meta.url), 'utf8')
  const script = readFileSync(new URL('../scripts/discover.ts', import.meta.url), 'utf8')

  it('never puts the password or the API key into the request log', () => {
    expect(source).toContain('query: {}, // never record credentials')
    expect(source).toContain("note: res.ok ? 'key redacted' : 'auth failed'")
  })

  it('does not interpolate the password into any string', () => {
    expect(source).not.toMatch(/\$\{.*[Pp]assword.*\}/)
    expect(script).not.toMatch(/console\.(log|error|warn)\([^)]*[Pp]assword/)
  })

  it('does not hand the API key out to callers', () => {
    // describeKey passes the key to a callback; there is no getter that returns it.
    expect(source).not.toMatch(/get key\(\)/)
    expect(source).toContain('describeKey')
  })

  it('writes every address-bearing dump through the redactor', () => {
    for (const call of ['clients', 'warehouses', 'asns', 'orders_recent']) {
      expect(script, `${call} dump must be redacted`)
        .toMatch(new RegExp(`dump\\('${call}',[^)]*\\{ pii: true \\}`))
    }
  })

  it('keeps the discovery output folder git-ignored', () => {
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
    expect(ignore).toMatch(/^discovery\/$/m)
  })
})

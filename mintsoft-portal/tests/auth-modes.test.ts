import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MintsoftReadOnlyClient, resolveAuthMode,
} from '../src/lib/mintsoft/readonly-client.ts'

/**
 * Mintsoft accepts one thing on the wire — an `ms-apikey` header — but there are three
 * ways to end up holding one, and they behave differently when the key is refused. Only
 * the login can mint a replacement; a pre-minted key and a proxy-attached one cannot, and
 * a silent retry loop against either would be pointless traffic against a live 3PL API.
 */

afterEach(() => vi.restoreAllMocks())

const jsonOnce = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )

describe('resolveAuthMode', () => {
  it('names each of the three forms', () => {
    expect(resolveAuthMode({ username: 'u', password: 'p' })).toBe('password')
    expect(resolveAuthMode({ apiKey: 'k' })).toBe('key')
    expect(resolveAuthMode({ proxyAuth: true })).toBe('proxy')
  })

  it('refuses when nothing is supplied, rather than failing later at the network', () => {
    expect(() => resolveAuthMode({})).toThrow(/No Mintsoft credential/)
  })

  it('treats a half-supplied login as no login', () => {
    expect(() => resolveAuthMode({ username: 'u' })).toThrow(/No Mintsoft credential/)
    expect(() => resolveAuthMode({ password: 'p' })).toThrow(/No Mintsoft credential/)
  })

  it('refuses two forms at once, so a failure is never ambiguous about which was at fault', () => {
    expect(() => resolveAuthMode({ username: 'u', password: 'p', apiKey: 'k' }))
      .toThrow(/Ambiguous/)
    expect(() => resolveAuthMode({ apiKey: 'k', proxyAuth: true })).toThrow(/Ambiguous/)
  })
})

describe('a pre-minted key', () => {
  it('sends the key without ever calling /api/Auth', async () => {
    const fetchSpy = jsonOnce([])
    const client = new MintsoftReadOnlyClient({ apiKey: 'given-key', throttleMs: 0 })
    await client.get('/api/Client')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('/api/Client')
    expect((init as RequestInit).headers).toMatchObject({ 'ms-apikey': 'given-key' })
    expect(client.reauthCount).toBe(0)
  })

  it('reports a 401 instead of retrying, because it has nothing to retry with', async () => {
    const fetchSpy = jsonOnce({}, 401)
    const client = new MintsoftReadOnlyClient({ apiKey: 'expired', throttleMs: 0 })
    const res = await client.get('/api/Client')

    expect(res.status).toBe(401)
    // One call. A retry here would re-send the same dead key.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(client.log.at(-1)?.note).toMatch(/cannot be renewed/)
  })

  it('refuses an explicit authenticate(), naming what to supply instead', async () => {
    const client = new MintsoftReadOnlyClient({ apiKey: 'k', throttleMs: 0 })
    await expect(client.authenticate()).rejects.toThrow(/MINTSOFT_USERNAME and MINTSOFT_PASSWORD/)
  })
})

describe('a proxy-attached key', () => {
  it('sends no ms-apikey header at all, leaving it to the proxy', async () => {
    const fetchSpy = jsonOnce([])
    const client = new MintsoftReadOnlyClient({ proxyAuth: true, throttleMs: 0 })
    await client.get('/api/Warehouse')

    const [, init] = fetchSpy.mock.calls[0]!
    expect((init as RequestInit).headers).not.toHaveProperty('ms-apikey')
  })

  it('holds no key, so there is nothing in the process to leak', () => {
    const client = new MintsoftReadOnlyClient({ proxyAuth: true, throttleMs: 0 })
    expect(client.describeKey((k) => k)).toBeNull()
  })

  it('still refuses a disallowed path — the proxy is not a way around the allow-list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = new MintsoftReadOnlyClient({ proxyAuth: true, throttleMs: 0 })
    await expect(client.get('/api/Order/1/Cancel')).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the login', () => {
  it('still re-mints once on a 401, which is the whole reason it is the form the sync uses', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('"first-key"', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('"second-key"', { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', {
        status: 200, headers: { 'content-type': 'application/json' },
      }))

    const client = new MintsoftReadOnlyClient({ username: 'u', password: 'p', throttleMs: 0 })
    const res = await client.get('/api/Client')

    expect(res.status).toBe(200)
    expect(client.reauthCount).toBe(1)
    // The retry went out under the new key, not the dead one.
    const last = fetchSpy.mock.calls.at(-1)!
    expect((last[1] as RequestInit).headers).toMatchObject({ 'ms-apikey': 'second-key' })
  })
})

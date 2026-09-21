import { afterEach, describe, expect, it, vi } from 'vitest'
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'

/**
 * "No silent truncation of lists" is one of the portal's hard rules. A list that stops
 * early and says nothing is worse than one that fails, because it looks like an answer.
 */

function stubApi(pages: unknown[][]) {
  let call = 0
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/api/Auth') return new Response('"test-key"', { status: 200 })
    const body = pages[call++] ?? []
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

const newClient = () =>
  new MintsoftReadOnlyClient({ username: 'u', password: 'p', throttleMs: 0 })

afterEach(() => vi.restoreAllMocks())

describe('getAllPages', () => {
  it('stops on a short page and reports only the pages that carried data', async () => {
    stubApi([[1, 2, 3], [4]]) // limit 3: second page is short, so it is the last
    const r = await newClient().getAllPages<number>('/api/Product/List', {}, { limit: 3 })
    expect(r.items).toEqual([1, 2, 3, 4])
    expect(r.pages).toBe(2)
    expect(r.truncated).toBe(false)
  })

  it('does not count the empty page that ended the walk', async () => {
    stubApi([[1, 2], []]) // limit 2: full page, then nothing left
    const r = await newClient().getAllPages<number>('/api/Product/List', {}, { limit: 2 })
    expect(r.items).toEqual([1, 2])
    expect(r.pages).toBe(1) // one page held data, not two
    expect(r.truncated).toBe(false)
  })

  it('flags truncation when it stops at the ceiling on a still-full page', async () => {
    stubApi([[1, 2], [3, 4], [5, 6]])
    const r = await newClient().getAllPages<number>('/api/Product/List', {}, { limit: 2, maxPages: 2 })
    expect(r.items).toEqual([1, 2, 3, 4])
    // The ceiling was hit while pages were still full — there is more we did not fetch,
    // and the caller has to be told rather than shown a quietly short list.
    expect(r.truncated).toBe(true)
  })

  it('does not cry truncation when the ceiling coincides with the true end', async () => {
    stubApi([[1, 2], [3]])
    const r = await newClient().getAllPages<number>('/api/Product/List', {}, { limit: 2, maxPages: 2 })
    expect(r.items).toEqual([1, 2, 3])
    expect(r.truncated).toBe(false)
  })

  it('returns an empty result rather than inventing one when there is nothing', async () => {
    stubApi([[]])
    const r = await newClient().getAllPages<number>('/api/Product/List', {}, { limit: 10 })
    expect(r).toEqual({ items: [], pages: 0, truncated: false })
  })
})

describe('authentication handling', () => {
  it('sends the key as the ms-apikey header and never in the query string', async () => {
    const fetchSpy = stubApi([[1]])
    await newClient().get('/api/Product/List', { ClientId: 7 })
    const [, init] = fetchSpy.mock.calls.at(-1)!
    expect((init?.headers as Record<string, string>)['ms-apikey']).toBe('test-key')
    const url = new URL(String(fetchSpy.mock.calls.at(-1)![0]))
    expect(url.search).not.toMatch(/key|password/i)
  })

  it('re-authenticates once when the key is rejected, then gives up', async () => {
    let auths = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/api/Auth') { auths++; return new Response('"k"', { status: 200 }) }
      return new Response('', { status: 401 })
    })
    const res = await newClient().get('/api/Product/List')
    expect(res.status).toBe(401)
    // One initial auth plus exactly one retry — not an endless loop against a locked account.
    expect(auths).toBe(2)
  })

  it('records the auth call without the credentials', async () => {
    stubApi([[1]])
    const client = newClient()
    await client.authenticate()
    const entry = client.log.find((l) => l.path === '/api/Auth')!
    expect(entry.query).toEqual({})
    expect(JSON.stringify(entry)).not.toMatch(/password|test-key/i)
  })
})

/**
 * A deliberately read-only Mintsoft client, used by Phase 0 discovery.
 *
 * This module can only issue GETs, plus the single POST to /api/Auth that exchanges
 * credentials for an API key. There is no code path here that can create, update or
 * delete anything in Mintsoft. That is a safety property of the module, not a
 * convention: the write verbs are simply not implemented.
 *
 * The portal's own client (Phase 2+) adds exactly one write — PUT /api/Order — behind
 * the MINTSOFT_WRITES_ENABLED flag and an approver check. Nothing else is ever written.
 */

const BASE = 'https://api.mintsoft.co.uk'

export interface RequestLog {
  path: string
  query: Record<string, string | number | boolean | undefined>
  status: number
  ms: number
  bytes: number
  /** Set when the response was not JSON, or the request failed outright. */
  note?: string
}

export interface ClientOptions {
  username: string
  password: string
  /** Pause between calls, to stay polite with an API whose limits we do not know. */
  throttleMs?: number
  onLog?: (entry: RequestLog) => void
}

export class MintsoftReadOnlyClient {
  private key: string | null = null
  private authCount = 0
  readonly log: RequestLog[] = []

  constructor(private readonly opts: ClientOptions) {}

  /** Number of times we exchanged credentials for a key. >1 means a key expired mid-run. */
  get reauthCount() {
    return Math.max(0, this.authCount - 1)
  }

  /**
   * Describes the key without handing it out, so discovery can report on its lifetime
   * without the key ever leaving this object. `describe` receives the key, and only its
   * return value escapes — which keeps the one place that touches the raw key right here.
   */
  describeKey<T>(describe: (key: string) => T): T | null {
    return this.key === null ? null : describe(this.key)
  }

  /**
   * Exchanges credentials for an API key.
   *
   * The spec types the 200 response as a bare `string`, not an object, so we read it as
   * text and only strip JSON quoting if the server wrapped it. The credentials are sent
   * in the body and are never logged, echoed, or included in any dump.
   */
  async authenticate(): Promise<void> {
    const started = performance.now()
    const res = await fetch(`${BASE}/api/Auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Casing matters: the spec's MintsoftAuthRequest is { Username, Password }.
      body: JSON.stringify({ Username: this.opts.username, Password: this.opts.password }),
    })
    const raw = (await res.text()).trim()
    const ms = Math.round(performance.now() - started)

    this.log.push({
      path: '/api/Auth',
      query: {}, // never record credentials
      status: res.status,
      ms,
      bytes: raw.length,
      note: res.ok ? 'key redacted' : 'auth failed',
    })

    if (!res.ok) {
      // Deliberately does not include the body: a failed auth response can echo input.
      throw new Error(
        `Mintsoft auth failed with HTTP ${res.status}. ` +
          `Check MINTSOFT_USERNAME / MINTSOFT_PASSWORD are set correctly.`,
      )
    }

    // The key arrives either bare or as a JSON-quoted string.
    this.key = raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw
    if (!this.key) throw new Error('Mintsoft auth returned an empty key.')
    this.authCount += 1
  }

  /**
   * Issues a GET. Re-authenticates once on a 401 (the key has an unknown lifetime, so a
   * long discovery run may outlive it) and backs off on a 429.
   */
  async get<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    { retriedAuth = false, retriedRateLimit = 0 } = {},
  ): Promise<{ data: T | null; status: number; ms: number; raw: string }> {
    if (!this.key) await this.authenticate()

    const url = new URL(path, BASE)
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }

    const started = performance.now()
    const res = await fetch(url, {
      headers: { 'ms-apikey': this.key!, Accept: 'application/json' },
    })
    const raw = await res.text()
    const ms = Math.round(performance.now() - started)

    const entry: RequestLog = { path, query, status: res.status, ms, bytes: raw.length }
    this.log.push(entry)
    this.opts.onLog?.(entry)

    if (res.status === 401 && !retriedAuth) {
      entry.note = 'key rejected — re-authenticating once'
      this.key = null
      await this.authenticate()
      return this.get<T>(path, query, { retriedAuth: true, retriedRateLimit })
    }

    // The spec documents no 429 anywhere, so if one appears it is undocumented
    // behaviour worth recording loudly as well as backing off from.
    if (res.status === 429 && retriedRateLimit < 3) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2000 * 2 ** retriedRateLimit
      entry.note = `RATE LIMITED — backing off ${waitMs}ms`
      await sleep(waitMs)
      return this.get<T>(path, query, { retriedAuth, retriedRateLimit: retriedRateLimit + 1 })
    }

    await sleep(this.opts.throttleMs ?? 250)

    if (!res.ok) {
      entry.note = entry.note ?? `HTTP ${res.status}`
      return { data: null, status: res.status, ms, raw }
    }

    try {
      return { data: JSON.parse(raw) as T, status: res.status, ms, raw }
    } catch {
      entry.note = 'response was not JSON'
      return { data: null, status: res.status, ms, raw }
    }
  }

  /**
   * Walks a paginated list endpoint to the end.
   *
   * The subtlety this handles: Mintsoft caps `Limit` per endpoint (100 on Product/List and
   * ASN/List, 500 on Inventory/Bulk) and silently returns the cap rather than erroring when
   * you ask for more. So a page shorter than requested is ambiguous — it means either "this
   * is the last page" or "the server capped your page size". Stopping on the first short
   * page would quietly truncate the catalogue at 100 products and look like a complete
   * answer, which is the worst kind of wrong.
   *
   * We resolve the ambiguity by asking for the next page instead of guessing. If it has
   * rows, the server capped us, and we carry on at the size it actually gave.
   */
  async getAllPages<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    { limit = 100, maxPages = 100 }: { limit?: number; maxPages?: number } = {},
  ): Promise<{ items: T[]; pages: number; truncated: boolean; serverCappedPageSizeAt?: number }> {
    const items: T[] = []
    let pagesWithData = 0
    let hitCeiling = false
    let serverCappedPageSizeAt: number | undefined
    let effectiveLimit = limit

    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.get<T[]>(path, { ...query, PageNo: page, Limit: limit })
      if (!Array.isArray(data) || data.length === 0) break

      items.push(...data)
      pagesWithData++

      if (data.length < effectiveLimit) {
        if (page === 1 && data.length > 0 && data.length < limit) {
          // Ambiguous: last page, or a server-side cap? Only the next page can say.
          effectiveLimit = data.length
          serverCappedPageSizeAt = data.length
          continue
        }
        break // genuinely the last page
      }

      if (page === maxPages) hitCeiling = true
    }

    // If the walk ended immediately after the probe, there was no cap — just one short page.
    if (serverCappedPageSizeAt !== undefined && pagesWithData === 1) serverCappedPageSizeAt = undefined

    // Being explicit about hitting the ceiling matters: silently truncating a list is
    // exactly the kind of dishonest data the portal is meant to avoid.
    return { items, pages: pagesWithData, truncated: hitCeiling, serverCappedPageSizeAt }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

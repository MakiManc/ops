/**
 * The only Mintsoft client that can write, and it can write exactly one thing.
 *
 * Kept separate from MintsoftReadOnlyClient on purpose. That client is proved read-only
 * by tests, and it stays that way: the sync jobs, the discovery script and everything
 * else use it and cannot post an order even by accident. This client exists solely so
 * that the ability to create an order lives in one file that is easy to find and hard
 * to reach by mistake.
 *
 * Creating one does not grant permission. The caller must still pass the write gate,
 * which checks the flag and the approver's sign-off.
 */
import { MintsoftReadOnlyClient, type ClientOptions } from '../../lib/mintsoft/readonly-client.ts'
import type { NewOrderResult } from '../../lib/mintsoft/types.ts'

const BASE = 'https://api.mintsoft.co.uk'

export class MintsoftOrderClient extends MintsoftReadOnlyClient {
  constructor(opts: ClientOptions) { super(opts) }

  /**
   * PUT /api/Order — create an order.
   *
   * Returns the raw result rather than interpreting it. Deciding what a response means
   * belongs in postOrder(), which knows that a 200 can carry a failure and that a
   * dropped connection is not the same as a refusal.
   */
  async putOrder(body: unknown): Promise<{ data: NewOrderResult[] | null; status: number; raw: string }> {
    const res = await fetch(new URL('/api/Order', BASE), {
      method: 'PUT',
      headers: await this.authorizedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })

    const raw = await res.text()
    this.log.push({
      path: '/api/Order',
      query: {},
      status: res.status,
      ms: 0,
      bytes: raw.length,
      note: 'ORDER CREATE',
    })

    // A key older than 24 hours gets a 401. Renew once and try again -- but only for
    // 401, and only once, because a retry on anything else risks a duplicate order.
    if (res.status === 401) {
      await this.authenticate()
      const retry = await fetch(new URL('/api/Order', BASE), {
        method: 'PUT',
        headers: await this.authorizedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      const retryRaw = await retry.text()
      return { data: parse(retryRaw), status: retry.status, raw: retryRaw }
    }

    return { data: parse(raw), status: res.status, raw }
  }
}

function parse(raw: string): NewOrderResult[] | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as NewOrderResult[]) : null
  } catch {
    return null
  }
}

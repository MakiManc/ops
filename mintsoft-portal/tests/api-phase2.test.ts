import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import type { Env } from '../src/server/auth/middleware.ts'
import { buildSessionCookie, sessionTtlSeconds, signSession } from '../src/server/auth/session.ts'
import { FakeD1, seedRoles } from './helpers/d1.ts'

/** The Phase 2 screens, checked through the API with each role's own session. */

let db: FakeD1
let app: ReturnType<typeof createApp>
let env: Env
const SECRET = 'test-secret'
const GM = 1, APPROVER = 2, ADMIN = 3

beforeEach(() => {
  db = new FakeD1()
  seedRoles(db)
  db.exec(`
    INSERT INTO products (id, name, stock_type, recharge_unit_price) VALUES (1, 'Ramen Bowl', 'internal', 2.50);
    INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at) VALUES
      (7001, 'BOWL-01', 'Ramen Bowl', '2026-09-21T10:00:00Z'),
      (7002, 'BOWL-02', 'Ramen Bowl v2', '2026-09-21T10:00:00Z');
    INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary) VALUES (1, 7001, 'BOWL-01', 1);
    INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, synced_at)
      VALUES (7001, 1, 1, 40, 5, '2026-09-21T10:00:00Z');
  `)
  app = createApp()
  env = { DB: db as unknown as D1Database, SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'x' }
})

async function as(userId: number) {
  const v = await signSession({ userId, expiresAt: Math.floor(Date.now() / 1000) + sessionTtlSeconds }, SECRET)
  return buildSessionCookie(v, sessionTtlSeconds).split(';')[0]!
}
const call = (path: string, cookie?: string, init: RequestInit = {}) =>
  app.fetch(new Request(`https://portal.test${path}`, {
    ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  }), env)

describe('the catalogue', () => {
  it('gives a GM their site\'s products with a stock figure and its age', async () => {
    const res = await call('/api/sites/1/catalogue', await as(GM))
    expect(res.status).toBe(200)
    const body = await res.json() as {
      site: { code: string; recharge: boolean }
      freshness: { stale: boolean }
      products: { name: string; available: number; status: string; stockSyncedAt: string; rechargeUnitPrice: number | null }[]
    }
    expect(body.site.code).toBe('M9')
    expect(body.products[0]).toMatchObject({ name: 'Ramen Bowl', available: 35, status: 'in_stock' })
    expect(body.products[0]!.stockSyncedAt).toBe('2026-09-21T10:00:00Z')
  })

  it('never shows a price at a corporate site', async () => {
    const body = await (await call('/api/sites/1/catalogue', await as(GM))).json() as
      { products: { rechargeUnitPrice: number | null }[] }
    expect(body.products[0]!.rechargeUnitPrice).toBeNull()
  })

  it('warns that stock is stale when no sync has ever succeeded', async () => {
    const body = await (await call('/api/sites/1/catalogue', await as(GM))).json() as
      { freshness: { stale: boolean; lastSuccessAt: string | null } }
    // Never synced is the stalest state there is, not a fresh one.
    expect(body.freshness).toEqual({ stale: true, lastSuccessAt: null, minutesOld: null })
  })

  it('reports fresh once a stock sync has just succeeded', async () => {
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    db.exec(`INSERT INTO sync_runs (job, started_at, finished_at, status) VALUES ('stock', '${at}', '${at}', 'ok')`)
    const body = await (await call('/api/sites/1/catalogue', await as(GM))).json() as { freshness: { stale: boolean } }
    expect(body.freshness.stale).toBe(false)
  })

  it('stays closed to another site', async () => {
    expect((await call('/api/sites/2/catalogue', await as(GM))).status).toBe(404)
  })
})

describe('the stock overview', () => {
  it('is open to an approver', async () => {
    const res = await call('/api/approvals/stock', await as(APPROVER))
    expect(res.status).toBe(200)
    const body = await res.json() as { unmappedMintsoftLines: number; products: { available: number }[] }
    expect(body.products[0]!.available).toBe(35)
    // One Mintsoft line is not mapped to anything, which is stock the portal cannot see.
    expect(body.unmappedMintsoftLines).toBe(1)
  })

  it('is closed to a GM', async () => {
    expect((await call('/api/approvals/stock', await as(GM))).status).toBe(403)
  })
})

describe('the mapping tool', () => {
  it('lists what is left to map, for an admin', async () => {
    const body = await (await call('/api/admin/mapping/unmapped', await as(ADMIN))).json() as
      { lines: { sku: string }[] }
    expect(body.lines.map((l) => l.sku)).toEqual(['BOWL-02'])
  })

  it('suggests the duplicate that arrived after the mapping was done', async () => {
    const body = await (await call('/api/admin/mapping/suggestions', await as(ADMIN))).json() as
      { suggestions: { partiallyMapped: boolean }[] }
    expect(body.suggestions.some((s) => s.partiallyMapped)).toBe(true)
  })

  it('adds a line to an existing product, and the stock follows', async () => {
    db.exec(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id, on_hand, allocated, synced_at)
             VALUES (7002, 1, 1, 10, 0, '2026-09-21T10:00:00Z')`)
    const res = await call('/api/admin/mapping/products/1/lines', await as(ADMIN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintsoftProductIds: [7002] }),
    })
    expect(res.status).toBe(200)
    const body = await (await call('/api/sites/1/catalogue', await as(GM))).json() as
      { products: { available: number; mappedLines: number }[] }
    // 35 free from the first line plus 10 from the newly-mapped duplicate.
    expect(body.products[0]).toMatchObject({ available: 45, mappedLines: 2 })
  })

  it('explains a rejected mapping instead of returning a constraint error', async () => {
    const res = await call('/api/admin/mapping/products', await as(ADMIN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Another Bowl', stockType: 'internal',
        mintsoftProductIds: [7001], primaryMintsoftProductId: 7001,
      }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/already mapped to "Ramen Bowl"/)
  })

  it('is closed to an approver and to a GM', async () => {
    for (const user of [APPROVER, GM]) {
      expect((await call('/api/admin/mapping/unmapped', await as(user))).status).toBe(403)
    }
  })
})

describe('sync health', () => {
  it('shows an admin when each job last succeeded', async () => {
    db.exec(`INSERT INTO sync_runs (job, started_at, finished_at, status, rows_written)
             VALUES ('stock', '2026-09-21T10:00:00Z', '2026-09-21T10:00:05Z', 'ok', 120)`)
    const body = await (await call('/api/admin/sync', await as(ADMIN))).json() as
      { lastSuccess: Record<string, string>; recent: unknown[] }
    expect(body.lastSuccess.stock).toBe('2026-09-21T10:00:05Z')
    expect(body.recent).toHaveLength(1)
  })
})

describe('admin reporting and bulk edit', () => {
  it('downloads the par-level grid as CSV', async () => {
    const res = await call('/api/admin/par-levels.csv', await as(ADMIN))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/csv/)
    expect(res.headers.get('Content-Disposition')).toMatch(/par-levels\.csv/)
    expect(await res.text()).toContain('site_code,product_name,par_level')
  })

  it('applies an edited grid', async () => {
    const csv = 'site_code,product_name,par_level,max_per_order,min_days_between_orders\nM9,Ramen Bowl,48,96,14'
    const res = await call('/api/admin/par-levels', await as(ADMIN), { method: 'POST', body: csv })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: 1, problems: [] })
  })

  it('rejects a bad grid with the problems listed, writing nothing', async () => {
    const csv = 'site_code,product_name,par_level,max_per_order,min_days_between_orders\nM99,Ramen Bowl,48,,'
    const res = await call('/api/admin/par-levels', await as(ADMIN), { method: 'POST', body: csv })
    // 422: the request was fine, the contents were not.
    expect(res.status).toBe(422)
    expect((await res.json() as { problems: unknown[] }).problems).toHaveLength(1)
  })

  it('downloads the recharge report for a month', async () => {
    const res = await call('/api/admin/recharge/2026-10/csv', await as(ADMIN))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toMatch(/recharge-2026-10\.csv/)
  })

  it('refuses a month it cannot parse', async () => {
    expect((await call('/api/admin/recharge/October', await as(ADMIN))).status).toBe(400)
  })

  it('keeps all of it away from approvers and GMs', async () => {
    for (const user of [APPROVER, GM]) {
      expect((await call('/api/admin/par-levels.csv', await as(user))).status).toBe(403)
      expect((await call('/api/admin/recharge/2026-10', await as(user))).status).toBe(403)
    }
  })
})

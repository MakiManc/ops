/**
 * The portal's API.
 *
 * Phase 1 scope: sign in, sign out, "who am I", and one placeholder route per role so
 * the role gates can be proved end to end. The ordering routes arrive in Phase 3.
 *
 * The browser never talks to Mintsoft. It talks to this, and this talks to Mintsoft —
 * which is what keeps the warehouse credentials on the server and the approval rule
 * somewhere a GM cannot edit.
 */
import { Hono } from 'hono'
import { catalogueForSite, stockStatus } from './db/catalogue.ts'
import {
  addLinesToProduct, createProductFromLines, duplicateSuggestions, MappingError,
  setPrimaryLine, unmapLine, unmappedLines,
} from './db/mapping.ts'
import { readSettings, stockFreshness } from './db/settings.ts'
import { stockOverview, unmappedLineCount } from './db/stock-overview.ts'
import { lastSuccessfulSyncs } from './sync/runner.ts'
import { verifyGoogleIdToken, InvalidIdTokenError } from './auth/google.ts'
import {
  buildSessionCookie, clearSessionCookie, sessionTtlSeconds, signSession,
} from './auth/session.ts'
import {
  type AppContext, requireRole, requireSiteAccess, requireUser, withRepository,
} from './auth/middleware.ts'

export const createApp = () => {
  const app = new Hono<AppContext>().basePath('/api')

  app.use('*', withRepository)

  // ---- sign in / out -------------------------------------------------------

  /**
   * Exchanges a Google ID token for a session.
   *
   * Two checks, in this order: the token really is a current one Google issued for
   * this app, and the email is on the allow-list and active. Failing either gives the
   * same answer, so the endpoint cannot be used to find out which emails have accounts.
   */
  app.post('/auth/google', async (c) => {
    let idToken: string | undefined
    try {
      idToken = (await c.req.json<{ idToken?: string }>()).idToken
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    if (!idToken) return c.json({ error: 'bad_request' }, 400)

    let identity
    try {
      identity = await verifyGoogleIdToken(idToken, c.env.GOOGLE_CLIENT_ID)
    } catch (err) {
      if (err instanceof InvalidIdTokenError) return c.json({ error: 'sign_in_failed' }, 401)
      throw err
    }

    const user = await c.get('repo').findActiveUserByEmail(identity.email)
    // Not on the list, or switched off. Same response as a bad token, on purpose.
    if (!user) return c.json({ error: 'sign_in_failed' }, 401)

    const expiresAt = Math.floor(Date.now() / 1000) + sessionTtlSeconds
    const cookie = await signSession({ userId: user.id, expiresAt }, c.env.SESSION_SECRET)
    await c.get('repo').touchLastSeen(user.id, new Date().toISOString().replace(/\.\d+Z$/, 'Z'))

    c.header('Set-Cookie', buildSessionCookie(cookie, sessionTtlSeconds))
    return c.json({ user: { name: user.name, email: user.email, role: user.role } })
  })

  app.post('/auth/signout', (c) => {
    c.header('Set-Cookie', clearSessionCookie())
    return c.json({ ok: true })
  })

  // ---- everything below requires a signed-in, active user ------------------

  app.use('/me', requireUser)
  app.use('/sites', requireUser)
  app.use('/sites/:siteId/*', requireUser, requireSiteAccess())
  app.use('/approvals/*', requireUser, requireRole('approver'))
  app.use('/admin/*', requireUser, requireRole('admin'))

  /** What the browser uses to decide which screens to draw. */
  app.get('/me', async (c) => {
    const user = c.get('user')
    const sites = await c.get('repo').sitesVisibleTo(user)
    return c.json({
      user: { name: user.name, email: user.email, role: user.role },
      sites: sites.map((s) => ({
        id: s.id, code: s.code, name: s.name, type: s.type,
        // Only franchise sites are ever shown prices; corporate sites are never
        // recharged and never see one.
        recharge: s.recharge === 1,
      })),
    })
  })

  app.get('/sites', async (c) =>
    c.json({ sites: await c.get('repo').sitesVisibleTo(c.get('user')) }))

  // ---- catalogue (GM) ------------------------------------------------------

  app.get('/sites/:siteId/catalogue', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    const site = await c.env.DB
      .prepare(`SELECT id, code, name, recharge FROM sites WHERE id = ? AND active = 1`)
      .bind(siteId)
      .first<{ id: number; code: string; name: string; recharge: number }>()
    if (!site) return c.json({ error: 'not_found' }, 404)

    const settings = await readSettings(c.env.DB)
    const items = await catalogueForSite(c.env.DB, siteId, settings.availableFormula, {
      // Prices are a property of the site, not of who is asking.
      showPrices: site.recharge === 1,
    })

    return c.json({
      site: { id: site.id, code: site.code, name: site.name, recharge: site.recharge === 1 },
      // The banner the brief asks for: every figure is shown with its age, and stale
      // data is called stale rather than presented as current.
      freshness: await stockFreshness(c.env.DB),
      products: items.map((item) => ({ ...item, status: stockStatus(item) })),
    })
  })

  app.get('/approvals/queue', (c) => c.json({ requests: [], phase: 3 }))

  // ---- stock overview (approver) -------------------------------------------

  app.get('/approvals/stock', async (c) => {
    const settings = await readSettings(c.env.DB)
    return c.json({
      freshness: await stockFreshness(c.env.DB),
      unmappedMintsoftLines: await unmappedLineCount(c.env.DB),
      products: await stockOverview(c.env.DB, settings.availableFormula),
    })
  })

  // ---- catalogue mapping (admin) -------------------------------------------

  app.get('/admin/mapping/suggestions', async (c) =>
    c.json({ suggestions: await duplicateSuggestions(c.env.DB) }))

  app.get('/admin/mapping/unmapped', async (c) =>
    c.json({ lines: await unmappedLines(c.env.DB) }))

  app.post('/admin/mapping/products', async (c) => {
    try {
      const body = await c.req.json<{
        name: string; category?: string | null; stockType: 'internal' | 'expansion'
        packSize?: number | null; unit?: string | null; rechargeUnitPrice?: number | null
        mintsoftProductIds: number[]; primaryMintsoftProductId: number
      }>()
      const id = await createProductFromLines(c.env.DB, body)
      return c.json({ productId: id }, 201)
    } catch (err) {
      // Mapping errors are for a human to act on, so their message is the useful part.
      if (err instanceof MappingError) return c.json({ error: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad_request' }, 400)
      throw err
    }
  })

  app.post('/admin/mapping/products/:productId/lines', async (c) => {
    try {
      const { mintsoftProductIds } = await c.req.json<{ mintsoftProductIds: number[] }>()
      const added = await addLinesToProduct(c.env.DB, Number(c.req.param('productId')), mintsoftProductIds)
      return c.json({ added })
    } catch (err) {
      if (err instanceof MappingError) return c.json({ error: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad_request' }, 400)
      throw err
    }
  })

  app.post('/admin/mapping/products/:productId/primary/:mintsoftProductId', async (c) => {
    try {
      await setPrimaryLine(
        c.env.DB, Number(c.req.param('productId')), Number(c.req.param('mintsoftProductId')),
      )
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof MappingError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.delete('/admin/mapping/lines/:mintsoftProductId', async (c) => {
    try {
      await unmapLine(c.env.DB, Number(c.req.param('mintsoftProductId')))
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof MappingError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  // ---- sync health (admin) -------------------------------------------------

  app.get('/admin/sync', async (c) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT job, started_at, finished_at, status, rows_written, detail
           FROM sync_runs ORDER BY started_at DESC LIMIT 50`,
      )
      .all()
    return c.json({
      lastSuccess: await lastSuccessfulSyncs(c.env.DB),
      freshness: await stockFreshness(c.env.DB),
      recent: results ?? [],
    })
  })

  app.get('/admin/settings', async (c) => {
    const row = await c.env.DB
      .prepare(`SELECT mercium_order_fee, default_min_days_between_orders,
                       pass_order_fee_to_franchise, available_formula
                  FROM settings WHERE id = 1`)
      .first()
    return c.json({ settings: row })
  })

  app.notFound((c) => c.json({ error: 'not_found' }, 404))

  app.onError((err, c) => {
    // Never hand an internal message to the browser; it can name tables or bindings.
    console.error('Unhandled API error:', err instanceof Error ? err.message : 'unknown')
    return c.json({ error: 'server_error' }, 500)
  })

  return app
}

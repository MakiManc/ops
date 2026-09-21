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
import {
  addToBasket, approvalQueue, approveOrder, cancelOrder, eventsForOrder, linesForOrder,
  mergeRequests, openRequestForSite, OrderError, orderById, ordersForSites,
  recentOrdersForSite, rejectOrder, setLineQty, submitRequest,
} from './db/orders.ts'
import { readSettings, stockFreshness } from './db/settings.ts'
import { checkApproval, rechargeTotals, type LineToApprove, type MappedSku } from './orders/approval.ts'
import { checkBasket, type BasketLine } from './orders/basket-checks.ts'
import {
  approverEmails, requestApproved, requestRejected, requestSubmitted, sendEmail, type EmailEnv,
} from './email/send.ts'
import { stockOverview, unmappedLineCount } from './db/stock-overview.ts'
import { lastSuccessfulSyncs } from './sync/runner.ts'
import { verifyGoogleIdToken, InvalidIdTokenError } from './auth/google.ts'
import {
  buildSessionCookie, clearSessionCookie, sessionTtlSeconds, signSession,
} from './auth/session.ts'
import {
  type AppContext, currentUser, requireRole, requireSiteAccess, requireUser, withRepository,
} from './auth/middleware.ts'

export const createApp = () => {
  const app = new Hono<AppContext>().basePath('/api')

  app.use('*', withRepository)

  /**
   * Everything requires a signed-in user unless it is on this list.
   *
   * Deliberately the opposite way round from opting each route into a guard. With
   * opt-in, a route added later is public until somebody remembers to protect it, and
   * nothing fails to tell you. With opt-out, forgetting means a route returns 401 —
   * annoying, and immediately obvious.
   */
  const PUBLIC_PATHS = new Set(['/api/auth/google', '/api/auth/signout'])

  app.use('*', async (c, next) => {
    if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) return next()
    return requireUser(c, next)
  })

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

  // Role and site rules on top of that baseline.
  app.use('/sites/:siteId/*', requireSiteAccess())
  app.use('/approvals/*', requireRole('approver'))
  app.use('/admin/*', requireRole('admin'))

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

  // ---- basket and requests (GM) --------------------------------------------

  /** Everything a basket screen needs: the open request, its lines, and the checks. */
  app.get('/sites/:siteId/request', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    const settings = await readSettings(c.env.DB)
    const open = await openRequestForSite(c.env.DB, siteId)
    if (!open) return c.json({ request: null, lines: [], checks: [] })

    const site = await c.env.DB
      .prepare(`SELECT name, recharge, min_days_between_orders FROM sites WHERE id = ?`)
      .bind(siteId).first<{ name: string; recharge: number; min_days_between_orders: number | null }>()

    const lines = await linesForOrder(c.env.DB, open.id)
    const catalogue = await catalogueForSite(c.env.DB, siteId, settings.availableFormula, {
      showPrices: site?.recharge === 1,
    })

    const last = await c.env.DB
      .prepare(
        `SELECT MAX(approved_at) AS at FROM orders
          WHERE site_id = ? AND status IN ('approved', 'posted', 'despatched')`,
      ).bind(siteId).first<{ at: string | null }>()

    const basketLines: BasketLine[] = lines.map((l) => {
      const product = catalogue.find((p) => p.productId === l.productId)
      return {
        productId: l.productId, productName: l.productName, qty: l.qtyRequested,
        available: product?.available ?? null,
        parLevel: product?.parLevel ?? null,
        maxPerOrder: product?.maxPerOrder ?? null,
        qtyAlreadyInOpenRequest: null,
      }
    })

    return c.json({
      request: open,
      lines: lines.map((l) => ({
        ...l,
        available: catalogue.find((p) => p.productId === l.productId)?.available ?? null,
        rechargeUnitPrice: site?.recharge === 1
          ? catalogue.find((p) => p.productId === l.productId)?.rechargeUnitPrice ?? null
          : null,
      })),
      recharge: site?.recharge === 1,
      checks: checkBasket(basketLines, {
        siteName: site?.name ?? 'This site',
        lastOrderAt: last?.at ?? null,
        minDaysBetweenOrders: site?.min_days_between_orders ?? settings.defaultMinDaysBetweenOrders,
        earlyOrderReason: open.earlyOrderReason,
        now: new Date(),
      }),
    })
  })

  app.post('/sites/:siteId/request/lines', async (c) => {
    try {
      const siteId = Number(c.req.param('siteId'))
      const { productId, qty } = await c.req.json<{ productId: number; qty: number }>()
      const settings = await readSettings(c.env.DB)
      const catalogue = await catalogueForSite(c.env.DB, siteId, settings.availableFormula, { showPrices: false })
      const available = catalogue.find((p) => p.productId === productId)?.available ?? null
      const order = await addToBasket(c.env.DB, {
        siteId, productId, qty, actor: currentUser(c).email, availableNow: available,
      })
      return c.json({ request: order })
    } catch (err) {
      if (err instanceof OrderError) return c.json({ error: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad_request' }, 400)
      throw err
    }
  })

  app.post('/sites/:siteId/request/lines/:productId', async (c) => {
    try {
      const { qty } = await c.req.json<{ qty: number }>()
      const open = await openRequestForSite(c.env.DB, Number(c.req.param('siteId')))
      if (!open) return c.json({ error: 'no_open_request' }, 404)
      await setLineQty(c.env.DB, {
        orderId: open.id, productId: Number(c.req.param('productId')), qty, actor: currentUser(c).email,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof OrderError) return c.json({ error: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad_request' }, 400)
      throw err
    }
  })

  app.post('/sites/:siteId/request/submit', async (c) => {
    try {
      const body = await c.req.json<{
        requesterName: string; requiredDate?: string | null; notes?: string | null
        earlyOrderReason?: string | null
      }>()
      const siteId = Number(c.req.param('siteId'))
      const open = await openRequestForSite(c.env.DB, siteId)
      if (!open) return c.json({ error: 'no_open_request' }, 404)

      await submitRequest(c.env.DB, {
        orderId: open.id, requesterName: body.requesterName,
        requiredDate: body.requiredDate ?? null, notes: body.notes ?? null,
        earlyOrderReason: body.earlyOrderReason ?? null, actor: currentUser(c).email,
      })

      // Best effort: the request is submitted whether or not the email goes.
      const lines = await linesForOrder(c.env.DB, open.id)
      const to = await approverEmails(c.env.DB as never)
      const mail = requestSubmitted(c.env as EmailEnv, {
        orderNumber: open.orderNumber, siteName: open.siteName,
        requesterName: body.requesterName, lineCount: lines.length,
        earlyOrderReason: body.earlyOrderReason ?? null,
      })
      const emailed = await sendEmail(c.env as EmailEnv, { ...mail, to })

      return c.json({ ok: true, orderNumber: open.orderNumber, emailed })
    } catch (err) {
      if (err instanceof OrderError) return c.json({ error: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad_request' }, 400)
      throw err
    }
  })

  /** A GM's own orders, across the sites they cover. */
  app.get('/my-orders', async (c) => {
    const user = currentUser(c)
    const siteIds = user.role === 'gm'
      ? user.siteIds
      : (await c.get('repo').sitesVisibleTo(user)).map((s) => s.id)
    return c.json({ orders: await ordersForSites(c.env.DB, siteIds) })
  })

  app.get('/orders/:orderId', async (c) => {
    const order = await orderById(c.env.DB, Number(c.req.param('orderId')))
    if (!order) return c.json({ error: 'not_found' }, 404)
    const user = currentUser(c)
    // A GM may only read their own sites' orders.
    if (user.role === 'gm' && !user.siteIds.includes(order.siteId)) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({
      order,
      lines: await linesForOrder(c.env.DB, order.id),
      events: await eventsForOrder(c.env.DB, order.id),
    })
  })

  app.post('/orders/:orderId/cancel', async (c) => {
    try {
      const orderId = Number(c.req.param('orderId'))
      const order = await orderById(c.env.DB, orderId)
      if (!order) return c.json({ error: 'not_found' }, 404)
      const user = currentUser(c)
      if (user.role === 'gm' && !user.siteIds.includes(order.siteId)) {
        return c.json({ error: 'not_found' }, 404)
      }
      const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }))
      await cancelOrder(c.env.DB, { orderId, actor: user.email, reason: body.reason ?? null })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof OrderError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  // ---- approval queue (approver) -------------------------------------------

  app.get('/approvals/queue', async (c) => {
    const settings = await readSettings(c.env.DB)
    const queue = await approvalQueue(c.env.DB)

    const requests = await Promise.all(queue.map(async (order) => {
      const lines = await linesForOrder(c.env.DB, order.id)
      const catalogue = await catalogueForSite(c.env.DB, order.siteId, settings.availableFormula, {
        showPrices: order.recharge,
      })
      const recent = await recentOrdersForSite(c.env.DB, order.siteId, 3)

      // What other sites have asked for and not yet had signed off. Mintsoft cannot
      // see this, so the approver is the only one who can.
      const { results: otherDemand } = await c.env.DB
        .prepare(
          `SELECT ol.product_id, SUM(ol.qty_requested) AS qty
             FROM order_lines ol JOIN orders o ON o.id = ol.order_id
            WHERE o.status = 'submitted' AND o.id != ?
            GROUP BY ol.product_id`,
        ).bind(order.id).all<{ product_id: number; qty: number }>()

      const lastApproved = recent.find((r) => r.approvedAt)?.approvedAt ?? null
      return {
        order,
        lines: lines.map((l) => {
          const product = catalogue.find((p) => p.productId === l.productId)
          return {
            ...l,
            available: product?.available ?? null,
            availableBasis: product?.availableBasis ?? '',
            rechargeUnitPrice: order.recharge ? product?.rechargeUnitPrice ?? null : null,
            otherSitesPending: (otherDemand ?? []).find((d) => d.product_id === l.productId)?.qty ?? 0,
          }
        }),
        recentOrders: recent,
        daysSinceLastOrder: lastApproved
          ? Math.floor((Date.now() - new Date(lastApproved).getTime()) / 86_400_000)
          : null,
        mergeCandidates: queue
          .filter((o) => o.siteId === order.siteId && o.id !== order.id)
          .map((o) => ({ id: o.id, orderNumber: o.orderNumber })),
      }
    }))

    return c.json({ requests, settings: { merciumOrderFee: settings.merciumOrderFee } })
  })

  app.post('/approvals/:orderId/approve', async (c) => {
    try {
      const orderId = Number(c.req.param('orderId'))
      const user = currentUser(c)
      const body = await c.req.json<{ lines: { productId: number; qtyApproved: number }[] }>()

      const order = await orderById(c.env.DB, orderId)
      if (!order) return c.json({ error: 'not_found' }, 404)

      const settings = await readSettings(c.env.DB)
      const catalogue = await catalogueForSite(c.env.DB, order.siteId, settings.availableFormula, {
        showPrices: order.recharge,
      })

      const { results: skuRows } = await c.env.DB
        .prepare(
          `SELECT pmm.product_id, pmm.mintsoft_product_id, pmm.sku, pmm.is_primary,
                  SUM(sc.available) AS available, COUNT(sc.id) AS rows_seen,
                  COUNT(sc.available) AS rows_with_value
             FROM product_mintsoft_map pmm
             LEFT JOIN stock_cache sc ON sc.mintsoft_product_id = pmm.mintsoft_product_id
            GROUP BY pmm.mintsoft_product_id`,
        ).all<{
          product_id: number; mintsoft_product_id: number; sku: string; is_primary: number
          available: number | null; rows_seen: number; rows_with_value: number
        }>()

      const skusByProduct = new Map<number, MappedSku[]>()
      for (const r of skuRows ?? []) {
        const available = r.rows_seen === 0 || r.rows_with_value < r.rows_seen ? null : r.available
        skusByProduct.set(r.product_id, [
          ...(skusByProduct.get(r.product_id) ?? []),
          { mintsoftProductId: r.mintsoft_product_id, sku: r.sku, isPrimary: r.is_primary === 1, available },
        ])
      }

      const toApprove: LineToApprove[] = body.lines.map((l) => ({
        productId: l.productId,
        productName: catalogue.find((p) => p.productId === l.productId)?.name ?? 'Unknown',
        qtyApproved: l.qtyApproved,
        skus: skusByProduct.get(l.productId) ?? [],
        rechargeUnitPrice: catalogue.find((p) => p.productId === l.productId)?.rechargeUnitPrice ?? null,
      }))

      // The stock re-check the brief requires, against live figures rather than
      // whatever was on screen when the GM submitted.
      const check = checkApproval(toApprove, {
        recharge: order.recharge,
        orderFee: settings.merciumOrderFee,
        passOrderFeeToFranchise: settings.passOrderFeeToFranchise,
      })
      if (!check.ok) return c.json({ error: 'cannot_approve', problems: check.problems }, 409)

      const totals = rechargeTotals(toApprove, {
        recharge: order.recharge,
        orderFee: settings.merciumOrderFee,
        passOrderFeeToFranchise: settings.passOrderFeeToFranchise,
      })

      await approveOrder(c.env.DB, {
        orderId, actor: user.email, actorRole: user.role,
        lines: toApprove.map((l) => ({
          productId: l.productId, qtyApproved: l.qtyApproved,
          rechargeUnitPrice: l.rechargeUnitPrice,
          availableAtApproval: catalogue.find((p) => p.productId === l.productId)?.available ?? null,
        })),
        rechargeTotal: totals?.total ?? null,
        orderFee: totals?.orderFee ?? null,
      })

      // Whether the approver changed any quantity, so the email can say so.
      const requested = await linesForOrder(c.env.DB, orderId)
      const changed = body.lines.some((l) => {
        const before = requested.find((r) => r.productId === l.productId)
        return before !== undefined && before.qtyRequested !== l.qtyApproved
      })
      const mail = requestApproved(c.env as EmailEnv, {
        orderNumber: order.orderNumber, siteName: order.siteName, changed,
      })
      const { results: siteUsers } = await c.env.DB
        .prepare(
          `SELECT u.email FROM users u JOIN user_sites us ON us.user_id = u.id
            WHERE us.site_id = ? AND u.active = 1`,
        ).bind(order.siteId).all<{ email: string }>()
      const emailed = await sendEmail(c.env as EmailEnv, {
        ...mail, to: (siteUsers ?? []).map((u) => u.email),
      })

      return c.json({ ok: true, splits: check.splits, recharge: totals, emailed })
    } catch (err) {
      if (err instanceof OrderError) return c.json({ error: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad_request' }, 400)
      throw err
    }
  })

  app.post('/approvals/:orderId/reject', async (c) => {
    try {
      const orderId = Number(c.req.param('orderId'))
      const user = currentUser(c)
      const { reason } = await c.req.json<{ reason: string }>()
      const order = await orderById(c.env.DB, orderId)
      if (!order) return c.json({ error: 'not_found' }, 404)

      await rejectOrder(c.env.DB, { orderId, actor: user.email, actorRole: user.role, reason })

      const { results: siteUsers } = await c.env.DB
        .prepare(
          `SELECT u.email FROM users u JOIN user_sites us ON us.user_id = u.id
            WHERE us.site_id = ? AND u.active = 1`,
        ).bind(order.siteId).all<{ email: string }>()
      const emailed = await sendEmail(c.env as EmailEnv, {
        ...requestRejected(c.env as EmailEnv, {
          orderNumber: order.orderNumber, siteName: order.siteName, reason,
        }),
        to: (siteUsers ?? []).map((u) => u.email),
      })

      return c.json({ ok: true, emailed })
    } catch (err) {
      if (err instanceof OrderError) return c.json({ error: err.message }, 400)
      if (err instanceof SyntaxError) return c.json({ error: 'bad_request' }, 400)
      throw err
    }
  })

  app.post('/approvals/:orderId/merge/:mergeId', async (c) => {
    try {
      const user = currentUser(c)
      await mergeRequests(c.env.DB, {
        keepId: Number(c.req.param('orderId')), mergeId: Number(c.req.param('mergeId')),
        actor: user.email, actorRole: user.role,
      })
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof OrderError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

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

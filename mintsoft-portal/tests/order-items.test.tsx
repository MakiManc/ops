/**
 * @vitest-environment jsdom
 *
 * One order's own page, and the link to it.
 *
 * The lines have been on the server since Phase 3 and /api/orders/:id has always
 * returned them — no screen ever asked, so a GM taking a delivery off the van had
 * nothing to check it against. It is a page at `#order/<id>` rather than a panel inside
 * the list because the address is the point: it survives a refresh, and it can be sent
 * to whoever you are talking to about that order.
 *
 * The number that matters on a sent order is the APPROVED quantity, not the requested
 * one: that is what Mercium are picking. A line signed off at nothing is called out
 * rather than listed quietly as 0, because nothing is coming for it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MyOrders } from '../src/client/MyOrders.tsx'
import { OrderPage } from '../src/client/OrderPage.tsx'

const summary = (over: Record<string, unknown> = {}) => ({
  id: 9, orderNumber: 'MR-M19-20261002-001', siteCode: 'M19', siteName: 'Maki M19',
  status: 'posted', requesterName: 'GM', rejectedReason: null,
  submittedAt: '2026-10-02T10:00:00Z', approvedAt: '2026-10-02T11:00:00Z',
  despatchedAt: null, mintsoftOrderNumber: 'MRK-2374', mergedIntoOrderNumber: null,
  mintsoftStatusId: 1, mintsoftStatusAt: '2026-10-05T10:00:00Z',
  trackingNumber: null, trackingUrl: null,
  createdAt: '2026-10-02T09:00:00Z', recharge: false, rechargeTotal: null, ...over,
})

const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(), requiredDate: '2026-10-05', notes: null, earlyOrderReason: null, ...over,
})

/** The real combined M19 order: two lines signed off at nothing, two coming. */
const M19_LINES = [
  { productId: 37, productName: '150ML LADLE - MRK011', qtyRequested: 5, qtyApproved: 0 },
  { productId: 22, productName: 'FOH Kimono (M)No apron', qtyRequested: 6, qtyApproved: 6 },
  { productId: 48, productName: 'Ramekin', qtyRequested: 60, qtyApproved: 60 },
  { productId: 69, productName: 'Sushi Kimono (M)No apron', qtyRequested: 2, qtyApproved: 0 },
]

const servePage = (order: unknown, lines: unknown[] = M19_LINES, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(status === 200 ? { order, lines } : {}), { status }))

const serveList = (orders: unknown[]) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ orders }), { status: 200 }))

beforeEach(() => vi.restoreAllMocks())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the link from the orders list', () => {
  it('is a real link to the order\'s own address', async () => {
    serveList([summary()])
    render(<MyOrders />)
    const link = await waitFor(() => screen.getByRole('link', { name: "What's on this order" }))
    // An href, so it can be long-pressed, middle-clicked, or copied and sent to someone.
    expect(link.getAttribute('href')).toBe('#order/9')
  })

  it('opens the page in the app when plainly clicked', async () => {
    serveList([summary()])
    const onOpenOrder = vi.fn()
    render(<MyOrders onOpenOrder={onOpenOrder} />)
    const link = await waitFor(() => screen.getByRole('link', { name: "What's on this order" }))
    fireEvent.click(link)
    expect(onOpenOrder).toHaveBeenCalledWith(9)
  })

  it('leaves a modifier click to the browser, so it can be opened in a new tab', async () => {
    serveList([summary()])
    const onOpenOrder = vi.fn()
    render(<MyOrders onOpenOrder={onOpenOrder} />)
    const link = await waitFor(() => screen.getByRole('link', { name: "What's on this order" }))
    fireEvent.click(link, { metaKey: true })
    expect(onOpenOrder).not.toHaveBeenCalled()
  })

  it('is not offered before Mercium have it, while the request is still changing', async () => {
    for (const status of ['draft', 'submitted', 'approved', 'rejected', 'cancelled', 'post_failed']) {
      cleanup()
      serveList([summary({ status, mintsoftOrderNumber: null })])
      render(<MyOrders />)
      await waitFor(() => expect(screen.getByText(/MR-M19-20261002-001/)).toBeDefined())
      expect(screen.queryByRole('link', { name: "What's on this order" }), status).toBeNull()
    }
  })
})

describe('the order page', () => {
  it('leads with the number Mercium use, and names the site', async () => {
    servePage(detail())
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('MRK-2374')).toBeDefined())
    expect(screen.getByText(/M19 · Maki M19/)).toBeDefined()
    expect(screen.getByText(/ours: MR-M19-20261002-001/)).toBeDefined()
  })

  it('lists what is coming, at the quantity that was signed off', async () => {
    servePage(detail())
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('Ramekin')).toBeDefined())
    expect(screen.getByText('FOH Kimono (M)No apron')).toBeDefined()
    expect(screen.getByText(/66 items in total/)).toBeDefined()
  })

  it('says when less was approved than was asked for', async () => {
    servePage(detail(), [{ productId: 48, productName: 'Ramekin', qtyRequested: 60, qtyApproved: 24 }])
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText(/asked for 60/)).toBeDefined())
  })

  it('calls out a line signed off at nothing, rather than listing it as 0', async () => {
    servePage(detail())
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Not coming:/)).toBeDefined())
    expect(screen.getByText(/150ML LADLE - MRK011 \(asked for 5\)/)).toBeDefined()
  })

  it('shows what was asked for, not a column of zeros, before sign-off', async () => {
    servePage(detail({ status: 'submitted', approvedAt: null }),
      [{ productId: 48, productName: 'Ramekin', qtyRequested: 60, qtyApproved: null }])
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('What has been asked for')).toBeDefined())
    expect(screen.getByText('60')).toBeDefined()
    expect(screen.queryByText(/Not coming:/)).toBeNull()
  })

  it('shows the tracking number and the link', async () => {
    servePage(detail({
      status: 'despatched', trackingNumber: '15503737183118',
      trackingUrl: 'https://dpd.example/t/15503737183118',
    }))
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('15503737183118')).toBeDefined())
    expect(screen.getByRole('link', { name: 'Track this delivery' }).getAttribute('href'))
      .toBe('https://dpd.example/t/15503737183118')
  })

  it('raises a Mercium status that has stopped the order', async () => {
    servePage(detail({ mintsoftStatusId: 9 }))
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText(/On back order/)).toBeDefined())
  })

  it('says plainly when the link names an order you cannot see', async () => {
    servePage(null, [], 404)
    render(<OrderPage orderId={999} onBack={() => {}} />)
    // 404 covers "no such order" and "not your site" on purpose, so the wording covers both.
    await waitFor(() => expect(screen.getByText(/There is no order here/)).toBeDefined())
  })

  it('offers a retry rather than a dead end when it will not load', async () => {
    servePage(null, [], 500)
    render(<OrderPage orderId={9} onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeDefined())
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
  })

  it('goes back to the list', async () => {
    servePage(detail())
    const onBack = vi.fn()
    render(<OrderPage orderId={9} onBack={onBack} />)
    const back = await waitFor(() => screen.getByRole('button', { name: 'Back to the orders list' }))
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalled()
  })
})

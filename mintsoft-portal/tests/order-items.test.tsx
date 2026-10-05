/**
 * @vitest-environment jsdom
 *
 * What is on an order that has gone to Mercium.
 *
 * The lines have been on the server since Phase 3 and /api/orders/:id has always
 * returned them — no screen ever asked. So a GM taking a delivery in off the van had no
 * way to check it against what was actually sent.
 *
 * The number that matters on a sent order is the APPROVED quantity, not the requested
 * one: that is what Mercium are picking. A line signed off at nothing is called out
 * rather than listed quietly as 0, because nothing is coming for it and a GM counting
 * boxes needs to know before they ring anyone.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MyOrders } from '../src/client/MyOrders.tsx'

const order = (over: Record<string, unknown> = {}) => ({
  id: 9, orderNumber: 'MR-M19-20261002-001', siteCode: 'M19', siteName: 'Maki M19',
  status: 'posted', requesterName: 'GM', rejectedReason: null,
  submittedAt: '2026-10-02T10:00:00Z', approvedAt: '2026-10-02T11:00:00Z',
  despatchedAt: null, mintsoftOrderNumber: 'MRK-2374', mergedIntoOrderNumber: null,
  mintsoftStatusId: 1, mintsoftStatusAt: '2026-10-05T10:00:00Z',
  trackingNumber: null, trackingUrl: null,
  createdAt: '2026-10-02T09:00:00Z', recharge: false, rechargeTotal: null, ...over,
})

/** The real combined M19 order: two lines signed off at nothing, two coming. */
const M19_LINES = [
  { productId: 37, productName: '150ML LADLE - MRK011', qtyRequested: 5, qtyApproved: 0 },
  { productId: 22, productName: 'FOH Kimono (M)No apron', qtyRequested: 6, qtyApproved: 6 },
  { productId: 48, productName: 'Ramekin', qtyRequested: 60, qtyApproved: 60 },
  { productId: 69, productName: 'Sushi Kimono (M)No apron', qtyRequested: 2, qtyApproved: 0 },
]

function serve(orders: unknown[], lines: unknown[] = M19_LINES, lineStatus = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('/api/orders/')) {
      return new Response(JSON.stringify({ lines }), { status: lineStatus })
    }
    return new Response(JSON.stringify({ orders }), { status: 200 })
  })
}

const open = async () => {
  const btn = await waitFor(() => screen.getByRole('button', { name: "What's on this order" }))
  fireEvent.click(btn)
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('an order Mercium have', () => {
  it('offers the items', async () => {
    serve([order()])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByRole('button', { name: "What's on this order" })).toBeDefined())
  })

  it('lists what is coming, at the quantity that was signed off', async () => {
    serve([order()])
    render(<MyOrders />)
    await open()
    await waitFor(() => expect(screen.getByText('Ramekin')).toBeDefined())
    expect(screen.getByText('FOH Kimono (M)No apron')).toBeDefined()
    expect(screen.getByText(/66 items in total/)).toBeDefined()
  })

  it('says when less was approved than was asked for', async () => {
    serve([order()], [{ productId: 48, productName: 'Ramekin', qtyRequested: 60, qtyApproved: 24 }])
    render(<MyOrders />)
    await open()
    await waitFor(() => expect(screen.getByText(/asked for 60/)).toBeDefined())
  })

  it('calls out a line signed off at nothing, rather than listing it as 0', async () => {
    serve([order()])
    render(<MyOrders />)
    await open()
    await waitFor(() => expect(screen.getByText(/Not coming:/)).toBeDefined())
    expect(screen.getByText(/150ML LADLE - MRK011 \(asked for 5\)/)).toBeDefined()
    expect(screen.getByText(/Sushi Kimono \(M\)No apron \(asked for 2\)/)).toBeDefined()
  })

  it('closes again, and says so while it is open', async () => {
    serve([order()])
    render(<MyOrders />)
    await open()
    const close = await waitFor(() => screen.getByRole('button', { name: 'Hide the items' }))
    expect(close.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(close)
    await waitFor(() => expect(screen.getByRole('button', { name: "What's on this order" })).toBeDefined())
  })

  it('is offered on a despatched order too, which is when boxes get counted', async () => {
    serve([order({ status: 'despatched', despatchedAt: '2026-10-06T08:00:00Z', mintsoftStatusId: 4 })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByRole('button', { name: "What's on this order" })).toBeDefined())
  })

  it('says so rather than sitting on a spinner when the items will not load', async () => {
    serve([order()], [], 500)
    render(<MyOrders />)
    await open()
    await waitFor(() => expect(screen.getByText(/Could not load what is on this order/)).toBeDefined())
  })
})

describe('a request Mercium do not have', () => {
  it('is not offered the items, because it is still being changed', async () => {
    for (const status of ['draft', 'submitted', 'approved', 'rejected', 'cancelled', 'post_failed']) {
      cleanup()
      serve([order({ status, mintsoftOrderNumber: null })])
      render(<MyOrders />)
      await waitFor(() => expect(screen.getByText(/MR-M19-20261002-001|MRK-2374/)).toBeDefined())
      expect(screen.queryByRole('button', { name: "What's on this order" }), status).toBeNull()
    }
  })
})

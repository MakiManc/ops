/**
 * @vitest-environment jsdom
 *
 * The offer to combine two signed-off orders.
 *
 * Mercium charges and delivers per order, so a site with two waiting is money going out
 * twice. The card has to say that, name which order survives, and not appear at all when
 * there is nothing to combine.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalQueue } from '../src/client/ApprovalQueue.tsx'

const order = (id: number, orderNumber: string) => ({
  id, orderNumber, siteCode: 'M19', siteName: 'Maki Nineteen', requesterName: 'GM',
  approvedAt: '2026-10-02T11:00:00Z', postError: null, mintsoftOrderNumber: null,
  mergedIntoOrderNumber: null,
})

/** A fresh Response per call: the screen fetches the queue and the awaiting list. */
function serve(doubledUp: unknown[], posts: string[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      posts.push(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (url.includes('awaiting-send')) {
      return new Response(JSON.stringify({
        orders: [order(1, 'MR-M19-20261002-001'), order(2, 'MR-M19-20261002-002')],
        doubledUp,
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ requests: [] }), { status: 200 })
  })
  return posts
}

const SITE = {
  siteId: 1, siteCode: 'M19', siteName: 'Maki Nineteen',
  orders: [
    { id: 1, orderNumber: 'MR-M19-20261002-001' },
    { id: 2, orderNumber: 'MR-M19-20261002-002' },
  ],
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a site with two orders waiting', () => {
  it('is raised, with the count', async () => {
    serve([SITE])
    render(<ApprovalQueue />)
    await waitFor(() =>
      expect(screen.getByText(/M19 · Maki Nineteen has 2 orders waiting/)).toBeDefined())
  })

  it('says why it costs money, which is the whole reason to combine', async () => {
    serve([SITE])
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByText(/fee per order and delivers per order/)).toBeDefined())
  })

  it('names the order that survives and the one that closes', async () => {
    serve([SITE])
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByText('MR-M19-20261002-001')).toBeDefined())
    expect(screen.getByText(/closes MR-M19-20261002-002/)).toBeDefined()
  })

  it('folds the others into the oldest when pressed', async () => {
    const posts = serve([SITE])
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Combine into one order' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Combine into one order' }))
    await waitFor(() => expect(posts).toContain('/api/approvals/1/merge-approved/2'))
  })

  it('shows the server\'s reason rather than a status code when it refuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          error: 'MR-M19-20261002-002 was sent and we did not hear back, so it may already be with Mercium.',
        }), { status: 400 })
      }
      if (url.includes('awaiting-send')) {
        return new Response(JSON.stringify({ orders: [], doubledUp: [SITE] }), { status: 200 })
      }
      return new Response(JSON.stringify({ requests: [] }), { status: 200 })
    })
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Combine into one order' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Combine into one order' }))
    await waitFor(() => expect(screen.getByText(/may already be with Mercium/)).toBeDefined())
  })
})

describe('a site with one order waiting', () => {
  it('is not offered anything, because there is nothing to combine', async () => {
    serve([])
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByText(/Signed off, not yet sent/)).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Combine into one order' })).toBeNull()
    expect(screen.queryByText(/more than one order waiting/)).toBeNull()
  })

  it('still works against a server that does not send the grouping at all', async () => {
    // An older deploy, or a half-rolled-out one. The send half must not disappear.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('awaiting-send')) {
        return new Response(JSON.stringify({ orders: [order(1, 'MR-M19-20261002-001')] }), { status: 200 })
      }
      return new Response(JSON.stringify({ requests: [] }), { status: 200 })
    })
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByText(/Signed off, not yet sent/)).toBeDefined())
    expect(screen.queryByText(/more than one order waiting/)).toBeNull()
  })
})

describe('what a GM is told about the request that was absorbed', () => {
  const gmOrder = (over: Record<string, unknown>) => ({
    id: 2, orderNumber: 'MR-M19-20261002-002', siteCode: 'M19',
    status: 'cancelled', requesterName: 'GM', rejectedReason: null,
    submittedAt: '2026-10-02T10:00:00Z', approvedAt: '2026-10-02T11:00:00Z',
    despatchedAt: null, mintsoftOrderNumber: null, trackingUrl: null,
    createdAt: '2026-10-02T09:00:00Z', recharge: false, rechargeTotal: null,
    mergedIntoOrderNumber: null, ...over,
  })

  const serveOrders = (orders: unknown[]) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ orders }), { status: 200 }))

  it('is told it was combined, not that it was cancelled', async () => {
    serveOrders([gmOrder({ mergedIntoOrderNumber: 'MR-M19-20261002-001' })])
    const { MyOrders } = await import('../src/client/MyOrders.tsx')
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Combined')).toBeDefined())
    expect(screen.getByText(/moved onto MR-M19-20261002-001/)).toBeDefined()
    expect(screen.queryByText('This request was cancelled.')).toBeNull()
  })

  it('is not offered "order the same again", which would order it twice', async () => {
    serveOrders([gmOrder({ mergedIntoOrderNumber: 'MR-M19-20261002-001' })])
    const { MyOrders } = await import('../src/client/MyOrders.tsx')
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Combined')).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Order the same again' })).toBeNull()
  })

  it('still gets it on a request they cancelled themselves', async () => {
    serveOrders([gmOrder({ mergedIntoOrderNumber: null })])
    const { MyOrders } = await import('../src/client/MyOrders.tsx')
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Cancelled')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Order the same again' })).toBeDefined()
  })
})

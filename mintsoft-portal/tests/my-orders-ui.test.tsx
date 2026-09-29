/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MyOrders } from '../src/client/MyOrders.tsx'

const order = (over: Record<string, unknown> = {}) => ({
  id: 1, orderNumber: 'MR-M9-20260921-001', siteCode: 'M9', siteName: 'Leith Walk', status: 'submitted',
  requesterName: 'Alex', rejectedReason: null, submittedAt: new Date().toISOString(),
  approvedAt: null, despatchedAt: null, trackingUrl: null, mintsoftOrderNumber: null,
  createdAt: new Date().toISOString(), recharge: false, rechargeTotal: null, ...over,
})

function serve(orders: unknown[]) {
  const posts: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'POST') {
      posts.push(String(input))
      return new Response(JSON.stringify({ ok: true, added: 2 }), { status: 200 })
    }
    return new Response(JSON.stringify({ orders }), { status: 200 })
  })
  return posts
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('after sending', () => {
  it('says the request went, and names it', async () => {
    // The most consequential action in the app used to end in silence, and silence
    // mid-service reads as "it did not work" — so people pressed Send again.
    serve([order()])
    render(<MyOrders justSent="MR-M9-20260921-001" />)
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/MR-M9-20260921-001 has been sent for sign-off/))
  })
})

describe('every card', () => {
  it('names the site, because logins are shared and requester is free text', async () => {
    serve([order({ siteCode: 'M3', siteName: 'Fountainbridge' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('M3')).toBeDefined())
    expect(screen.getByText(/Fountainbridge/)).toBeDefined()
  })

  it('offers a site filter only when there is more than one site to filter', async () => {
    serve([order({ id: 1, siteCode: 'M9' }), order({ id: 2, siteCode: 'M3', siteName: 'Fountainbridge' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByLabelText('Show')).toBeDefined())
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'M3' } })
    expect(screen.queryByText('M9')).toBeNull()
  })
})

describe('cancelling', () => {
  it('is offered while the request has not reached the warehouse, and asks first', async () => {
    const posts = serve([order({ status: 'submitted' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Cancel this request')).toBeDefined())
    fireEvent.click(screen.getByText('Cancel this request'))
    expect(posts).toHaveLength(0)
    expect(screen.getByText(/It will not be sent to the warehouse/)).toBeDefined()
    fireEvent.click(screen.getByText('Yes, cancel it'))
    await waitFor(() => expect(posts).toEqual(['/api/orders/1/cancel']))
  })

  it('is not offered once it has gone to the warehouse', async () => {
    serve([order({ status: 'posted' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Sent to warehouse')).toBeDefined())
    expect(screen.queryByText('Cancel this request')).toBeNull()
  })
})

describe('ordering the same again', () => {
  it('confirms in the card it belongs to, naming the site it filled', async () => {
    serve([order({ status: 'despatched', siteCode: 'M3', siteName: 'Fountainbridge' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Order the same again')).toBeDefined())
    fireEvent.click(screen.getByText('Order the same again'))
    await waitFor(() => expect(screen.getByText(/Added 2 items to M3's current request/)).toBeDefined())
  })
})

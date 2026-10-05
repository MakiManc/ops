/**
 * @vitest-environment jsdom
 *
 * The consignment number on the orders page.
 *
 * The despatch sync has always written tracking_number, and it was never selected into
 * the payload — so the only thing a GM got was a "Track this delivery" button. That is
 * no use in the moment the number is actually wanted, which is on the phone to the
 * courier reading it out; and on a Van or Manual courier service there is no link to
 * click at all. Two of the three services this account ships on are those, so a number
 * with no link is the normal case rather than the odd one.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MyOrders } from '../src/client/MyOrders.tsx'

const order = (over: Record<string, unknown> = {}) => ({
  id: 1, orderNumber: 'MR-M19-20261002-001', siteCode: 'M19', siteName: 'Maki M19',
  status: 'despatched', requesterName: 'GM', rejectedReason: null,
  submittedAt: '2026-10-02T10:00:00Z', approvedAt: '2026-10-02T11:00:00Z',
  despatchedAt: '2026-10-06T08:00:00Z', mintsoftOrderNumber: 'MRK-8811',
  mergedIntoOrderNumber: null, mintsoftStatusId: null, mintsoftStatusAt: null,
  trackingNumber: null, trackingUrl: null,
  createdAt: '2026-10-02T09:00:00Z', recharge: false, rechargeTotal: null, ...over,
})

const serve = (orders: unknown[]) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ orders }), { status: 200 }))

beforeEach(() => vi.restoreAllMocks())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a despatched order', () => {
  it('shows the tracking number, labelled', async () => {
    serve([order({ trackingNumber: 'DPD1234567890', trackingUrl: 'https://dpd.example/t/DPD1234567890' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('DPD1234567890')).toBeDefined())
    expect(screen.getByText(/Tracking number/)).toBeDefined()
  })

  it('shows the number even with no link to click, which is the Van and Manual case', async () => {
    serve([order({ trackingNumber: 'VAN-00042', trackingUrl: null })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('VAN-00042')).toBeDefined())
    // No link, and that is not a fault: those services have nothing to link to.
    expect(screen.queryByRole('link', { name: 'Track this delivery' })).toBeNull()
  })

  it('still offers the link when there is one', async () => {
    serve([order({ trackingNumber: 'DPD1234567890', trackingUrl: 'https://dpd.example/t/DPD1234567890' })])
    render(<MyOrders />)
    const link = await waitFor(() => screen.getByRole('link', { name: 'Track this delivery' }))
    expect(link.getAttribute('href')).toBe('https://dpd.example/t/DPD1234567890')
  })

  it('makes the number selectable in one go, for reading out or pasting', async () => {
    serve([order({ trackingNumber: 'DPD1234567890' })])
    render(<MyOrders />)
    const el = await waitFor(() => screen.getByText('DPD1234567890'))
    // select-all so a tap selects the whole number, and a monospace face so 0 and O,
    // 1 and l are not read out wrong over the phone.
    expect(el.className).toContain('select-all')
    expect(el.className).toContain('font-mono')
  })

  it('says nothing about tracking before the courier has given a number', async () => {
    serve([order({ status: 'posted', despatchedAt: null, trackingNumber: null, trackingUrl: null })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Sent to warehouse')).toBeDefined())
    expect(screen.queryByText(/Tracking number/)).toBeNull()
  })

  it('shows a number that arrives before the despatch date does', async () => {
    // The sync writes tracking ahead of despatch when the courier supplies it early.
    serve([order({ status: 'posted', despatchedAt: null, trackingNumber: 'DPD999' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('DPD999')).toBeDefined())
  })
})

/**
 * What Mercium says, when it is not what we are saying.
 *
 * The portal has one word for every order at the warehouse: "Sent to warehouse — Mercium
 * have it and are picking it". On 5 October that sentence was on screen for an order
 * Mercium had CANCELLED and another they had put ON BACK ORDER, and for seven more that
 * had not been touched since the 2nd. Their status is theirs, so it is shown beside ours
 * rather than replacing it — but only when it means the order has stopped.
 */
describe('a Mercium status that has stopped the order', () => {
  it('is raised, in their words', async () => {
    serve([order({ status: 'posted', despatchedAt: null, mintsoftStatusId: 3 })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText(/Mercium have this as/)).toBeDefined())
    expect(screen.getByText(/Cancelled/)).toBeDefined()
  })

  it('says it disagrees with the portal, because theirs is the one that ships', async () => {
    serve([order({ status: 'posted', despatchedAt: null, mintsoftStatusId: 9 })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText(/On back order/)).toBeDefined())
    expect(screen.getByText(/not the same as what the portal says/)).toBeDefined()
  })

  it('stays quiet for a status that just means it is on its way', async () => {
    // New, Picked, Packed and the rest. Raising every one trains people to ignore the
    // line that matters.
    for (const id of [1, 2, 4, 15, 16, 17, 20, 22]) {
      cleanup()
      serve([order({ status: 'posted', despatchedAt: null, mintsoftStatusId: id })])
      render(<MyOrders />)
      await waitFor(() => expect(screen.getByText('Sent to warehouse')).toBeDefined())
      expect(screen.queryByText(/Mercium have this as/), `status ${id}`).toBeNull()
    }
  })

  it('stays quiet when Mercium has not been read yet', async () => {
    serve([order({ status: 'posted', despatchedAt: null, mintsoftStatusId: null })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Sent to warehouse')).toBeDefined())
    expect(screen.queryByText(/Mercium have this as/)).toBeNull()
  })

  it('says when it was last read, so a stale answer is not mistaken for a fresh one', async () => {
    serve([order({ status: 'posted', despatchedAt: null, mintsoftStatusId: 3, mintsoftStatusAt: '2026-10-05T10:00:00Z' })])
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText(/Read from Mercium/)).toBeDefined())
  })
})

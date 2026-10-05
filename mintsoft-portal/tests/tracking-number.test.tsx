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
  mergedIntoOrderNumber: null, trackingNumber: null, trackingUrl: null,
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

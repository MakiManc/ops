/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MyOrders } from '../src/client/MyOrders.tsx'
import { Basket } from '../src/client/Basket.tsx'
import { ApprovalQueue } from '../src/client/ApprovalQueue.tsx'

const order = (over: Record<string, unknown> = {}) => ({
  id: 1, orderNumber: 'MR-M9-20260921-001', siteCode: 'M9', status: 'submitted',
  requesterName: 'Alex', rejectedReason: null, submittedAt: new Date().toISOString(),
  approvedAt: null, despatchedAt: null, trackingUrl: null,
  createdAt: new Date().toISOString(), recharge: false, rechargeTotal: null, ...over,
})

// A fresh Response per call, and the awaiting-send list answered separately. One shared
// Response only works while a screen makes exactly one fetch: a body can be read once.
const serve = (body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('awaiting-send')) {
      return new Response(JSON.stringify({ orders: [] }), { status: 200 })
    }
    return new Response(JSON.stringify(body), { status: 200 })
  })

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('the order timeline', () => {
  it('speaks plainly rather than in system states', async () => {
    serve({ orders: [order({ status: 'posted' })] })
    render(<MyOrders />)
    // A GM does not need to know what "posted" means.
    await waitFor(() => expect(screen.getByText('Sent to warehouse')).toBeDefined())
    expect(screen.getByText(/Mercium have it and are picking it/)).toBeDefined()
  })

  it('never offers a delivered step, because Mintsoft cannot tell us', async () => {
    serve({ orders: [order({ status: 'despatched' })] })
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('On its way')).toBeDefined())
    // The order record carries no delivery confirmation, so the portal does not claim one.
    expect(screen.queryByText(/Delivered/i)).toBeNull()
  })

  it('shows the reason when a request is sent back', async () => {
    serve({ orders: [order({ status: 'rejected', rejectedReason: 'Ordered last week already' })] })
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Ordered last week already')).toBeDefined())
  })

  it('says something is stuck rather than pretending it is fine', async () => {
    serve({ orders: [order({ status: 'post_failed' })] })
    render(<MyOrders />)
    await waitFor(() => expect(screen.getByText('Stuck')).toBeDefined())
    expect(screen.getByText(/could not reach the warehouse/)).toBeDefined()
  })

  it('offers a tracking link once there is one', async () => {
    serve({ orders: [order({ status: 'despatched', trackingUrl: 'https://courier.example/track/1' })] })
    render(<MyOrders />)
    await waitFor(() => {
      const link = screen.getByText('Track this delivery') as HTMLAnchorElement
      expect(link.getAttribute('href')).toBe('https://courier.example/track/1')
    })
  })
})

describe('the basket', () => {
  const basket = (over: Record<string, unknown> = {}) => ({
    request: { id: 1, orderNumber: 'MR-M9-20260921-001', earlyOrderReason: null },
    lines: [{ productId: 1, productName: 'Ramen Bowl', qtyRequested: 24, available: 100, rechargeUnitPrice: null }],
    recharge: false,
    checks: [],
    ...over,
  })

  it('tells a franchise GM the order will be recharged, and totals the lines', async () => {
    serve(basket({
      recharge: true,
      lines: [
        { productId: 1, productName: 'Ramen Bowl', qtyRequested: 10, available: 100, rechargeUnitPrice: 2.5 },
        { productId: 2, productName: 'Chopsticks', qtyRequested: 4, available: 100, rechargeUnitPrice: 1.25 },
      ],
    }))
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText(/will be recharged to your site/)).toBeDefined())
    // 10 x 2.50 plus 4 x 1.25 — the total, not either line on its own.
    expect(screen.getByText(/Total so far: £30\.00/)).toBeDefined()
  })

  it('says when a franchise line has no price rather than showing a blank', async () => {
    serve(basket({
      recharge: true,
      lines: [{ productId: 1, productName: 'Ramen Bowl', qtyRequested: 10, available: 100, rechargeUnitPrice: null }],
    }))
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText(/— each/)).toBeDefined())
  })

  it('shows no prices at all at a corporate site', async () => {
    serve(basket())
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    expect(screen.queryByText(/£/)).toBeNull()
    expect(screen.queryByText(/recharged/i)).toBeNull()
  })

  it('shows a blocking check against the line it belongs to', async () => {
    serve(basket({
      checks: [{ code: 'over_available', severity: 'blocks', productId: 1, message: 'Only 5 available — you have asked for 24.' }],
    }))
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Only 5 available/)).toBeDefined())
    expect(screen.getByText(/Fix the problems above/)).toBeDefined()
  })

  it('asks why when ordering inside the usual gap, and says why it is asking', async () => {
    serve(basket({
      checks: [{ code: 'too_soon', severity: 'needs_reason', message: 'M9 ordered 3 days ago…' }],
    }))
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Why this cannot wait')).toBeDefined())
    // The reason for the rule, in the GM's terms.
    expect(screen.getByText(/Every order costs a delivery fee/)).toBeDefined()
  })

  it('asks for a name, because site logins are shared', async () => {
    serve(basket())
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText(/Your name/)).toBeDefined())
    expect(screen.getByText(/So the approver knows who to come back to/)).toBeDefined()
  })

  it('says plainly when there is nothing in the request', async () => {
    serve({ request: null, lines: [], recharge: false, checks: [] })
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Nothing in this request yet/)).toBeDefined())
  })
})

/**
 * The approve box used to pre-fill with the quantity asked for, whatever the stock said.
 * The server re-checks and refuses to approve more than is free, so on any short line
 * the default action failed: press Approve, get "12 approved but only 0 in stock".
 */
describe('the approval queue', () => {
  const queueItem = (lines: Record<string, unknown>[]) => ({
    requests: [{
      order: order({ status: 'submitted', siteName: 'Maki & Ramen Leith Walk' }),
      lines, recentOrders: [], mergeCandidates: [],
    }],
    settings: { merciumOrderFee: 0, passOrderFeeToFranchise: false },
  })
  const line = (over: Record<string, unknown> = {}) => ({
    id: 1, productId: 1, productName: 'Chairs', qtyRequested: 12, qtyApproved: null,
    available: 0, availableBasis: '0 free to order.', rechargeUnitPrice: null,
    availableAtRequest: 0, ...over,
  })

  it('offers only what is actually free, so the default action succeeds', async () => {
    serve(queueItem([line({ qtyRequested: 12, available: 0 })]))
    render(<ApprovalQueue />)
    const box = await screen.findByRole('spinbutton') as HTMLInputElement
    expect(box.value).toBe('0')
    // The ask is still on screen, so nothing is hidden from the approver.
    expect(screen.getByText(/of 12 asked for/)).toBeTruthy()
  })

  it('offers the full amount when there is enough', async () => {
    serve(queueItem([line({ qtyRequested: 6, available: 40 })]))
    render(<ApprovalQueue />)
    expect((await screen.findByRole('spinbutton') as HTMLInputElement).value).toBe('6')
  })

  it('caps at what is free when there is some but not enough', async () => {
    serve(queueItem([line({ qtyRequested: 24, available: 13 })]))
    render(<ApprovalQueue />)
    expect((await screen.findByRole('spinbutton') as HTMLInputElement).value).toBe('13')
  })

  it('leaves an unknown line at the requested amount rather than zeroing it', async () => {
    // A missing Mintsoft record is not evidence there is none. Silently zeroing the
    // line would drop it from the order without anyone deciding to.
    serve(queueItem([line({ qtyRequested: 9, available: null })]))
    render(<ApprovalQueue />)
    expect((await screen.findByRole('spinbutton') as HTMLInputElement).value).toBe('9')
  })
})

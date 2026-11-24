/**
 * @vitest-environment jsdom
 *
 * Telling the two warehouses apart on the catalogue.
 *
 * Eight of the products now held outside Mercium carry names that are near-twins of
 * Mercium lines — "Cup" beside "Blue Cups Round", "Tea pot" beside "CAST IRON TEA POT
 * (900ML)", "Ramen bowl (ceramic)" beside "Ramen Bowl Vegan". They are genuinely separate
 * stock in a separate building, which is why they exist twice, and an order cannot mix the
 * two because they ship separately.
 *
 * That puts a real weight on this screen. A GM who cannot tell which "Cup" they are
 * tapping will order from the wrong building, and the only thing that stops them finding
 * out late is what the catalogue shows BEFORE the tap. So: every card says which store it
 * is from, the warehouse filter lets a GM work inside one of them, and an open request
 * that already has a route says so.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Catalogue } from '../src/client/Catalogue.tsx'

const product = (over: Record<string, unknown> = {}) => ({
  productId: 1, name: 'Blue Cups Round- MRK005', category: 'Tableware',
  packSize: null, unit: 'Case', imageUrl: null,
  available: 40, availableBasis: 'From 1 Mintsoft line.', status: 'in_stock',
  stockSyncedAt: '2026-11-24T09:00:00Z', parLevel: null,
  inboundQty: null, inboundExpected: null, rechargeUnitPrice: null, mappedLines: 1,
  supplyRoute: 'mercium', qtyInRequest: 0, ...over,
})

const MERCIUM = product({ productId: 1, name: 'Blue Cups Round- MRK005' })
const OTHER = product({
  productId: 2, name: 'Cup', supplyRoute: 'email',
  available: null, status: 'not_tracked',
  availableBasis: 'Held outside Mercium, where stock is not tracked — order it and the team there will confirm.',
  stockSyncedAt: null, mappedLines: 0,
})

/** Serves the catalogue and the open-request endpoints the screen calls. */
const serve = ({ products, lines = [] }: { products: unknown[]; lines?: unknown[] }) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input)
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    if (url.includes('/catalogue')) {
      return json({
        site: { id: 1, code: 'M9', name: 'Leith Walk', recharge: false },
        freshness: { stock: { at: '2026-11-24T09:00:00Z', stale: false } },
        products,
      })
    }
    if (url.includes('/request')) return json({ lines })
    return json({})
  })

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the warehouse filter', () => {
  it('shows only the other store’s items when asked', async () => {
    serve({ products: [MERCIUM, OTHER] })
    render(<Catalogue siteId={1} />)

    // Both to begin with.
    await waitFor(() => expect(screen.getByText('Cup')).toBeTruthy())
    expect(screen.getByText('Blue Cups Round- MRK005')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /other store/i }))

    // The near-twin is gone, which is the whole point: a GM working the other store's
    // list cannot tap a Mercium product by mistake.
    await waitFor(() => expect(screen.queryByText('Blue Cups Round- MRK005')).toBeNull())
    expect(screen.getByText('Cup')).toBeTruthy()
  })

  it('shows only Mercium items when asked, so the filter works both ways', async () => {
    serve({ products: [MERCIUM, OTHER] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Cup')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^mercium/i }))

    await waitFor(() => expect(screen.queryByText('Cup')).toBeNull())
    expect(screen.getByText('Blue Cups Round- MRK005')).toBeTruthy()
  })

  it('counts what is behind each button, so a filter is never a surprise', async () => {
    serve({ products: [MERCIUM, OTHER, product({ productId: 3, name: 'Ramekin' })] })
    render(<Catalogue siteId={1} />)

    // 2 Mercium, 1 other. A count that did not match would send a GM looking for items
    // the filter had quietly dropped.
    await waitFor(() => expect(screen.getByRole('button', { name: /other store 1/i })).toBeTruthy())
    expect(screen.getByRole('button', { name: /mercium 2/i })).toBeTruthy()
  })

  it('keeps the filtered count honest in the products line', async () => {
    serve({ products: [MERCIUM, OTHER] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('2 products')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /other store/i }))

    // "1 of 2", never a bare "1" — a short list must not read as a small catalogue.
    await waitFor(() => expect(screen.getByText('1 of 2 products')).toBeTruthy())
  })

  it('is cleared by Show everything along with the other filters', async () => {
    serve({ products: [MERCIUM, OTHER] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Cup')).toBeTruthy())

    // Filter to a route, then search for something that matches nothing in it.
    fireEvent.click(screen.getByRole('button', { name: /other store/i }))
    fireEvent.change(screen.getByLabelText(/search products/i), { target: { value: 'zzzz' } })
    await waitFor(() => expect(screen.getByText(/Nothing matches that search/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /show everything/i }))

    // Both back. A reset that left the warehouse filter on would leave a GM staring at a
    // list they had just asked to be shown in full.
    await waitFor(() => expect(screen.getByText('Blue Cups Round- MRK005')).toBeTruthy())
    expect(screen.getByText('Cup')).toBeTruthy()
  })
})

describe('an open request that already has a warehouse', () => {
  it('says which one, before a GM adds something that cannot go on it', async () => {
    // Two Mercium lines already in the draft.
    serve({ products: [MERCIUM, OTHER], lines: [{ productId: 1, qtyRequested: 3 }] })
    render(<Catalogue siteId={1} />)

    // The server would refuse the mix, but only after the tap. Saying it here is the
    // difference between a rule and a bug.
    await waitFor(() => expect(screen.getByText(/this request is for Mercium stock/i)).toBeTruthy())
  })

  it('says so the other way round too', async () => {
    serve({ products: [MERCIUM, OTHER], lines: [{ productId: 2, qtyRequested: 1 }] })
    render(<Catalogue siteId={1} />)

    await waitFor(() => expect(screen.getByText(/this request is for other-store stock/i)).toBeTruthy())
  })

  it('says nothing when the request is empty, because nothing is ruled out yet', async () => {
    serve({ products: [MERCIUM, OTHER], lines: [] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Cup')).toBeTruthy())

    expect(screen.queryByText(/this request is for/i)).toBeNull()
  })
})

describe('every card', () => {
  it('names the store an other-store item comes from', async () => {
    serve({ products: [OTHER] })
    render(<Catalogue siteId={1} />)

    await waitFor(() => expect(screen.getByText('Other store')).toBeTruthy())
    // And does not offer a stock figure it does not have.
    expect(screen.getByText(/Stock level not tracked/)).toBeTruthy()
  })

  it('leaves a Mercium card saying what it always said', async () => {
    serve({ products: [MERCIUM] })
    render(<Catalogue siteId={1} />)

    await waitFor(() => expect(screen.getByText('In stock')).toBeTruthy())
    expect(screen.queryByText('Other store')).toBeNull()
  })
})

/**
 * The basket, which is the screen a GM reads before committing.
 *
 * A line here used to be a name and a stock figure. For other-store stock the figure is
 * an em dash — there is none to have — and a name alone cannot be checked when "Cup"
 * exists in both warehouses. Both are fixed by saying which store the line is from.
 */
describe('the basket', () => {
  const serveBasket = (lines: unknown[]) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
      if (url.includes('/request')) {
        return json({
          request: { id: 7, orderNumber: 'MR-M9-20261124-001', earlyOrderReason: null, status: 'draft' },
          lines, recharge: false, checks: [],
        })
      }
      return json({})
    })

  it('says which store each line is from, and offers no figure it has not got', async () => {
    const { Basket } = await import('../src/client/Basket.tsx')
    serveBasket([
      { productId: 2, productName: 'Cup', qtyRequested: 4, available: null, rechargeUnitPrice: null, supplyRoute: 'email' },
    ])
    render(<Basket siteId={1} onSubmitted={() => {}} />)

    await waitFor(() => expect(screen.getByText('Cup')).toBeTruthy())
    expect(screen.getByText('Other store')).toBeTruthy()
    // "— available" was the old rendering, and it reads as a reading we failed to get.
    expect(screen.queryByText(/— available/)).toBeNull()
  })

  it('sets the delivery expectation before the GM commits', async () => {
    const { Basket } = await import('../src/client/Basket.tsx')
    serveBasket([
      { productId: 2, productName: 'Cup', qtyRequested: 4, available: null, rechargeUnitPrice: null, supplyRoute: 'email' },
    ])
    render(<Basket siteId={1} onSubmitted={() => {}} />)

    // No Mintsoft order means no tracking number, and My orders would otherwise be where
    // a GM discovered that.
    await waitFor(() => expect(screen.getByText(/no tracking number for this one/i)).toBeTruthy())
  })

  it('leaves a Mercium basket exactly as it was', async () => {
    const { Basket } = await import('../src/client/Basket.tsx')
    serveBasket([
      { productId: 1, productName: 'Blue Cups Round- MRK005', qtyRequested: 2, available: 40, rechargeUnitPrice: null, supplyRoute: 'mercium' },
    ])
    render(<Basket siteId={1} onSubmitted={() => {}} />)

    await waitFor(() => expect(screen.getByText('40 available')).toBeTruthy())
    expect(screen.queryByText('Other store')).toBeNull()
    expect(screen.queryByText(/no tracking number/i)).toBeNull()
  })
})

/**
 * What a GM is told after the order has gone.
 *
 * Every sentence on these two screens used to name Mercium, because Mercium was the only
 * warehouse. An emailed order reaches exactly the same statuses — sendByEmail sets
 * status='posted' — so a GM chasing a late delivery was sent to the wrong company, about
 * an order Mintsoft had never seen. The route was already on the wire and discarded by
 * the client, which is worse than not having it.
 */
describe('after an other-store order has gone', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: 9, orderNumber: 'MR-M9-20261124-001', siteCode: 'M9', siteName: 'Leith Walk',
    status: 'posted', requesterName: 'Site GM', rejectedReason: null,
    submittedAt: '2026-11-24T09:00:00Z', approvedAt: '2026-11-24T10:00:00Z',
    despatchedAt: null, mintsoftOrderNumber: null, mergedIntoOrderNumber: null,
    mintsoftStatusId: null, mintsoftStatusAt: null,
    trackingNumber: null, trackingUrl: null, createdAt: '2026-11-24T08:00:00Z',
    recharge: false, rechargeTotal: null, supplyRoute: 'email', ...over,
  })

  const serveOrders = (orders: unknown[]) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
      if (url.includes('my-orders')) return json({ orders })
      return json({ orders: [] })
    })

  it('does not tell the GM that Mercium are picking it', async () => {
    const { MyOrders } = await import('../src/client/MyOrders.tsx')
    serveOrders([order()])
    render(<MyOrders />)

    await waitFor(() => expect(screen.getByText('Sent to the other store')).toBeTruthy())
    // The exact sentence that sent a GM to the wrong company.
    expect(screen.queryByText(/Mercium have it/)).toBeNull()
    expect(screen.getByText(/no tracking number for this one/i)).toBeTruthy()
  })

  it('does not promise a despatch step that can never arrive', async () => {
    const { MyOrders } = await import('../src/client/MyOrders.tsx')
    serveOrders([order()])
    render(<MyOrders />)

    // The despatch reconcile selects on mintsoft_order_id IS NOT NULL, and an emailed
    // order never has one — so "On its way" is a step nothing could ever move it to.
    await waitFor(() => expect(screen.getByText('Sent to the other store')).toBeTruthy())
    expect(screen.queryByText('On its way')).toBeNull()
  })

  it('still says Mercium for a Mercium order', async () => {
    const { MyOrders } = await import('../src/client/MyOrders.tsx')
    serveOrders([order({ supplyRoute: 'mercium', mintsoftOrderNumber: 'MS-55' })])
    render(<MyOrders />)

    await waitFor(() => expect(screen.getByText(/Mercium have it and are picking it/)).toBeTruthy())
    // And the four-step journey is intact, so nothing was taken from the Mercium route.
    expect(screen.getByText(/On its way/)).toBeTruthy()
  })
})

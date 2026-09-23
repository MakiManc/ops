/**
 * @vitest-environment jsdom
 *
 * That the catalogue can actually order.
 *
 * This is the test that was missing. The Phase 2 catalogue was read-only and Phase 3
 * built the basket, but nothing ever connected them — so a GM could browse stock and
 * had no way to request any of it, while the basket screen told them to "add something
 * from the stock list". Every other test passed throughout, because none of them asked
 * the one question that mattered: can a site place an order at all?
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Catalogue, type CatalogueProduct } from '../src/client/Catalogue.tsx'

const product = (over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: 7, name: 'Ramen Bowl', category: 'Crockery', packSize: 12, unit: 'each',
  imageUrl: null, available: 35, availableBasis: '40 on hand less 5 allocated.',
  status: 'in_stock', stockSyncedAt: new Date().toISOString(), parLevel: 24,
  inboundQty: null, inboundExpected: null, rechargeUnitPrice: null, mappedLines: 1, ...over,
})

/** Routes the catalogue fetch, the open-request fetch and the add-line POST. */
function serve({
  products = [product()],
  lines = [] as { productId: number }[],
  addFails = null as string | null,
} = {}) {
  const posts: { url: string; body: unknown }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return addFails
        ? new Response(JSON.stringify({ error: addFails }), { status: 400 })
        : new Response(JSON.stringify({ request: { id: 1 } }), { status: 200 })
    }
    if (url.includes('/request')) return new Response(JSON.stringify({ lines }), { status: 200 })
    return new Response(JSON.stringify({
      site: { id: 1, code: 'M9', name: 'Leith Walk', recharge: false },
      freshness: { lastSuccessAt: new Date().toISOString(), minutesOld: 2, stale: false },
      products,
    }), { status: 200 })
  })
  return posts
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('putting something in the request', () => {
  it('offers an add control on every product', async () => {
    serve()
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    expect(screen.getByRole('button', { name: 'Add to request' })).toBeDefined()
  })

  it('sends the product and quantity the GM chose', async () => {
    const posts = serve()
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'One more Ramen Bowl' }))
    fireEvent.click(screen.getByRole('button', { name: 'One more Ramen Bowl' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to request' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.url).toContain('/api/sites/1/request/lines')
    expect(posts[0]!.body).toEqual({ productId: 7, qty: 3 })
  })

  it('starts at one rather than guessing from the par level', async () => {
    const posts = serve({ products: [product({ parLevel: 24, available: 35 })] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Add to request' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    // A box pre-filled with a number nobody chose is the kind of thing that gets
    // submitted unread.
    expect(posts[0]!.body).toEqual({ productId: 7, qty: 1 })
  })

  it('never goes below one', async () => {
    serve()
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    const fewer = screen.getByRole('button', { name: 'One fewer Ramen Bowl' })
    expect((fewer as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the server\'s reason when it refuses, rather than failing silently', async () => {
    serve({ addFails: 'M9 ordered 3 days ago; the gap is 14 days.' })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Add to request' }))
    await waitFor(() =>
      expect(screen.getByText('M9 ordered 3 days ago; the gap is 14 days.')).toBeDefined())
  })

  it('lets an out-of-stock product be requested, because stock is a reading not a rule', async () => {
    // The server re-checks and the basket shows what it said. Disabling the button here
    // would hide the reason and make a stale reading look like a decision.
    serve({ products: [product({ available: 0, status: 'out' })] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    expect((screen.getByRole('button', { name: 'Add to request' }) as HTMLButtonElement).disabled)
      .toBe(false)
  })
})

describe('knowing there is a request on the go', () => {
  it('says how much is in it, and offers the way to send it', async () => {
    const onGoToBasket = vi.fn()
    serve({ lines: [{ productId: 7 }, { productId: 8 }] })
    render(<Catalogue siteId={1} onGoToBasket={onGoToBasket} />)

    await waitFor(() => expect(screen.getByText('2')).toBeDefined())
    expect(screen.getByText(/products in this request/)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }))
    expect(onGoToBasket).toHaveBeenCalled()
  })

  it('stays out of the way when the request is empty', async () => {
    serve({ lines: [] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    expect(screen.queryByText(/in this request/)).toBeNull()
  })

  it('counts the singular properly', async () => {
    serve({ lines: [{ productId: 7 }] })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText(/product in this request/)).toBeDefined())
  })
})

/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Catalogue, type CatalogueProduct } from '../src/client/Catalogue.tsx'
import { qty, timeAgo } from '../src/client/format.ts'

/**
 * The honest-data rules, checked where a GM actually meets them. The logic is tested
 * elsewhere; this is about what reaches the screen.
 */

const product = (over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: 1, name: 'Ramen Bowl', category: 'Crockery', packSize: 12, unit: 'each',
  imageUrl: null, available: 35, availableBasis: '40 on hand less 5 allocated.',
  status: 'in_stock', stockSyncedAt: new Date().toISOString(), parLevel: 24,
  inboundQty: null, inboundExpected: null, rechargeUnitPrice: null, mappedLines: 1, ...over,
})

function serve(
  products: CatalogueProduct[],
  freshness: { lastSuccessAt: string | null; minutesOld: number | null; stale: boolean } =
    { lastSuccessAt: new Date().toISOString(), minutesOld: 2, stale: false },
  recharge = false,
) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    site: { id: 1, code: 'M9', name: 'Leith Walk', recharge },
    freshness, products,
  }), { status: 200 }))
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('unknown stock', () => {
  it('shows an em dash, never a zero', async () => {
    serve([product({ available: null, status: 'unknown', availableBasis: 'Not in the latest stock feed, so the level is unknown.' })])
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('—')).toBeDefined())
    // A GM who sees 0 stops ordering; a GM who sees a dash asks.
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getByText(/Not in the latest stock feed/)).toBeDefined()
  })

  it('still shows a real zero as zero', async () => {
    serve([product({ available: 0, status: 'out', availableBasis: '0 on hand less 0 allocated.' })])
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('0')).toBeDefined())
  })
})

describe('status chips', () => {
  it('carry words, not just a colour', async () => {
    serve([
      product({ productId: 1, name: 'A', status: 'in_stock' }),
      product({ productId: 2, name: 'B', status: 'low' }),
      product({ productId: 3, name: 'C', status: 'out', available: 0 }),
      product({ productId: 4, name: 'D', status: 'inbound', available: 0, inboundQty: 200 }),
      product({ productId: 5, name: 'E', status: 'unknown', available: null }),
    ])
    render(<Catalogue siteId={1} />)
    // Colour alone says nothing to someone who cannot tell red from green.
    await waitFor(() => expect(screen.getByText('In stock')).toBeDefined())
    for (const label of ['Low', 'Out', 'Inbound', 'Unknown']) {
      expect(screen.getByText(label), label).toBeDefined()
    }
  })
})

describe('the staleness banner', () => {
  it('appears when the figures are old, and says how old', async () => {
    serve([product()], { lastSuccessAt: '2026-09-20T08:00:00Z', minutesOld: 1720, stale: true })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/These stock figures are/))
  })

  it('says so plainly when stock has never been checked', async () => {
    serve([product()], { lastSuccessAt: null, minutesOld: null, stale: true })
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText(/never been checked/)).toBeDefined())
  })

  it('stays out of the way when the data is fresh', async () => {
    serve([product()])
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText(/Stock last checked/)).toBeDefined())
    expect(screen.queryByText(/may be out of date/)).toBeNull()
  })
})

describe('prices', () => {
  it('are shown at a franchise site', async () => {
    serve([product({ rechargeUnitPrice: 2.5 })], undefined, true)
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText(/£2\.50 each/)).toBeDefined())
  })

  it('are absent entirely at a corporate site', async () => {
    serve([product({ rechargeUnitPrice: null })], undefined, false)
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    expect(screen.queryByText(/£/)).toBeNull()
  })

  it('says a franchise product has no price rather than showing nothing', async () => {
    serve([product({ rechargeUnitPrice: null })], undefined, true)
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText(/no price set/)).toBeDefined())
  })
})

describe('the product count', () => {
  it('says when the list is filtered, so a short list is not read as a small catalogue', async () => {
    serve([product({ productId: 1, name: 'Ramen Bowl' }), product({ productId: 2, name: 'Chopsticks' })])
    render(<Catalogue siteId={1} />)
    await waitFor(() => expect(screen.getByText('2 products')).toBeDefined())
  })
})

describe('formatting helpers', () => {
  it('renders an unknown quantity as an em dash', () => {
    expect(qty(null)).toBe('—')
    expect(qty(undefined)).toBe('—')
    expect(qty(0)).toBe('0')
  })

  it('describes how old a reading is in words', () => {
    const now = new Date('2026-09-21T12:00:00Z')
    expect(timeAgo('2026-09-21T11:58:00Z', now)).toBe('2 minutes ago')
    expect(timeAgo('2026-09-21T09:00:00Z', now)).toBe('3 hours ago')
    expect(timeAgo('2026-09-19T12:00:00Z', now)).toBe('2 days ago')
    expect(timeAgo(null, now)).toBe('never')
  })
})

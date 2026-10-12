/**
 * @vitest-environment jsdom
 *
 * The mapping screen, and the stock position it now shows.
 *
 * The mapping tool is where a line Mintsoft has no inventory record for gets attached to
 * a product, and until now this screen said nothing about it. The consequence landed two
 * screens away and three weeks later: Tea cups became unorderable with 577 units in
 * Witham, and the first anyone knew was a GM's order being refused.
 *
 * Nothing here blocks the mapping. A line whose first shipment has not landed legitimately
 * has no record. The screen's job is to make the consequence visible where the decision is
 * made, and to surface the products already in that state.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mapping } from '../src/client/Mapping.tsx'

const line = (over: Record<string, unknown> = {}) => ({
  mintsoftProductId: 7001, sku: 'BOWL-01', name: 'Ramen Bowl', ean: null,
  mappedToProductId: null, mappedToProductName: null,
  hasStockRecord: true, available: 100, ...over,
})

/** Routes each endpoint the screen calls, so one test can set all three up. */
const serve = (
  { suggestions = [], lines = [], products = [], post }:
  {
    suggestions?: unknown[]; lines?: unknown[]; products?: unknown[]
    post?: { status?: number; body?: unknown }
  },
) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input)
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    if (init?.method === 'POST') return json(post?.body ?? { productId: 1 }, post?.status ?? 201)
    if (url.includes('/suggestions')) return json({ suggestions })
    if (url.includes('/unmapped')) return json({ lines })
    if (url.includes('/stock-gaps')) return json({ products })
    return json({}, 404)
  })

const suggestion = (lines: unknown[]) => ({
  signal: 'same-normalised-name', key: 'ramen-bowl', lines, partiallyMapped: false,
})

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('a line’s stock position, where the decision is made', () => {
  it('marks a line Mintsoft has no record for', async () => {
    serve({ suggestions: [suggestion([line(), line({ mintsoftProductId: 7002, sku: 'BOWL-02', hasStockRecord: false, available: null })])] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/no stock record in Mintsoft/)).toBeDefined())
    // And a line that does have one says what it holds, so the two are told apart.
    expect(screen.getByText(/100 free/)).toBeDefined()
  })

  it('tells an unreadable figure from an absent record', async () => {
    serve({ suggestions: [suggestion([line({ hasStockRecord: true, available: null })])] })
    render(<Mapping />)
    // A row exists but says nothing. Different problem, different sentence.
    await waitFor(() => expect(screen.getByText(/stock figure unreadable/)).toBeDefined())
    expect(screen.queryByText(/no stock record in Mintsoft/)).toBeNull()
  })

  it('defaults the primary to a line that has a figure', async () => {
    // Orders fill from the primary first, and unmapping a primary needs another line
    // promoted first, so the default is the one choice worth making for the admin.
    serve({ suggestions: [suggestion([
      line({ mintsoftProductId: 7001, sku: 'NO-RECORD', hasStockRecord: false, available: null }),
      line({ mintsoftProductId: 7002, sku: 'HAS-STOCK', available: 40 }),
    ])] })
    render(<Mapping />)
    const select = await waitFor(() => screen.getByLabelText(/Primary SKU/)) as unknown as HTMLSelectElement
    expect(select.value).toBe('7002')
    // The recordless line is still offered, labelled — the admin may have a reason.
    expect(screen.getByRole('option', { name: /NO-RECORD.*no stock record/ })).toBeDefined()
  })

  it('shows the server’s warning after saving, and does not call it an error', async () => {
    serve({
      suggestions: [suggestion([line({ hasStockRecord: false, available: null })])],
      post: { status: 201, body: { productId: 9, warning: 'Mintsoft has no stock record for BOWL-01, so this product will show at least 40 rather than a total.' } },
    })
    render(<Mapping />)
    const button = await waitFor(() => screen.getByRole('button', { name: /Combine into one product/ }))
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByText(/will show at least 40 rather than a total/)).toBeDefined())
    // It saved. The warning must not read as a failure.
    expect(screen.getByText('Saved.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()
  })

  it('closes straight away when there is nothing to warn about', async () => {
    serve({
      suggestions: [suggestion([line()])],
      post: { status: 201, body: { productId: 9, warning: null } },
    })
    render(<Mapping />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Combine into one product/ })))
    await waitFor(() => expect(screen.queryByText('Saved.')).toBeNull())
  })

  it('still shows a real failure as an error', async () => {
    serve({
      suggestions: [suggestion([line()])],
      post: { status: 400, body: { error: 'Mintsoft line 7001 is already mapped to "Ramekin".' } },
    })
    render(<Mapping />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Combine into one product/ })))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already mapped/))
  })
})

describe('the products already mapped to a recordless line', () => {
  const gap = (over: Record<string, unknown> = {}) => ({
    productId: 1, productName: 'Tea cups', active: true,
    recordlessLines: [{ mintsoftProductId: 1585, sku: 'MRK010-TCT', isPrimary: false }],
    mappedLines: 8, readableFloor: 577, readableLines: 7, ...over,
  })

  it('names the product, the line and what sites can still order', async () => {
    serve({ products: [gap()] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/1 mapped product has a/)).toBeDefined())
    expect(screen.getByText('Tea cups')).toBeDefined()
    expect(screen.getByText(/MRK010-TCT/)).toBeDefined()
    expect(screen.getByText(/Sites can order up to 577/)).toBeDefined()
  })

  it('says when no line has a figure at all, which is the one that stops an order', async () => {
    serve({ products: [gap({ productName: 'All absent', readableFloor: 0, readableLines: 0 })] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/cannot be ordered at all until one appears in the feed/)).toBeDefined())
  })

  it('says something different when the readable lines are simply empty', async () => {
    // Round Table Base: a floor of zero, but the next shipment fixes it without anybody
    // touching the mapping. Not the same as having no figure.
    serve({ products: [gap({ productName: 'Round Table Base', readableFloor: 0, readableLines: 6, mappedLines: 7 })] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/6 readable lines hold nothing/)).toBeDefined())
    expect(screen.queryByText(/cannot be ordered at all/)).toBeNull()
  })

  it('calls out a recordless line that is the primary', async () => {
    serve({ products: [gap({
      productName: 'Sakura planters', readableFloor: 2, readableLines: 1, mappedLines: 2,
      recordlessLines: [{ mintsoftProductId: 1308, sku: 'MRK002-STS-30', isPrimary: true }],
    })] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/MRK002-STS-30 \(primary\)/)).toBeDefined())
    expect(screen.getByText(/promote a line that has a figure/)).toBeDefined()
  })

  it('says nothing at all when there are no gaps', async () => {
    serve({ products: [] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/not mapped yet/)).toBeDefined())
    expect(screen.queryByText(/no stock record/)).toBeNull()
  })

  it('keeps the mapping tool working when the gaps call fails', async () => {
    // The panel is useful, not essential. It must not take the screen down with it.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      const json = (body: unknown, status = 200) =>
        Promise.resolve(new Response(JSON.stringify(body), { status }))
      if (url.includes('/stock-gaps')) return json({ error: 'nope' }, 500)
      if (url.includes('/suggestions')) return json({ suggestions: [] })
      return json({ lines: [line()] })
    })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/1 warehouse line is not mapped yet/)).toBeDefined())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

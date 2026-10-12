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

  it('saves and reloads the list when there is nothing to warn about', async () => {
    // This test used to assert only that 'Saved.' was absent, which is true before the
    // click and before the POST resolves -- it passed with no click at all. Assert the
    // positive effects instead: the POST went, and the screen reloaded.
    serve({
      suggestions: [suggestion([line()])],
      post: { status: 201, body: { productId: 9, warning: null } },
    })
    render(<Mapping />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Combine into one product/ })))

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/admin/mapping/products', expect.objectContaining({ method: 'POST' }),
    ))
    // onDone reloads, so the suggestions endpoint is hit again.
    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(calls.filter((c) => String(c[0]).includes('/suggestions')).length).toBeGreaterThan(1)
    })
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('does not leave the card stuck on "Saved." when the cluster survives', async () => {
    // onDone reloads and the parent re-renders this card under the same key, so a warning
    // left in state outlives the reload. That happens precisely when the cluster still has
    // unmapped lines -- when there is more to do -- and the card would have no way back.
    serve({
      suggestions: [suggestion([line({ hasStockRecord: false, available: null })])],
      post: { status: 201, body: { productId: 9, warning: 'at least 40 rather than a total' } },
    })
    render(<Mapping />)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Combine into one product/ })))
    const done = await waitFor(() => screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(done)

    await waitFor(() => expect(screen.queryByText('Saved.')).toBeNull())
    // The card is usable again.
    expect(screen.getByRole('button', { name: /Combine into one product/ })).toBeDefined()
  })

  it('submits a primary that is actually one of the selected lines', async () => {
    // Asserting select.value here proves nothing: a <select> whose value matches no option
    // reports the FIRST option's value, so the element reads '7002' either way while React
    // state still holds 7001. The bug is only visible in what gets submitted -- the server
    // refused with "The primary SKU must be one of the lines being mapped", an error with
    // no visible cause.
    serve({ suggestions: [suggestion([
      line({ mintsoftProductId: 7001, sku: 'HAS-STOCK', available: 40 }),
      line({ mintsoftProductId: 7002, sku: 'ALSO-STOCK', available: 7 }),
    ])] })
    render(<Mapping />)
    await waitFor(() => screen.getByLabelText(/Primary SKU/))

    fireEvent.click(screen.getByLabelText(/HAS-STOCK/))        // deselect the default primary
    fireEvent.click(screen.getByRole('button', { name: /Combine into one product/ }))

    await waitFor(() => {
      const post = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .find((c) => (c[1] as { method?: string } | undefined)?.method === 'POST')
      expect(post, 'nothing was submitted').toBeDefined()
      const body = JSON.parse((post![1] as { body: string }).body) as
        { mintsoftProductIds: number[]; primaryMintsoftProductId: number }
      expect(body.mintsoftProductIds).toEqual([7002])
      expect(body.primaryMintsoftProductId).toBe(7002)
    })
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
  const readable = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ mintsoftProductId: 2000 + i, sku: `OK-${i}`, available: 10 }))

  const gap = (over: Record<string, unknown> = {}) => ({
    productId: 1, productName: 'Tea cups', active: true,
    unreadableLines: [{ mintsoftProductId: 1585, sku: 'MRK010-TCT', isPrimary: false, hasStockRecord: false }],
    mappedLines: 8, readableFloor: 577, readableLines: readable(7), ...over,
  })

  it('names the product, the line and what sites can still order', async () => {
    serve({ products: [gap()] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/1 mapped product has a/)).toBeDefined())
    expect(screen.getByText('Tea cups')).toBeDefined()
    expect(screen.getByText('MRK010-TCT')).toBeDefined()
    expect(screen.getByText(/Sites can order up to 577/)).toBeDefined()
  })

  it('says when no line has a figure at all, which is the one that stops an order', async () => {
    serve({ products: [gap({ productName: 'All absent', readableFloor: 0, readableLines: [] })] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/cannot be ordered at all until one starts reporting/)).toBeDefined())
  })

  it('says something different when the readable lines are simply empty', async () => {
    // Round Table Base: a floor of zero, but the next shipment fixes it without anybody
    // touching the mapping. Not the same as having no figure.
    serve({ products: [gap({ productName: 'Round Table Base', readableFloor: 0, readableLines: readable(6), mappedLines: 7 })] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/6 readable/)).toBeDefined())
    expect(screen.getByText(/lines hold.*nothing, so/s)).toBeDefined()
    expect(screen.queryByText(/cannot be ordered at all/)).toBeNull()
  })

  it('calls out a recordless line that is the primary', async () => {
    serve({ products: [gap({
      productName: 'Sakura planters', readableFloor: 2, mappedLines: 2,
      readableLines: [{ mintsoftProductId: 1309, sku: 'MRK002-STS', available: 2 }],
      unreadableLines: [{ mintsoftProductId: 1308, sku: 'MRK002-STS-30', isPrimary: true, hasStockRecord: false }],
    })] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText('MRK002-STS-30')).toBeDefined())
    expect(screen.getByText(/holds the primary flag, which must move before it can be unmapped/))
      .toBeDefined()
  })

  it('says nothing at all when there are no gaps', async () => {
    serve({ products: [] })
    render(<Mapping />)
    await waitFor(() => expect(screen.getByText(/not mapped yet/)).toBeDefined())
    expect(screen.queryByText(/line with no stock figure/)).toBeNull()
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

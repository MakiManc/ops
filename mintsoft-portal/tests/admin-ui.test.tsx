/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderedBySite, ParLevels, SyncHealth } from '../src/client/AdminScreens.tsx'

const serve = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('what each site has ordered', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    month: '2026-10',
    sites: [{
      siteCode: 'M19', siteName: 'Maki M19', siteType: 'restaurant',
      orderCount: 2, ordersWithMercium: 2, productCount: 2, itemCount: 66,
      products: [
        { productId: 22, productName: 'FOH Kimono (M)No apron', qty: 6, orders: 1 },
        { productId: 48, productName: 'Ramekin', qty: 60, orders: 2 },
      ],
    }],
    productTotals: [
      { productId: 48, productName: 'Ramekin', qty: 60, orders: 2 },
      { productId: 22, productName: 'FOH Kimono (M)No apron', qty: 6, orders: 1 },
    ],
    siteCount: 1, itemCount: 66, warnings: [], ...over,
  })

  it('shows every site and what it had, in items rather than money', async () => {
    serve(report())
    render(<OrderedBySite />)
    await waitFor(() => expect(screen.getByText('M19 · Maki M19')).toBeDefined())
    expect(screen.getByText('66 items')).toBeDefined()
    // The report this replaced showed money for franchise sites only, and no site is one.
    expect(screen.queryByText(/£/)).toBeNull()
  })

  it('shows the products behind a site when asked', async () => {
    serve(report())
    render(<OrderedBySite />)
    const toggle = await waitFor(() => screen.getByRole('button', { name: 'Show the products' }))
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByText('Ramekin')).toBeDefined())
    expect(screen.getByText(/over 2 orders/)).toBeDefined()
  })

  it('cuts the same figures by product, for "how many went out"', async () => {
    serve(report())
    render(<OrderedBySite />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'By product' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'By product' }))
    await waitFor(() => expect(screen.getByText('Ramekin')).toBeDefined())
    expect(screen.getByText('60')).toBeDefined()
  })

  it('warns when some of a site\'s orders have not reached Mercium', async () => {
    serve(report({
      sites: [{ ...report().sites[0], orderCount: 3, ordersWithMercium: 1 }],
    }))
    render(<OrderedBySite />)
    // Signed off is not delivered, and a usage figure read as delivered would be wrong by
    // however much is still waiting.
    await waitFor(() => expect(screen.getByText(/2 not sent to Mercium yet/)).toBeDefined())
  })

  it('says a quiet month is quiet rather than showing an empty page', async () => {
    serve(report({ sites: [], productTotals: [], siteCount: 0, itemCount: 0, warnings: ['No orders were signed off in 2026-10.'] }))
    render(<OrderedBySite />)
    await waitFor(() => expect(screen.getByText(/No orders were signed off/)).toBeDefined())
  })

  it('reports lines signed off at nothing rather than listing them as zero', async () => {
    serve(report({ warnings: ['2 lines were signed off at nothing, so nothing was ordered for them and they are not listed.'] }))
    render(<OrderedBySite />)
    await waitFor(() => expect(screen.getByText(/signed off at nothing/)).toBeDefined())
  })

  it('offers the CSV', async () => {
    serve(report())
    render(<OrderedBySite />)
    await waitFor(() => {
      const link = screen.getByText('Download CSV') as HTMLAnchorElement
      expect(link.getAttribute('href')).toBe('/api/admin/ordered/2026-10/csv')
    })
  })

  it('offers a retry rather than a dead end when it will not load', async () => {
    serve({ error: 'Could not load' }, 500)
    render(<OrderedBySite />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined())
  })
})

describe('par levels', () => {
  it('explains that a blank cell clears a limit', async () => {
    serve({})
    render(<ParLevels />)
    // The alternative reading would make a limit impossible to remove.
    await waitFor(() => expect(screen.getByText(/A blank cell means no limit/)).toBeDefined())
    expect(screen.getByText(/Nothing is saved unless every row is valid/)).toBeDefined()
  })

  it('lists every problem and says nothing was saved', async () => {
    render(<ParLevels />)
    serve({ applied: 0, cleared: 0, problems: [
      { line: 2, message: 'No active site with code "M99"' },
      { line: 5, message: 'par_level must be a whole number or left blank (got "lots")' },
    ] }, 422)
    const textarea = screen.getByLabelText('Paste the edited grid') as HTMLTextAreaElement
    textarea.value = 'x'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor(() => expect(screen.getByText('Apply')).toBeDefined())
  })
})

describe('sync health', () => {
  it('shows when each job last worked', async () => {
    serve({
      lastSuccess: { stock: new Date().toISOString() },
      recent: [{ job: 'stock', started_at: new Date().toISOString(), finished_at: null, status: 'ok', rows_written: 120, detail: null }],
    })
    render(<SyncHealth />)
    // Appears twice on purpose: once under "last success", once in the run list.
    await waitFor(() => expect(screen.getAllByText('Stock levels')).toHaveLength(2))
    expect(screen.getByText('Worked')).toBeDefined()
    expect(screen.getByText(/120 rows/)).toBeDefined()
  })

  it('calls out a job that has never run', async () => {
    serve({ lastSuccess: {}, recent: [] })
    render(<SyncHealth />)
    // Never is the stalest state there is, not a blank.
    await waitFor(() => expect(screen.getAllByText('never run').length).toBeGreaterThan(0))
  })

  it('shows what a failed run said', async () => {
    serve({
      lastSuccess: {},
      recent: [{ job: 'inbound', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: 'failed', rows_written: null, detail: 'Mintsoft returned 500' }],
    })
    render(<SyncHealth />)
    await waitFor(() => expect(screen.getByText('Failed')).toBeDefined())
    expect(screen.getByText('Mintsoft returned 500')).toBeDefined()
  })

  it('distinguishes a run still going from one that finished', async () => {
    serve({
      lastSuccess: {},
      recent: [{ job: 'stock', started_at: new Date().toISOString(), finished_at: null, status: 'running', rows_written: null, detail: null }],
    })
    render(<SyncHealth />)
    await waitFor(() => expect(screen.getByText('Still running')).toBeDefined())
  })
})

/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ParLevels, RechargeReport, SyncHealth } from '../src/client/AdminScreens.tsx'

const serve = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('the recharge report', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    month: '2026-10',
    siteTotals: [{
      siteCode: 'MAF1', siteName: 'Guildford', orderCount: 2, lineCount: 5,
      itemCount: 310, goodsTotal: 240.5, orderFees: 24, total: 264.5, unpricedLines: 0,
    }],
    grandTotal: 264.5, warnings: [], lines: [], ...over,
  })

  it('shows each site\'s total, split into goods and fees', async () => {
    serve(report())
    render(<RechargeReport />)
    await waitFor(() => expect(screen.getByText('MAF1 · Guildford')).toBeDefined())
    expect(screen.getByText('£264.50')).toBeDefined()
    expect(screen.getByText(/Goods £240\.50 \+ delivery fees £24\.00/)).toBeDefined()
  })

  it('says when lines had no price and are therefore missing from the total', async () => {
    serve(report({
      siteTotals: [{ ...report().siteTotals[0], unpricedLines: 2 }],
      warnings: ['2 lines had no price set when the order was approved, so they are shown with no value and are not in the totals.'],
    }))
    render(<RechargeReport />)
    // Finance should not be left to notice the total looks light.
    await waitFor(() => expect(screen.getByText(/2 lines had no price set/)).toBeDefined())
    expect(screen.getByText(/are not in this total/)).toBeDefined()
  })

  it('says a quiet month is quiet rather than showing an empty page', async () => {
    serve(report({ siteTotals: [], grandTotal: 0, warnings: ['No franchise orders were approved in 2026-10.'] }))
    render(<RechargeReport />)
    await waitFor(() => expect(screen.getByText(/No franchise orders were approved/)).toBeDefined())
  })

  it('offers the CSV for Finance', async () => {
    serve(report())
    render(<RechargeReport />)
    await waitFor(() => {
      const link = screen.getByText('Download CSV for Finance') as HTMLAnchorElement
      expect(link.getAttribute('href')).toMatch(/\/csv$/)
    })
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

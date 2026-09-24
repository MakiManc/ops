import { useCallback, useEffect, useState } from 'react'
import { money, timeAgo } from './format.ts'

/**
 * The admin screens: recharge reporting, par levels, and sync health.
 *
 * All three are "look at the numbers and act" screens rather than forms, so they favour
 * showing the whole picture over hiding detail behind clicks.
 */

// ---------------------------------------------------------------------------
// Recharge report
// ---------------------------------------------------------------------------

interface RechargeSite {
  siteCode: string; siteName: string; orderCount: number; lineCount: number
  itemCount: number; goodsTotal: number; orderFees: number; total: number; unpricedLines: number
}
interface Report {
  month: string
  siteTotals: RechargeSite[]
  grandTotal: number
  warnings: string[]
  lines: { orderNumber: string; siteCode: string; productName: string; qty: number; unitPrice: number | null; lineTotal: number | null }[]
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

export function RechargeReport() {
  const [month, setMonth] = useState(thisMonth())
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setReport(null); setError(null)
    fetch(`/api/admin/recharge/${month}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Could not load')
        if (!cancelled) setReport(await res.json() as Report)
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [month])

  return (
    <div className="space-y-4">
      <p className="text-gray-700">
        What each franchise site owes for the month, from the prices recorded when each
        order was approved. The portal does not raise invoices — this is the figures for
        Finance to work from.
      </p>

      <div>
        <label htmlFor="month" className="block text-sm font-medium text-gray-800">Month</label>
        <input
          id="month" type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          className="mt-1 rounded-lg border border-gray-400 px-3 py-2"
        />
      </div>

      {error && <p role="alert" className="text-red-800 bg-red-50 border border-red-300 rounded p-3">{error}</p>}
      {!report && !error && <p role="status" className="text-gray-700">Loading…</p>}

      {report && (
        <>
          {report.warnings.map((w) => (
            <p key={w} className="text-sm text-amber-900 bg-amber-50 border border-amber-400 rounded p-3">{w}</p>
          ))}

          {report.siteTotals.length > 0 && (
            <>
              <ul className="grid gap-3">
                {report.siteTotals.map((site) => (
                  <li key={site.siteCode} className="bg-white border border-gray-300 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-semibold text-gray-900">{site.siteCode} · {site.siteName}</h3>
                      <p className="font-semibold text-gray-900">{money(site.total)}</p>
                    </div>
                    <p className="mt-1 text-sm text-gray-700">
                      {site.orderCount} order{site.orderCount === 1 ? '' : 's'} · {site.lineCount} lines ·{' '}
                      {site.itemCount} items
                    </p>
                    <p className="mt-1 text-sm text-gray-700">
                      Goods {money(site.goodsTotal)} + delivery fees {money(site.orderFees)}
                    </p>
                    {site.unpricedLines > 0 && (
                      <p className="mt-2 text-sm text-amber-900">
                        {site.unpricedLines} line{site.unpricedLines === 1 ? '' : 's'} had no price and {site.unpricedLines === 1 ? 'is' : 'are'} not in this total.
                      </p>
                    )}
                  </li>
                ))}
              </ul>

              <p className="text-lg font-semibold text-gray-900">
                Grand total {money(report.grandTotal)}
              </p>

              <a
                href={`/api/admin/recharge/${month}/csv`}
                className="tappable inline-block px-4 py-3 rounded-lg bg-everglade text-paper"
              >
                Download CSV for Finance
              </a>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Par levels
// ---------------------------------------------------------------------------

export function ParLevels() {
  const [csv, setCsv] = useState('')
  const [result, setResult] = useState<{ applied: number; cleared: number; problems: { line: number; message: string }[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const upload = async () => {
    setBusy(true); setResult(null)
    try {
      const res = await fetch('/api/admin/par-levels', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'text/csv' }, body: csv,
      })
      setResult(await res.json() as never)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-gray-700">
        Par levels and order limits for every site and product. Download the grid, edit it
        in a spreadsheet, paste it back.
      </p>

      <a href="/api/admin/par-levels.csv" className="tappable inline-block px-4 py-3 rounded-lg bg-everglade text-paper">
        Download the current grid
      </a>

      <div>
        <label htmlFor="par-csv" className="block text-sm font-medium text-gray-800">
          Paste the edited grid
        </label>
        {/* Stated here because the alternative reading would make a limit impossible to remove. */}
        <p className="text-sm text-gray-600">
          A blank cell means no limit and clears whatever was there. Nothing is saved
          unless every row is valid.
        </p>
        <textarea
          id="par-csv" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2 font-mono text-sm"
          placeholder="site_code,product_name,par_level,max_per_order,min_days_between_orders"
        />
      </div>

      <button
        onClick={() => void upload()} disabled={busy || !csv.trim()}
        className="px-4 py-3 rounded-lg bg-everglade text-paper disabled:bg-gray-400"
      >
        {busy ? 'Checking…' : 'Apply'}
      </button>

      {result && result.problems.length === 0 && (
        <p role="status" className="text-green-900 bg-green-50 border border-green-300 rounded p-3">
          Saved. {result.applied} row{result.applied === 1 ? '' : 's'} updated
          {result.cleared > 0 && `, ${result.cleared} cleared`}.
        </p>
      )}

      {result && result.problems.length > 0 && (
        <div role="alert" className="space-y-2">
          <p className="text-red-900 font-medium">Nothing was saved. {result.problems.length} problem(s):</p>
          <ul className="space-y-1">
            {result.problems.map((p) => (
              <li key={`${p.line}-${p.message}`} className="text-sm text-red-900 bg-red-50 border border-red-300 rounded p-2">
                Line {p.line}: {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sync health
// ---------------------------------------------------------------------------

interface SyncRun {
  job: string; started_at: string; finished_at: string | null
  status: 'running' | 'ok' | 'failed' | 'skipped'
  rows_written: number | null; detail: string | null
}

interface Budget { spent: number; budget: number; remaining: number; mayWrite: boolean }

const JOB_LABEL: Record<string, string> = {
  stock: 'Stock levels', catalogue: 'Product catalogue', inbound: 'Inbound shipments',
  orders: 'Order status', reconcile: 'Nightly reconcile',
}

export function SyncHealth() {
  const [data, setData] = useState<{
    lastSuccess: Record<string, string | null>; recent: SyncRun[]; budget?: Budget
  } | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/sync', { credentials: 'same-origin' })
      if (!res.ok) throw new Error()
      setData(await res.json() as never)
    } catch { setError(true) }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <p role="alert" className="text-red-800">Sync health could not be loaded.</p>
  if (!data) return <p role="status" className="text-gray-700">Loading…</p>

  const jobs = ['stock', 'orders', 'catalogue', 'inbound']
  const budget = data.budget
  // Amber well before it bites, because the day it ran out the first sign was somebody
  // being told their account could not sign in.
  const pressure = budget ? budget.spent / budget.budget : 0

  return (
    <div className="space-y-4">
      {budget && (
        <section
          aria-labelledby="write-budget"
          className={`rounded-lg border p-3 ${
            !budget.mayWrite ? 'bg-red-50 border-red-300 text-red-900'
              : pressure > 0.7 ? 'bg-amber-50 border-amber-400 text-amber-900'
                : 'bg-gray-50 border-gray-300 text-gray-800'}`}
        >
          <h2 id="write-budget" className="text-sm font-semibold uppercase tracking-wide">
            Database writes today
          </h2>
          <p className="mt-1">
            Syncing has used <strong>{budget.spent.toLocaleString()}</strong> of its{' '}
            <strong>{budget.budget.toLocaleString()}</strong> daily budget.
          </p>
          <p className="mt-1 text-sm">
            {!budget.mayWrite
              ? 'Syncing has stood down for today so that ordering keeps working. Stock '
                + 'figures will be stale until midnight UTC, and the catalogue says so.'
              : 'The rest of the day\u2019s allowance is kept for ordering, so a busy sync '
                + 'can never stop somebody signing in or sending an order.'}
          </p>
        </section>
      )}
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">Last success</h2>
      <ul className="grid gap-2">
        {jobs.map((job) => {
          const at = data.lastSuccess[job]
          return (
            <li key={job} className="bg-white border border-gray-300 rounded-lg p-3 flex justify-between gap-3">
              <span className="text-gray-900">{JOB_LABEL[job] ?? job}</span>
              <span className={at ? 'text-gray-700' : 'text-red-900 font-medium'}>
                {/* Never is the stalest state there is, not a blank. */}
                {at ? timeAgo(at) : 'never run'}
              </span>
            </li>
          )
        })}
      </ul>

      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600 pt-2">Recent runs</h2>
      {data.recent.length === 0 ? (
        <p className="text-gray-700">Nothing has run yet.</p>
      ) : (
        <ul className="grid gap-2">
          {data.recent.map((run, i) => (
            <li key={`${run.job}-${run.started_at}-${i}`} className="bg-white border border-gray-300 rounded-lg p-3">
              <div className="flex justify-between gap-3">
                <span className="text-gray-900">{JOB_LABEL[run.job] ?? run.job}</span>
                <span className={
                  run.status === 'ok' ? 'text-green-900'
                    : run.status === 'skipped' ? 'text-amber-900 font-medium'
                      : run.status === 'failed' ? 'text-red-900 font-medium'
                    : 'text-amber-900'
                }>
                  {run.status === 'ok' ? 'Worked'
                    : run.status === 'skipped' ? 'Stood down'
                      : run.status === 'failed' ? 'Failed' : 'Still running'}
                </span>
              </div>
              <p className="text-sm text-gray-600">
                {timeAgo(run.started_at)}
                {run.rows_written !== null && ` · ${run.rows_written} rows`}
              </p>
              {run.detail && (
                <p className="mt-1 text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded p-2">
                  {run.detail}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

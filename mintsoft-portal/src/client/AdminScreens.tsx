import { useCallback, useEffect, useState } from 'react'
import { timeAgo } from './format.ts'
import { btnSecondary, card } from './ui.ts'

/**
 * The admin screens: what each site has ordered, par levels, and sync health.
 *
 * All three are "look at the numbers and act" screens rather than forms, so they favour
 * showing the whole picture over hiding detail behind clicks.
 */

// ---------------------------------------------------------------------------
// What each site has ordered
// ---------------------------------------------------------------------------

interface OrderedProduct {
  productId: number; productName: string; qty: number; orders: number
  unitPrice: number | null; cost: number | null
  gapReason: string | null; priceNote: string | null
}
interface OrderedSite {
  siteCode: string; siteName: string; siteType: string
  orderCount: number; ordersWithMercium: number; productCount: number; itemCount: number
  cost: number; unpricedProducts: number; unpricedItems: number
  products: OrderedProduct[]
}
interface Report {
  month: string
  sites: OrderedSite[]
  productTotals: OrderedProduct[]
  siteCount: number
  itemCount: number
  cost: number
  unpricedProducts: number
  unpricedItems: number
  priceBasisNote: string
  warnings: string[]
}

const thisMonth = () => new Date().toISOString().slice(0, 7)

/**
 * Money, as money. Intl rather than toFixed, so a four-figure total gets its comma.
 *
 * A figure that is not a number comes back as a dash rather than throwing. The payload
 * always carries one, but a whole admin screen going blank is a bad way to find out
 * otherwise, and a dash says the same thing an absent price says everywhere else here.
 */
const money = (n: number | null | undefined): string =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })
    : '\u2014'

/**
 * A cost, and whether it is the whole cost.
 *
 * A site with unpriced products has a cost that is short by however much they are worth,
 * and the figure has to say so where it is read rather than in a footnote. "£99.00" and
 * "£99.00 + 2 unpriced" are different claims.
 */
function Cost({ cost, unpriced }: { cost: number | null | undefined; unpriced: number }) {
  return (
    <>
      {money(cost)}
      {unpriced > 0 && (
        <span className="ml-1 text-sm font-normal text-amber-900">
          + {unpriced} unpriced
        </span>
      )}
    </>
  )
}

/**
 * What every site has ordered in a month, by product, in quantities.
 *
 * This replaced a recharge report that had never shown a row: it filtered to franchise
 * sites and none exist, and priced from a snapshot that is only taken for franchise
 * sites. So the one question anybody asked of it -- how much has this restaurant had --
 * had no answer for any site in the group.
 *
 * Two cuts of the same figures, because both questions get asked: by site, for "what has
 * Leith Walk been getting through", and by product, for "how many ramekins went out this
 * month".
 */
export function OrderedBySite() {
  const [month, setMonth] = useState(thisMonth())
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [by, setBy] = useState<'site' | 'product'>('site')
  const [openSite, setOpenSite] = useState<string | null>(null)

  const load = useCallback(() => {
    setReport(null); setError(null)
    return fetch(`/api/admin/ordered/${month}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Could not load')
        setReport(await res.json() as Report)
      })
      .catch((e: Error) => { setError(e.message) })
  }, [month])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-4">
      <p className="text-gray-700">
        What every site has ordered in the month, by product, and what it cost. Counted at
        the quantity that was signed off, not what was asked for, and from the month the
        order was signed off rather than when it shipped — so a month&apos;s figures do not
        move afterwards.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="month" className="block text-sm font-medium text-gray-800">Month</label>
          <input
            id="month" type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="mt-1 rounded-lg border border-gray-400 px-3 py-2"
          />
        </div>
        <div role="group" aria-label="Group by" className="flex gap-2">
          {(['site', 'product'] as const).map((k) => (
            <button
              key={k} type="button" onClick={() => setBy(k)}
              aria-pressed={by === k}
              className={`min-h-[44px] px-4 rounded-xl font-semibold ${
                by === k ? 'bg-everglade text-paper' : 'border border-gray-400 text-gray-900'}`}
            >
              By {k}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-red-800 bg-red-50 border border-red-300 rounded p-3">{error}</p>
          <button type="button" className={btnSecondary} onClick={() => void load()}>Try again</button>
        </div>
      )}
      {!report && !error && <p role="status" className="text-gray-700">Loading…</p>}

      {report && (
        <>
          {report.warnings.map((w) => (
            <p key={w} className="text-sm text-amber-900 bg-amber-50 border border-amber-400 rounded p-3">{w}</p>
          ))}

          {report.sites.length > 0 && (
            <>
              <div className={card}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <p className="text-gray-900">
                    {report.itemCount} items across {report.siteCount}{' '}
                    {report.siteCount === 1 ? 'site' : 'sites'}.
                  </p>
                  <p className="text-xl font-semibold text-gray-900">
                    <Cost cost={report.cost} unpriced={report.unpricedProducts} />
                  </p>
                </div>
                {/* Supplier cost reads as "what the site owes" to anyone not told
                    otherwise, and it is neither: no freight, no VAT, no duty, no markup.
                    So the caveat travels with the number, not in a footnote. */}
                <p className="mt-2 text-sm text-gray-700">{report.priceBasisNote}</p>
              </div>

              {by === 'site' ? (
                <ul className="grid gap-3">
                  {report.sites.map((site) => (
                    <li key={site.siteCode} className={card}>
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="font-semibold text-gray-900">
                          {site.siteCode} · {site.siteName}
                        </h3>
                        <div className="text-right whitespace-nowrap">
                          <p className="font-semibold text-gray-900">
                            <Cost cost={site.cost} unpriced={site.unpricedProducts} />
                          </p>
                          <p className="text-sm text-gray-700">{site.itemCount} items</p>
                        </div>
                      </div>
                      <p className="mt-1 text-sm text-gray-700">
                        {site.orderCount} order{site.orderCount === 1 ? '' : 's'} ·{' '}
                        {site.productCount} product{site.productCount === 1 ? '' : 's'}
                        {/* Signed off is not the same as gone, and a usage figure read as
                            delivered would be wrong by however much is still waiting. */}
                        {site.ordersWithMercium < site.orderCount && (
                          <span className="text-amber-900">
                            {' '}· {site.orderCount - site.ordersWithMercium} not sent to Mercium yet
                          </span>
                        )}
                        {site.unpricedProducts > 0 && (
                          <span className="text-amber-900">
                            {' '}· {site.unpricedItems} item{site.unpricedItems === 1 ? '' : 's'} with no price
                          </span>
                        )}
                      </p>
                      <button
                        type="button"
                        className="mt-2 min-h-[44px] text-everglade underline"
                        aria-expanded={openSite === site.siteCode}
                        onClick={() => setOpenSite(openSite === site.siteCode ? null : site.siteCode)}
                      >
                        {openSite === site.siteCode ? 'Hide the products' : 'Show the products'}
                      </button>
                      {openSite === site.siteCode && (
                        <ul className="mt-2 divide-y divide-gray-200">
                          {site.products.map((p) => (
                            <li key={p.productId} className="py-2">
                              <div className="flex items-baseline justify-between gap-3">
                                <span className="text-gray-900">{p.productName}</span>
                                <span className="whitespace-nowrap text-right">
                                  <span className="font-semibold text-gray-900">
                                    {p.qty}
                                    {p.orders > 1 && (
                                      <span className="ml-1 text-sm font-normal text-gray-700">
                                        over {p.orders} orders
                                      </span>
                                    )}
                                  </span>
                                  <span className="ml-3 font-semibold text-gray-900">
                                    {/* A dash, not £0.00. There is no price, and a zero
                                        would be read as a free line. */}
                                    {p.cost === null ? <span className="text-gray-500">—</span> : money(p.cost)}
                                  </span>
                                </span>
                              </div>
                              {/* Why there is no price, and what is odd about the one
                                  there is. Either is the difference between a figure
                                  somebody can act on and one they have to go and check. */}
                              {(p.gapReason ?? p.priceNote) && (
                                <p className="mt-0.5 text-sm text-amber-900">
                                  {p.gapReason ?? p.priceNote}
                                </p>
                              )}
                              {p.unitPrice !== null && (
                                <p className="mt-0.5 text-sm text-gray-600">
                                  {money(p.unitPrice)} each
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className={`${card} divide-y divide-gray-200`}>
                  {report.productTotals.map((p) => (
                    <li key={p.productId} className="py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-gray-900">{p.productName}</span>
                        <span className="whitespace-nowrap text-right">
                          <span className="font-semibold text-gray-900">{p.qty}</span>
                          <span className="ml-3 font-semibold text-gray-900">
                            {p.cost === null ? <span className="text-gray-500">—</span> : money(p.cost)}
                          </span>
                        </span>
                      </div>
                      {(p.gapReason ?? p.priceNote) && (
                        <p className="mt-0.5 text-sm text-amber-900">{p.gapReason ?? p.priceNote}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <a href={`/api/admin/ordered/${month}/csv`} className={`tappable ${btnSecondary}`}>
                Download CSV
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

      <a href="/api/admin/par-levels.csv" className={`tappable ${btnSecondary}`}>
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
        className={btnSecondary}
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
            <li key={job} className={`${card} p-3 flex justify-between gap-3`}>
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
            <li key={`${run.job}-${run.started_at}-${i}`} className={`${card} p-3`}>
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

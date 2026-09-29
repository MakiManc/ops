import { useCallback, useEffect, useMemo, useState } from 'react'
import { FreshnessBanner, type Freshness } from './Freshness.tsx'
import { money, qty, shortDate, STATUS_CHIP, timeAgo, type StockStatus } from './format.ts'
import { btnPrimary, btnQuiet, btnSecondary, card, input } from './ui.ts'

/**
 * The catalogue a GM browses.
 *
 * Read-only in Phase 2: this is where the stock figures become visible and get
 * checked against reality, and each row can be added to the open request.
 */

export interface CatalogueProduct {
  productId: number
  name: string
  category: string | null
  packSize: number | null
  unit: string | null
  imageUrl: string | null
  available: number | null
  availableBasis: string
  status: StockStatus
  stockSyncedAt: string | null
  parLevel: number | null
  inboundQty: number | null
  inboundExpected: string | null
  rechargeUnitPrice: number | null
  mappedLines: number
  /** How many are already on the open request, so a second tap is never a silent double. */
  qtyInRequest?: number
}

interface CatalogueResponse {
  site: { id: number; code: string; name: string; recharge: boolean }
  freshness: Freshness
  products: CatalogueProduct[]
  /** Opening-kit products (furniture, signage) left out of this list. */
  hiddenExpansion?: number
}

function StatusChip({ status }: { status: StockStatus }) {
  const chip = STATUS_CHIP[status]
  // The label carries the meaning; the colour only reinforces it.
  return (
    <span className={`inline-block rounded border px-2 py-1 text-xs font-semibold ${chip.className}`}>
      {chip.label}
    </span>
  )
}


/**
 * Adding one product to the open request.
 *
 * The stepper defaults to 1 rather than the par shortfall: a GM who wants a case knows
 * it, and a box pre-filled with a number they did not choose is the kind of thing that
 * gets submitted unread.
 *
 * Nothing here decides whether the quantity is allowed. The server re-checks against
 * stock, par levels and the ordering gap, and the basket shows what it said — so a
 * refusal arrives with a reason rather than the button just being disabled.
 */
function AddToRequest({ siteId, product, onAdded }: {
  siteId: number; product: CatalogueProduct; onAdded: () => void
}) {
  const [qtyWanted, setQtyWanted] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  const inRequest = product.qtyInRequest ?? 0

  const add = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/request/lines`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.productId, qty: qtyWanted }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Could not add it (${res.status}).`)
      }
      setAdded(true)
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it.')
    } finally { setBusy(false) }
  }, [siteId, product.productId, qtyWanted, onAdded])

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`qty-${product.productId}`}>
          Quantity of {product.name}
        </label>
        <div className="flex items-center">
          <button
            type="button"
            aria-label={`One fewer ${product.name}`}
            className="min-h-[44px] min-w-[44px] rounded-l-lg border border-gray-400 text-lg"
            onClick={() => setQtyWanted((q) => Math.max(1, q - 1))}
            disabled={busy || qtyWanted <= 1}
          >
            −
          </button>
          <input
            id={`qty-${product.productId}`}
            inputMode="numeric"
            className="min-h-[44px] w-16 border-y border-gray-400 bg-white text-center font-semibold"
            value={qtyWanted}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^0-9]/g, ''))
              setQtyWanted(Number.isFinite(n) && n > 0 ? n : 1)
            }}
          />
          <button
            type="button"
            aria-label={`One more ${product.name}`}
            className="min-h-[44px] min-w-[44px] rounded-r-xl border border-gray-400 bg-white text-lg"
            onClick={() => setQtyWanted((q) => q + 1)}
            disabled={busy}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className={inRequest > 0 || added ? btnSecondary : btnSecondary}
          onClick={() => void add()}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? 'Adding…' : inRequest > 0 || added ? 'Add more' : 'Add to request'}
        </button>
      </div>
      {/* What is already on the request, so someone interrupted mid-tap can see whether
          it registered rather than guessing and doubling it. */}
      {inRequest > 0 && !error && (
        <p className="mt-2 text-sm font-medium text-everglade" role="status">
          ✓ {inRequest} already in this request
        </p>
      )}
      {error && <p className="mt-1 text-sm text-red-700" role="alert">{error}</p>}
    </div>
  )
}

function ProductCard({ product, showPrices, siteId, onAdded }: {
  product: CatalogueProduct; showPrices: boolean; siteId: number; onAdded: () => void
}) {
  const unknown = product.available === null

  return (
    <li className={`${card} flex gap-4 ${(product.qtyInRequest ?? 0) > 0 ? 'border-everglade' : ''}`}>
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          // Decorative: the name is right beside it, so announcing the filename twice
          // would only add noise for a screen reader.
          alt=""
          className="w-20 h-20 object-cover rounded-xl bg-gray-100 shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="w-20 h-20 rounded-xl bg-gray-100 shrink-0 flex items-center justify-center text-gray-400 text-xs" aria-hidden="true">No photo</div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold text-gray-900">{product.name}</h3>
          <StatusChip status={product.status} />
        </div>

        <p className="text-sm text-gray-700">
          {product.packSize ? `${product.packSize} per pack` : 'Pack size not set'}
          {product.unit ? ` · ${product.unit}` : ''}
        </p>

        <p className="mt-2 text-gray-900">
          <span className="font-semibold text-lg">{qty(product.available)}</span>
          <span className="text-gray-700"> available</span>
          {product.parLevel != null && (
            <span className="text-gray-600 text-sm"> · par {product.parLevel}</span>
          )}
        </p>

        {/* Why the number is what it is — or why there isn't one. */}
        <p className="mt-1 text-sm text-gray-600">{product.availableBasis}</p>

        {product.inboundQty !== null && product.inboundQty > 0 && (
          <p className="mt-1 text-sm text-blue-900">
            {product.inboundQty} on its way
            {product.inboundExpected ? `, expected ${shortDate(product.inboundExpected)}` : ''}
          </p>
        )}

        {showPrices && (
          <p className="mt-1 text-sm text-purple-900">
            {money(product.rechargeUnitPrice)} each
            {product.rechargeUnitPrice === null && ' — no price set, so this cannot be recharged yet'}
          </p>
        )}

        <p className="mt-2 text-xs text-gray-500">
          {unknown ? 'No stock reading' : `Stock read ${timeAgo(product.stockSyncedAt)}`}
          {product.mappedLines > 1 && ` · combines ${product.mappedLines} warehouse lines`}
        </p>

        <AddToRequest siteId={siteId} product={product} onAdded={onAdded} />
      </div>
    </li>
  )
}

export function Catalogue({ siteId, onGoToBasket, canOrderExpansion = false }: {
  siteId: number; onGoToBasket?: () => void
  /** Approvers and admins can ask for the opening kit; a GM never sees it. */
  canOrderExpansion?: boolean
}) {
  const [data, setData] = useState<CatalogueResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [inStockOnly, setInStockOnly] = useState(false)
  const [category, setCategory] = useState<string | null>(null)
  const [includeExpansion, setIncludeExpansion] = useState(false)
  const [reloads, setReloads] = useState(0)
  // How much is already in the open request. Without it, adding something gives no
  // sign it worked and no way to reach the basket from here.
  const [inRequest, setInRequest] = useState(0)

  const refreshRequest = useCallback(async () => {
    try {
      const res = await fetch(`/api/sites/${siteId}/request`, { credentials: 'same-origin' })
      if (!res.ok) return
      const body = await res.json() as { lines?: { productId?: number; qtyRequested?: number }[] }
      const lines = body.lines ?? []
      setInRequest(lines.length)
      // Keep each card's "already in this request" honest without refetching 93 products.
      setData((d) => d && {
        ...d,
        products: d.products.map((p) => ({
          ...p, qtyInRequest: lines.find((l) => l.productId === p.productId)?.qtyRequested ?? 0,
        })),
      })
    } catch { /* the count is a convenience; the basket screen is the source of truth */ }
  }, [siteId])

  useEffect(() => { void refreshRequest() }, [refreshRequest])

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    const query = includeExpansion ? '?include=expansion' : ''
    fetch(`/api/sites/${siteId}/catalogue${query}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json() as CatalogueResponse
        if (!cancelled) setData(body)
      })
      .catch(() => { if (!cancelled) setError('The stock list could not be loaded.') })
    return () => { cancelled = true }
  }, [siteId, includeExpansion, reloads])

  const groups = useMemo(() => {
    if (!data) return []
    const term = search.trim().toLowerCase()
    const filtered = data.products.filter((p) => {
      if (term && !p.name.toLowerCase().includes(term)) return false
      // "In stock only" hides what is genuinely out — never what is merely unknown,
      // which would quietly shrink the list without saying so.
      if (inStockOnly && p.status === 'out') return false
      if (category && (p.category ?? 'Everything else') !== category) return false
      return true
    })
    const byCategory = new Map<string, CatalogueProduct[]>()
    for (const p of filtered) {
      const key = p.category ?? 'Everything else'
      byCategory.set(key, [...(byCategory.get(key) ?? []), p])
    }
    return [...byCategory.entries()]
  }, [data, search, inStockOnly, category])

  // Every category in the catalogue, unfiltered, so the chips do not vanish as you filter.
  const categories = useMemo(() => {
    if (!data) return []
    const seen = new Map<string, number>()
    for (const p of data.products) {
      const key = p.category ?? 'Everything else'
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    return [...seen.entries()]
  }, [data])

  if (error) {
    return (
      <div className={card}>
        <p role="alert" className="text-red-800">{error}</p>
        <button onClick={() => setReloads((n) => n + 1)} className={`mt-3 ${btnQuiet}`}>Try again</button>
      </div>
    )
  }
  if (!data) return <p role="status" className="p-4 text-gray-700">Loading the stock list…</p>

  const total = data.products.length
  const shown = groups.reduce((n, [, items]) => n + items.length, 0)
  const clearFilters = () => { setSearch(''); setInStockOnly(false); setCategory(null) }

  return (
    <div className="space-y-4">
      <FreshnessBanner freshness={data.freshness} />

      {/* Search, the stock filter and the categories stay pinned under the header, so
          finding the next product is never a scroll back to the top. */}
      <div className="sticky top-[60px] z-10 -mx-4 px-4 py-3 bg-gray-50/95 backdrop-blur border-b border-gray-200 space-y-2">
        <div className="flex gap-2">
          <label htmlFor="catalogue-search" className="sr-only">Search products</label>
          <input
            id="catalogue-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search: bowls, chopsticks…"
            className={input}
          />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 -mb-1" role="group" aria-label="Filter by category">
          <button
            type="button"
            onClick={() => setCategory(null)}
            aria-pressed={category === null}
            className={`min-h-[40px] shrink-0 rounded-full border px-3 text-sm font-medium ${
              category === null ? 'bg-everglade border-everglade text-paper' : 'bg-white border-gray-400 text-gray-900'}`}
          >
            All
          </button>
          {categories.map(([name, count]) => (
            <button
              key={name}
              type="button"
              onClick={() => setCategory(category === name ? null : name)}
              aria-pressed={category === name}
              className={`min-h-[40px] shrink-0 rounded-full border px-3 text-sm font-medium ${
                category === name ? 'bg-everglade border-everglade text-paper' : 'bg-white border-gray-400 text-gray-900'}`}
            >
              {name} <span className="opacity-70">{count}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <label className="flex items-center gap-2 text-sm text-gray-800 min-h-[44px]">
            <input
              type="checkbox"
              checked={inStockOnly}
              onChange={(e) => setInStockOnly(e.target.checked)}
              className="w-5 h-5 accent-[#1C463E]"
            />
            Hide products that are out of stock
          </label>
          {canOrderExpansion && (
            <label className="flex items-center gap-2 text-sm text-gray-800 min-h-[44px]">
              <input
                type="checkbox"
                checked={includeExpansion}
                onChange={(e) => setIncludeExpansion(e.target.checked)}
                className="w-5 h-5 accent-[#1C463E]"
              />
              Include opening kit (furniture, signage)
            </label>
          )}
          {/* Say when the list is filtered, so a short list never reads as a small
              catalogue. Not a live region: it changes on every keystroke of the search
              box, and having that announced over the staleness banner would bury the
              message that matters. */}
          <p className="text-sm text-gray-600">
            {shown === total ? `${total} products` : `${shown} of ${total} products`}
          </p>
        </div>

        {inRequest > 0 && (
          <div className="rounded-xl bg-everglade text-paper pl-3 pr-1.5 py-1.5 flex items-center justify-between gap-3">
            <span className="text-sm">
              <strong>{inRequest}</strong> {inRequest === 1 ? 'product' : 'products'} in this request
            </span>
            {onGoToBasket && (
              <button type="button" onClick={onGoToBasket} className={`${btnPrimary} min-h-[40px] px-4 whitespace-nowrap`}>
                Review and send
              </button>
            )}
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <div className={`${card} text-center`}>
          <p className="text-gray-700">
            {total === 0 ? 'There is nothing in the stock list for this site yet.' : 'Nothing matches that search.'}
          </p>
          {total > 0 && (
            <button onClick={clearFilters} className={`mt-3 ${btnQuiet}`}>Show everything</button>
          )}
        </div>
      ) : (
        groups.map(([name, items]) => (
          <section key={name} aria-labelledby={`cat-${name}`}>
            <h2 id={`cat-${name}`} className="text-xs font-semibold uppercase tracking-wider text-everglade mt-6">
              {name}
            </h2>
            <ul className="mt-2 grid gap-3">
              {items.map((p) => (
                <ProductCard
                  key={p.productId}
                  product={p}
                  showPrices={data.site.recharge}
                  siteId={siteId}
                  onAdded={() => void refreshRequest()}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

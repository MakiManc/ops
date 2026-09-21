import { useEffect, useMemo, useState } from 'react'
import { FreshnessBanner, type Freshness } from './Freshness.tsx'
import { money, qty, shortDate, STATUS_CHIP, timeAgo, type StockStatus } from './format.ts'

/**
 * The catalogue a GM browses.
 *
 * Read-only in Phase 2: this is where the stock figures become visible and get
 * checked against reality. The basket and ordering arrive in Phase 3.
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
}

interface CatalogueResponse {
  site: { id: number; code: string; name: string; recharge: boolean }
  freshness: Freshness
  products: CatalogueProduct[]
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

function ProductCard({ product, showPrices }: { product: CatalogueProduct; showPrices: boolean }) {
  const unknown = product.available === null

  return (
    <li className="bg-white border border-gray-300 rounded-xl p-4 flex gap-4">
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          // Decorative: the name is right beside it, so announcing the filename twice
          // would only add noise for a screen reader.
          alt=""
          className="w-20 h-20 object-cover rounded-lg bg-gray-100 shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="w-20 h-20 rounded-lg bg-gray-100 shrink-0" aria-hidden="true" />
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
      </div>
    </li>
  )
}

export function Catalogue({ siteId }: { siteId: number }) {
  const [data, setData] = useState<CatalogueResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [inStockOnly, setInStockOnly] = useState(false)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    fetch(`/api/sites/${siteId}/catalogue`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json() as CatalogueResponse
        if (!cancelled) setData(body)
      })
      .catch(() => { if (!cancelled) setError('The catalogue could not be loaded.') })
    return () => { cancelled = true }
  }, [siteId])

  const groups = useMemo(() => {
    if (!data) return []
    const term = search.trim().toLowerCase()
    const filtered = data.products.filter((p) => {
      if (term && !p.name.toLowerCase().includes(term)) return false
      // "In stock only" hides what is genuinely out — never what is merely unknown,
      // which would quietly shrink the list without saying so.
      if (inStockOnly && p.status === 'out') return false
      return true
    })
    const byCategory = new Map<string, CatalogueProduct[]>()
    for (const p of filtered) {
      const key = p.category ?? 'Everything else'
      byCategory.set(key, [...(byCategory.get(key) ?? []), p])
    }
    return [...byCategory.entries()]
  }, [data, search, inStockOnly])

  if (error) return <p role="alert" className="p-4 text-red-800">{error}</p>
  if (!data) return <p role="status" className="p-4 text-gray-700">Loading the catalogue…</p>

  const total = data.products.length
  const shown = groups.reduce((n, [, items]) => n + items.length, 0)

  return (
    <div className="space-y-4">
      <FreshnessBanner freshness={data.freshness} />

      <div className="space-y-3">
        <div>
          <label htmlFor="catalogue-search" className="block text-sm font-medium text-gray-800">
            Search products
          </label>
          <input
            id="catalogue-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Bowls, chopsticks…"
            className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2"
          />
        </div>

        <label className="flex items-center gap-3 text-gray-800">
          <input
            type="checkbox"
            checked={inStockOnly}
            onChange={(e) => setInStockOnly(e.target.checked)}
            className="w-5 h-5"
          />
          Hide products that are out of stock
        </label>
      </div>

      {/* Say when the list is filtered, so a short list never reads as a small catalogue.
          Not a live region: it changes on every keystroke of the search box, and having
          that announced over the staleness banner would bury the message that matters. */}
      <p className="text-sm text-gray-600">
        {shown === total ? `${total} products` : `${shown} of ${total} products`}
      </p>

      {groups.length === 0 ? (
        <p className="text-gray-700">Nothing matches that search.</p>
      ) : (
        groups.map(([category, items]) => (
          <section key={category} aria-labelledby={`cat-${category}`}>
            <h2 id={`cat-${category}`} className="text-sm font-semibold uppercase tracking-wide text-gray-600 mt-6">
              {category}
            </h2>
            <ul className="mt-2 grid gap-3">
              {items.map((p) => (
                <ProductCard key={p.productId} product={p} showPrices={data.site.recharge} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

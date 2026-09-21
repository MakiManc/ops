import { useEffect, useState } from 'react'
import { FreshnessBanner, type Freshness } from './Freshness.tsx'
import { qty, shortDate, timeAgo } from './format.ts'

/**
 * What an approver looks at before signing anything off.
 *
 * A wide table on a desktop, stacked cards on a phone — approvers do use this on a
 * phone, and a table that scrolls sideways is unusable one-handed.
 */

interface OverviewProduct {
  productId: number
  name: string
  category: string | null
  onHand: number | null
  allocated: number | null
  available: number | null
  availableBasis: string
  oversold: boolean
  stockSyncedAt: string | null
  pendingDemand: number
  inboundQty: number | null
  inboundExpected: string | null
  weeksOfCover: number | null
  weeksOfCoverBasis: string
  mappedLines: number
  flags: string[]
}

interface OverviewResponse {
  freshness: Freshness
  unmappedMintsoftLines: number
  products: OverviewProduct[]
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-600">{label}</dt>
      <dd className="text-lg font-semibold text-gray-900">{value}</dd>
    </div>
  )
}

function ProductRow({ product }: { product: OverviewProduct }) {
  return (
    <li className="bg-white border border-gray-300 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900">{product.name}</h3>
          {product.category && <p className="text-sm text-gray-600">{product.category}</p>}
        </div>
        <p className="text-xs text-gray-500 whitespace-nowrap">
          {product.stockSyncedAt ? timeAgo(product.stockSyncedAt) : 'no reading'}
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Figure label="On hand" value={qty(product.onHand)} />
        <Figure label="Allocated" value={qty(product.allocated)} />
        <Figure label="Available" value={qty(product.available)} />
        <Figure label="Requested" value={String(product.pendingDemand)} />
        <Figure label="Inbound" value={qty(product.inboundQty)} />
      </dl>

      <p className="mt-2 text-sm text-gray-700">{product.availableBasis}</p>

      <p className="mt-1 text-sm text-gray-700">
        {product.weeksOfCover === null
          ? product.weeksOfCoverBasis
          : `About ${product.weeksOfCover} weeks of cover. ${product.weeksOfCoverBasis}`}
      </p>

      {product.inboundQty !== null && product.inboundQty > 0 && product.inboundExpected && (
        <p className="mt-1 text-sm text-blue-900">
          Next delivery expected {shortDate(product.inboundExpected)}.
        </p>
      )}

      {product.flags.length > 0 && (
        <ul className="mt-3 space-y-1">
          {product.flags.map((flag) => (
            <li key={flag} className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded px-2 py-1">
              {flag}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function StockOverview() {
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/approvals/stock', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const body = await res.json() as OverviewResponse
        if (!cancelled) setData(body)
      })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [])

  if (error) return <p role="alert" className="p-4 text-red-800">The stock overview could not be loaded.</p>
  if (!data) return <p role="status" className="p-4 text-gray-700">Loading stock…</p>

  return (
    <div className="space-y-4">
      <FreshnessBanner freshness={data.freshness} />

      {data.unmappedMintsoftLines > 0 && (
        // Unmapped lines are stock sitting in the warehouse that no site can order,
        // and it will not show up anywhere else.
        <p role="status" className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-amber-900">
          {data.unmappedMintsoftLines} warehouse {data.unmappedMintsoftLines === 1 ? 'line is' : 'lines are'} not
          mapped to a product yet, so that stock is invisible to sites. An admin can map
          {data.unmappedMintsoftLines === 1 ? ' it' : ' them'} under Catalogue mapping.
        </p>
      )}

      <p className="text-sm text-gray-600">{data.products.length} products</p>

      <ul className="grid gap-3">
        {data.products.map((p) => <ProductRow key={p.productId} product={p} />)}
      </ul>
    </div>
  )
}

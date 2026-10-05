/**
 * One order, on its own page, at its own address.
 *
 * `#order/9` opens it, so it survives a refresh and can be sent to somebody: Ross can
 * message Francheska a link to the order they are talking about instead of "open the
 * portal and scroll". That is the whole reason this is a page rather than a panel that
 * expands inside the list.
 *
 * What it answers, in the order a person asks it: what is coming, how much, where has it
 * got to, and what is the number for chasing it.
 */
import { useCallback, useEffect, useState } from 'react'
import { shortDate, timeAgo } from './format.ts'
import { mintsoftStatusName, mintsoftStatusNeedsAttention } from '../lib/mintsoft/order-status.ts'
import { btnQuiet, btnSecondary, card } from './ui.ts'

interface Line {
  productId: number
  productName: string
  qtyRequested: number
  qtyApproved: number | null
}

interface Detail {
  order: {
    id: number
    orderNumber: string
    mintsoftOrderNumber: string | null
    siteCode: string
    siteName: string
    status: string
    requesterName: string | null
    requiredDate: string | null
    notes: string | null
    earlyOrderReason: string | null
    submittedAt: string | null
    approvedAt: string | null
    despatchedAt: string | null
    mergedIntoOrderNumber: string | null
    mintsoftStatusId: number | null
    mintsoftStatusAt: string | null
    trackingNumber: string | null
    trackingUrl: string | null
  }
  lines: Line[]
}

/** The portal's own words for where an order has got to. */
const WHERE: Record<string, string> = {
  draft: 'Still being built — not sent for sign-off yet.',
  submitted: 'Waiting for sign-off.',
  approved: 'Signed off, and about to go to the warehouse.',
  posted: 'Mercium have it.',
  despatched: 'It has left the warehouse.',
  rejected: 'Sent back — have a look at the reason and try again.',
  cancelled: 'Cancelled.',
  post_failed: 'It was signed off but could not reach the warehouse. Someone is looking at it.',
}

export function OrderPage({ orderId, onBack }: { orderId: number; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<'missing' | 'failed' | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/orders/${orderId}`, { credentials: 'same-origin' })
      // 404 covers both "no such order" and "not one of your sites", deliberately: the
      // server does not tell a GM that another site's order exists.
      if (res.status === 404) { setError('missing'); return }
      if (!res.ok) throw new Error()
      setData(await res.json() as Detail)
    } catch {
      setError('failed')
    }
  }, [orderId])

  useEffect(() => { void load() }, [load])

  if (error === 'missing') {
    return (
      <div className="space-y-3">
        <p className="text-gray-900">
          There is no order here. Either the link is wrong, or it is an order for a site
          you do not cover.
        </p>
        <button type="button" className={btnQuiet} onClick={onBack}>Back to the orders list</button>
      </div>
    )
  }
  if (error === 'failed') {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-red-900 bg-red-50 border border-red-300 rounded p-3">
          This order could not be loaded.
        </p>
        <button type="button" className={btnQuiet} onClick={() => void load()}>Try again</button>
      </div>
    )
  }
  if (!data) return <p role="status" className="text-gray-700">Loading the order…</p>

  const { order, lines } = data
  const coming = lines.filter((l) => (l.qtyApproved ?? 0) > 0)
  const notComing = lines.filter((l) => (l.qtyApproved ?? 0) === 0)
  const totalItems = coming.reduce((n, l) => n + (l.qtyApproved ?? 0), 0)
  // Before sign-off nothing has been approved, so the requested figure is the only one
  // there is and the "approved" column would read as a row of zeros.
  const beforeSignOff = ['draft', 'submitted'].includes(order.status)

  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="font-heading text-lg font-semibold text-gray-900">
          {order.mintsoftOrderNumber ?? order.orderNumber}
        </h2>
        <p className="text-sm text-gray-700">
          {order.siteCode} · {order.siteName}
          {order.mintsoftOrderNumber && order.mintsoftOrderNumber !== order.orderNumber
            && ` · ours: ${order.orderNumber}`}
        </p>
        <p className="mt-2 text-gray-900">{WHERE[order.status] ?? order.status}</p>
        {order.requiredDate && (
          <p className="mt-1 text-sm text-gray-700">Needed by {shortDate(order.requiredDate)}.</p>
        )}
        {order.requesterName && (
          <p className="text-sm text-gray-700">Asked for by {order.requesterName}.</p>
        )}
      </div>

      {order.mergedIntoOrderNumber && (
        <p className="rounded-xl border border-maki-orange bg-cherry p-3 text-woodsmoke">
          <strong>Combined with {order.mergedIntoOrderNumber}.</strong> Everything on this
          request moved onto that order, so it comes in one delivery. Nothing was dropped.
        </p>
      )}

      {mintsoftStatusNeedsAttention(order.mintsoftStatusId) && (
        <p role="status" className="rounded-xl border border-amber-400 bg-amber-50 p-3 text-gray-900">
          <strong>Mercium have this as “{mintsoftStatusName(order.mintsoftStatusId)}”.</strong>{' '}
          That is not the same as what the portal says above, and theirs is the one that
          decides whether anything ships.
          {order.mintsoftStatusAt && (
            <span className="block mt-1 text-sm text-gray-700">
              Read from Mercium {timeAgo(order.mintsoftStatusAt)}.
            </span>
          )}
        </p>
      )}

      <section aria-labelledby="items" className={card}>
        <h3 id="items" className="font-heading font-semibold text-gray-900">
          {beforeSignOff ? 'What has been asked for' : 'What is on this order'}
        </h3>

        {lines.length === 0 ? (
          <p className="mt-2 text-gray-700">There is nothing on it.</p>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-gray-200">
              {(beforeSignOff ? lines : coming).map((l) => (
                <li key={l.productId} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="text-gray-900">{l.productName}</span>
                  <span className="whitespace-nowrap font-semibold text-gray-900">
                    {beforeSignOff ? l.qtyRequested : l.qtyApproved}
                    {!beforeSignOff && l.qtyApproved !== l.qtyRequested && (
                      <span className="ml-1 text-sm font-normal text-gray-700">
                        (asked for {l.qtyRequested})
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>

            {!beforeSignOff && notComing.length > 0 && (
              // Listed as "0" these read as an order for none. A GM counting boxes needs
              // to know the shortage was a decision before they ring anyone about it.
              <p className="mt-3 border-t border-gray-300 pt-3 text-sm text-gray-900">
                <strong>Not coming:</strong>{' '}
                {notComing.map((l) => `${l.productName} (asked for ${l.qtyRequested})`).join(', ')}.{' '}
                {notComing.length === 1 ? 'It was' : 'They were'} signed off at nothing, so
                Mercium are not picking {notComing.length === 1 ? 'it' : 'them'}.
              </p>
            )}

            {!beforeSignOff && (
              <p className="mt-2 text-sm text-gray-700">
                {coming.length === 1 ? '1 product' : `${coming.length} products`}
                {coming.length > 0 && `, ${totalItems} items in total`}.
              </p>
            )}
          </>
        )}
      </section>

      {(order.trackingNumber || order.trackingUrl) && (
        <section aria-labelledby="tracking" className={card}>
          <h3 id="tracking" className="font-heading font-semibold text-gray-900">Tracking</h3>
          {order.trackingNumber && (
            <p className="mt-2 text-gray-900">
              <span className="font-mono font-semibold tracking-wide select-all">
                {order.trackingNumber}
              </span>
            </p>
          )}
          {order.trackingUrl && (
            <a
              href={order.trackingUrl}
              target="_blank"
              rel="noreferrer"
              className={`tappable mt-3 inline-flex ${btnSecondary}`}
            >
              Track this delivery
            </a>
          )}
        </section>
      )}

      {(order.notes || order.earlyOrderReason) && (
        <section aria-labelledby="notes" className={card}>
          <h3 id="notes" className="font-heading font-semibold text-gray-900">Notes</h3>
          {order.earlyOrderReason && (
            <p className="mt-2 text-sm text-gray-900">
              <strong>Ordered early:</strong> {order.earlyOrderReason}
            </p>
          )}
          {order.notes && <p className="mt-2 text-sm text-gray-900">{order.notes}</p>}
        </section>
      )}

      <button type="button" className={btnQuiet} onClick={onBack}>Back to the orders list</button>
    </div>
  )
}

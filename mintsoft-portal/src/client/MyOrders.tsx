import { useCallback, useEffect, useMemo, useState } from 'react'
import { shortDate, timeAgo } from './format.ts'
import { btnDanger, btnPrimary, btnQuiet, btnSecondary, card, input } from './ui.ts'

/**
 * What a GM sees after submitting.
 *
 * The timeline is in plain language rather than system states. A GM does not need to
 * know what "posted" means; they need to know whether anything is coming and roughly
 * when. Note there is no "Delivered" step — the warehouse's order record cannot tell us
 * a box arrived, so the portal does not claim it.
 */

interface Order {
  id: number
  orderNumber: string
  siteCode: string
  siteName?: string
  status: 'draft' | 'submitted' | 'approved' | 'posted' | 'despatched' | 'rejected' | 'cancelled' | 'post_failed'
  requesterName: string | null
  rejectedReason: string | null
  submittedAt: string | null
  approvedAt: string | null
  despatchedAt: string | null
  mintsoftOrderNumber: string | null
  /** Set when this request's lines were folded into another order for the same site. */
  mergedIntoOrderNumber: string | null
  trackingUrl: string | null
  createdAt: string
  recharge: boolean
  rechargeTotal: number | null
}

/** Each status in words a GM would use, with what it actually means for them. */
const PLAIN: Record<Order['status'], { label: string; detail: string; tone: string }> = {
  draft: { label: 'Not sent yet', detail: 'Still being put together.', tone: 'bg-gray-100 text-gray-900 border-gray-300' },
  submitted: { label: 'Waiting for sign-off', detail: 'Ross or Francheska will look at it.', tone: 'bg-amber-100 text-amber-900 border-amber-400' },
  approved: { label: 'Approved', detail: 'Signed off and about to go to the warehouse.', tone: 'bg-blue-100 text-blue-900 border-blue-300' },
  posted: { label: 'Sent to warehouse', detail: 'Mercium have it and are picking it.', tone: 'bg-blue-100 text-blue-900 border-blue-300' },
  despatched: { label: 'On its way', detail: 'It has left the warehouse.', tone: 'bg-green-100 text-green-900 border-green-300' },
  rejected: { label: 'Sent back', detail: 'Have a look at the reason and try again.', tone: 'bg-red-100 text-red-900 border-red-300' },
  cancelled: { label: 'Cancelled', detail: 'This request was cancelled.', tone: 'bg-gray-100 text-gray-900 border-gray-300' },
  post_failed: {
    label: 'Stuck', detail: 'It was approved but could not reach the warehouse. Someone is looking at it.',
    tone: 'bg-red-100 text-red-900 border-red-300',
  },
}

/** The steps a healthy order goes through, so a GM can see where it has got to. */
const JOURNEY: Order['status'][] = ['submitted', 'approved', 'posted', 'despatched']

/** A request that has not reached the warehouse can still be pulled back. */
const CANCELLABLE: Order['status'][] = ['draft', 'submitted', 'approved']

function Timeline({ order }: { order: Order }) {
  // Side exits do not belong on a progress line; they are the end of the story.
  if (['rejected', 'cancelled', 'post_failed', 'draft'].includes(order.status)) return null
  const reached = JOURNEY.indexOf(order.status)

  return (
    <ol className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm">
      {JOURNEY.map((step, i) => (
        <li key={step} className={i <= reached ? 'text-gray-900 font-medium' : 'text-gray-500'}>
          {i <= reached ? '✓ ' : ''}{PLAIN[step].label}
          {i < JOURNEY.length - 1 && <span className="text-gray-400" aria-hidden="true"> ›</span>}
        </li>
      ))}
    </ol>
  )
}

/**
 * Cancelling asks once, inline, and says what will happen. A request that is
 * "Waiting for sign-off" mid-service is exactly the one a GM realises is wrong; the
 * API has always allowed this, the screen just never offered it.
 */
function CancelControl({ order, onCancelled }: { order: Order; onCancelled: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cancel = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/orders/${order.id}/cancel`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? 'That could not be cancelled.')
        return
      }
      onCancelled()
    } catch {
      setError('That could not be cancelled — check your connection and try again.')
    } finally { setBusy(false) }
  }

  if (!confirming) {
    return (
      <button onClick={() => setConfirming(true)} className={btnDanger}>
        Cancel this request
      </button>
    )
  }
  return (
    <div className="w-full rounded-xl border border-red-300 bg-red-50 p-3 space-y-2">
      <p className="text-sm text-red-900 font-medium">
        Cancel request {order.orderNumber}? It will not be sent to the warehouse. You can
        start a new one afterwards.
      </p>
      <label htmlFor={`cancel-why-${order.id}`} className="block text-sm text-red-900">
        Why? <span className="text-red-800/80">(optional, so the approver knows)</span>
      </label>
      <input
        id={`cancel-why-${order.id}`} value={reason} onChange={(e) => setReason(e.target.value)}
        className={input}
      />
      {error && <p role="alert" className="text-sm text-red-900">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void cancel()} disabled={busy} className={btnDanger}>
          {busy ? 'Cancelling…' : 'Yes, cancel it'}
        </button>
        <button onClick={() => setConfirming(false)} disabled={busy} className={btnQuiet}>
          Keep it
        </button>
      </div>
    </div>
  )
}

export function MyOrders({ justSent = null, onSeen, onGoToCatalogue }: {
  /** The order number just sent from the basket, so this screen can say so. */
  justSent?: string | null
  /** Called once the confirmation has been shown, so it is not shown again later. */
  onSeen?: () => void
  onGoToCatalogue?: () => void
} = {}) {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [error, setError] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [siteFilter, setSiteFilter] = useState<string>('')
  /** Per-order feedback, rendered in the card it belongs to rather than at the top. */
  const [cardNote, setCardNote] = useState<Record<number, string>>({})
  const [reordering, setReordering] = useState<number | null>(null)

  const load = useCallback(async () => {
    setError(false)
    try {
      const res = await fetch('/api/my-orders', { credentials: 'same-origin' })
      if (!res.ok) throw new Error()
      setOrders((await res.json() as { orders: Order[] }).orders)
    } catch { setError(true) }
  }, [])

  useEffect(() => { void load() }, [load])

  // The confirmation the send used to lack. It sits here rather than on the basket
  // because this is where the GM lands, and it names the request so they can find it.
  useEffect(() => {
    if (justSent) {
      setMessage(`Request ${justSent} has been sent for sign-off. Ross or Francheska will look at it.`)
      onSeen?.()
    }
  }, [justSent, onSeen])

  const sites = useMemo(() => {
    const seen = new Map<string, string>()
    for (const o of orders ?? []) seen.set(o.siteCode, o.siteName ?? o.siteCode)
    return [...seen.entries()].sort()
  }, [orders])
  const multiSite = sites.length > 1
  const shown = (orders ?? []).filter((o) => !siteFilter || o.siteCode === siteFilter)

  const reorder = async (order: Order) => {
    setReordering(order.id)
    try {
      const res = await fetch(`/api/orders/${order.id}/reorder`, { method: 'POST', credentials: 'same-origin' })
      const body = await res.json().catch(() => ({})) as { error?: string; added?: number }
      setCardNote((n) => ({
        ...n,
        [order.id]: res.ok
          ? `Added ${body.added} item${body.added === 1 ? '' : 's'} to ${order.siteCode}'s current request.`
          : body.error ?? 'That could not be reordered.',
      }))
    } catch {
      setCardNote((n) => ({ ...n, [order.id]: 'That could not be reordered — check your connection and try again.' }))
    } finally { setReordering(null) }
  }

  if (error) {
    return (
      <div className={card}>
        <p role="alert" className="text-red-800">Your orders could not be loaded.</p>
        <button onClick={() => void load()} className={`mt-3 ${btnQuiet}`}>Try again</button>
      </div>
    )
  }
  if (!orders) return <p role="status" className="text-gray-700">Loading…</p>
  if (orders.length === 0) {
    return (
      <div className={`${card} text-center`}>
        <p className="text-gray-700">You have not requested anything yet.</p>
        {onGoToCatalogue && (
          <button onClick={onGoToCatalogue} className={`mt-4 ${btnPrimary}`}>Order stock</button>
        )}
      </div>
    )
  }

  return (
    <>
    {message && (
      <p role="status" className="mb-3 rounded-xl border border-everglade bg-everglade/10 p-3 text-gray-900 font-medium">
        ✓ {message}
      </p>
    )}

    {multiSite && (
      <div className="mb-3 flex items-center gap-2">
        <label htmlFor="site-filter" className="text-sm text-gray-800 whitespace-nowrap">Show</label>
        <select
          id="site-filter" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}
          className="min-h-[44px] rounded-xl border border-gray-400 bg-white px-3"
        >
          <option value="">All sites</option>
          {sites.map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
        </select>
      </div>
    )}

    <ul className="grid gap-3">
      {shown.map((order) => {
        /**
         * An absorbed request wears its own words.
         *
         * It is 'cancelled' in the database because there is no other status for closed
         * and not going, but to the GM reading this "Cancelled" would mean the stock is
         * not coming — when in fact it is, on the order named here.
         */
        const plain = order.mergedIntoOrderNumber
          ? {
              label: 'Combined',
              detail: `Everything on this request moved onto ${order.mergedIntoOrderNumber}, `
                + 'so it comes in one delivery instead of two. Nothing was dropped.',
              tone: 'bg-cherry text-woodsmoke border-maki-orange',
            }
          : PLAIN[order.status]
        const highlight = justSent === order.orderNumber || message?.includes(order.orderNumber)
        return (
          <li key={order.id} className={`${card} ${highlight ? 'border-everglade ring-2 ring-everglade/30' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {/* Once it has gone, lead with the number Mercium uses. Quoting our own
                    reference at them means looking up which order it is first. */}
                <h3 className="font-sans font-semibold text-gray-900 break-all">
                  {order.mintsoftOrderNumber ?? order.orderNumber}
                </h3>
                <p className="text-sm text-gray-600">
                  {/* The site, always: logins are shared and the requester is free text,
                      so on an approver's "All orders" nothing else says whose it is. */}
                  <span className="font-medium text-gray-800">{order.siteCode}</span>
                  {order.siteName ? ` · ${order.siteName}` : ''}
                  {order.mintsoftOrderNumber && <> · ours: {order.orderNumber}</>}
                </p>
                <p className="text-sm text-gray-600">
                  {order.requesterName ? `${order.requesterName} · ` : ''}{timeAgo(order.createdAt)}
                </p>
              </div>
              <span className={`text-xs font-semibold border rounded px-2 py-1 whitespace-nowrap ${plain.tone}`}>
                {plain.label}
              </span>
            </div>

            <p className="mt-2 text-gray-700">{plain.detail}</p>

            {order.status === 'rejected' && order.rejectedReason && (
              <p className="mt-2 text-sm text-red-900 bg-red-50 border border-red-300 rounded-lg p-2">
                {order.rejectedReason}
              </p>
            )}

            <Timeline order={order} />

            {order.despatchedAt && (
              <p className="mt-2 text-sm text-gray-700">Left the warehouse {shortDate(order.despatchedAt)}.</p>
            )}

            {cardNote[order.id] && (
              <p role="status" className="mt-3 rounded-lg border border-everglade bg-everglade/10 p-2 text-sm text-gray-900">
                {cardNote[order.id]}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {order.trackingUrl && (
                <a href={order.trackingUrl} target="_blank" rel="noreferrer" className={`tappable ${btnSecondary}`}>
                  Track this delivery
                </a>
              )}

              {/* Never on an absorbed request: the stock is already coming on the order
                  it was combined with, and offering this is how a GM orders it twice. */}
              {['despatched', 'posted', 'rejected', 'cancelled'].includes(order.status)
                && !order.mergedIntoOrderNumber && (
                <button
                  onClick={() => void reorder(order)}
                  disabled={reordering === order.id}
                  aria-busy={reordering === order.id}
                  className={btnQuiet}
                >
                  {reordering === order.id ? 'Adding…' : 'Order the same again'}
                </button>
              )}

              {CANCELLABLE.includes(order.status) && (
                <CancelControl order={order} onCancelled={() => {
                  setCardNote((n) => ({ ...n, [order.id]: 'Cancelled. Nothing will be sent to the warehouse.' }))
                  void load()
                }} />
              )}
            </div>

            {order.recharge && order.rechargeTotal !== null && (
              <p className="mt-2 text-sm text-purple-900">
                Recharged to your site: £{order.rechargeTotal.toFixed(2)}
              </p>
            )}
          </li>
        )
      })}
    </ul>
    </>
  )
}

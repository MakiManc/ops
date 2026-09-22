import { useEffect, useState } from 'react'
import { shortDate, timeAgo } from './format.ts'

/**
 * What a GM sees after submitting.
 *
 * The timeline is in plain language rather than system states. A GM does not need to
 * know what "posted" means; they need to know whether anything is coming and roughly
 * when. Note there is no "Delivered" step — Mintsoft's order record cannot tell us a
 * box arrived, so the portal does not claim it.
 */

interface Order {
  id: number
  orderNumber: string
  siteCode: string
  status: 'draft' | 'submitted' | 'approved' | 'posted' | 'despatched' | 'rejected' | 'cancelled' | 'post_failed'
  requesterName: string | null
  rejectedReason: string | null
  submittedAt: string | null
  approvedAt: string | null
  despatchedAt: string | null
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

export function MyOrders() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [error, setError] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/my-orders', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error()
        setOrders((await res.json() as { orders: Order[] }).orders)
      })
      .catch(() => setError(true))
  }, [])

  if (error) return <p role="alert" className="text-red-800">Your orders could not be loaded.</p>
  if (!orders) return <p role="status" className="text-gray-700">Loading…</p>
  if (orders.length === 0) return <p className="text-gray-700">You have not requested anything yet.</p>

  return (
    <>
    {message && (
      <p role="status" className="mb-3 text-green-900 bg-green-50 border border-green-300 rounded p-3">
        {message}
      </p>
    )}
    <ul className="grid gap-3">
      {orders.map((order) => {
        const plain = PLAIN[order.status]
        return (
          <li key={order.id} className="bg-white border border-gray-300 rounded-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-gray-900">{order.orderNumber}</h3>
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
              <p className="mt-2 text-sm text-red-900 bg-red-50 border border-red-300 rounded p-2">
                {order.rejectedReason}
              </p>
            )}

            <Timeline order={order} />

            {order.despatchedAt && (
              <p className="mt-2 text-sm text-gray-700">Left the warehouse {shortDate(order.despatchedAt)}.</p>
            )}

            {order.trackingUrl && (
              <a
                href={order.trackingUrl}
                target="_blank"
                rel="noreferrer"
                className="tappable mt-3 inline-block px-4 py-2 rounded-lg bg-gray-900 text-white"
              >
                Track this delivery
              </a>
            )}

            {['despatched', 'posted', 'rejected', 'cancelled'].includes(order.status) && (
              <button
                onClick={async () => {
                  const res = await fetch(`/api/orders/${order.id}/reorder`, {
                    method: 'POST', credentials: 'same-origin',
                  })
                  const body = await res.json().catch(() => ({})) as { error?: string; added?: number }
                  setMessage(res.ok
                    ? `Added ${body.added} item${body.added === 1 ? '' : 's'} to your current request.`
                    : body.error ?? 'That could not be reordered.')
                }}
                className="mt-3 ml-0 px-4 py-2 rounded-lg border border-gray-400 text-gray-900"
              >
                Order the same again
              </button>
            )}

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

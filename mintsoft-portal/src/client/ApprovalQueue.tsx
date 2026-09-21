import { useCallback, useEffect, useState } from 'react'
import { money, qty, shortDate, timeAgo } from './format.ts'

/**
 * The queue an approver works through, oldest first.
 *
 * Everything needed to make the decision is on the card: live stock, what other sites
 * have already asked for, how recently this site last ordered, and any reason given for
 * ordering early. The alternative is opening three other screens per request, which
 * means it does not get done.
 */

interface QueueLine {
  productId: number; productName: string; qtyRequested: number
  available: number | null; availableBasis: string
  otherSitesPending: number; rechargeUnitPrice: number | null
}
interface QueueOrder {
  id: number; orderNumber: string; siteCode: string; siteName: string
  requesterName: string | null; submittedAt: string | null; notes: string | null
  earlyOrderReason: string | null; recharge: boolean
}
interface QueueItem {
  order: QueueOrder
  lines: QueueLine[]
  recentOrders: { orderNumber: string; approvedAt: string | null }[]
  daysSinceLastOrder: number | null
  mergeCandidates: { id: number; orderNumber: string }[]
}

function RequestCard({ item, onChanged }: { item: QueueItem; onChanged: () => void }) {
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(item.lines.map((l) => [l.productId, l.qtyRequested])),
  )
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const act = async (path: string, body: unknown) => {
    setBusy(true); setProblems([])
    try {
      const res = await fetch(path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { problems?: string[]; error?: string }
        setProblems(payload.problems ?? [payload.error ?? 'That could not be done.'])
        return
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const rechargeTotal = item.order.recharge
    ? item.lines.reduce((sum, l) => sum + (quantities[l.productId] ?? 0) * (l.rechargeUnitPrice ?? 0), 0)
    : null

  return (
    <li className="bg-white border border-gray-300 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900">
            {item.order.siteCode} · {item.order.siteName}
          </h3>
          <p className="text-sm text-gray-600">
            {item.order.requesterName ?? 'Unknown'} · {timeAgo(item.order.submittedAt)} · {item.order.orderNumber}
          </p>
        </div>
        {item.order.recharge && (
          <span className="text-xs font-semibold text-purple-900 bg-purple-100 border border-purple-300 rounded px-2 py-1 whitespace-nowrap">
            Recharged
          </span>
        )}
      </div>

      <p className="mt-2 text-sm text-gray-700">
        {item.daysSinceLastOrder === null
          ? 'This site has not ordered before.'
          : `Last order ${item.daysSinceLastOrder} day${item.daysSinceLastOrder === 1 ? '' : 's'} ago.`}
        {item.recentOrders.length > 0 && ` Recent: ${item.recentOrders.map((o) => o.orderNumber).join(', ')}.`}
      </p>

      {item.order.earlyOrderReason && (
        // The reason the GM typed for ordering inside the usual gap. This is the whole
        // point of asking for it.
        <p className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-400 rounded p-2">
          <strong>Ordering early:</strong> {item.order.earlyOrderReason}
        </p>
      )}

      {item.order.notes && (
        <p className="mt-2 text-sm text-gray-800 bg-gray-50 border border-gray-300 rounded p-2">
          {item.order.notes}
        </p>
      )}

      <ul className="mt-3 grid gap-3">
        {item.lines.map((line) => (
          <li key={line.productId} className="border-t border-gray-200 pt-3">
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium text-gray-900">{line.productName}</p>
              <p className="text-sm text-gray-700 whitespace-nowrap">{qty(line.available)} available</p>
            </div>
            <p className="text-xs text-gray-600">{line.availableBasis}</p>

            <div className="mt-2 flex items-center gap-3 flex-wrap">
              <label htmlFor={`q-${item.order.id}-${line.productId}`} className="text-sm text-gray-800">
                Approve
              </label>
              <input
                id={`q-${item.order.id}-${line.productId}`}
                type="number" min={0} inputMode="numeric"
                value={quantities[line.productId] ?? 0}
                onChange={(e) => setQuantities((q) => ({ ...q, [line.productId]: Number(e.target.value) }))}
                className="w-24 rounded-lg border border-gray-400 px-3 py-2"
              />
              <span className="text-sm text-gray-600">of {line.qtyRequested} asked for</span>
            </div>

            {line.otherSitesPending > 0 && (
              // Mintsoft still reports this stock as free to everyone; the portal is
              // the only thing that knows another site has already asked for it.
              <p className="mt-1 text-sm text-amber-900">
                {line.otherSitesPending} also requested by other sites and not yet signed off.
              </p>
            )}

            {item.order.recharge && (
              <p className="mt-1 text-sm text-purple-900">
                {money(line.rechargeUnitPrice)} each
                {line.rechargeUnitPrice === null && ' — no price set, so this cannot be approved'}
              </p>
            )}
          </li>
        ))}
      </ul>

      {rechargeTotal !== null && (
        <p className="mt-3 text-purple-900 font-medium">
          Recharge total: {money(rechargeTotal)} (before any delivery fee)
        </p>
      )}

      {item.mergeCandidates.length > 0 && (
        <div className="mt-3 rounded-lg border border-blue-300 bg-blue-50 p-3">
          <p className="text-blue-900 text-sm">
            This site has another request waiting. Merging them means one delivery fee instead of two.
          </p>
          {item.mergeCandidates.map((candidate) => (
            <button
              key={candidate.id}
              onClick={() => void act(`/api/approvals/${item.order.id}/merge/${candidate.id}`, {})}
              disabled={busy}
              className="mt-2 px-3 py-2 rounded-lg bg-blue-900 text-white text-sm"
            >
              Merge {candidate.orderNumber} into this one
            </button>
          ))}
        </div>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1">
          {problems.map((p) => (
            <li key={p} className="text-sm text-red-900 bg-red-50 border border-red-300 rounded p-2">{p}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          onClick={() => void act(`/api/approvals/${item.order.id}/approve`, {
            lines: item.lines.map((l) => ({ productId: l.productId, qtyApproved: quantities[l.productId] ?? 0 })),
          })}
          disabled={busy}
          className="px-4 py-3 rounded-lg bg-gray-900 text-white font-semibold disabled:bg-gray-400"
        >
          Approve
        </button>
        <button
          onClick={() => setRejecting((r) => !r)}
          className="px-4 py-3 rounded-lg border border-gray-400 text-gray-900"
        >
          Send back
        </button>
      </div>

      {rejecting && (
        <div className="mt-3">
          <label htmlFor={`reject-${item.order.id}`} className="block text-sm font-medium text-gray-800">
            Why, so the site knows what to change
          </label>
          <textarea
            id={`reject-${item.order.id}`} rows={2} value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2"
          />
          <button
            onClick={() => void act(`/api/approvals/${item.order.id}/reject`, { reason: rejectReason })}
            disabled={busy || !rejectReason.trim()}
            className="mt-2 px-4 py-2 rounded-lg bg-red-800 text-white disabled:bg-gray-400"
          >
            Send it back
          </button>
        </div>
      )}
    </li>
  )
}

export function ApprovalQueue() {
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/approvals/queue', { credentials: 'same-origin' })
      if (!res.ok) throw new Error()
      setItems((await res.json() as { requests: QueueItem[] }).requests)
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <p role="alert" className="text-red-800">The queue could not be loaded.</p>
  if (!items) return <p role="status" className="text-gray-700">Loading the queue…</p>
  if (items.length === 0) return <p className="text-gray-700">Nothing waiting for sign-off.</p>

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        {items.length} request{items.length === 1 ? '' : 's'} waiting, oldest first.
      </p>
      <ul className="grid gap-3">
        {items.map((item) => (
          <RequestCard key={item.order.id} item={item} onChanged={() => void load()} />
        ))}
      </ul>
    </div>
  )
}

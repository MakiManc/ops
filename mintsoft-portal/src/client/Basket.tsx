import { useCallback, useEffect, useState } from 'react'
import { money, qty } from './format.ts'

/**
 * The basket a GM submits.
 *
 * Checks are shown as they are, not hidden until submit: someone building a request on
 * a phone should see why something is a problem while they can still do something about
 * it. Nothing here is a silent warning.
 */

interface Check { code: string; severity: 'blocks' | 'needs_reason' | 'note'; message: string; productId?: number }
interface Line {
  productId: number; productName: string; qtyRequested: number
  available: number | null; rechargeUnitPrice: number | null
}
interface RequestBody {
  request: { id: number; orderNumber: string; earlyOrderReason: string | null } | null
  lines: Line[]
  recharge: boolean
  checks: Check[]
}

const SEVERITY_STYLE: Record<Check['severity'], string> = {
  blocks: 'bg-red-50 border-red-300 text-red-900',
  needs_reason: 'bg-amber-50 border-amber-400 text-amber-900',
  note: 'bg-gray-50 border-gray-300 text-gray-800',
}

export function Basket({ siteId, onSubmitted }: { siteId: number; onSubmitted: () => void }) {
  const [data, setData] = useState<RequestBody | null>(null)
  const [requesterName, setRequesterName] = useState('')
  const [requiredDate, setRequiredDate] = useState('')
  const [notes, setNotes] = useState('')
  const [earlyReason, setEarlyReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/sites/${siteId}/request`, { credentials: 'same-origin' })
    if (res.ok) setData(await res.json() as RequestBody)
  }, [siteId])

  useEffect(() => { void load() }, [load])

  const setQty = async (productId: number, newQty: number) => {
    await fetch(`/api/sites/${siteId}/request/lines/${productId}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qty: newQty }),
    })
    void load()
  }

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/request/submit`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesterName, requiredDate: requiredDate || null,
          notes: notes || null, earlyOrderReason: earlyReason || null,
        }),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({})) as { error?: string }).error ?? 'That could not be submitted.')
        return
      }
      onSubmitted()
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <p role="status" className="text-gray-700">Loading…</p>
  if (!data.request || data.lines.length === 0) {
    return <p className="text-gray-700">Nothing in this request yet. Add something from the stock list.</p>
  }

  const blocking = data.checks.filter((c) => c.severity === 'blocks')
  const needsReason = data.checks.filter((c) => c.severity === 'needs_reason')
  const needsEarlyReason = data.checks.some((c) => c.code === 'too_soon' && c.severity === 'needs_reason')
  const rechargeTotal = data.recharge
    ? data.lines.reduce((sum, l) => sum + l.qtyRequested * (l.rechargeUnitPrice ?? 0), 0)
    : null

  /**
   * Why the button is off, in the order a person would fix them. Derived in one place
   * rather than as separate conditions beside each message: a disabled button whose
   * reason lives somewhere else is how "Send" ends up dead and silent, which is what
   * happened to the missing name — three fields are marked optional, the required one
   * was marked nothing, and no message rendered unless some other check was already
   * failing.
   */
  const blockedBecause =
    blocking.length > 0 ? 'Fix the problems above before sending this.'
      : !requesterName.trim() ? 'Put your name above, then you can send this.'
        : needsEarlyReason && !earlyReason.trim() ? 'Say why this cannot wait, then you can send this.'
          : null

  const canSubmit = blockedBecause === null && !busy

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">Request {data.request.orderNumber}</p>

      <ul className="grid gap-3">
        {data.lines.map((line) => {
          const lineChecks = data.checks.filter((c) => c.productId === line.productId)
          return (
            <li key={line.productId} className="bg-white border border-gray-300 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-gray-900">{line.productName}</h3>
                <p className="text-sm text-gray-700 whitespace-nowrap">
                  {qty(line.available)} available
                </p>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <label htmlFor={`qty-${line.productId}`} className="text-sm text-gray-800">Quantity</label>
                <input
                  id={`qty-${line.productId}`}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  defaultValue={line.qtyRequested}
                  onBlur={(e) => void setQty(line.productId, Number(e.target.value))}
                  className="w-24 rounded-lg border border-gray-400 px-3 py-2"
                />
                <button
                  onClick={() => void setQty(line.productId, 0)}
                  className="text-gray-700 underline"
                >
                  Remove
                </button>
              </div>

              {data.recharge && (
                <p className="mt-2 text-sm text-purple-900">
                  {money(line.rechargeUnitPrice)} each ·{' '}
                  {money(line.rechargeUnitPrice === null ? null : line.rechargeUnitPrice * line.qtyRequested)} for this line
                </p>
              )}

              {lineChecks.map((check) => (
                <p key={check.code} className={`mt-2 text-sm border rounded p-2 ${SEVERITY_STYLE[check.severity]}`}>
                  {check.message}
                </p>
              ))}
            </li>
          )
        })}
      </ul>

      {data.recharge && (
        <p className="rounded-lg border border-purple-300 bg-purple-50 p-3 text-purple-900">
          <strong>This order will be recharged to your site.</strong>{' '}
          Total so far: {money(rechargeTotal)}. A delivery fee may be added on top.
        </p>
      )}

      {data.checks.filter((c) => !c.productId).map((check) => (
        <p key={check.code} className={`text-sm border rounded p-3 ${SEVERITY_STYLE[check.severity]}`}>
          {check.message}
        </p>
      ))}

      <div className="space-y-3 bg-white border border-gray-300 rounded-xl p-4">
        <div>
          <label htmlFor="requester" className="block text-sm font-medium text-gray-800">
            Your name <span className="text-gray-600">(needed)</span>
          </label>
          {/* Site logins are often shared, so the login does not answer who asked. */}
          <p id="requester-why" className="text-sm text-gray-600">
            So the approver knows who to come back to.
          </p>
          <input
            id="requester" value={requesterName} onChange={(e) => setRequesterName(e.target.value)}
            aria-describedby="requester-why" aria-required="true"
            className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="required" className="block text-sm font-medium text-gray-800">
            Needed by <span className="text-gray-600">(optional)</span>
          </label>
          <input
            id="required" type="date" value={requiredDate} onChange={(e) => setRequiredDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2"
          />
        </div>

        {needsEarlyReason && (
          <div>
            <label htmlFor="early" className="block text-sm font-medium text-gray-800">
              Why this cannot wait
            </label>
            <p className="text-sm text-gray-600">
              Every order costs a delivery fee, so the approver will want to know.
            </p>
            <textarea
              id="early" value={earlyReason} onChange={(e) => setEarlyReason(e.target.value)}
              rows={2} className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2"
            />
          </div>
        )}

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-800">
            Anything else <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            id="notes" value={notes} onChange={(e) => setNotes(e.target.value)}
            rows={2} className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2"
          />
        </div>
      </div>

      {error && <p role="alert" className="text-red-800 bg-red-50 border border-red-300 rounded p-3">{error}</p>}

      {blockedBecause && (
        <p
          id="cannot-send"
          role={blocking.length > 0 ? 'alert' : undefined}
          className={`text-sm ${blocking.length > 0 ? 'text-red-900' : 'text-amber-900'}`}
        >
          {blockedBecause}
        </p>
      )}
      {!blockedBecause && needsReason.length > 0 && (
        <p className="text-sm text-amber-900">The approver will see the notes above.</p>
      )}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        aria-describedby={blockedBecause ? 'cannot-send' : undefined}
        className="w-full px-4 py-3 rounded-lg bg-maki-orange text-woodsmoke font-semibold disabled:bg-gray-400 disabled:text-white"
      >
        {busy ? 'Submitting…' : 'Send for sign-off'}
      </button>
    </div>
  )
}

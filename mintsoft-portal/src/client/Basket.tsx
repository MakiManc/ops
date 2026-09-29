import { useCallback, useEffect, useRef, useState } from 'react'
import { money, qty } from './format.ts'
import { btnPrimary, btnQuiet, card, input } from './ui.ts'

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
  /**
   * `status` is what separates a draft from a request that has already gone. Without
   * it the screen could not tell, and showed a sent request with editable quantities
   * and a live Send button — the most misleading thing the portal did.
   */
  request: { id: number; orderNumber: string; earlyOrderReason: string | null; status?: string } | null
  lines: Line[]
  recharge: boolean
  checks: Check[]
}

const SEVERITY_STYLE: Record<Check['severity'], string> = {
  blocks: 'bg-red-50 border-red-300 text-red-900',
  needs_reason: 'bg-amber-50 border-amber-400 text-amber-900',
  note: 'bg-gray-50 border-gray-300 text-gray-800',
}

/**
 * The name, date, reason and notes survive a refresh.
 *
 * They are typed on a phone, mid-service, and a refresh (or the tab being thrown
 * away in the background) used to lose them without warning — including the "why
 * this cannot wait" reason someone had just composed. sessionStorage keeps them for
 * this tab only, and they are cleared once the request is sent.
 */
interface Draft { requesterName: string; requiredDate: string; notes: string; earlyReason: string }
const EMPTY: Draft = { requesterName: '', requiredDate: '', notes: '', earlyReason: '' }
const draftKey = (siteId: number) => `basket-draft-${siteId}`

function readDraft(siteId: number): Draft {
  try {
    const raw = window.sessionStorage.getItem(draftKey(siteId))
    return raw ? { ...EMPTY, ...JSON.parse(raw) as Partial<Draft> } : EMPTY
  } catch { return EMPTY }
}
function writeDraft(siteId: number, draft: Draft) {
  try { window.sessionStorage.setItem(draftKey(siteId), JSON.stringify(draft)) } catch { /* fine */ }
}
function clearDraft(siteId: number) {
  try { window.sessionStorage.removeItem(draftKey(siteId)) } catch { /* fine */ }
}

/**
 * One line's quantity, with the same −/+ stepper the catalogue uses.
 *
 * It used to be a number box that saved on blur: a failed save was silent, and
 * clearing the box to type a new number deleted the line. Now every change is
 * saved after a short pause, the row says when it is saving and when a save failed,
 * and removing a line is its own button.
 */
function QtyStepper({ line, onSave }: {
  line: Line; onSave: (productId: number, qty: number) => Promise<boolean>
}) {
  const [value, setValue] = useState(line.qtyRequested)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(value)
  latest.current = value

  // The server is the source of truth; follow it when it changes under us.
  useEffect(() => { setValue(line.qtyRequested) }, [line.qtyRequested])

  const schedule = (next: number) => {
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      if (latest.current === line.qtyRequested) { setState('idle'); return }
      setState('saving')
      const ok = await onSave(line.productId, latest.current)
      setState(ok ? 'saved' : 'failed')
    }, 500)
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const label = line.productName
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <div className="flex items-center shrink-0">
        <button
          type="button"
          aria-label={`One fewer ${label}`}
          className="min-h-[44px] min-w-[44px] rounded-l-xl border border-gray-400 bg-white text-lg"
          onClick={() => schedule(Math.max(1, value - 1))}
          disabled={value <= 1}
        >
          −
        </button>
        <input
          id={`qty-${line.productId}`}
          aria-label={`Quantity of ${label}`}
          inputMode="numeric"
          className="min-h-[44px] w-16 border-y border-gray-400 bg-white text-center font-semibold"
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^0-9]/g, ''))
            // An emptied box is someone about to type, not someone removing the line.
            schedule(Number.isFinite(n) && n > 0 ? n : 1)
          }}
        />
        <button
          type="button"
          aria-label={`One more ${label}`}
          className="min-h-[44px] min-w-[44px] rounded-r-xl border border-gray-400 bg-white text-lg"
          onClick={() => schedule(value + 1)}
        >
          +
        </button>
      </div>
      <span className="text-sm" role="status" aria-live="polite">
        {state === 'saving' && <span className="text-gray-600">Saving…</span>}
        {state === 'saved' && <span className="text-everglade font-medium">Saved</span>}
        {state === 'failed' && (
          <span className="text-red-800 font-medium">Not saved — check your connection and try again.</span>
        )}
      </span>
    </div>
  )
}

export function Basket({ siteId, onSubmitted, onGoToCatalogue }: {
  siteId: number
  onSubmitted: (orderNumber: string | null) => void
  onGoToCatalogue?: () => void
}) {
  const [data, setData] = useState<RequestBody | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => readDraft(siteId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)

  const { requesterName, requiredDate, notes, earlyReason } = draft
  const patch = (change: Partial<Draft>) => setDraft((d) => {
    const next = { ...d, ...change }
    writeDraft(siteId, next)
    return next
  })

  const load = useCallback(async () => {
    setLoadError(false)
    try {
      const res = await fetch(`/api/sites/${siteId}/request`, { credentials: 'same-origin' })
      if (res.ok) setData(await res.json() as RequestBody)
      else setLoadError(true)
    } catch { setLoadError(true) }
  }, [siteId])

  useEffect(() => { void load() }, [load])

  const setQty = async (productId: number, newQty: number): Promise<boolean> => {
    try {
      const res = await fetch(`/api/sites/${siteId}/request/lines/${productId}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty: newQty }),
      })
      void load()
      return res.ok
    } catch { return false }
  }

  const remove = async (productId: number) => {
    setRemoving(productId)
    await setQty(productId, 0)
    setRemoving(null)
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
      const body = await res.json().catch(() => ({})) as { orderNumber?: string }
      clearDraft(siteId)
      onSubmitted(body.orderNumber ?? data?.request?.orderNumber ?? null)
    } catch {
      setError('That could not be sent — check your connection and try again. Nothing has been lost.')
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return (
      <div className={card}>
        <p role="alert" className="text-red-800">The request could not be loaded.</p>
        <button onClick={() => void load()} className={`mt-3 ${btnQuiet}`}>Try again</button>
      </div>
    )
  }
  if (!data) return <p role="status" className="text-gray-700">Loading…</p>
  if (!data.request || data.lines.length === 0) {
    return (
      <div className={`${card} text-center`}>
        <p className="text-gray-700">Nothing in this request yet. Add something from the stock list.</p>
        {onGoToCatalogue && (
          <button onClick={onGoToCatalogue} className={`mt-4 ${btnPrimary}`}>Go to the stock list</button>
        )}
      </div>
    )
  }

  /**
   * Already sent: show what went, read-only, and say who is looking at it.
   *
   * The lines are still the site's open request until an approver deals with it, so
   * the server sends them here; but nothing on this screen should look editable, and
   * pressing Send twice must not be possible.
   */
  if (data.request.status === 'submitted') {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-everglade bg-everglade/10 p-4 text-gray-900">
          <p className="font-semibold">Request {data.request.orderNumber} has been sent for sign-off.</p>
          <p className="mt-1 text-sm">
            Ross or Francheska will look at it. You cannot change it now — if something is
            wrong, cancel it from My orders and start again.
          </p>
        </div>
        <ul className="grid gap-2">
          {data.lines.map((line) => (
            <li key={line.productId} className={`${card} flex items-center justify-between gap-3 py-3`}>
              <span className="font-medium text-gray-900">{line.productName}</span>
              <span className="text-gray-700 whitespace-nowrap">× {line.qtyRequested}</span>
            </li>
          ))}
        </ul>
        {onGoToCatalogue && (
          <p className="text-sm text-gray-700">
            Need more? Anything you add now joins a new request once this one is signed off.
          </p>
        )}
        {onGoToCatalogue && (
          <button onClick={onGoToCatalogue} className={btnQuiet}>Back to the stock list</button>
        )}
      </div>
    )
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
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600">
          Request {data.request.orderNumber} · {data.lines.length} {data.lines.length === 1 ? 'product' : 'products'}
        </p>
        {onGoToCatalogue && (
          <button onClick={onGoToCatalogue} className={`${btnQuiet} whitespace-nowrap shrink-0`}>+ Add more</button>
        )}
      </div>

      <ul className="grid gap-3">
        {data.lines.map((line) => {
          const lineChecks = data.checks.filter((c) => c.productId === line.productId)
          return (
            <li key={line.productId} className={card}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-gray-900">{line.productName}</h3>
                <p className="text-sm text-gray-700 whitespace-nowrap">
                  {qty(line.available)} available
                </p>
              </div>

              <div className="flex flex-wrap items-end justify-between gap-x-3">
                <QtyStepper line={line} onSave={setQty} />
                <button
                  onClick={() => void remove(line.productId)}
                  disabled={removing === line.productId}
                  className="mt-3 min-h-[44px] px-2 text-gray-700 underline disabled:opacity-60"
                >
                  {removing === line.productId ? 'Removing…' : 'Remove'}
                </button>
              </div>

              {data.recharge && (
                <p className="mt-2 text-sm text-purple-900">
                  {money(line.rechargeUnitPrice)} each ·{' '}
                  {money(line.rechargeUnitPrice === null ? null : line.rechargeUnitPrice * line.qtyRequested)} for this line
                </p>
              )}

              {lineChecks.map((check) => (
                <p key={check.code} className={`mt-2 text-sm border rounded-lg p-2 ${SEVERITY_STYLE[check.severity]}`}>
                  {check.message}
                </p>
              ))}
            </li>
          )
        })}
      </ul>

      {data.recharge && (
        <p className="rounded-xl border border-purple-300 bg-purple-50 p-3 text-purple-900">
          <strong>This order will be recharged to your site.</strong>{' '}
          Total so far: {money(rechargeTotal)}. A delivery fee may be added on top.
        </p>
      )}

      {data.checks.filter((c) => !c.productId).map((check) => (
        <p key={check.code} className={`text-sm border rounded-xl p-3 ${SEVERITY_STYLE[check.severity]}`}>
          {check.message}
        </p>
      ))}

      <div className={`space-y-3 ${card}`}>
        <div>
          <label htmlFor="requester" className="block text-sm font-medium text-gray-800">
            Your name <span className="text-gray-600">(needed)</span>
          </label>
          {/* Site logins are often shared, so the login does not answer who asked. */}
          <p id="requester-why" className="text-sm text-gray-600">
            So the approver knows who to come back to.
          </p>
          <input
            id="requester" value={requesterName} onChange={(e) => patch({ requesterName: e.target.value })}
            aria-describedby="requester-why" aria-required="true" autoComplete="name"
            className={`mt-1 ${input}`}
          />
        </div>

        <div>
          <label htmlFor="required" className="block text-sm font-medium text-gray-800">
            Needed by <span className="text-gray-600">(optional)</span>
          </label>
          <input
            id="required" type="date" value={requiredDate} onChange={(e) => patch({ requiredDate: e.target.value })}
            className={`mt-1 ${input}`}
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
              id="early" value={earlyReason} onChange={(e) => patch({ earlyReason: e.target.value })}
              rows={2} className={`mt-1 ${input}`}
            />
          </div>
        )}

        <div>
          <label htmlFor="notes" className="block text-sm font-medium text-gray-800">
            Anything else <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            id="notes" value={notes} onChange={(e) => patch({ notes: e.target.value })}
            rows={2} className={`mt-1 ${input}`}
          />
        </div>
      </div>

      {error && <p role="alert" className="text-red-800 bg-red-50 border border-red-300 rounded-xl p-3">{error}</p>}

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
        className={`w-full ${btnPrimary} text-lg`}
      >
        {busy ? 'Sending…' : 'Send for sign-off'}
      </button>
      <p className="text-center text-sm text-gray-600">
        Nothing goes to the warehouse until Ross or Francheska approve it.
      </p>
    </div>
  )
}

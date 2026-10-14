import { useCallback, useEffect, useState } from 'react'
import { btnSecondary, card, input } from './ui.ts'

/**
 * The mapping tool.
 *
 * Mintsoft's catalogue carries the same product several times over, once per shipment.
 * This is where an admin says "these four lines are one bowl", after which GMs see one
 * product with one stock figure. Nothing is ever changed in Mintsoft itself.
 *
 * It now says what each line's stock position is, because that was invisible here and it
 * has consequences this screen causes. A line Mintsoft holds no inventory record for
 * turns the product's figure into a floor, and if the other lines hold nothing, orders
 * for the product are refused. Nothing is blocked -- a line awaiting its first shipment
 * legitimately has no record -- but the primary defaults to a line that has a figure,
 * since orders are placed against the primary first.
 */

interface Line {
  mintsoftProductId: number
  sku: string
  name: string | null
  ean: string | null
  mappedToProductId: number | null
  mappedToProductName: string | null
  hasStockRecord: boolean
  available: number | null
}

interface StockGap {
  productId: number
  productName: string
  active: boolean
  mappedLines: number
  unreadableLines: { mintsoftProductId: number; sku: string; isPrimary: boolean; hasStockRecord: boolean }[]
  readableLines: { mintsoftProductId: number; sku: string; available: number }[]
  readableFloor: number
}

/** What a line's stock says, for the label beside it. */
function StockNote({ line }: { line: Line }) {
  if (!line.hasStockRecord) {
    return (
      <span className="text-amber-900">
        {' '}· no stock record in Mintsoft
      </span>
    )
  }
  if (line.available === null) return <span className="text-amber-900">{' '}· stock figure unreadable</span>
  return <span className="text-gray-600">{' '}· {line.available} free</span>
}

interface Suggestion {
  signal: string
  key: string
  lines: Line[]
  partiallyMapped: boolean
}

const SIGNAL_LABEL: Record<string, string> = {
  'same-normalised-name': 'Same name once shipment markers are stripped',
  'shared-sku-stem': 'SKU codes share a stem',
  'same-barcode': 'Same barcode',
}

function MergeForm({ suggestion, onDone }: { suggestion: Suggestion; onDone: () => void }) {
  const unmapped = suggestion.lines.filter((l) => l.mappedToProductId === null)
  const alreadyMapped = suggestion.lines.find((l) => l.mappedToProductId !== null)

  const [name, setName] = useState(suggestion.lines[0]?.name ?? '')
  const [selected, setSelected] = useState<number[]>(unmapped.map((l) => l.mintsoftProductId))
  // Orders fill from the primary first, and a primary with no stock figure is both the
  // worst choice and the hardest to undo -- unmapping one needs another line promoted
  // first. So the default is a line that has a figure, where there is one.
  const [primary, setPrimary] = useState<number | undefined>(
    (unmapped.find((l) => l.hasStockRecord) ?? unmapped[0])?.mintsoftProductId,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      // When part of the cluster already belongs to a product, the right move is almost
      // always to add to it rather than create a rival product holding the other half.
      const res = alreadyMapped
        ? await fetch(`/api/admin/mapping/products/${alreadyMapped.mappedToProductId}/lines`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mintsoftProductIds: selected }),
          })
        : await fetch('/api/admin/mapping/products', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name, stockType: 'internal',
              mintsoftProductIds: selected, primaryMintsoftProductId: primary,
            }),
          })
      const body = await res.json().catch(() => ({})) as { error?: string; warning?: string | null }
      if (!res.ok) {
        setError(body.error ?? 'That could not be saved.')
        return
      }
      // Saved. If mapping a line with no stock record changed what GMs will see, say so
      // and leave it on screen -- the work is done, but somebody has to know.
      if (body.warning) { setWarning(body.warning); return }
      onDone()
    } catch {
      setError('That could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = s.includes(id) ? s.filter((x) => x !== id) : [...s, id]
      // The dropdown only lists selected lines, so deselecting the primary left it
      // displaying one line while submitting another, and the server rightly refused with
      // "The primary SKU must be one of the lines being mapped" -- a confusing error with
      // no visible cause. Move the flag to another selected line instead, preferring one
      // that has a stock figure.
      if (primary !== undefined && !next.includes(primary)) {
        const left = unmapped.filter((l) => next.includes(l.mintsoftProductId))
        setPrimary((left.find((l) => l.hasStockRecord) ?? left[0])?.mintsoftProductId)
      }
      return next
    })

  return (
    <div className="mt-3 border-t border-gray-200 pt-3">
      {alreadyMapped ? (
        <p className="text-sm text-gray-800">
          Part of this group is already <strong>{alreadyMapped.mappedToProductName}</strong>.
          Adding the rest keeps their stock counted together.
        </p>
      ) : (
        <div>
          <label htmlFor={`name-${suggestion.key}`} className="block text-sm font-medium text-gray-800">
            Product name that GMs will see
          </label>
          <input
            id={`name-${suggestion.key}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`mt-1 ${input}`}
          />
        </div>
      )}

      <fieldset className="mt-3">
        <legend className="text-sm font-medium text-gray-800">Warehouse lines to combine</legend>
        <ul className="mt-2 space-y-2">
          {unmapped.map((l) => (
            <li key={l.mintsoftProductId} className="flex items-start gap-3">
              <input
                type="checkbox"
                id={`line-${l.mintsoftProductId}`}
                checked={selected.includes(l.mintsoftProductId)}
                onChange={() => toggle(l.mintsoftProductId)}
                className="mt-1 w-5 h-5"
              />
              <label htmlFor={`line-${l.mintsoftProductId}`} className="text-gray-900">
                <span className="font-mono text-sm">{l.sku}</span>
                <span className="text-gray-700"> · {l.name ?? 'no name'}</span>
                <StockNote line={l} />
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {!alreadyMapped && (
        <div className="mt-3">
          <label htmlFor={`primary-${suggestion.key}`} className="block text-sm font-medium text-gray-800">
            Primary SKU — orders are placed against this one first
          </label>
          <select
            id={`primary-${suggestion.key}`}
            value={primary ?? ''}
            onChange={(e) => setPrimary(Number(e.target.value))}
            className={`mt-1 ${input}`}
          >
            {unmapped.filter((l) => selected.includes(l.mintsoftProductId)).map((l) => (
              <option key={l.mintsoftProductId} value={l.mintsoftProductId}>
                {l.sku} — {l.name ?? 'no name'}
                {l.hasStockRecord ? '' : ' (no stock record)'}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-red-800 bg-red-50 border border-red-300 rounded p-2">{error}</p>}

      {warning ? (
        <div className="mt-3 space-y-2">
          <p role="status" className="text-amber-900 bg-amber-50 border border-amber-400 rounded p-2">
            <strong>Saved.</strong> {warning}
          </p>
          <button
            onClick={() => {
              // Cleared before reloading. The parent re-renders this card under the same
              // key, so a warning left in state survives the reload and the card is stuck
              // on "Saved." with no submit button -- which happens whenever the cluster
              // still has unmapped lines, i.e. exactly when there is more to do.
              setWarning(null)
              onDone()
            }}
            className={btnSecondary}
          >
            Done
          </button>
        </div>
      ) : (
        <button
          onClick={() => void submit()}
          disabled={busy || selected.length === 0 || (!alreadyMapped && !name.trim())}
          className={`mt-3 ${btnSecondary}`}
        >
          {busy ? 'Saving…' : alreadyMapped ? 'Add to that product' : 'Combine into one product'}
        </button>
      )}
    </div>
  )
}

/**
 * Products mapped to a line with no usable stock figure.
 *
 * Warning on new mappings does nothing about the ones that are already like that, and
 * those are the ones costing orders. Tea cups had four orders signed off and shipped and
 * then went unorderable with 577 units in Witham; the first anyone knew was a GM's order
 * being refused three weeks later.
 *
 * The buttons are the point. The first version of this panel told the admin to "unmap the
 * line" and to "promote a line that has a figure" and the screen had neither control --
 * the routes existed and nothing in the client had ever called them. That is the same
 * mistake as telling an approver to "try again once the next sync has run" for a condition
 * no sync could change: advice nobody can act on is worse than silence, because it looks
 * like help.
 *
 * It also no longer carries one standing imperative over every row. Of the three live
 * products, unmapping is right for none of them as a reflex: it would not move Tea cups'
 * floor by a single unit, and for a product whose only line is unreadable it would leave
 * the product mapped to nothing at all, which is strictly worse. Each row says what its
 * own situation warrants.
 */
function StockGaps({ products, onChange }: { products: StockGap[]; onChange: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (lineId: number, url: string, method: string) => {
    setBusy(lineId); setError(null)
    try {
      const res = await fetch(url, { method, credentials: 'same-origin' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? 'That could not be done.')
        return
      }
      onChange()
    } catch {
      setError('That could not be done.')
    } finally {
      setBusy(null)
    }
  }

  if (products.length === 0) return null
  return (
    <div className={`${card} border-amber-400 bg-amber-50`}>
      <h3 className="font-semibold text-gray-900">
        {products.length} mapped {products.length === 1 ? 'product has' : 'products have'} a
        line with no stock figure
      </h3>
      <p className="mt-1 text-sm text-gray-700">
        Mintsoft gives no usable stock figure for these lines, so each product&apos;s figure
        is a floor rather than a total. A line still awaiting its first shipment will start
        reporting on its own — there is nothing to do for those.
      </p>

      {error && <p role="alert" className="mt-3 text-red-800 bg-red-50 border border-red-300 rounded p-2">{error}</p>}

      <ul className="mt-3 space-y-4">
        {products.map((p) => (
          <li key={p.productId} className="border-t border-amber-300 pt-3 first:border-0 first:pt-0">
            <p className="text-gray-900">
              <strong>{p.productName}</strong>
              {!p.active && <span className="text-gray-600"> (not in the catalogue)</span>}
            </p>
            <p className="text-sm text-gray-700">
              {p.unreadableLines.length} of {p.mappedLines}{' '}
              {p.mappedLines === 1 ? 'line' : 'lines'} without a figure
            </p>

            <p className="text-sm">
              {/* Three situations, and only the first is a mapping problem. No readable
                  line means no figure, which the approval guard refuses outright. Readable
                  lines adding to zero means the shelf is empty, which the next shipment
                  fixes by itself. */}
              {p.readableLines.length === 0 ? (
                <span className="text-red-900 font-medium">
                  No line has a stock figure, so this cannot be ordered at all until one
                  starts reporting.
                </span>
              ) : p.readableFloor === 0 ? (
                <span className="text-gray-700">
                  The {p.readableLines.length} readable{' '}
                  {p.readableLines.length === 1 ? 'line holds' : 'lines hold'} nothing, so
                  there is nothing to order yet — though the real figure may be higher than
                  zero and we cannot see it.
                </span>
              ) : (
                <span className="text-gray-700">
                  Sites can order up to {p.readableFloor}; the real figure may be higher.
                  Nothing needs doing unless this line is dead.
                </span>
              )}
            </p>

            <ul className="mt-2 space-y-2">
              {p.unreadableLines.map((l) => (
                <li key={l.mintsoftProductId} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-gray-900">{l.sku}</span>
                  <span className="text-sm text-gray-600">
                    {l.hasStockRecord ? 'row reports no figure' : 'no stock record'}
                  </span>

                  {l.isPrimary ? (
                    // The flag has to move before this line can be unmapped, and it is the
                    // only true consequence of a primary with no figure -- allocation
                    // already skips it.
                    <>
                      <span className="text-sm text-amber-900">
                        holds the primary flag, which must move before it can be unmapped
                      </span>
                      {p.readableLines.length > 0 && (
                        <label className="text-sm text-gray-800">
                          Make primary:{' '}
                          <select
                            className="rounded border border-gray-400 px-2 py-1"
                            defaultValue=""
                            disabled={busy !== null}
                            onChange={(e) => {
                              if (!e.target.value) return
                              void act(
                                l.mintsoftProductId,
                                `/api/admin/mapping/products/${p.productId}/primary/${e.target.value}`,
                                'POST',
                              )
                            }}
                          >
                            <option value="">choose a line…</option>
                            {p.readableLines.map((r) => (
                              <option key={r.mintsoftProductId} value={r.mintsoftProductId}>
                                {r.sku} ({r.available} free)
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === l.mintsoftProductId}
                      onClick={() => void act(
                        l.mintsoftProductId,
                        `/api/admin/mapping/lines/${l.mintsoftProductId}`,
                        'DELETE',
                      )}
                      className="min-h-[44px] px-3 rounded-lg border border-gray-400 text-gray-900"
                    >
                      {busy === l.mintsoftProductId ? 'Unmapping…' : 'Unmap'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Mapping() {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  const [unmapped, setUnmapped] = useState<{ count: number; stock: number }>({ count: 0, stock: 0 })
  const [stockGaps, setStockGaps] = useState<StockGap[]>([])
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, u, g] = await Promise.all([
        fetch('/api/admin/mapping/suggestions', { credentials: 'same-origin' }),
        fetch('/api/admin/mapping/unmapped', { credentials: 'same-origin' }),
        fetch('/api/admin/mapping/stock-gaps', { credentials: 'same-origin' }),
      ])
      if (!s.ok || !u.ok) throw new Error('failed')
      setSuggestions((await s.json() as { suggestions: Suggestion[] }).suggestions)
      const lines = (await u.json() as { lines: Line[] }).lines
      setUnmapped({
        count: lines.length,
        stock: lines.reduce((n, l) => n + (l.available ?? 0), 0),
      })
      // The gaps panel is useful, not essential: a failure there must not take the
      // mapping tool down with it.
      setStockGaps(g.ok ? (await g.json() as { products: StockGap[] }).products : [])
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <p role="alert" className="p-4 text-red-800">Mapping could not be loaded.</p>
  if (suggestions === null) return <p role="status" className="p-4 text-gray-700">Looking for duplicates…</p>

  return (
    <div className="space-y-4">
      <p className="text-gray-700">
        Mintsoft holds the same product several times over, once per shipment. Combining
        those lines here means a GM sees one product with one stock figure. Nothing is
        changed in Mintsoft itself.
      </p>

      {/* The count on its own hid the thing that mattered. When Mercium merged the
          shipment duplicates in October the new lines arrived unmapped, and this read
          "19 warehouse lines are not mapped yet" while those lines held 6,236 units --
          a quarter of everything we own, invisible to every restaurant, with 48 of 93
          products showing nothing. It is the stock, not the count, that is worth
          shouting about. */}
      {unmapped.stock > 0 ? (
        <p role="status" className="text-amber-900 bg-amber-50 border border-amber-400 rounded p-3">
          <strong>{unmapped.stock.toLocaleString()} units</strong> are sitting on{' '}
          {unmapped.count} unmapped warehouse {unmapped.count === 1 ? 'line' : 'lines'}, so no
          site can order them. Map {unmapped.count === 1 ? 'it' : 'them'} to a product below.
        </p>
      ) : (
        <p className="text-sm text-gray-600" role="status">
          {unmapped.count} warehouse {unmapped.count === 1 ? 'line is' : 'lines are'} not
          mapped yet, and {unmapped.count === 1 ? 'it holds' : 'they hold'} no stock.
        </p>
      )}

      <StockGaps products={stockGaps} onChange={() => void load()} />

      {suggestions.length === 0 ? (
        <p className="text-gray-700">
          No likely duplicates to review. Anything still unmapped can be added to a product individually.
        </p>
      ) : (
        <ul className="grid gap-3">
          {suggestions.map((s) => (
            <li key={`${s.signal}-${s.key}`} className={card}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-gray-900">
                  {s.lines.length} lines that look like one product
                </h3>
                {s.partiallyMapped && (
                  <span className="text-xs font-semibold text-amber-900 bg-amber-100 border border-amber-400 rounded px-2 py-1">
                    Partly mapped
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600">{SIGNAL_LABEL[s.signal] ?? s.signal}</p>
              <MergeForm suggestion={s} onDone={() => void load()} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

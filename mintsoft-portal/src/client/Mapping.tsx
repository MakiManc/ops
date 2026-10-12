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
  recordlessLines: { mintsoftProductId: number; sku: string; isPrimary: boolean }[]
  mappedLines: number
  readableFloor: number
  readableLines: number
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
    setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])

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
          <button onClick={onDone} className={btnSecondary}>Done</button>
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
 * Products already mapped to a line Mintsoft has no stock record for.
 *
 * Warning on new mappings does nothing about the ones that are already like that, and
 * those are the ones costing orders. Tea cups had four orders signed off and shipped and
 * then went unorderable with 577 units in Witham; the first anyone knew was a GM's order
 * being refused three weeks later.
 */
function StockGaps({ products }: { products: StockGap[] }) {
  if (products.length === 0) return null
  return (
    <div className={`${card} border-amber-400 bg-amber-50`}>
      <h3 className="font-semibold text-gray-900">
        {products.length} mapped {products.length === 1 ? 'product has' : 'products have'} a
        line with no stock record
      </h3>
      <p className="mt-1 text-sm text-gray-700">
        Mintsoft holds no inventory record for these lines, so each product&apos;s stock
        figure is a floor rather than a total. Unmap the line, or leave it if its shipment
        is still to land.
      </p>
      <ul className="mt-3 space-y-3">
        {products.map((p) => (
          <li key={p.productId}>
            <p className="text-gray-900">
              <strong>{p.productName}</strong>
              {!p.active && <span className="text-gray-600"> (not in the catalogue)</span>}
            </p>
            <p className="text-sm text-gray-700">
              {p.recordlessLines.length} of {p.mappedLines} lines:{' '}
              {p.recordlessLines.map((l) => (
                <span key={l.mintsoftProductId} className="font-mono">
                  {l.sku}{l.isPrimary ? ' (primary)' : ''}{' '}
                </span>
              ))}
            </p>
            <p className="text-sm">
              {/* Three different situations, and only the first is a mapping problem.
                  No readable line at all means no figure, which the approval guard
                  refuses outright. Readable lines adding to zero means the shelf is
                  empty, which the next shipment fixes by itself. */}
              {p.readableLines === 0 ? (
                <span className="text-red-900 font-medium">
                  No line has a stock figure, so this cannot be ordered at all until one
                  appears in the feed.
                </span>
              ) : p.readableFloor === 0 ? (
                <span className="text-gray-700">
                  The {p.readableLines} readable {p.readableLines === 1 ? 'line holds' : 'lines hold'}{' '}
                  nothing, so there is nothing to order today — though the real figure may
                  be higher than zero and we cannot see it.
                </span>
              ) : (
                <span className="text-gray-700">
                  Sites can order up to {p.readableFloor}; the real figure may be higher.
                </span>
              )}
              {p.recordlessLines.some((l) => l.isPrimary) && (
                <span className="text-amber-900">
                  {' '}Orders are placed against the primary first — promote a line that has
                  a figure.
                </span>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Mapping() {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  const [unmappedCount, setUnmappedCount] = useState<number | null>(null)
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
      setUnmappedCount((await u.json() as { lines: Line[] }).lines.length)
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

      <p className="text-sm text-gray-600" role="status">
        {unmappedCount} warehouse {unmappedCount === 1 ? 'line is' : 'lines are'} not mapped yet.
      </p>

      <StockGaps products={stockGaps} />

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

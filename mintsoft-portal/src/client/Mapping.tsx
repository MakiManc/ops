import { useCallback, useEffect, useState } from 'react'

/**
 * The mapping tool.
 *
 * Mintsoft's catalogue carries the same product several times over, once per shipment.
 * This is where an admin says "these four lines are one bowl", after which GMs see one
 * product with one stock figure. Nothing is ever changed in Mintsoft itself.
 */

interface Line {
  mintsoftProductId: number
  sku: string
  name: string | null
  ean: string | null
  mappedToProductId: number | null
  mappedToProductName: string | null
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
  const [primary, setPrimary] = useState<number | undefined>(unmapped[0]?.mintsoftProductId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? 'That could not be saved.')
        return
      }
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
            className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2"
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
            className="mt-1 w-full rounded-lg border border-gray-400 px-3 py-2 bg-white"
          >
            {unmapped.filter((l) => selected.includes(l.mintsoftProductId)).map((l) => (
              <option key={l.mintsoftProductId} value={l.mintsoftProductId}>
                {l.sku} — {l.name ?? 'no name'}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-red-800 bg-red-50 border border-red-300 rounded p-2">{error}</p>}

      <button
        onClick={() => void submit()}
        disabled={busy || selected.length === 0 || (!alreadyMapped && !name.trim())}
        className="mt-3 px-4 py-2 rounded-lg bg-everglade text-paper disabled:bg-gray-400"
      >
        {busy ? 'Saving…' : alreadyMapped ? 'Add to that product' : 'Combine into one product'}
      </button>
    </div>
  )
}

export function Mapping() {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  const [unmappedCount, setUnmappedCount] = useState<number | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([
        fetch('/api/admin/mapping/suggestions', { credentials: 'same-origin' }),
        fetch('/api/admin/mapping/unmapped', { credentials: 'same-origin' }),
      ])
      if (!s.ok || !u.ok) throw new Error('failed')
      setSuggestions((await s.json() as { suggestions: Suggestion[] }).suggestions)
      setUnmappedCount((await u.json() as { lines: Line[] }).lines.length)
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

      {suggestions.length === 0 ? (
        <p className="text-gray-700">
          No likely duplicates to review. Anything still unmapped can be added to a product individually.
        </p>
      ) : (
        <ul className="grid gap-3">
          {suggestions.map((s) => (
            <li key={`${s.signal}-${s.key}`} className="bg-white border border-gray-300 rounded-xl p-4">
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

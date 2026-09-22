/**
 * Uploading product photos.
 *
 * Mintsoft cannot serve them, so they are ours to hold. Before this screen the only way
 * to add one was to name a file after an item code, commit it and deploy — fine for a
 * developer, useless for someone standing in a warehouse with a phone.
 *
 * The resize happens here rather than on the server. A photo straight off a phone is
 * around 4MB; at 800px on the long edge it is nearer 60KB, and that is what every GM
 * downloads afterwards on restaurant wifi. Doing it before the upload also means a bad
 * signal carries 60KB, not 4MB.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface PhotoRow {
  productId: number
  productName: string
  code: string | null
  byteSize: number | null
  uploadedAt: string | null
  uploadedByName: string | null
}

/** The long edge, in pixels. An 80px thumbnail on a 3x screen needs 240; 800 leaves room
 *  for a larger view later without anyone having to re-shoot the catalogue. */
const LONG_EDGE = 800

/** Draws the image down to LONG_EDGE and re-encodes it, preferring WebP. */
async function resize(file: File): Promise<{ blob: Blob; type: string }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot resize images.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.82))
  // Safari below 14 cannot write WebP and hands back null or a PNG. JPEG is the floor
  // everything can produce, and the server accepts it.
  if (blob && blob.type === 'image/webp') return { blob, type: 'image/webp' }

  const jpeg = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.82))
  if (!jpeg) throw new Error('This browser could not re-encode the photo.')
  return { blob: jpeg, type: 'image/jpeg' }
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))}KB`

function Row({ row, onChanged }: { row: PhotoRow; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped after an upload so the <img> refetches instead of showing the old photo.
  const [version, setVersion] = useState(0)

  const send = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const { blob, type } = await resize(file)
      const res = await fetch(`/api/admin/photos/${row.productId}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': type },
        body: blob,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Upload failed (${res.status}).`)
      }
      setVersion((v) => v + 1)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/photos/${row.productId}`, {
        method: 'DELETE', credentials: 'same-origin',
      })
      if (!res.ok) throw new Error(`Could not remove it (${res.status}).`)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove it.')
    } finally {
      setBusy(false)
    }
  }

  const has = row.byteSize !== null

  return (
    <li className="bg-white border border-gray-300 rounded-xl p-4 flex gap-4 items-start">
      {has ? (
        <img
          src={`/api/photos/${row.productId}?v=${version}`}
          alt=""
          className="w-20 h-20 object-cover rounded-lg bg-gray-100 shrink-0"
          loading="lazy"
        />
      ) : (
        <div
          className="w-20 h-20 rounded-lg bg-gray-100 shrink-0 flex items-center justify-center
                     text-xs text-gray-600 text-center px-1"
          aria-hidden="true"
        >
          No photo
        </div>
      )}

      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-gray-900">{row.productName}</h3>
        <p className="text-sm text-gray-700">
          {row.code ?? <span className="italic">no mapped line</span>}
          {has && ` · ${kb(row.byteSize!)}`}
          {has && row.uploadedByName && ` · added by ${row.uploadedByName}`}
        </p>
        {error && <p className="mt-1 text-sm text-red-700">{error}</p>}

        <div className="mt-2 flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            // capture is deliberately absent: it forces the camera on some phones and
            // stops you picking a photo you already took.
            accept="image/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f) }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="min-h-[44px] px-4 rounded-lg bg-everglade text-paper font-semibold
                       disabled:opacity-60"
          >
            {busy ? 'Working…' : has ? 'Replace' : 'Add photo'}
          </button>
          {has && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="min-h-[44px] px-4 rounded-lg border border-gray-400 text-gray-900
                         disabled:opacity-60"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

export function Photos() {
  const [rows, setRows] = useState<PhotoRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onlyMissing, setOnlyMissing] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/photos', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`Could not load the list (${res.status}).`)
      setRows((await res.json() as { rows: PhotoRow[] }).rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the list.')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <p className="text-red-700">{error}</p>
  if (!rows) return <p className="text-gray-700">Loading…</p>

  const missing = rows.filter((r) => r.byteSize === null)
  const shown = onlyMissing ? missing : rows

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 flex flex-wrap
                      items-center justify-between gap-3">
        <span>
          <strong>{rows.length - missing.length}</strong> of <strong>{rows.length}</strong> products
          have a photo.
        </span>
        <label className="flex items-center gap-2 min-h-[44px]">
          <input
            type="checkbox"
            checked={onlyMissing}
            onChange={(e) => setOnlyMissing(e.target.checked)}
            className="w-4 h-4"
          />
          Only show the ones still missing
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="text-gray-700">
          {onlyMissing ? 'Every product has a photo.' : 'No products yet.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {shown.map((row) => (
            <Row key={row.productId} row={row} onChanged={() => void load()} />
          ))}
        </ul>
      )}
    </div>
  )
}

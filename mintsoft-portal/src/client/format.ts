/**
 * Shared formatting, so "we don't know" looks the same everywhere.
 */

/**
 * Renders a quantity. Unknown is an em dash, never 0.
 *
 * This is the single most repeated rule in the portal: a GM who sees "0" stops
 * ordering, and a GM who sees "—" asks. Only one of those is honest when Mintsoft did
 * not tell us.
 */
export const qty = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : String(value)

export const money = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `£${value.toFixed(2)}`

/** "4 minutes ago", "2 days ago" — how old a figure is, in words. */
export function timeAgo(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never'
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 'unknown'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export const shortDate = (iso: string | null | undefined): string =>
  !iso ? '—' : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export type StockStatus = 'in_stock' | 'low' | 'out' | 'inbound' | 'unknown'

/**
 * How each status reads and looks.
 *
 * Text as well as colour, always. A colour-only chip tells someone who cannot
 * distinguish red from green precisely nothing, and the brief is explicit about it.
 */
export const STATUS_CHIP: Record<StockStatus, { label: string; className: string }> = {
  in_stock: { label: 'In stock', className: 'bg-green-100 text-green-900 border-green-300' },
  low:      { label: 'Low',      className: 'bg-amber-100 text-amber-900 border-amber-400' },
  out:      { label: 'Out',      className: 'bg-red-100 text-red-900 border-red-300' },
  inbound:  { label: 'Inbound',  className: 'bg-blue-100 text-blue-900 border-blue-300' },
  unknown:  { label: 'Unknown',  className: 'bg-gray-100 text-gray-800 border-gray-400' },
}

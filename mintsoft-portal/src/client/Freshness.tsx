import { timeAgo } from './format.ts'

export interface Freshness {
  lastSuccessAt: string | null
  minutesOld: number | null
  stale: boolean
}

/**
 * The banner that appears when stock figures are more than an hour old.
 *
 * It is deliberately not dismissible. The point is that every number on the screen
 * below it should be read with the age in mind, and that does not stop being true
 * because someone clicked a cross.
 */
export function FreshnessBanner({ freshness }: { freshness: Freshness }) {
  if (!freshness.stale) {
    return (
      <p className="text-sm text-gray-600">
        Stock last checked {timeAgo(freshness.lastSuccessAt)}.
      </p>
    )
  }

  return (
    <div role="status" className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-amber-900">
      <p className="font-semibold">
        {freshness.lastSuccessAt
          ? `These stock figures are ${timeAgo(freshness.lastSuccessAt)}.`
          : 'Stock has never been checked against the warehouse.'}
      </p>
      <p className="mt-1 text-sm">
        They may be out of date. Nothing here is wrong on purpose — the sync has not run
        recently, so treat the numbers as a guide rather than a promise.
      </p>
    </div>
  )
}

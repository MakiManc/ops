/**
 * Order numbers: MR-<sitecode>-<yyyymmdd>-<seq>.
 *
 * This is the idempotency key. Mintsoft has no idempotency of its own — Phase 0
 * confirmed there is no key header and no dedupe on order number anywhere in the API —
 * so if we send the same order twice, Mercium picks and ships it twice and bills us
 * twice. The number is what lets us ask "did this already go?" before retrying.
 */

export const orderNumberPattern = /^MR-[A-Z0-9]+-\d{8}-\d{3}$/

export function buildOrderNumber(siteCode: string, date: Date, sequence: number): string {
  const code = siteCode.trim().toUpperCase()
  if (!/^[A-Z0-9]+$/.test(code)) {
    throw new Error(`Site code "${siteCode}" is not usable in an order number.`)
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) {
    // Three digits is a lot of orders for one site in one day. Rolling over would
    // silently reuse a number that is already in Mintsoft.
    throw new Error(`Order sequence ${sequence} is out of range for one site in one day.`)
  }
  const yyyymmdd = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('')
  return `MR-${code}-${yyyymmdd}-${String(sequence).padStart(3, '0')}`
}

/** Pulls the parts back out, for reading an order number found in Mintsoft. */
export function parseOrderNumber(value: string): { siteCode: string; date: string; sequence: number } | null {
  if (!orderNumberPattern.test(value)) return null
  const [, siteCode, date, seq] = value.split('-') as [string, string, string, string]
  return { siteCode, date, sequence: Number(seq) }
}

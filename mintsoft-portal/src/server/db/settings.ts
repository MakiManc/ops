import type { AvailableFormula } from '../sync/availability.ts'
import type { Database } from './repo.ts'

export interface Settings {
  merciumOrderFee: number
  defaultMinDaysBetweenOrders: number
  passOrderFeeToFranchise: boolean
  availableFormula: AvailableFormula
  /**
   * The courier service every order is sent with.
   *
   * Not a choice about how anything ships — Mercium makes that when they raise the
   * shipment, and they are the ones who can. It is here because Mintsoft REFUSES an
   * order that carries no courier service, so without a value nothing can be sent at
   * all. Sites used to be able to override it; none ever did, and the column is gone.
   */
  defaultCourierServiceId: number
}

export async function readSettings(db: Database): Promise<Settings> {
  const row = await db
    .prepare(
      `SELECT mercium_order_fee, default_min_days_between_orders,
              pass_order_fee_to_franchise, available_formula,
              default_courier_service_id
         FROM settings WHERE id = 1`,
    )
    .first<{
      mercium_order_fee: number
      default_min_days_between_orders: number
      pass_order_fee_to_franchise: number
      available_formula: AvailableFormula
      default_courier_service_id: number
    }>()

  // The row is created by the migration, so its absence means something is badly wrong.
  if (!row) throw new Error('Settings row is missing — the database has not been migrated.')

  return {
    merciumOrderFee: row.mercium_order_fee,
    defaultMinDaysBetweenOrders: row.default_min_days_between_orders,
    passOrderFeeToFranchise: row.pass_order_fee_to_franchise === 1,
    availableFormula: row.available_formula,
    defaultCourierServiceId: row.default_courier_service_id,
  }
}

/**
 * How stale the stock figures are.
 *
 * The brief wants a banner once the last sync is over an hour old. This answers the
 * question the banner is actually asking: when did the stock sync last *succeed*.
 */
export async function stockFreshness(
  db: Database, { now = new Date(), staleAfterMinutes = 60 } = {},
): Promise<{ lastSuccessAt: string | null; minutesOld: number | null; stale: boolean }> {
  const row = await db
    .prepare(`SELECT MAX(finished_at) AS at FROM sync_runs WHERE job = 'stock' AND status = 'ok'`)
    .first<{ at: string | null }>()

  const at = row?.at ?? null
  if (!at) {
    // Never synced is the stalest state there is, not a fresh one.
    return { lastSuccessAt: null, minutesOld: null, stale: true }
  }
  const minutesOld = Math.floor((now.getTime() - new Date(at).getTime()) / 60_000)
  return { lastSuccessAt: at, minutesOld, stale: minutesOld >= staleAfterMinutes }
}

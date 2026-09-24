/**
 * How much of the day's database write allowance background jobs may spend.
 *
 * D1's free tier allows 100,000 row writes a day across everything. On 2026-09-23 the
 * stock sync spent about 63,000 of that rewriting figures that had not changed, the
 * allowance ran out, and every write started failing — including the one that records
 * last_seen_at when somebody signs in. The portal was unusable and the error people saw
 * was "that account cannot sign in", which pointed at authentication and wasted an hour.
 *
 * The rewriting is fixed. This is the other half: making sure a background job can never
 * again take the allowance a person needs. The jobs keep to half of it. The rest is
 * reserved for the things people do — signing in, building a request, approving it,
 * sending it to Mercium — which are the writes that must not fail.
 *
 * Deliberately a floor under people rather than a ceiling on spend. If a job stands
 * down, stock figures go stale and the catalogue says so plainly, which is a bad day.
 * If the allowance runs out instead, nobody can order at all, which is a worse one.
 */
import type { Database } from '../db/repo.ts'

/** D1's free tier, for the arithmetic below. */
export const DAILY_WRITE_ALLOWANCE = 100_000

/** Background jobs keep to half; the remainder is people's. */
export const SYNC_DAILY_BUDGET = DAILY_WRITE_ALLOWANCE / 2

/**
 * A single run may not spend more than this, however much budget is left.
 *
 * A full replacement of every product is about 670 writes. Anything an order of
 * magnitude past that is a bug — a changed availability formula dirtying every row, a
 * comparison that stopped matching — and a bug should stop at one run rather than empty
 * the day's budget before anyone looks.
 */
export const MAX_WRITES_PER_RUN = 8_000

export interface BudgetState {
  spent: number
  budget: number
  remaining: number
  /** False once the jobs have used their share. */
  mayWrite: boolean
}

/**
 * What background jobs have spent since midnight UTC, which is when D1 resets.
 *
 * date('now') is UTC in SQLite, matching the reset rather than local midnight. Getting
 * that wrong would reset the count in the middle of the afternoon.
 */
export async function budgetState(db: Database): Promise<BudgetState> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(writes_charged), 0) AS spent
         FROM sync_runs
        WHERE started_at >= date('now')`,
    )
    .first<{ spent: number }>()

  const spent = Number(row?.spent ?? 0)
  return {
    spent,
    budget: SYNC_DAILY_BUDGET,
    remaining: Math.max(0, SYNC_DAILY_BUDGET - spent),
    mayWrite: spent < SYNC_DAILY_BUDGET,
  }
}

/**
 * What a set of statements will actually cost.
 *
 * Every statement that touches a row counts, so a product replaced by one DELETE and
 * three INSERTs costs four, not three. rows_written counts products and would undercount
 * by more than half — which is how the spend went unnoticed in the first place.
 */
export const chargeFor = (statementCount: number, auditRows = 1): number =>
  statementCount + auditRows

/**
 * Records every sync attempt.
 *
 * A job is opened before it does anything and closed when it finishes, so a run that
 * dies mid-flight leaves a 'running' row rather than no row at all. That distinction
 * matters on the health screen: a job that crashed and a job that never started look
 * identical if you only record successes.
 */
import type { Database } from '../db/repo.ts'
import { budgetState, chargeFor } from './budget.ts'

export type SyncJob = 'stock' | 'inbound' | 'catalogue' | 'orders' | 'reconcile'

export interface SyncOutcome {
  rowsWritten: number
  /** Anything the health screen should say beyond "it worked". */
  detail?: string
  /**
   * What the run actually cost the database, if the job counted it.
   *
   * Not the same as rowsWritten: replacing a product costs a DELETE as well as its
   * INSERTs. Left out, the charge falls back to twice the rows plus the audit row,
   * which errs high — a budget that guesses should guess against itself.
   */
  writesCharged?: number
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

export async function runSync(
  db: Database,
  job: SyncJob,
  work: () => Promise<SyncOutcome>,
): Promise<{ ok: boolean; detail?: string; rowsWritten?: number }> {
  const startedAt = now()

  /**
   * Stand down if background jobs have used their share of the day.
   *
   * Checked here rather than in each job so a job added later is covered without anyone
   * remembering to. The run is still recorded — a job that declined to write is a thing
   * the health screen must show, not a gap in the history.
   */
  const budget = await budgetState(db)
  if (!budget.mayWrite) {
    const detail = `Stood down: background jobs have used their ${budget.budget.toLocaleString()} `
      + `write budget for today (${budget.spent.toLocaleString()} spent). The rest of the day's `
      + `allowance is kept for ordering. Figures will be stale until midnight UTC.`
    await db
      .prepare(
        `INSERT INTO sync_runs (job, started_at, finished_at, status, rows_written,
                                writes_charged, detail)
              VALUES (?, ?, ?, 'skipped', 0, 1, ?)`,
      )
      .bind(job, startedAt, now(), detail)
      .run()
    return { ok: true, rowsWritten: 0, detail }
  }

  const opened = await db
    .prepare(`INSERT INTO sync_runs (job, started_at, status) VALUES (?, ?, 'running') RETURNING id`)
    .bind(job, startedAt)
    .first<{ id: number }>()
  const runId = opened?.id

  try {
    const outcome = await work()
    // Err high when a job did not count: a budget that guesses should guess against
    // itself, not in its own favour.
    const charged = outcome.writesCharged ?? chargeFor(outcome.rowsWritten * 2)
    await db
      .prepare(
        `UPDATE sync_runs SET finished_at = ?, status = 'ok', rows_written = ?,
                writes_charged = ?, detail = ? WHERE id = ?`,
      )
      .bind(now(), outcome.rowsWritten, charged, outcome.detail ?? null, runId ?? -1)
      .run()
    return { ok: true, rowsWritten: outcome.rowsWritten, detail: outcome.detail }
  } catch (err) {
    // The message only — never the error object, which can carry request details and,
    // on an auth failure, echo what was sent.
    const detail = err instanceof Error ? err.message : 'unknown error'
    await db
      .prepare(
        `UPDATE sync_runs SET finished_at = ?, status = 'failed', writes_charged = ?,
                detail = ? WHERE id = ?`,
      )
      .bind(now(), chargeFor(0), detail, runId ?? -1)
      .run()
    return { ok: false, detail }
  }
}

/**
 * When each job last succeeded.
 *
 * This is what the staleness banner asks about — not when a job last ran, which a
 * failing job answers just as readily.
 */
export async function lastSuccessfulSyncs(db: Database): Promise<Record<string, string | null>> {
  const { results } = await db
    .prepare(
      `SELECT job, MAX(finished_at) AS finished_at FROM sync_runs WHERE status = 'ok' GROUP BY job`,
    )
    .all<{ job: string; finished_at: string | null }>()
  return Object.fromEntries((results ?? []).map((r) => [r.job, r.finished_at]))
}

/** D1 caps how much one batch can carry, so writes go in chunks. */
export const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

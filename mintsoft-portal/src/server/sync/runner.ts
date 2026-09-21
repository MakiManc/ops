/**
 * Records every sync attempt.
 *
 * A job is opened before it does anything and closed when it finishes, so a run that
 * dies mid-flight leaves a 'running' row rather than no row at all. That distinction
 * matters on the health screen: a job that crashed and a job that never started look
 * identical if you only record successes.
 */
import type { Database } from '../db/repo.ts'

export type SyncJob = 'stock' | 'inbound' | 'catalogue' | 'orders' | 'reconcile'

export interface SyncOutcome {
  rowsWritten: number
  /** Anything the health screen should say beyond "it worked". */
  detail?: string
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

export async function runSync(
  db: Database,
  job: SyncJob,
  work: () => Promise<SyncOutcome>,
): Promise<{ ok: boolean; detail?: string; rowsWritten?: number }> {
  const startedAt = now()
  const opened = await db
    .prepare(`INSERT INTO sync_runs (job, started_at, status) VALUES (?, ?, 'running') RETURNING id`)
    .bind(job, startedAt)
    .first<{ id: number }>()
  const runId = opened?.id

  try {
    const outcome = await work()
    await db
      .prepare(`UPDATE sync_runs SET finished_at = ?, status = 'ok', rows_written = ?, detail = ? WHERE id = ?`)
      .bind(now(), outcome.rowsWritten, outcome.detail ?? null, runId ?? -1)
      .run()
    return { ok: true, rowsWritten: outcome.rowsWritten, detail: outcome.detail }
  } catch (err) {
    // The message only — never the error object, which can carry request details and,
    // on an auth failure, echo what was sent.
    const detail = err instanceof Error ? err.message : 'unknown error'
    await db
      .prepare(`UPDATE sync_runs SET finished_at = ?, status = 'failed', detail = ? WHERE id = ?`)
      .bind(now(), detail, runId ?? -1)
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

/**
 * Background jobs cannot spend the allowance people need.
 *
 * On 2026-09-23 the stock sync consumed D1's free daily write allowance and every write
 * started failing. What anyone actually saw was Ross being told "that account cannot
 * sign in", because signing in writes last_seen_at. Reducing the writes was half the
 * answer; this is the other half — nothing stopped the jobs taking the lot.
 *
 * The property: when the jobs have used their share, they stand down, the run is still
 * recorded, and the writes people depend on keep working.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/server/db/repo.ts'
import { runSync } from '../src/server/sync/runner.ts'
import { SYNC_DAILY_BUDGET, budgetState, chargeFor } from '../src/server/sync/budget.ts'
import { FakeD1 } from './helpers/d1.ts'

let fake: FakeD1
let db: Database

beforeEach(() => {
  fake = new FakeD1()
  db = fake as unknown as Database
})

/** Pretends the jobs have already spent this much today. */
const alreadySpent = (writes: number) =>
  fake.exec(`INSERT INTO sync_runs (job, started_at, finished_at, status, rows_written, writes_charged)
             VALUES ('stock', strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                     strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'ok', 0, ${writes})`)

const runs = () =>
  fake.sqlite.prepare(`SELECT job, status, rows_written, detail FROM sync_runs ORDER BY id`)
    .all() as { job: string; status: string; rows_written: number; detail: string | null }[]

describe('while there is budget left', () => {
  it('runs the job normally', async () => {
    let ran = false
    const out = await runSync(db, 'stock', async () => {
      ran = true
      return { rowsWritten: 12, writesCharged: 25 }
    })
    expect(ran).toBe(true)
    expect(out.ok).toBe(true)
    expect(runs()[0]).toMatchObject({ status: 'ok', rows_written: 12 })
  })

  it('records what the run actually cost, not what it wrote', async () => {
    // Replacing a product costs a DELETE as well as its INSERTs. Budgeting on
    // rows_written would undercount by more than half, which is how the spend went
    // unnoticed for as long as it did.
    await runSync(db, 'stock', async () => ({ rowsWritten: 10, writesCharged: 21 }))
    expect((await budgetState(db)).spent).toBe(21)
  })

  it('errs high when a job does not count its own cost', async () => {
    await runSync(db, 'catalogue', async () => ({ rowsWritten: 10 }))
    // 10 rows assumed to cost two writes each, plus the audit row. A budget that has to
    // guess should guess against itself.
    expect((await budgetState(db)).spent).toBe(chargeFor(20))
  })
})

describe('once the budget is gone', () => {
  beforeEach(() => alreadySpent(SYNC_DAILY_BUDGET))

  it('does not run the job at all', async () => {
    let ran = false
    await runSync(db, 'stock', async () => { ran = true; return { rowsWritten: 500 } })
    // Not "runs but writes nothing" — the work never starts, so it cannot write.
    expect(ran).toBe(false)
  })

  it('still records the run, because a gap in the history hides it', async () => {
    await runSync(db, 'stock', async () => ({ rowsWritten: 500 }))
    const stoodDown = runs().at(-1)!
    expect(stoodDown.status).toBe('skipped')
    expect(stoodDown.rows_written).toBe(0)
  })

  it('says why, and that ordering is the reason', async () => {
    await runSync(db, 'stock', async () => ({ rowsWritten: 500 }))
    const detail = runs().at(-1)!.detail!
    expect(detail).toMatch(/kept for ordering/)
    expect(detail).toMatch(/stale until midnight UTC/)
  })

  it('is not reported as a failure, because nothing failed', async () => {
    const out = await runSync(db, 'stock', async () => ({ rowsWritten: 500 }))
    // A red cross here would send someone hunting a broken job instead of reading it.
    expect(out.ok).toBe(true)
    expect(runs().at(-1)!.status).not.toBe('failed')
  })

  it('leaves room for the writes people make', async () => {
    // The whole point: the allowance the jobs stand down from is the allowance that
    // lets somebody sign in and send an order.
    const state = await budgetState(db)
    expect(state.mayWrite).toBe(false)
    expect(SYNC_DAILY_BUDGET).toBeLessThan(100_000)
  })
})

describe('the running total', () => {
  it('counts only today, because the allowance resets at midnight UTC', async () => {
    fake.exec(`INSERT INTO sync_runs (job, started_at, status, rows_written, writes_charged)
               VALUES ('stock', '2020-01-01T10:00:00Z', 'ok', 9999, 99999)`)
    expect((await budgetState(db)).spent).toBe(0)
    expect((await budgetState(db)).mayWrite).toBe(true)
  })

  it('adds up across every job, not per job', async () => {
    await runSync(db, 'stock', async () => ({ rowsWritten: 0, writesCharged: 100 }))
    await runSync(db, 'catalogue', async () => ({ rowsWritten: 0, writesCharged: 50 }))
    expect((await budgetState(db)).spent).toBe(150)
  })

  it('counts a failed run too, since the attempt still cost something', async () => {
    await runSync(db, 'stock', async () => { throw new Error('Mintsoft timed out') })
    expect((await budgetState(db)).spent).toBeGreaterThan(0)
  })
})

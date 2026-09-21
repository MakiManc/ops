/**
 * The sync Worker.
 *
 * Pages Functions cannot hold a cron trigger, so the scheduled jobs live in this
 * separate Worker, bound to the same D1 database. It reads from Mintsoft and writes to
 * our own tables. It never writes to Mintsoft — the single write the portal ever makes
 * is placing an order, which happens in the API behind an approver's sign-off.
 *
 * Cadence follows the brief:
 *   every 15 minutes  stock
 *   hourly            catalogue and inbound ASNs
 *   nightly           a full pass of all three
 */
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'
import { readSettings } from '../src/server/db/settings.ts'
import type { Database } from '../src/server/db/repo.ts'
import { syncCatalogue, syncInbound, syncOrderStatus, syncStock } from '../src/server/sync/jobs.ts'
import { runSync, type SyncJob } from '../src/server/sync/runner.ts'

export interface SyncEnv {
  DB: D1Database
  MINTSOFT_USERNAME: string
  MINTSOFT_PASSWORD: string
  /** Pin the client so a sync can never read another customer's warehouse. */
  MINTSOFT_CLIENT_ID?: string
  MINTSOFT_WAREHOUSE_ID?: string
}

const CADENCE: Record<string, SyncJob[]> = {
  '*/15 * * * *': ['stock', 'orders'],
  '0 * * * *': ['catalogue', 'inbound'],
  '0 3 * * *': ['stock', 'orders', 'catalogue', 'inbound'],
}

export async function runJobs(env: SyncEnv, jobs: SyncJob[]): Promise<Record<string, unknown>> {
  if (!env.MINTSOFT_USERNAME || !env.MINTSOFT_PASSWORD) {
    throw new Error('MINTSOFT_USERNAME and MINTSOFT_PASSWORD are not set, so nothing can be synced.')
  }

  const db = env.DB as unknown as Database
  const client = new MintsoftReadOnlyClient({
    username: env.MINTSOFT_USERNAME,
    password: env.MINTSOFT_PASSWORD,
    // Mintsoft documents no rate limit anywhere, and sits behind Cloudflare, so the
    // sync paces itself rather than assuming there is nothing to trip.
    throttleMs: 250,
  })

  const scope = {
    clientId: env.MINTSOFT_CLIENT_ID ? Number(env.MINTSOFT_CLIENT_ID) : undefined,
    warehouseId: env.MINTSOFT_WAREHOUSE_ID ? Number(env.MINTSOFT_WAREHOUSE_ID) : undefined,
  }
  const settings = await readSettings(db)

  const results: Record<string, unknown> = {}
  for (const job of jobs) {
    // Each job records its own run and swallows its own failure, so one bad endpoint
    // does not stop the others — a stock outage should not also stale the catalogue.
    results[job] = await runSync(db, job, async () => {
      switch (job) {
        case 'stock': return syncStock(db, client, settings.availableFormula, scope)
        case 'inbound': return syncInbound(db, client, scope)
        case 'catalogue': return syncCatalogue(db, client, scope)
        case 'orders': return syncOrderStatus(db, client, scope)
        default: throw new Error(`No such job: ${job}`)
      }
    })
  }
  return results
}

export default {
  async scheduled(event: ScheduledController, env: SyncEnv, ctx: ExecutionContext) {
    // An unrecognised cron is a configuration mistake, not a reason to sync everything.
    const jobs = CADENCE[event.cron]
    if (!jobs) {
      console.error(`No jobs configured for cron "${event.cron}" — nothing run.`)
      return
    }
    ctx.waitUntil(runJobs(env, jobs).then(
      (r) => console.log(`Sync finished: ${JSON.stringify(r)}`),
      (e) => console.error(`Sync failed: ${e instanceof Error ? e.message : 'unknown'}`),
    ))
  },
} satisfies ExportedHandler<SyncEnv>

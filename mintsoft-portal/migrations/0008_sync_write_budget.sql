-- A reserve of the daily write allowance that background jobs may not touch.
--
-- On 2026-09-23 the portal went down: D1's free tier allows 100,000 row writes a day,
-- the stock sync was spending ~63,000 of it rewriting figures that had not changed, and
-- when the allowance ran out every write failed. The first anyone knew was Ross being
-- told "that account cannot sign in" — because signing in writes last_seen_at.
--
-- The rewriting is fixed, and today the syncs write almost nothing. But nothing STOPPED
-- them spending the lot, and that is the part that mattered: a background job must never
-- be able to consume the allowance a person needs to place an order. So the jobs now
-- keep their own budget and stand down when it is gone.
--
-- Two columns, because the existing one cannot answer the question:
--
--   writes_charged  what the run actually cost D1. rows_written counts product rows,
--                   but replacing a product costs a DELETE as well as its INSERTs, and
--                   the run's own audit row is a write too. Budgeting on rows_written
--                   would undercount by more than half.
--
--   'skipped'       a run that declined to write is not 'ok'. Reporting it as ok is how
--                   a stale cache looks healthy on the Sync Health screen, which is the
--                   same trap as an order-tracking job that reports success because it
--                   had nothing to poll.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. Rows are carried across; the
-- history on the health screen survives.
CREATE TABLE sync_runs_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job            TEXT    NOT NULL CHECK (job IN ('stock', 'inbound', 'catalogue', 'orders', 'reconcile')),
  started_at     TEXT    NOT NULL,
  finished_at    TEXT,
  status         TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  rows_written   INTEGER,
  writes_charged INTEGER,
  detail         TEXT
);

INSERT INTO sync_runs_new (id, job, started_at, finished_at, status, rows_written, writes_charged, detail)
  SELECT id, job, started_at, finished_at, status, rows_written,
         -- Best guess for history: a product row cost about two writes, plus the audit
         -- row. Only used for the budget's running total, and today's is what matters.
         CASE WHEN rows_written IS NULL THEN 1 ELSE rows_written * 2 + 1 END,
         detail
    FROM sync_runs;

DROP TABLE sync_runs;
ALTER TABLE sync_runs_new RENAME TO sync_runs;

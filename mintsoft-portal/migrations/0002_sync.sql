-- Phase 2: what the sync jobs land, and a record of the jobs themselves.

-- ---------------------------------------------------------------------------
-- Mintsoft's catalogue, mirrored
-- ---------------------------------------------------------------------------

-- The raw product list as Mintsoft holds it, duplicates and all. We never write back
-- to Mintsoft, so this is a read-only mirror kept only so the mapping tool can show
-- what is there and suggest which lines are the same thing.
--
-- Fields follow Mintsoft's own spelling, including DisCont for discontinued.
CREATE TABLE mintsoft_products (
  mintsoft_product_id INTEGER PRIMARY KEY,           -- Product.ID
  sku                 TEXT    NOT NULL,
  name                TEXT,
  ean                 TEXT,
  upc                 TEXT,
  image_url           TEXT,
  discontinued        INTEGER CHECK (discontinued IN (0, 1)),
  client_id           INTEGER,
  last_updated        TEXT,                          -- Product.LastUpdated, as Mintsoft reports it
  synced_at           TEXT    NOT NULL
);

CREATE INDEX idx_mintsoft_products_sku ON mintsoft_products (sku);
CREATE INDEX idx_mintsoft_products_name ON mintsoft_products (name);

-- Unmapped lines are the mapping tool's work queue. A partial index makes "what is
-- left to map" cheap without a join.
CREATE INDEX idx_mintsoft_products_synced ON mintsoft_products (synced_at);

-- ---------------------------------------------------------------------------
-- Sync runs
-- ---------------------------------------------------------------------------

-- One row per attempt, successful or not. The Sync health screen reads this, and the
-- stale-data banner needs to know when a job last actually succeeded rather than when
-- it last ran.
CREATE TABLE sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job          TEXT    NOT NULL CHECK (job IN ('stock', 'inbound', 'catalogue', 'orders', 'reconcile')),
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  -- 'running' rows that never reach a terminal state are themselves a finding: a job
  -- that died mid-flight looks exactly like one still going unless we record the start.
  status       TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  rows_written INTEGER,
  -- Free text for the health screen: what failed, or what was skipped and why.
  detail       TEXT
);

CREATE INDEX idx_sync_runs_job ON sync_runs (job, started_at DESC);

-- The last success per job, which is what the staleness banner is actually asking about.
CREATE INDEX idx_sync_runs_success ON sync_runs (job, finished_at DESC) WHERE status = 'ok';

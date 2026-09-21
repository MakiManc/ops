-- Phase 1 foundation schema.
--
-- Cloudflare D1, so this is SQLite: booleans are INTEGER 0/1 and timestamps are
-- ISO-8601 TEXT in UTC ("2026-09-21T14:30:00Z"), which sorts correctly as text.
--
-- Three rules from Phase 0 discovery are built into the column definitions here,
-- because they are far easier to honour in the schema than to remember in every query:
--
--   1. UNKNOWN IS NOT ZERO. Every stock quantity is nullable with no default. A
--      product missing from Mintsoft's feed must read as "we don't know", which the
--      screens render as an em dash. A DEFAULT 0 would quietly turn "we didn't hear"
--      into "there is none", which is the portal's easiest way to start lying.
--   2. NO DELIVERED STATE. Mintsoft's order record cannot tell us a box arrived, so
--      the status CHECK stops at 'despatched'.
--   3. AVAILABLE IS DERIVED. Mintsoft publishes no "available" figure anywhere, so
--      stock_cache.available is something we compute and must be able to explain --
--      hence available_basis alongside it.

-- ---------------------------------------------------------------------------
-- Sites
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  code                       TEXT    NOT NULL UNIQUE,            -- M9, M19, MAF1
  name                       TEXT    NOT NULL,
  type                       TEXT    NOT NULL CHECK (type IN ('restaurant', 'factory', 'franchise')),
  cluster                    TEXT,

  -- Delivery address, as Mintsoft will receive it.
  address_1                  TEXT,
  address_2                  TEXT,
  address_3                  TEXT,
  town                       TEXT,
  county                     TEXT,
  postcode                   TEXT,
  country                    TEXT    NOT NULL DEFAULT 'GB',
  contact_name               TEXT,
  contact_phone              TEXT,
  delivery_notes             TEXT,

  default_courier_service_id INTEGER,                            -- Mintsoft CourierService.ID

  -- Franchise sites are recharged for what they order; corporate sites never are
  -- and are never shown a price.
  recharge                   INTEGER NOT NULL DEFAULT 0 CHECK (recharge IN (0, 1)),

  -- NULL means "use settings.default_min_days_between_orders". Mercium bills per
  -- order, so the gap between orders is a cost control, not a preference.
  min_days_between_orders    INTEGER CHECK (min_days_between_orders >= 0),

  active                     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_sites_active ON sites (active, code);

-- ---------------------------------------------------------------------------
-- Users and their sites
-- ---------------------------------------------------------------------------

-- Sign-in is Google from any domain, gated entirely by this table: an email that is
-- not here, or is here but inactive, cannot get in. There is no domain rule, because
-- site logins are often shared gmail accounts.
CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stored lowercase; the CHECK stops a mixed-case row from silently never matching.
  email      TEXT    NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%'),
  name       TEXT    NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('gm', 'approver', 'admin')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_users_active ON users (active, email);

-- A GM may cover more than one site. Approvers and admins are not scoped by this
-- table -- they see everything -- so an empty set here is meaningful for a GM
-- (they see nothing) and irrelevant for the other roles.
CREATE TABLE user_sites (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

CREATE INDEX idx_user_sites_site ON user_sites (site_id);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

-- The clean Maki catalogue. One row here can map to many Mintsoft lines, which is
-- how the duplicates from the last several shipments are hidden from GMs. We never
-- edit, merge or delete anything in Mintsoft itself.
CREATE TABLE products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  category            TEXT,
  stock_type          TEXT    NOT NULL CHECK (stock_type IN ('internal', 'expansion')),
  pack_size           INTEGER CHECK (pack_size > 0),
  unit                TEXT,
  image_url           TEXT,

  -- What a franchise site is charged per unit. NULL is not zero: it means unpriced,
  -- and it blocks approval of a recharge order rather than recharging at nothing.
  recharge_unit_price REAL    CHECK (recharge_unit_price IS NULL OR recharge_unit_price >= 0),

  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_products_active ON products (active, stock_type, category);

-- The mapping that hides Mintsoft's duplicate lines.
CREATE TABLE product_mintsoft_map (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id          INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  -- UNIQUE: a Mintsoft line belongs to at most one Maki product, so stock can never
  -- be double-counted by being mapped twice.
  mintsoft_product_id INTEGER NOT NULL UNIQUE,
  sku                 TEXT    NOT NULL,
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_pmm_product ON product_mintsoft_map (product_id);
-- Exactly one primary SKU per product: it is the line we order against first.
CREATE UNIQUE INDEX idx_pmm_one_primary ON product_mintsoft_map (product_id) WHERE is_primary = 1;

-- ---------------------------------------------------------------------------
-- Stock, as last seen in Mintsoft
-- ---------------------------------------------------------------------------

-- Fed from GET /api/Product/Inventory/Bulk, not /StockLevels -- Phase 0 found the
-- latter returns neither Allocated nor Available.
--
-- GRAIN: one row per Mintsoft product per warehouse per location. Whether the live
-- feed actually splits by location is still unknown (it is one of the open questions
-- for the discovery run), so location_id is nullable and the unique index covers
-- both shapes. Readers must SUM across rows rather than assume one row per product.
CREATE TABLE stock_cache (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mintsoft_product_id INTEGER NOT NULL,
  warehouse_id        INTEGER,
  location_id         INTEGER,

  -- Nullable by design. No DEFAULT 0 anywhere: absent from the feed must stay
  -- distinguishable from "none in stock".
  on_hand             INTEGER,
  allocated           INTEGER,

  -- Derived, because Mintsoft publishes no availability figure at all. The basis
  -- string records how it was worked out so a figure on screen can always be
  -- explained, and so the formula can change once discovery settles it.
  available           INTEGER,
  available_basis     TEXT,

  synced_at           TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_stock_cache_grain
  ON stock_cache (mintsoft_product_id, ifnull(warehouse_id, -1), ifnull(location_id, -1));
CREATE INDEX idx_stock_cache_synced ON stock_cache (synced_at);

-- Stock on its way in, from ASNs. expected_date comes from ASN.EstimatedDelivery;
-- qty is QuantityExpected less QuantityReceieved (Mintsoft's spelling, not ours).
CREATE TABLE inbound (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mintsoft_product_id INTEGER NOT NULL,
  asn_id              INTEGER NOT NULL,
  qty                 INTEGER,
  expected_date       TEXT,
  synced_at           TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_inbound_line ON inbound (asn_id, mintsoft_product_id);
CREATE INDEX idx_inbound_product ON inbound (mintsoft_product_id, expected_date);

-- ---------------------------------------------------------------------------
-- Per-site ordering rules
-- ---------------------------------------------------------------------------

CREATE TABLE site_products (
  site_id                 INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  product_id              INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  par_level               INTEGER CHECK (par_level IS NULL OR par_level >= 0),
  max_per_order           INTEGER CHECK (max_per_order IS NULL OR max_per_order > 0),
  min_days_between_orders INTEGER CHECK (min_days_between_orders IS NULL OR min_days_between_orders >= 0),
  PRIMARY KEY (site_id, product_id)
);

CREATE INDEX idx_site_products_product ON site_products (product_id);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- MR-<sitecode>-<yyyymmdd>-<seq>. Unique here and used as the idempotency key
  -- when posting: before any retry we look this number up in Mintsoft rather than
  -- creating a second order.
  order_number      TEXT    NOT NULL UNIQUE,

  site_id           INTEGER NOT NULL REFERENCES sites (id),
  type              TEXT    NOT NULL CHECK (type IN ('replenishment', 'expansion')),

  -- Stops at despatched: Mintsoft's order record carries no delivery confirmation,
  -- so a 'delivered' state could only ever be a guess.
  status            TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN (
                      'draft', 'submitted', 'approved', 'posted', 'despatched',
                      'rejected', 'cancelled', 'post_failed')),

  requested_by      INTEGER REFERENCES users (id),
  -- Typed by hand at submit, because site logins are often shared accounts and
  -- "who actually asked for this" is not answered by the login.
  requester_name    TEXT,
  required_date     TEXT,
  notes             TEXT,

  -- A typed reason is required when ordering inside the site's minimum gap, and is
  -- shown to the approver.
  early_order_reason TEXT,

  submitted_at      TEXT,
  approved_by       INTEGER REFERENCES users (id),
  approved_at       TEXT,
  rejected_reason   TEXT,

  mintsoft_order_id INTEGER UNIQUE,
  posted_at         TEXT,
  post_error        TEXT,
  despatched_at     TEXT,
  tracking_number   TEXT,
  tracking_url      TEXT,

  -- Snapshotted at approval so a later price change never alters a posted order.
  recharge          INTEGER NOT NULL DEFAULT 0 CHECK (recharge IN (0, 1)),
  order_fee         REAL,
  recharge_total    REAL,

  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_orders_site_status ON orders (site_id, status);
CREATE INDEX idx_orders_status_created ON orders (status, created_at);

-- Mercium charges per order, so fewer and fuller orders is a design goal. A site has
-- at most one request open at a time; new items join it rather than starting a second.
-- Enforced here so no code path can create a second one by accident.
CREATE UNIQUE INDEX idx_orders_one_open_per_site
  ON orders (site_id) WHERE status IN ('draft', 'submitted');

CREATE TABLE order_lines (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id              INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id            INTEGER NOT NULL REFERENCES products (id),
  qty_requested         INTEGER NOT NULL CHECK (qty_requested > 0),
  qty_approved          INTEGER CHECK (qty_approved IS NULL OR qty_approved >= 0),

  -- What we showed the requester, and what we saw again at approval. Nullable:
  -- if stock was unknown at the time, it must stay unknown in the record.
  available_at_request  INTEGER,
  available_at_approval INTEGER,

  -- Price snapshot, taken at approval. Never read live when reporting.
  recharge_unit_price   REAL CHECK (recharge_unit_price IS NULL OR recharge_unit_price >= 0),

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX idx_order_lines_unique ON order_lines (order_id, product_id);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  id                            INTEGER PRIMARY KEY CHECK (id = 1),   -- one row, always
  mercium_order_fee             REAL    NOT NULL DEFAULT 0,
  default_min_days_between_orders INTEGER NOT NULL DEFAULT 14 CHECK (default_min_days_between_orders >= 0),
  pass_order_fee_to_franchise   INTEGER NOT NULL DEFAULT 0 CHECK (pass_order_fee_to_franchise IN (0, 1)),

  -- How stock_cache.available is worked out. Phase 0 could not settle this from the
  -- specification, so it is configuration rather than a constant in the code.
  available_formula             TEXT    NOT NULL DEFAULT 'on_hand_minus_allocated'
                                  CHECK (available_formula IN ('on_hand_minus_allocated', 'stock_level')),

  updated_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO settings (id) VALUES (1);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Append-only. Every state change and every quantity edit lands here, and the
-- triggers below make that a property of the database rather than a habit.
CREATE TABLE order_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  actor    TEXT    NOT NULL,        -- user email, or 'system' for sync jobs
  event    TEXT    NOT NULL,        -- 'submitted', 'approved', 'qty_changed', 'merged', ...
  detail   TEXT,                    -- JSON, free text
  at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_order_events_order ON order_events (order_id, at);

CREATE TRIGGER order_events_no_update
BEFORE UPDATE ON order_events
BEGIN
  SELECT RAISE(ABORT, 'order_events is append-only: rows cannot be updated');
END;

CREATE TRIGGER order_events_no_delete
BEFORE DELETE ON order_events
BEGIN
  SELECT RAISE(ABORT, 'order_events is append-only: rows cannot be deleted');
END;

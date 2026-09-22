-- Phase 0's stock question, settled against the live API on 2026-09-21.
--
-- The settings table shipped with two formulas and defaulted to the wrong one. A live
-- read of all 334 Witham products showed, with no exceptions:
--
--     Bulk.StockLevel == Bulk.OnHand + Bulk.Allocated        334/334
--     Bulk.OnHand     == StockLevels.Level                   334/334
--     Bulk.StockLevel == StockLevels.TotalStockLevel         334/334
--
-- So Mintsoft has ALREADY deducted allocations from OnHand. OnHand is free-to-order
-- stock; StockLevel is the gross figure including what is spoken for. The field names
-- suggest the opposite, which is exactly how this was got wrong in the first place.
--
-- Both shipped formulas are therefore unsafe on the 40 products that currently carry
-- allocations:
--
--   on_hand_minus_allocated  deducts a second time. MRK008-R-R has 40 free and would
--                            compute -260, floored to 0 and flagged oversold. A GM
--                            would be told there is none of something we hold 40 of.
--   stock_level              counts allocated stock as free. 14 products are fully
--                            allocated with nothing available; every one would be
--                            offered for ordering, and Mercium could not ship them.
--
-- 'on_hand' is the correct reading. The other two stay selectable rather than being
-- dropped, so this is reversible if Mercium tells us the arithmetic means something
-- else, but nothing should be using them.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.

CREATE TABLE settings_new (
  id                            INTEGER PRIMARY KEY CHECK (id = 1),
  mercium_order_fee             REAL    NOT NULL DEFAULT 0,
  default_min_days_between_orders INTEGER NOT NULL DEFAULT 14 CHECK (default_min_days_between_orders >= 0),
  pass_order_fee_to_franchise   INTEGER NOT NULL DEFAULT 0 CHECK (pass_order_fee_to_franchise IN (0, 1)),

  available_formula             TEXT    NOT NULL DEFAULT 'on_hand'
                                  CHECK (available_formula IN ('on_hand', 'on_hand_minus_allocated', 'stock_level')),

  updated_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Carry everything across, but move the formula onto the settled answer. Anyone still
-- on the old default was getting understated stock, so this is a correction, not a
-- preference being overridden.
INSERT INTO settings_new (id, mercium_order_fee, default_min_days_between_orders,
                          pass_order_fee_to_franchise, available_formula, updated_at)
SELECT id, mercium_order_fee, default_min_days_between_orders,
       pass_order_fee_to_franchise,
       CASE WHEN available_formula = 'on_hand_minus_allocated' THEN 'on_hand'
            ELSE available_formula END,
       updated_at
FROM settings;

DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- The cache was computed with the old formula, so every row in it is suspect. Clearing
-- it makes the next sync repopulate; until then the UI reads "unknown", which is
-- honest. Leaving stale understated numbers on screen would not be.
DELETE FROM stock_cache;

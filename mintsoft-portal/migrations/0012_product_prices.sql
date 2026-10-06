-- What a product costs, and where that figure came from.
--
-- The portal shipped with a price on every product and not one of them was real:
-- seed/catalogue.sql set recharge_unit_price to 45 for anything typed 'expansion' and
-- 2.50 for everything else. Two distinct values across 103 products. Nothing displayed
-- them, because the catalogue only shows a price when a site has recharge = 1 and no site
-- ever has, so the fiction sat there waiting for the first person to turn that flag on.
-- This migration clears them.
--
-- The real prices come from the China Stock Price File, loaded by scripts/load-prices.ts
-- out of prices/china-stock-prices.json. They are SUPPLIER COST OF GOODS: they exclude
-- freight, which the supplier quotes per CBM with no per-product volume recorded
-- anywhere, and they exclude UK VAT and duty. Anything that totals them has to say so.
--
-- Every active product gets a row, priced or not. A product the file cannot price carries
-- the reason instead, because a report that shows a gap and says why is useful and one
-- that just shows a blank looks broken. The CHECK keeps that honest: exactly one of a
-- price or a reason, never both and never neither.
CREATE TABLE product_prices (
  product_id      INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  -- What kind of price this is. 'supplier' is cost of goods. Kept open because a landed
  -- cost or a real recharge price would be a different basis on the same product.
  basis           TEXT NOT NULL CHECK (basis IN ('supplier', 'recharge', 'landed')),
  unit_price      REAL CHECK (unit_price IS NULL OR unit_price >= 0),
  -- Why there is no price, when there is no price.
  gap_reason      TEXT,
  currency        TEXT NOT NULL DEFAULT 'GBP',
  -- The unit the supplier quoted, verbatim. A price per pack against a product the portal
  -- sells by the unit is not a per-unit price, and this is how that gets spotted.
  quoted_unit     TEXT,
  -- Provenance, so any figure on a report can be traced back to a document.
  source_file     TEXT,
  source_doc      TEXT,
  doc_date        TEXT,
  order_no        TEXT,
  -- How many different prices the file holds for this product. More than one means the
  -- latest was taken and the spread is worth knowing.
  distinct_prices INTEGER NOT NULL DEFAULT 1 CHECK (distinct_prices >= 1),
  lowest          REAL,
  highest         REAL,
  -- How the product was matched to the file: 'exact' on the name, or 'alias' by hand.
  matched_by      TEXT NOT NULL DEFAULT 'exact' CHECK (matched_by IN ('exact', 'alias')),
  -- Anything a reader of the number needs to know, from the file's flags or the map.
  note            TEXT,
  loaded_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((unit_price IS NULL) = (gap_reason IS NOT NULL))
);

-- The fake prices. Not nulled quietly: there is no real price to preserve, and leaving
-- 2.50 in place next to a table of real ones is how a wrong number ends up on an invoice.
UPDATE products SET recharge_unit_price = NULL;

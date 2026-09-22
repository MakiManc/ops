-- Four pairs of products that carry the same name. One item each, under two codes.
--
-- Mercium changed the SKU stem between shipments and Mintsoft kept both, so a GM saw
-- two rows with identical text and no way to choose. Picking at random was the only
-- option available to them.
--
-- The evidence is that NO SHIPMENT EVER USED BOTH CODES. Across all four pairs the
-- shipment sets are exactly complementary — if these were two different chairs, or two
-- different ramekins, some shipment would have bought both. None did:
--
--   Chairs          10 C-C          MRK001, 008                  <- closed
--                   12 CHR          legacy, 002, 004, 005, 010, 013
--   Ramekin         49 RAM          MRK002                       <- closed
--                   48 R-R          MRK001, 004, 005, 008, 010, 011, 013
--   Ramen Strainers 93 UTL-RAMEN-STR  legacy (pre-MRK)           <- closed
--                   54 RSR          MRK001, 010
--   Ramen spoon     55 RSR-H        MRK001, 004, 008, 010, 011
--                   56 RSR-P        MRK002, 013                  <- closed
--
-- The Mintsoft names agree too: every line reads only "<ITEM> - MRK<shipment>", with
-- nothing to tell the two stems apart. Ramen Strainers is the legacy shape already seen
-- in 2026-09-22-merge-legacy-duplicates.sql — an old code from before the MRK scheme,
-- sitting beside its replacement.
--
-- Stock pools rather than moving: Ramekin keeps its 2,669 and gains nothing, ramen
-- spoons go from 20 and 1 to 21, strainers stay at 16, chairs are zero on both sides.
--
-- Safe: no order line and no site_products row references any of the eight.
--
-- Survivors were chosen for the cleaner name and the larger set of lines. The absorbed
-- line stops being primary, because the survivor already has one.
UPDATE product_mintsoft_map SET product_id = 12, is_primary = 0 WHERE product_id = 10;
UPDATE product_mintsoft_map SET product_id = 48, is_primary = 0 WHERE product_id = 49;
UPDATE product_mintsoft_map SET product_id = 54, is_primary = 0 WHERE product_id = 93;
UPDATE product_mintsoft_map SET product_id = 55, is_primary = 0 WHERE product_id = 56;

-- 54 inherits the plain name from the legacy product it absorbed. Its own name carried
-- a "- MRK001" suffix, which names a shipment rather than the item — the same noise
-- that was taken off product 80 earlier today.
UPDATE products SET name = 'Ramen Strainers', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 54;

-- Closed, not deleted, so every merge here is reversible.
UPDATE products SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id IN (10, 49, 93, 56);

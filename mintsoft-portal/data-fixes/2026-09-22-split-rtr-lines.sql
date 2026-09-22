-- Splitting the RTR family, which holds three different physical items under one product.
--
-- Product 58 "Round Table Base" was built by matching on the SKU stem RTR, and the stem
-- lies: Mercium reused it across round table tops, rectangle table bases and round table
-- bases. The Mintsoft names are the truth here, so every line below moves on what Mintsoft
-- calls it, not on its SKU.
--
-- Lines move by mintsoft_product_id, never by SKU: 1683 and 1686 are both MRK013-RTR and
-- are two different items, so a SKU-keyed update would move the wrong one.
--
--   product 58, before:
--     1244  MRK001-RTR    ROUND TABLE TOP (COPPER) - MRK001     1 free
--     1291  MRK002-RTR    RECTANGLE TABLE BASE - MRK002         0
--     1570  MRK008-RTR    Round Table Base                      not in the feed
--     1683  MRK013-RTR    RECTANGLE TABLE BASE - MRK013         0
--     1686  MRK013-RTR    ROUND TABLE TOP (COPPER) - MRK013     3 free
--
-- Also corrected: two ROUND TABLE BASE lines filed under 61 "Rectangle Table Base"
-- (1295 MRK002-RTR-B, 1687 MRK013-RTR-B). Same mistake, same family, both 0 free.
--
-- Safe to move: no order line and no site_products row references 58, 61 or 64.

-- 1. The copper round tabletops have no product of their own. 62 is the RECTANGLE
--    tabletop, not this. Created rather than merged, so the 4 free units stay findable.
INSERT INTO products (name, category, stock_type, pack_size, unit, recharge_unit_price, active)
VALUES ('Round Table Top (Copper)', 'Furniture', 'expansion', 1, 'unit', 45, 1);

UPDATE product_mintsoft_map
   SET product_id = (SELECT id FROM products WHERE name = 'Round Table Top (Copper)'),
       is_primary = CASE WHEN mintsoft_product_id = 1244 THEN 1 ELSE 0 END
 WHERE mintsoft_product_id IN (1244, 1686);

-- 2. The two rectangle bases join 61, which is what they are.
UPDATE product_mintsoft_map SET product_id = 61, is_primary = 0
 WHERE mintsoft_product_id IN (1291, 1683);

-- 3. The one genuine round base joins 64, the other "Round Table Base".
UPDATE product_mintsoft_map SET product_id = 64, is_primary = 0
 WHERE mintsoft_product_id = 1570;

-- 4. Two round bases misfiled under 61 move to 64.
UPDATE product_mintsoft_map SET product_id = 64, is_primary = 0
 WHERE mintsoft_product_id IN (1295, 1687);

-- 5. 58 now has no lines at all, and 64 carries the name it was duplicating. Closed
--    rather than deleted, so the split is reversible.
UPDATE products SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 58;

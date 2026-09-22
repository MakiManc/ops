-- The same SKU-stem mistake as the RTR split, in two more places.
--
-- Found while splitting the RTR lines, and fixed the same way: on what Mintsoft calls
-- each line, and by mintsoft_product_id rather than SKU.
--
-- A. Product 80 "SAKURA TREES - MRK002" holds three lines under the stem STS, and STS
--    covers two unrelated things:
--
--      1242  MRK001-STS  SQUARE TABLE TOP (COPPER) - MRK001   2 free
--      1259  MRK002-STS  SAKURA TREES - MRK002                0      <- the actual product
--      1579  MRK008-STS  SQUARE TABLE TOP - MRK008            0
--
--    The two square tabletops are the only ones in the catalogue and have no product of
--    their own, so 2 free units were filed under "Sakura Trees" where nobody would look.
--
--    1242 says "(COPPER)" and 1579 does not, and they are grouped anyway: Mercium drops
--    qualifiers between shipments. Product 101 is the precedent — MRK001 and MRK008 say
--    "GOLDEN RIM", MRK002 and MRK013 do not, and all four are one tabletop. If MRK008's
--    turns out to be a genuinely different, non-copper top it needs pulling back out;
--    it is 0 free, so nothing is orderable either way until that is known.
--
-- B. Product 79 "SQUARETABLE BASE - MRK008" is one line, 1580 MRK008-STB, whose Mintsoft
--    name is identical to 1566 MRK008-SBS already on product 66 "Square Table Base".
--    Mercium listed the same MRK008 square table base under two stems. A merge, not a
--    split. Both 0 free.
--
-- Safe: no order line and no site_products row references 66, 79 or 80.

-- A1. The square tabletops get the product they never had. 1242 carries the primary
--     across, which also frees 80's primary slot for the line that stays.
INSERT INTO products (name, category, stock_type, pack_size, unit, recharge_unit_price, active)
VALUES ('Square Table Top (Copper)', 'Furniture', 'expansion', 1, 'unit', 45, 1);

UPDATE product_mintsoft_map
   SET product_id = (SELECT id FROM products WHERE name = 'Square Table Top (Copper)'),
       is_primary = CASE WHEN mintsoft_product_id = 1242 THEN 1 ELSE 0 END
 WHERE mintsoft_product_id IN (1242, 1579);

-- A2. 80 is left with the one line that is actually a sakura tree, so it becomes the
--     primary — and the product takes the plain name, the way 67 and 68 are named. The
--     "- MRK002" suffix was only ever inherited from a line.
UPDATE product_mintsoft_map SET is_primary = 1 WHERE mintsoft_product_id = 1259;

UPDATE products SET name = 'Sakura Trees', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 80;

-- B1. The duplicate square table base joins 66. The absorbed line stops being primary:
--     66 already has its own.
UPDATE product_mintsoft_map SET product_id = 66, is_primary = 0
 WHERE mintsoft_product_id = 1580;

-- B2. Closed, not deleted, so the merge is reversible.
UPDATE products SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 79;

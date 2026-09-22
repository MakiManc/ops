-- Merging the legacy pre-MRK products into their MRK equivalents.
--
-- Each pair is the same physical item listed twice: the old code Mercium used before
-- the MRK<shipment> scheme, sitting beside its replacement. Verified line by line
-- before merging, not matched on name alone.
--
--   product 92  UTL-CHP-BLK        -> 1   BCB       Black Chopsticks
--   product 88  TSHT-MAKI-BLK-XL   -> 5   BMB-XL    Tee Shirt (XL)
--   product 89  TSHT-MAKI-BLK-XXL  -> 6   BMB-XXL   Tee Shirt (XXL)
--   product 24  FRN-CHAIR-GEN      -> 12  CHR       Chairs
--
-- NOT merged: Round Table Base (58 and 64). See the note at the bottom.
--
-- The absorbed line stops being primary — a product has one primary line, and the
-- survivor already has its own.
UPDATE product_mintsoft_map SET product_id = 1,  is_primary = 0 WHERE product_id = 92;
UPDATE product_mintsoft_map SET product_id = 5,  is_primary = 0 WHERE product_id = 88;
UPDATE product_mintsoft_map SET product_id = 6,  is_primary = 0 WHERE product_id = 89;
UPDATE product_mintsoft_map SET product_id = 12, is_primary = 0 WHERE product_id = 24;

-- Closed, not deleted, so the merge is reversible and any future order history survives.
UPDATE products SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id IN (92, 88, 89, 24);

-- Product 70 is the XL sushi kimono, named (M).
--
-- The catalogue showed two entries reading, character for character, "Sushi Kimono
-- (M)No apron" — products 69 and 70. Six of 70's seven Mintsoft lines say SUSHI KIMONO
-- (XL) outright:
--
--   MRK001-SKS-XL  SUSHI KIMONO (XL)NO APRON - MRK001
--   MRK002-SKS-XL  SUSHI KIMONO (XL)NO APRON - MRK002
--   MRK004-SKS-XL  Sushi Kimono (M)No apron            <- the one that is wrong
--   MRK008-SKS-XL  SUSHI KIMONO (XL)NO APRON - MRK008
--   MRK010-SKS-XL  SUSHI KIMONO (XL)NO APRON - MRK010
--   MRK011-SKS-XL  SUSHI KIMONO (XL)NO APRON - MRK011
--   MRK013-SKS-XL  SUSHI KIMONO (XL)NO APRON - MRK013
--
-- Every SKU on the product ends -SKS-XL. The product took its name from the single
-- mislabelled MRK004 line, so the error was Mercium's and we inherited it.
--
-- This one had teeth: a GM picking between two identical rows had a coin's chance of
-- ordering XL when they wanted M, and nothing on screen could have told them. The FOH
-- kimono pair (22 and 23) is named correctly, so this is the only one.
--
-- Renaming ours only. The MRK004 line stays as Mercium has it — we never edit Mintsoft.
UPDATE products
   SET name = 'Sushi Kimono (XL)No apron',
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 70;

-- The site code as it appears in an order number.
--
-- Order numbers are MR-<code>-<yyyymmdd>-<seq>, and that number is the idempotency key
-- against Mintsoft: it is the only way to ask "did this order already go?" before a
-- retry. buildOrderNumber therefore refuses anything outside [A-Z0-9], and rightly so.
--
-- Four sites have codes it cannot accept: "M1/2", "MAKI NORI", "MAKI PROPERTY" and
-- "AAHQ-GLASGOW". Creating a draft for any of them threw, the throw was not an
-- OrderError, and the API turned it into a bare 500 — so those sites could never place
-- an order at all, and had placed none between them since the portal opened. The first
-- anyone knew was a GM at M1/2 pressing "Add to request" and getting "server_error".
--
-- Stripping the punctuation automatically is NOT safe: "M1/2" would become "M12", which
-- is a different, trading site with its own orders, and the two would share an order
-- number prefix — interleaved sequences, and an Order/Search lookup that could match the
-- wrong site's order. So the usable code is recorded explicitly, per site.
ALTER TABLE sites ADD COLUMN order_code TEXT;

-- No two sites may share an EFFECTIVE order code, whether it comes from order_code or
-- falls back to code. A plain UNIQUE on order_code would not have caught setting one
-- site's order_code to another site's code.
CREATE UNIQUE INDEX idx_sites_effective_order_code
  ON sites (COALESCE(order_code, code));

-- M1AND2 rather than M1TOO or M12: it cannot be confused with site M12, and it needs no
-- lookup to read. Ross can change any of these while the site has no orders; once a site
-- has ordered, its code is in Mintsoft and should stay put.
UPDATE sites SET order_code = 'M1AND2'       WHERE code = 'M1/2';
UPDATE sites SET order_code = 'MAKINORI'     WHERE code = 'MAKI NORI';
UPDATE sites SET order_code = 'MAKIPROPERTY' WHERE code = 'MAKI PROPERTY';
UPDATE sites SET order_code = 'AAHQGLASGOW'  WHERE code = 'AAHQ-GLASGOW';

-- Where a product is actually stored, and therefore how an order for it is fulfilled.
--
-- Until now every product lived at Mercium and every approved order became a Mintsoft
-- order. Some stock sits in a different warehouse that has no WMS and no API, so an
-- order for it is fulfilled by emailing the people who pick it.
--
-- 'mercium'  -- push to Mintsoft, as before. The default, so every existing product and
--               every code path that does not mention a route keeps its behaviour.
-- 'email'    -- send the item list to the recipients in settings.email_route_recipients.
--               No Mintsoft order is created, so mintsoft_order_id stays NULL and the
--               reconcile job (which selects on that column) correctly ignores it.
ALTER TABLE products ADD COLUMN supply_route TEXT NOT NULL DEFAULT 'mercium'
  CHECK (supply_route IN ('mercium', 'email'));

CREATE INDEX idx_products_route ON products (supply_route, active);

-- Who gets the pick list for an email-route order. Comma-separated so it can be changed
-- without a deploy; blank is not "nobody by default", it is a configuration error, and
-- the send refuses rather than marking an order fulfilled that nobody was told about.
ALTER TABLE settings ADD COLUMN email_route_recipients TEXT NOT NULL DEFAULT '';

UPDATE settings SET email_route_recipients = 'ross@makiramen.com,ramenhq97@gmail.com'
  WHERE id = 1;

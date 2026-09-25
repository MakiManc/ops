-- Two things the portal was deciding that Mercium should decide.
--
-- COURIER. Every order carried a courier service Maki had chosen: a site's own, or the
-- account default beneath it. Nobody at Maki is in a position to choose one -- which the
-- data says plainly, because all 23 sites had NULL here and every order ever sent used
-- the fallback. So the per-site column goes. It held no value in any row, so nothing is
-- lost with it.
--
-- The account default stays, and has to: a live order on 2026-09-22 came back "No
-- CourierService Specified! Either use CourierService or CourierServiceId", so Mintsoft
-- will not accept an order without one. What it now means is narrower -- the value that
-- gets the order through the door, not a choice about how it ships. Mercium picks the
-- real service when they raise the shipment.
ALTER TABLE sites DROP COLUMN default_courier_service_id;

-- ORDER NUMBER. Mintsoft numbers its own orders MRK-<id>; ours arrived carrying
-- MR-<site>-<date>-<seq>, so the portal and Mercium had two names for one order. The
-- portal now sends no OrderNumber and lets Mintsoft assign one, and records it here so
-- both sides can say the same number out loud.
--
-- MR-<site>-<date>-<seq> does not disappear -- it is still the idempotency key, and
-- still the only thing standing between a timed-out send and a second pallet. It moves
-- to ExternalOrderReference, which /api/Order/List returns, so "has this already gone?"
-- can still be asked before every create.
ALTER TABLE orders ADD COLUMN mintsoft_order_number TEXT;

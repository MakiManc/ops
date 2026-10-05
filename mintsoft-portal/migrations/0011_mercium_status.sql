-- What Mercium says about the order, as well as what we say.
--
-- The portal has one word for every order that has reached the warehouse: 'posted', shown
-- to a GM as "Sent to warehouse — Mercium have it and are picking it". On 2026-10-05 that
-- sentence was being shown for twelve orders, and for two of them it was false:
--
--   MR-M9-20260925-001   Mintsoft status 3  CANCELLED      (cancelled at Mercium)
--   MR-M16-20261004-001  Mintsoft status 9  ONBACKORDER    (Mercium cannot fill it)
--
-- Seven more were status 1, NEW: sitting untouched since 2-4 October, not picked, not
-- started. Nobody could tell any of that from the portal.
--
-- Our own status stays the portal's lifecycle and is not overwritten by this -- it is what
-- the write gate and the send path reason about. These two columns are Mercium's answer,
-- recorded beside it, so a disagreement is visible instead of hidden.
ALTER TABLE orders ADD COLUMN mintsoft_status_id INTEGER;
ALTER TABLE orders ADD COLUMN mintsoft_status_at TEXT;

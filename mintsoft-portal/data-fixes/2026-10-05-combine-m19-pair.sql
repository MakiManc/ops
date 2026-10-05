-- Combines M19's two signed-off, unsent orders into one. Ross asked for it on 2026-10-05.
--
--   MR-M19-20261002-001  id 9   approved 2026-10-02 15:24  60 Ramekins
--   MR-M19-20261002-002  id 13  approved 2026-10-05 09:16  6 FOH Kimono, and a ladle and
--                                                          a sushi kimono approved at zero
--
-- Both for M19, both corporate, both signed off in October, neither with a Mintsoft id,
-- neither claimed by a send, no shared product and no line without an approved quantity.
-- Live stock covers the combined order: 60 Ramekins of 2,619 and 6 Kimonos of 27, with
-- every stock row readable for both.
--
-- Why this is a data fix and not a button press: the automatic merge went live minutes
-- after order 13 was signed off, so it never saw it, and these two predate the feature.
-- From now on a second sign-off for a site folds itself in.
--
-- NOT WRITTEN BY HAND. The live rows were replayed into a local database, the real
-- mergeApprovedOrders run against them, and the statements below taken from what it
-- produced -- including the audit JSON, verbatim. tests/merge-m19.test.ts is that
-- verification, kept as a fixture.
--
-- Order 9 survives because it is the older: its number has been quoted for longest, and
-- it carries the 2026-10-05 required date. Order 13's early-order reason moves across,
-- because losing the words a GM typed just because their order was absorbed would hide
-- them from everyone who later asks why this went early.

-- 1. Order 13's lines move to order 9. The two approved at zero move as zeros: a line the
--    approver declined is a decision, not a gap, and the send treats NULL very differently.
INSERT INTO order_lines (order_id, product_id, qty_requested, qty_approved, available_at_request, available_at_approval, recharge_unit_price)
  VALUES (9, 37, 5, 0, NULL, 6, NULL),
         (9, 22, 6, 6, NULL, 27, NULL),
         (9, 69, 2, 0, NULL, 2, NULL);

DELETE FROM order_lines WHERE order_id = 13;

-- 2. The survivor. Corporate site, so both money columns stay null.
UPDATE orders
   SET status = 'approved',
       recharge_total = NULL,
       order_fee = NULL,
       required_date = '2026-10-05',
       notes = 'na, Kait ordered thru Francheska',
       early_order_reason = 'The kimono had been requested for 2 months ',
       post_error = NULL,
       send_claimed_at = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 9 AND status = 'approved' AND mintsoft_order_id IS NULL;

-- 3. The absorbed order. 'cancelled' because there is no other status for closed and not
--    going, and merged_into_order_id so no screen calls it cancelled to a GM.
UPDATE orders
   SET status = 'cancelled',
       recharge_total = NULL,
       order_fee = NULL,
       send_claimed_at = NULL,
       merged_into_order_id = 9,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
 WHERE id = 13 AND status = 'approved' AND mintsoft_order_id IS NULL;

-- 4. The trail, on both sides. The detail is what the real function emits, so an auditor
--    reading this months from now sees the same shape as every merge after it. The actor
--    records who asked and how, rather than implying Ross pressed the button himself.
INSERT INTO order_events (order_id, actor, event, detail) VALUES
  (9, 'ross@makiramen.com (data fix)', 'merged_in',
   '{"from":"MR-M19-20261002-002","linesMoved":3,"linesCombined":0,"rechargeTotalBefore":null,"rechargeTotalAfter":null,"orderFeeBefore":null,"orderFeeAfter":null,"absorbed":[{"productId":37,"productName":"150ML LADLE - MRK011","qtyRequested":5,"qtyApproved":0,"rechargeUnitPrice":null},{"productId":22,"productName":"FOH Kimono (M)No apron","qtyRequested":6,"qtyApproved":6,"rechargeUnitPrice":null},{"productId":69,"productName":"Sushi Kimono (M)No apron","qtyRequested":2,"qtyApproved":0,"rechargeUnitPrice":null}]}'),
  (13, 'ross@makiramen.com (data fix)', 'merged_into',
   '{"into":"MR-M19-20261002-001","linesMoved":3,"linesCombined":0,"rechargeTotal":null,"orderFee":null,"approvedAt":"2026-10-05T09:16:22Z","lines":[{"productId":37,"productName":"150ML LADLE - MRK011","qtyRequested":5,"qtyApproved":0,"rechargeUnitPrice":null},{"productId":22,"productName":"FOH Kimono (M)No apron","qtyRequested":6,"qtyApproved":6,"rechargeUnitPrice":null},{"productId":69,"productName":"Sushi Kimono (M)No apron","qtyRequested":2,"qtyApproved":0,"rechargeUnitPrice":null}]}');

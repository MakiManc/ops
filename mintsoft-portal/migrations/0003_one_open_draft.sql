-- Narrow the one-open-request rule to drafts.
--
-- The original index covered draft AND submitted, which made it impossible for a site
-- to have two requests pending at once. That in turn made the approver's merge feature
-- dead code -- there was no way to reach the state it exists to resolve.
--
-- The rule that actually serves the goal is one open BASKET per site. While a GM is
-- building a request, more items join it rather than starting a second, which is where
-- consolidation does its work. Once submitted, the request is with the approver and
-- should not change underneath them.
--
-- If the site needs something else before that first request is signed off, they start
-- a new one. Two requests are then pending, the approver sees both side by side and
-- merges them, and Mercium still receives a single order. Consolidation is preserved;
-- it just happens at sign-off rather than being enforced by refusing the GM.
--
-- The alternative -- letting a GM add to a submitted request -- keeps one request but
-- changes what an approver is looking at while they look at it, which is worse.
DROP INDEX idx_orders_one_open_per_site;

CREATE UNIQUE INDEX idx_orders_one_open_draft_per_site
  ON orders (site_id) WHERE status = 'draft';

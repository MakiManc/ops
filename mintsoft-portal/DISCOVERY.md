# Phase 0 — Mintsoft discovery

**Written 21 September 2026 from the published specification. Updated the same evening,
after the live run. Read this before anything else gets built.**

## The headline

**Phase 0 is complete. The discovery script has run against the live Maki & Ramen account
at Mercium, and it changed four things we thought we knew.**

The original draft of this document was written without credentials, from Mintsoft's
published specification alone. That got a great deal right — the endpoints, the
safety picture, the absence of idempotency — but the questions it flagged as *unknowable
without a live run* turned out to matter more than the ones it could answer. Three of the
four corrections below were live in the code and would have reached GMs.

### What the live run settled

| Question | Answer |
| --- | --- |
| What does "available to order" mean? | **`OnHand`.** Mintsoft has already deducted allocations. |
| How many clients can this API user see? | Every stock row is client **10**, Maki & Ramen. Cannot be proven — `/api/Client` is admin-only — so it is pinned. |
| How many warehouses? | **Three**: Witham (5), Belgium (6), Germany (8). Only Witham holds stock. Pinned to 5. |
| How bad is the duplicate problem? | **306 of 337 products.** 54 item codes across 14 shipments. |
| Is there anything inbound? | **No.** Zero ASNs on the account. |

### The four corrections

**1. `OnHand` is free stock, not gross stock.** Across all 334 products at Witham, with
no exceptions:

```
Bulk.StockLevel == Bulk.OnHand + Bulk.Allocated     334/334
Bulk.OnHand     == StockLevels.Level                334/334
Bulk.StockLevel == StockLevels.TotalStockLevel      334/334
```

Mintsoft takes allocations off `OnHand` itself. `StockLevel` is the gross figure that
still includes them. The names invite precisely the opposite reading, and we had taken
it: the shipped default formula was `on_hand_minus_allocated`, which deducts a second
time. On the 40 products currently carrying allocations it produced numbers as low as
**−260**, floored to zero and flagged oversold. A GM would have been told there is none
of something we hold 40 of. The other option, `stock_level`, fails the opposite way: 14
products are fully allocated with nothing free, and every one would have been offered
for ordering. Migration `0004` adds `on_hand`, makes it the default, and clears the
stock cache so nothing computed the old way survives.

**2. The duplicate detector was merging clothing sizes.** Sizes live in parentheses —
"Black Maki & Ramen Tee Shirt (XL)" — and `normaliseName` deleted parenthesised text
wholesale. 21 of the 46 clusters in the first run were L/XL/XXL collapsed into one, and
the mapping tool would have offered Francheska three different garments to merge into a
single orderable product. Table tops went the same way: `MRK002-WTW-1500` and
`-WTW-1200` are 1500mm and 1200mm.

The SKU stem was wrong in the other direction. It stripped *trailing* digits, but
Mercium's convention puts the shipment at the **front**: `MRK<shipment>-<item code>`,
330 of 337 SKUs. So it never matched the real duplicates while happily merging the fake
ones. Corrected, the detector finds 108 clusters covering 306 products and zero size
collisions. Black chopsticks alone exist nine times — `UTL-CHP-BLK` plus one per
shipment from MRK001 to MRK011113.

**3. The warehouse pin is load-bearing.** Availability sums across the rows Mintsoft
returns. Unpinned, that adds Witham to Belgium and Germany. Both are empty today, so the
total is right *by luck* — and stops being right the moment Mercium puts anything in
them, silently offering every GM stock that cannot be shipped from Witham. Pinned to 5
in both wrangler configs.

**4. Discovery's own reconciliation was comparing mismatched grains.** `StockLevels`
returns a row per product per warehouse; `Inventory/Bulk` returned Witham only. Keying
on `ProductId` alone compared one warehouse's row against a total spanning all three,
and the two empty EU warehouses read as disagreements. That is why the first run
reported 66–73% agreement for relationships that in fact hold at every single row. Fixed
to key on product *and* warehouse; the numbers are now 100% or 88%, and decisive.

### What the live run confirmed

- `POST /api/Auth` takes `{Username, Password}` and returns a bare 36-character GUID,
  not a JWT. The 24-hour lifetime in the spec is real; one re-auth occurred mid-run.
- **Zero 429s** across ~25 calls at 250ms spacing. No rate limiting observed.
- `/api/Order/Search` gives a clean binary for "does this order exist": one element or
  none. `/api/Order/GetOrderId` returns the same `{OrderId}` body shape for both, and
  differs only in status (200 vs 404) — so `Search` remains the right call, as designed.
- 23 order statuses, 66 courier services, 337 products, 0 ASNs.
- `/api/Client` is refused with **401**, not 403. That is a permissions answer, not a
  credential failure, and conflating the two is what made the first credential check
  report a working login as broken.

### What is still open

- **`/api/Client` is admin-only**, so we cannot prove this user sees only Maki & Ramen.
  Every stock row returned belongs to client 10, which is strong evidence but not proof.
  The pins make it moot operationally. Worth one question to Mercium.
- **`MRK011113`** is a shipment prefix that does not fit the pattern — probably a typo
  for MRK011. Cosmetic, but it means one chopstick line sits outside its shipment group.
- **Belgium and Germany**: why does Maki & Ramen have warehouse records there at all?
  Empty today. Worth knowing before they stop being empty.
- The `name`-signal duplicate clusters are looser than the `sku-stem` ones — where a size
  appears only in the SKU and not the name, a name cluster can still span sizes. Every
  merge is confirmed by a human in the mapping tool, so this is a review-cost point
  rather than a correctness one.

---

## What was verified, and how

Mintsoft publishes a machine-readable specification of its whole API at
`https://api.mintsoft.co.uk/swagger/docs/v1`. I downloaded it on 21 September 2026
(version `8.5.28.001`) and read it directly: **164 endpoints and 134 data models.**

That is a genuine source of truth for endpoint names, parameter names, and the exact
spelling of every field. It is *not* a source of truth for what the data means or what is
in the account — hence the open questions further down.

The API models in `src/lib/mintsoft/types.ts` are generated straight from that
specification rather than typed by hand, so our field names are Mintsoft's, not ours.

### Confirmed: everything the brief assumed exists, does

All the endpoints the brief listed are real, at the paths it gave. Authentication works as
described: `POST /api/Auth` returns a key, sent back on later calls as an `ms-apikey`
header. The single write we will ever make, `PUT /api/Order`, exists and returns a result
per order.

---

## Where the brief was wrong

Three corrections. The first is significant.

### 1. Stock figures do not come from the endpoint the brief points at

The brief has the portal storing `on_hand`, `allocated` and `available` per product, and
points at `GET /api/Product/StockLevels` for stock.

**That endpoint does not return "allocated", and it does not return "available".** Its
response has exactly these fields:

```
ProductId  WarehouseId  ClientId  SKU  Level  TotalStockLevel
PreOrderable  Bundle  LowStockLevel  LastUpdated  Breakdown
```

The numbers the portal actually needs are on a *different* endpoint,
`GET /api/Product/Inventory/Bulk`, which returns:

```
ProductId  SKU  StockLevel  OnHand  Allocated  OffHand  OnOrder  AwaitingReplen
RequiredByBackOrder  InQuarantine  InTransit  InTransition  Scrapped
WarehouseId  LocationId  ClientId  ClientName  WarehouseName  LastUpdated  Breakdown
```

**So `/api/Product/Inventory/Bulk` is the source for the stock cache, not
`/api/Product/StockLevels`.** It also pages properly and takes a `LastUpdatedSince`
filter, which is what makes a 15-minute refresh affordable. Had we built against
`StockLevels`, we would have had no allocated figure at all and would have discovered it
late.

### 2. There is no "available" field anywhere in Mintsoft

> **Settled by the live run.** The answer is `OnHand`: Mintsoft deducts
> allocations itself, and `StockLevel` is the gross figure. See correction 1 in
> the headline. The reasoning below is kept because it explains why the portal
> derives and records the number rather than trusting a single field.

This is the one I most want your attention on.

The brief treats "available" as something we read. **It is not.** Across all 134 models
there is no field named `Available`. The single near-match is
`InventoryPreOrderBreakdown.AvailableForPreOrder`, which is about pre-orders and is not
what we need. Mintsoft gives us `OnHand`, `Allocated` and `StockLevel`, and it is up to us
to decide which of those — or which combination — means "stock a site can actually order
today".

The obvious reading is `available = OnHand − Allocated`, and `StockLevel` may well already
be exactly that. But "may well" is not good enough for a number a GM sees before
committing to an order, and getting it wrong in the optimistic direction means approving
orders the warehouse cannot fill.

So the script settles it empirically rather than assuming. It pulls both endpoints and
tests the candidate formulas against every product that appears in both, reporting how
often each holds:

```
StockLevel.Level          === Bulk.StockLevel
StockLevel.Level          === Bulk.OnHand
StockLevel.Level          === Bulk.OnHand − Bulk.Allocated
StockLevel.TotalStockLevel === Bulk.OnHand
StockLevel.TotalStockLevel === Bulk.StockLevel
Bulk.StockLevel           === Bulk.OnHand − Bulk.Allocated
```

A formula that holds for every product in the account is the definition we adopt, and
`DISCOVERY.md` gets updated with the answer and the sample size. If none holds cleanly,
that is a finding too, and it needs a conversation with Mercium before Phase 2 proceeds.

**Until that is settled, the portal shows no stock number to anybody.**

There is one more source worth weighing, which I nearly dismissed too early.
`GET /api/Product/{id}/Inventory/PreOrderBreakdown/All` returns the only model in the API
that states a *view* rather than a raw count: alongside the usual numbers it carries
**`OutOfStock`** — Mintsoft's own judgement about whether a product can be ordered — and
**`ETAForNewOrders`**, its own answer to when more is coming. Neither can be derived from
the stock feeds.

It is per-product, so it is far too expensive to drive the catalogue. But it is the
closest thing to a second opinion we have, so the run samples a handful of products and
compares. If `OutOfStock` disagrees with whichever formula the reconciliation picks, the
formula is wrong and the question re-opens — and `ETAForNewOrders` may turn out to be a
better source for the "Inbound + date" chip than working it out from ASN lines.

There is a second trap alongside it. `BulkInventoryItem` carries a `LocationId`, which
means one product can come back on **several rows — one per warehouse location**. Any code
that keys those rows by product and keeps the last one would show a single bin's stock as
the whole holding, and would do it silently. Every figure has to be a sum across
locations. The discovery run reports how many products are split this way, so we know
whether this is a live concern in our account or a theoretical one.

### 3. The stock endpoint the brief points at cannot be paged

`GET /api/Product/StockLevels` has **no `PageNo` and no `Limit`** — six parameters, none of
them pagination — and no "changed since" filter either. A whole-catalogue call returns one
unbounded array that cannot be resumed if it fails partway.

`GET /api/Product/Inventory/Bulk` pages properly (Mintsoft documents "Default 100 – Max
500"), takes `LastUpdatedSince`, and also takes an exact-match `SKU` filter, which gives us
a cheap single-product refresh on the same model as the bulk feed. That is a second,
independent reason it is the right source for the stock cache.

### 4. Three fields are spelled wrong in the API, and we have to match them

Mintsoft ships these typos, and code that spells them correctly silently reads nothing:

| What you would expect | What Mintsoft actually calls it |
| --- | --- |
| `ASNItem.QuantityReceived` | `ASNItem.QuantityReceieved` |
| `OrderItem.Committed` | `OrderItem.Commited` |
| `Product.Discontinued` | `Product.DisCont` |

Because our models are generated from Mintsoft's own specification, we match their
spelling automatically. This is mostly a note for anyone reading the code later and
assuming it is a bug.

---

## Useful things the brief did not mention

Reading the full specification turned up several endpoints and fields worth having:

- **`GET /api/Client` and `GET /api/Warehouse`** answer "which client are we, which
  warehouse is ours, and can this login see anybody else's stock" directly. With one
  caveat that matters: `/api/Client` is documented *"Available to Admin users only"*, so
  our API user may simply be refused. A refusal is **not** the same as "no other clients
  exist", and treating it as an empty list would answer the cross-client question with a
  reassuring lie — so the run reports "could not check" and says to pin the client id
  explicitly. There is no endpoint anywhere in the API that reports the caller's own
  identity, which is why this matters.
- **`Product.ImageURL`** — Mintsoft already holds a product photo. The catalogue can seed
  its images from there instead of us sourcing all of them by hand.
- **`Order.TrackingNumber` and `Order.TrackingURL`** sit on the order itself, so the "track
  my delivery" link is a plain read. No need to assemble it from courier templates.
- **`ASN.EstimatedDelivery`** is the expected-arrival date behind the "Inbound + date"
  chip. Per line, `ASNItem.QuantityExpected` minus `QuantityReceieved` gives what is still
  genuinely coming.
- **`GET /api/Product/StockLevels/UpdatedSince`** returns a bare list of *product ids*, not
  stock figures — it answers "what changed since this time", nothing more. That makes it a
  cheap 15-minute poll to decide whether a fuller sync is worth running, but code that
  expected stock records from it would fail at parse time. The real incremental lever is
  `LastUpdatedSince` on `Inventory/Bulk`.
- **`Order.Tags`** could carry the portal's own order reference, giving a second way to
  find an order we created if an order number lookup ever fails.

Three limitations worth knowing now rather than later:

- **Products carry no creation date — but "the last 7–9 shipments" is still available.**
  `Product` has `LastUpdated` and nothing recording when a line was created (across all 134
  models, only `Batch.Created` and `Return.CreatedAt` exist). My first reading of that was
  too pessimistic: I took it to mean duplicates could only be ranked by similarity, never
  by recency. That is wrong, because the window you actually want is defined over
  *shipments*, not over the product catalogue — and shipments are date-filterable.

  `GET /api/ASN/List` takes `BookedInStartInterval` and `BookedInEndInterval` with
  `IncludeASNItems`, and each `ASNItem` carries `ProductId`, `SKU`, `EAN`, `UPC` **and
  `NAME` inline**. That is everything the duplicate finder needs, in the shipment line
  itself, with no lookup back to the product record. `GET /api/Order/List` offers the same
  on the outbound side (`SinceDate`, `ToDate`, `SinceDespatchDate`, `SortOldestFirst`),
  though `OrderItem` carries no product name, so that path needs a join and the inbound one
  does not.

  So the Phase 2 mapping tool can honestly offer "products that arrived in the last N
  shipments" rather than making you wade through the whole catalogue. The detection built
  here still works on names, SKU stems and barcodes — that part stands — but it can now be
  scoped to a real date window instead of running blind over everything.
- **`Product` has no `Barcode` field.** It has `EAN` and `UPC` separately. Anything written
  against a `Barcode` field would silently read nothing.
- **A catalogue pull is probably fine, but worth measuring once.** `Product` declares
  nested `OrderItems`, `ProductPrices`, `ProductSuppliers`, `ProductInCategories` and
  `ProductCustomFields`. I initially flagged this as a likely problem — if `OrderItems`
  (every order line ever placed for that product) came back populated, a full pull would be
  enormous. On a closer read it is much less likely than that, for three reasons.

  In this API, nested collections are **opt-in**: `Order` declares `OrderItems` in exactly
  the same way, and `Order/List` and `Order/Search` both gate it behind an
  `IncludeOrderItems` flag that defaults to false, described as *"whether to populate the
  order items"*. `Product/List` has no such flag at all, which is at least as consistent
  with "never populated" as with "always populated". The `Product` graph is also cyclic
  (`ProductGrowthRates.Product` points back at `Product`), so the server must prune these
  navigation properties somewhere regardless. And `Limit` is capped at 100, so a single
  page is bounded either way.

  These look like artefacts of how Mintsoft generated its documentation rather than a real
  payload. The run still measures the actual response size, because one live call settles
  it — but this is a box to tick, not a redesign to plan for.

Two more, about order lines and categories:

- **Order lines do not carry a "quantity despatched".** `OrderItem` has `Quantity`,
  `Allocated`, `Commited` and `OnBackOrder`, but no despatched count. Detecting a partial
  delivery means reading shipments, not comparing line quantities.
- **Mintsoft's product categories are just a name.** They are too thin to drive the
  catalogue's browsing structure, which confirms the plan to keep our own category on the
  Maki product record.

---

## The most important safety finding: GET is not a safe verb here

This one is worth reading even if you skip the rest.

The normal assumption when working with an API is that `GET` reads and `POST`/`PUT`/
`DELETE` write, so restricting a client to `GET` makes it safe. **On the Mintsoft API that
assumption is false.** Around twenty state-changing operations are exposed as plain `GET`
requests, including:

```
GET /api/Order/{id}/MarkDespatched        GET /api/ASN/{id}/BookIn
GET /api/Order/{id}/Cancel                GET /api/ASN/{id}/Confirm
GET /api/Order/{id}/MarkConfirmed         GET /api/ASN/{id}/MarkPutAwayComplete
GET /api/WarehouseTransfer/{id}/Confirm   GET /api/ASN/{id}/PartBook
```

So a mistyped path, a copied snippet, or a helpful-looking "fetch the order and mark it
read" could book in a shipment or mark an order despatched — and the request would look
completely innocent in a log, because it is a GET.

The brief's hard rules say never to create an ASN and never to write outside the single
approved order. Those rules are sound, but "only issue GETs" is not how to keep them.

**So the discovery client now works from an explicit allow-list of eleven named read
endpoints, and refuses anything else before the request leaves the process** — it will not
even spend an authentication on a disallowed path. Adding to that list is a deliberate
act, and the tests check the list itself for anything that looks like a write.

I would suggest Phase 2 and Phase 3 keep exactly the same discipline: name the endpoints
the portal may call, refuse the rest, and treat the verb as telling you nothing.

---

## Honest stock numbers: three traps

The brief is firm that stock figures must be honest — every number stamped with when it
was synced, unknown values shown as a dash rather than zero. Three things in the API make
that harder than it looks.

### "Not in the feed" is not the same as "none in stock"

Mintsoft says this itself, in its description of `StockLevelsByWarehouse`: *"Based on
Inventory so you'll only get results where inventory record exists"*. A product with no
inventory record is **absent from the response**, not returned as zero. The same caveat
notes that bundles never appear at all.

If the portal builds its stock cache by writing what came back and leaving everything else
at its previous value — or worse, at zero — then a product that dropped out of the feed
shows a stale or invented number. Absent has to be stored as *unknown*, and unknown has to
render as a dash. This is the single easiest way for the portal to start lying, and it
would look completely normal on screen.

### The portal's "available to order" is its own bookkeeping, not Mintsoft's

The brief defines available to order as the mapped stock minus quantities in other
submitted-but-unapproved requests. **Mintsoft has no concept of that second term.** There
is no soft reservation and no pending-order hold anywhere in the API — nothing that would
let us tell Mintsoft "this stock is spoken for, but not yet ordered".

A caveat on my own wording here: an earlier draft said Mintsoft's `Allocated` figure "only
moves once a real order exists in the warehouse". That is a reasonable guess, but it is a
guess — **the specification never defines what `Allocated` means**, on any of the fourteen
models that carry it. It is exactly why the question for Mercium below is worth asking.

So that subtraction happens entirely in our own database, and it has a consequence worth
being deliberate about: between two sites requesting the same item, Mintsoft will keep
reporting the stock as unallocated to both. The portal is the only thing that knows one of
them has already asked for it. That makes the approval-time stock re-check (which the
brief already requires) not a nicety but the actual safety mechanism, and it means the
"other sites' pending demand" column on the approval screen is load-bearing rather than
informational.

### One parameter is spelled two different ways

The batch/expiry breakdown flag is `Breakdown` on `/api/Product/StockLevels` and
`/api/Product/Inventory/Bulk`, but `breakdown` on `/api/Product/{id}/Inventory`. A shared
constant across the client would be silently ignored on one of them — and an ignored flag
returns an empty breakdown array, which reads as "no batch data" rather than as a bug.

One more, less likely to bite: `/api/Product/StockLevels` takes an `IncludeSubclients`
flag, defaulting to false, described as *"currently disabled for most users"*. It only
matters if Maki's Mintsoft account turns out to be a master client with sub-clients
underneath it — which the discovery run will tell us.

---

## The write path, and why idempotency needs care

The portal makes exactly one kind of write to Mintsoft: `PUT /api/Order`. Phase 3 builds
it, but four things about it are worth knowing now, because they change the design rather
than the implementation.

### A successful HTTP response does not mean the order was created

`PUT /api/Order` returns an **array** of results, and each one carries its own `Success`
flag and `Message`. There is no separate error response declared — a failure comes back as
a 200 with `Success: false`.

So "the request worked" and "the order exists" are different questions, and only the
response body answers the second. The client has to parse every element of the array and
require `Success` to be exactly `true` on each. Treating a 200 as success would lose
orders silently, which is the worst possible failure for this system: a GM sees their
request marked sent, and nothing arrives.

The response being an array for a single-order request is a quirk worth respecting too —
we iterate it rather than reading the first element and assuming a length of one.

### Mintsoft has no idempotency of its own

Worth stating plainly: across all 164 endpoints there is **no idempotency key, no dedupe
on order number, and nothing that would reject a second order with the same
`MR-<sitecode>-<yyyymmdd>-<seq>`**. If we send the same order twice, Mercium picks and
ships it twice, and bills us twice.

Every safeguard against duplicates is ours to build, which the brief already assumes. What
the brief does not anticipate is the next point.

### "Not found" does not mean "safe to create"

The brief's retry rule is to call `GET /api/Order/GetOrderId` before re-sending, and
create the order again if it comes back missing. That rule has a hole in it.

Mintsoft's own description of that endpoint's 404 is **"Order not found or not
accessible"** — one status code covering two very different situations. If the order does
not exist, re-creating is correct. If it exists but our key cannot see it — wrong client
id, wrong warehouse, a permissions quirk — then re-creating produces the exact duplicate
we were trying to avoid.

So a 404 must never on its own be treated as permission to create. Phase 3 needs three
outcomes, not two: **found** (attach it, never create), **authoritatively absent** (safe to
create), and **could not tell** (stop, and show it in the sync health screen for a human
to look at). The third outcome is the one the brief is missing, and it is the one that
prevents a double order.

There is also a better endpoint for the check. `GET /api/Order/GetOrderId` declares its
success response as a bare untyped object with **no properties at all**, so there is no way
to know from the spec what it actually returns. `GET /api/Order/Search` takes the same
order number, supports `exactMatch`, and returns a properly typed list of orders — so it
tells us both that the order exists *and* which order it is, which is what we need to
attach it.

The discovery run probes both, against a real order number and against one that cannot
exist, and records exactly what each returns. That decides which one Phase 3 uses. It
creates nothing.

### Two smaller things

- **Cancelling returns a result object, not a boolean.** `GET /api/Order/{id}/Cancel`
  returns `Success`, `Message` and `WarningMessage`. Same rule as creating: check the
  body, not the status code.
- **Orders can carry our own references.** `Tags` and `OrderNameValues` let us stamp the
  portal's request id and site code onto the Mintsoft order. That gives us a second way to
  find an order we created if a lookup by order number ever fails, and it makes the audit
  trail legible from the Mintsoft side too.

---

## Tracking: the timeline ends at "On its way"

**Decided (Ross, 21 Sep): the portal does not claim a delivered state.** The order states
are `draft → submitted → approved → posted → despatched`, with the side exits `rejected`,
`cancelled` and `post_failed`. The GM-facing timeline runs "Waiting for sign-off" → "Sent
to warehouse" → "On its way", and stops there.

That follows the API rather than fighting it.

**Despatched is straightforward.** `Order` carries `DespatchDate` and `DespatchedByUser`,
and `Order/List` filters on `SinceDespatchDate`. That is a clean read, and it is what
drives the last step of the timeline.

**Delivered was never available from the order record.** `Order` has no delivered flag and
no actual delivery date. The only `DeliveryDate` in the whole API sits on the *create*
models — a date you ask for when placing an order, not a confirmation that anything
arrived. `RequiredDeliveryDate` is the same thing under another name.

The alternative was to infer it from courier tracking events
(`GET /api/Order/Shipments/TrackingEvents/List`). That was never solid ground:
`OrderShipment` carries a `DownloadTrackingEvents` flag, so the events can evidently be
switched off, and whether they flow for Mercium's couriers was unknowable without a live
run. A status that is right most of the time is worse than one we never claimed — a GM
who sees "Delivered" on a box that has not arrived stops trusting the whole screen.

**What this removes from the build:** the tracking-event sync, its status mapping, and the
`delivered` state and its transitions. Phase 4 gets simpler, and Phase 2's 15-minute
open-order sync only ever needs to watch for despatch.

**What a GM still gets:** the tracking link. `Order.TrackingURL` is marked `readOnly` in
the spec, so Mintsoft computes and serves the finished link — no courier template to
assemble, which is what the brief assumed. Once an order is on its way, the courier's own
page is the authoritative answer on where the box is, and it is better at that than we
would be.

If this ever needs revisiting, the door is not locked: the events endpoint is still there,
and the discovery run records whether anything flows through it.

---

## Rate limits and the API key

**The specification documents no rate limit at all** — no 429 response on any of the 164
endpoints, and no rate-limit headers.

That is not the same as there being no limit, and there are two hints that limits exist.

One is in the spec itself: `PUT /api/Product/ProductPrices` is documented as having a
*"Limit of 1 Concurrent Request per Mintsoft Customer"*. It is a write endpoint we will
never call, but it establishes that Mintsoft does apply concurrency limits somewhere in
its system — it simply does not say where they apply to reads.

The other is infrastructural: a single unauthenticated probe showed the API sits behind
Cloudflare, which typically enforces limits at the edge and returns an HTML error page
rather than the JSON an API client expects. So the discovery client
already assumes limits exist without knowing them: it paces itself between calls, backs
off on a 429, honours `Retry-After`, and records every response that was not JSON. The
run reports the latency spread and any throttling it actually met.

A failed authentication returns **401 with a completely empty body** — no error message at
all. Worth knowing when the first real run fails: there will be nothing to read, and the
cause is almost certainly the credentials themselves.

**The API key lasts 24 hours.** Mintsoft states it plainly in the description of the auth
endpoint: *"API keys last 24 hours. After that point you'll start receiving 401
unauthorized responses and will need to renew the API key."*

That is the behaviour the client already implements — cache the key, and on a 401
re-authenticate once and retry. It also means the 15-minute sync jobs need no special
handling: they will renew roughly once a day as a matter of course. The run still records
whether the key had to be renewed mid-run, and reads an expiry out of the key directly if
it turns out to be a JSON Web Token, but the headline question is answered.

---

## Duplicate products

The known problem — duplicate lines from the last 7–9 shipments — cannot be measured
without the credentials, so **the product count and the real duplicate count are still
unknown.**

The detection is built and tested, and runs over the real catalogue on the first run. It
clusters products three ways, because no single signal catches them all:

- **Same name once shipment markers are stripped** — "Ramen Bowl", "Ramen Bowl (shipment
  8)" and "Ramen Bowl v3" collapse to one.
- **Shared SKU stem** — `BOWL-01`, `BOWL-02`, `BOWL-03` share the stem `BOWL`.
- **Same barcode** — the strongest signal, and it catches duplicates that were renamed
  enough to defeat the other two.

The run writes every cluster to `discovery/duplicate_clusters.json`, which is exactly the
input the Phase 2 mapping tool needs to let you merge lines into one Maki product and pick
a primary SKU. Nothing is ever merged, edited or deleted in Mintsoft itself.

---

## Answered by the live run

Every question this section used to list as unknown now has an answer. Kept as a record
of what the run was for, and what it found.

**The ones that changed how we build:**

1. **What "available" actually means** — `OnHand`. Allocations are already deducted.
   Proven at 334/334 rows. This was the most important question in the document and the
   answer was the opposite of what we had implemented.
2. **Whether stock is split across warehouses** — yes, three of them, and availability
   sums across rows. Pinned to Witham. See correction 3 in the headline.
3. **Our `ClientId` and `WarehouseId`** — client 10, warehouse 5. Whether the login can
   see other clients cannot be proven (`/api/Client` is admin-only, 401), so both are
   pinned rather than inferred.
4. **How heavy a catalogue pull is** — light. 337 products over 4 pages, the whole sweep
   in well under a minute at 250ms spacing, zero rate limiting. No need for an
   incremental sync yet.

**The ones that shaped the screens:**

5. **How many products, and how bad the duplication** — 337 products, of which **306 are
   duplicates of something**: 54 item codes repeated across 14 shipments. Black
   chopsticks exist nine times. The mapping tool is not a nicety; without it the
   catalogue is unusable.
6. **What is inbound** — nothing. Zero ASNs on the account. The inbound column will be
   empty until Mercium books one in, and that is a true reading, not a broken feed.
7. **Order history** — 50 recent orders read cleanly, addresses redacted on write. 23
   order statuses, 66 courier services.

**The ones that were about safety:**

8. **Rate limits** — none observed. Zero 429s.
9. **Key lifetime** — the documented 24 hours is real. One re-auth happened mid-run,
   handled transparently.

---

## Decisions

### Settled

**Where the code lives — `MakiManc/ops`.** Decided 21 Sep. The portal stays at
`mintsoft-portal/` inside this repository rather than moving to a
`MakiManc/mintsoft-portal` of its own. It sits beside the Ops Command data it will
eventually write into, and it is covered by this repo's CI. No move is planned; the brief's
call for a separate repository is superseded.

**No delivered state.** Decided 21 Sep. See the tracking section above — the timeline ends
at "On its way", because Mintsoft's order record cannot honestly tell us anything past
despatch.

### Still open

**1. The credentials.** This is the only thing blocking the rest of Phase 0. Best set as
secrets on the environment running the work rather than sent in a message. They are never
logged, dumped or committed.

**2. One question for Mercium, worth asking early.** Does Mintsoft's `Allocated` figure
include stock reserved for orders that have not yet been picked? If it does, then
`OnHand − Allocated` is the honest number for "what a site can order today". If it does
not, sites could be shown stock that is already promised elsewhere.

This matters more than it first appears: **the specification never defines `Allocated` at
all**, on any of the fourteen models that carry it. The discovery run will tell us which
formula is *consistent* across the account, and `OutOfStock` from the pre-order breakdown
gives us a second opinion — but only Mercium can tell us what the number actually counts.

---

## What is built and tested

| | |
| --- | --- |
| **Discovery script** | Written, typechecked, ready. Not yet run against the live API. |
| **API models** | 47 models generated from the live specification, and the generator re-run to confirm it reproduces them exactly. |
| **Read-only guarantee** | An allow-list of eleven named endpoints plus two anchored id-bearing patterns, enforced at runtime and exercised by tests. |
| **Tests** | 52 passing. |
| **CI** | Runs the suite on every change to `mintsoft-portal/`, and warns if Mintsoft's spec drifts from our models. |

Run them with `npm test` from `mintsoft-portal/`. What they actually cover:

- **The duplicate clustering**, including that a standalone product is not swept into a
  cluster with its neighbours.
- **Redaction**, including inside nested objects and arrays, and that an empty field is
  left empty rather than given an invented value.
- **The "available" formula testing**, including that a missing number is never quietly
  counted as zero, and that a product split across warehouse locations is summed rather
  than read from one arbitrary row.
- **Pagination honesty** — that a server-capped page size does not read as the end of the
  list, and that hitting a ceiling is reported rather than passed off as a complete answer.
- **The safety properties** — that five real state-changing GETs are refused before
  anything reaches the network, that the allow-list is frozen and contains nothing
  write-shaped, that no credential or key reaches a log, that every address-bearing dump
  goes through the redactor, and that `discovery/` stays git-ignored.

The one thing the tests cannot cover is the live run itself, which is the honest reason
this phase is not finished.

---

## A note on how this was checked

Every factual claim in this document was read out of Mintsoft's published specification
directly, and the load-bearing ones were then re-checked against the raw file rather than
taken from notes — the field lists, the misspellings, the state-changing GETs, the page
caps, and the two order-lookup endpoints.

Where I could not verify something, it is in the unknowns list rather than stated
softly. Where the specification contradicts the brief, I have gone with the
specification and said so. Where the specification contradicts *itself* — `ASN/List`
says its items are excluded while also offering an `IncludeASNItems` flag — that is
recorded as a question for the live run rather than resolved by picking the reading I
prefer.

Every finding was then put to an independent adversarial check against the same
specification — **68 checks in all**, each one trying to refute the finding rather than
confirm it. **61 came back upheld and 7 refuted.** Four of the seven concerned working
notes that never made it into this document. Three were corrections to things I had
written, and all three are folded in above.

Five claims of my own needed correcting along the way, all worth naming:

- `Product/StockLevels/UpdatedSince` returns a list of product ids, not stock figures. An
  earlier draft implied otherwise.
- An earlier draft said the key lifetime was unknown and that the specification said
  nothing about it. **It does** — "API keys last 24 hours", in the auth endpoint's own
  description. I had read the endpoint's parameters and response types but not its prose,
  which is exactly the kind of thing a second pass is for. Worth knowing that the
  specification carries real information in its descriptions as well as its structures:
  the page-size caps, the admin-only restriction on listing clients, and the warning that
  products with no inventory record are absent rather than zero all came from prose too.
- An earlier draft said the missing product creation date meant duplicates could not be
  ranked by recency. Wrong — the window is over shipments, and both the inbound and
  outbound shipment lists are date-filterable.
- An earlier draft presented the nested-collections payload risk as likely rather than
  as the unlikely-but-cheap-to-check thing it is.
- An earlier draft stated that Mintsoft's `Allocated` figure only moves once a real order
  exists. That is a reasonable guess, but the specification never defines `Allocated` at
  all — and stating it as fact quietly undercut the very question this document asks
  Mercium to answer.

# Phase 0 — Mintsoft discovery

**Written 21 September 2026. Read this before anything else gets built.**

## The headline

Phase 0 asked for two things: a discovery script, and a write-up of what the live Mintsoft
account actually contains. **The script is built, tested and ready. The live dump has not
run, because the Mintsoft credentials are not available in this environment.**

`MINTSOFT_USERNAME` and `MINTSOFT_PASSWORD` are both unset here. Nothing I can do works
around that, and I am not going to guess at warehouse numbers.

What I did instead was go after the same questions from the authoritative source that
*is* reachable: Mintsoft's own published API specification. That turned out to answer a
lot more than expected — including three things the build brief got wrong, one of them in
a way that would have cost us a rebuild in Phase 2 — and it narrowed the genuinely
unknowable list down to a short, specific set of questions the script is now built to
answer in one run.

So: this document is honest about which of its statements are **verified facts** from
Mintsoft's specification, and which are **open questions** that need the credentials.
Nothing here is a guess dressed up as a finding.

---

## How to finish Phase 0

Give the script the credentials and it does the rest:

```sh
cd mintsoft-portal
npm install
MINTSOFT_USERNAME='…' MINTSOFT_PASSWORD='…' npm run discover
```

It takes a few minutes, prints a summary as it goes, and writes everything to
`mintsoft-portal/discovery/`. That folder is git-ignored, so the dumps never reach GitHub.
Delivery addresses in the order and ASN dumps are blanked as they are written — the field
*names* are kept, because finding those is the point, but the values are not.

The run needs no decisions from anyone and changes nothing in Mintsoft.

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

- **Products carry no creation date.** `Product` has `LastUpdated` but nothing recording
  when a line was created, so "the duplicates from the last 7–9 shipments" cannot be
  ordered by age directly. `Product.ID` is very likely a usable proxy for creation order,
  but that is an assumption the discovery run should check rather than something to build
  on. It also means duplicate detection has to work on names, SKU stems and barcodes —
  which is what it does — rather than on "recently added".
- **`Product` has no `Barcode` field.** It has `EAN` and `UPC` separately. Anything written
  against a `Barcode` field would silently read nothing.
- **A catalogue pull may be much heavier than it looks.** `Product` nests
  `OrderItems`, `ProductPrices`, `ProductSuppliers`, `ProductInCategories` and
  `ProductCustomFields`. If `GET /api/Product/List` populates those — in particular
  `OrderItems`, which is every order line ever placed for that product — a full pull could
  be enormous. The discovery run measures the real response size, which decides whether the
  hourly catalogue sync can pull the whole list or has to go incremental from day one.

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
submitted-but-unapproved requests. **Mintsoft has no concept of that second term.** It has
no soft reservation, no pending-order hold — its `Allocated` figure only moves once a real
order exists in the warehouse.

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

## Tracking: "despatched" is easy, "delivered" is not

The portal's order states run through to `delivered`, and the brief treats the last three
— posted, despatched, delivered — as driven by Mintsoft. Two of those three are.

**Despatched is straightforward.** `Order` carries `DespatchDate` and `DespatchedByUser`,
and `Order/List` can filter on `SinceDespatchDate`.

**Delivered is not available from the order record at all.** `Order` has no delivered flag
and no actual delivery date. The only `DeliveryDate` field in the whole API sits on the
*create* models — it is a date you ask for when placing an order, not a confirmation that
anything arrived. `RequiredDeliveryDate` is the same thing under another name.

So a genuine "delivered" state has to come from courier tracking events
(`GET /api/Order/Shipments/TrackingEvents/List`, which filters by `TrackingStatusId` and
`SinceLastUpdated`, with the status values themselves from
`/api/Order/Shipments/TrackingEvents/Statuses`). Whether those events actually arrive for
Mercium's couriers is a live question — `OrderShipment` has a `DownloadTrackingEvents`
flag, which suggests it is something that can be switched off.

That gives Phase 4 a decision to make, and it is better made deliberately than discovered
late: either drive "delivered" from tracking events when they exist, or drop the state and
end the GM-facing timeline at "On its way", which is honest and needs no guessing. I would
lean towards the second unless the discovery run shows tracking events flowing reliably —
a status that is sometimes right is worse than one we never claimed.

**The tracking link itself is easy.** `Order.TrackingURL` is marked `readOnly` in the
spec, meaning Mintsoft computes and serves the finished link. There is no need to assemble
one from a courier template, which is what the brief assumed.

---

## Rate limits and the API key

**The specification documents no rate limit at all** — no 429 response on any of the 164
endpoints, and no rate-limit headers.

That is not the same as there being no limit. A single unauthenticated probe showed the
API sits behind Cloudflare, which typically enforces limits at the edge and returns an
HTML error page rather than the JSON an API client expects. So the discovery client
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

## Still unknown until the script runs

Plainly, so nothing here reads as settled. The run answers all of these in one pass.

**The ones that change how we build:**

1. **What "available" actually means** — which of the candidate formulas holds. *The most
   important question in this document.*
2. **Whether stock is split across warehouse locations.** If products come back on
   multiple rows, every figure the portal shows has to be a sum, and the mapping tool has
   to account for it.
3. **Our `ClientId` and `WarehouseId`**, and whether this login can see other clients'
   stock. If it can, every call must pin the client before Phase 2 — otherwise a wrong
   number in one field reads somebody else's warehouse.
4. **How heavy a catalogue pull really is.** If `Product/List` returns every historic
   order line per product, the hourly sync has to be incremental from day one.

**The ones that shape the screens:**

5. **How many products there are**, how many are duplicates, and how bad the worst
   clusters are.
6. **The real order status list** — the ID and name of every status, which is what the
   plain-language timeline ("Sent to warehouse", "On its way") maps onto.
7. **The courier services available**, and which is the sensible default per site.
8. **Whether `Product.ImageURL` is populated**, and whether those images load in a browser
   without the API key. If not, we source photos ourselves.
9. **What the stock `Breakdown` contains** — batch and expiry data that may or may not
   matter for chopsticks and bowls.

**The ones that shape the sync jobs:**

10. **Whether rate limits bite** at a 15-minute cadence, and what Mintsoft returns when
    they do.
11. **Whether `Product.LastUpdated` moves on stock changes or only on catalogue edits.**
    It decides whether an incremental catalogue sync is safe.
12. **Whether `Product.ID` tracks creation order.** There is no created date, so this is
    the only handle on "the duplicates from the last 7–9 shipments".
13. **Whether the published spec matches reality.** The run compares every live payload
    against it and reports fields Mintsoft sends but does not document, fields it
    documents but never sends, and fields that always arrive empty.

---

## Decisions I need from you

**1. The credentials.** Nothing else in Phase 0 can finish without them. The safest route
is to set them as secrets on the environment running this work rather than sending them
in a message. They are never logged, dumped or committed.

**2. Where this code should live.** The brief asked for a new `MakiManc/mintsoft-portal`
repository. I could not create it: this session only has access to `MakiManc/ops`, and
that repository does not exist yet. So the work sits at `mintsoft-portal/` inside
`MakiManc/ops`, on the branch `claude/mintsoft-ordering-portal-t69aoc`.

Nothing is lost either way — splitting it into its own repository later keeps the full
history and takes minutes. But it is your call, and the options are: create
`MakiManc/mintsoft-portal` and grant access so I move it now; or leave it in `ops`, which
is arguably the better home given the Phase 5 job writes into `ops` anyway.

**3. Whether the portal should claim "delivered" at all.** Mintsoft's order record cannot
tell us — there is no delivered flag and no actual delivery date, only a despatch date.
A real delivered state depends on courier tracking events, which may or may not flow for
Mercium's couriers. My recommendation is to end the GM-facing timeline at "On its way"
unless the discovery run shows those events arriving reliably; a status that is sometimes
right is worse than one we never claimed. Happy to build it either way.

**4. One question for Mercium, worth asking early.** Does Mintsoft's `Allocated` figure
include stock reserved for orders that have not yet been picked? If it does, then
`OnHand − Allocated` is the honest number for "what a site can order today" and we are
fine. If it does not, sites could be shown stock that is already promised elsewhere. The
discovery run will tell us which formula is *consistent*, but only Mercium can tell us
what it *means*.

---

## What is built and tested

| | |
| --- | --- |
| **Discovery script** | Written, typechecked, ready. Not yet run against the live API. |
| **API models** | 45 models generated from the live specification, and the generator re-run to confirm it reproduces them exactly. |
| **Read-only guarantee** | An allow-list of eleven named endpoints, enforced at runtime and exercised by tests. |
| **Tests** | 47 passing. |
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

Two claims of my own needed correcting along the way, both worth naming:

- `Product/StockLevels/UpdatedSince` returns a list of product ids, not stock figures. An
  earlier draft implied otherwise.
- An earlier draft said the key lifetime was unknown and that the specification said
  nothing about it. **It does** — "API keys last 24 hours", in the auth endpoint's own
  description. I had read the endpoint's parameters and response types but not its prose,
  which is exactly the kind of thing a second pass is for. Worth knowing that the
  specification carries real information in its descriptions as well as its structures:
  the page-size caps, the admin-only restriction on listing clients, and the warning that
  products with no inventory record are absent rather than zero all came from prose too.

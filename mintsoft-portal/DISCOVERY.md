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
lot more than expected — including two things the build brief got wrong in ways that
would have caused real problems — and it narrowed the genuinely unknowable list down to
a short, specific set of questions the script is now built to answer in one run.

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

### 3. Three fields are spelled wrong in the API, and we have to match them

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
  warehouse is ours, and can this login see anybody else's stock" directly. The script
  calls both first and warns loudly if more than one client is visible.
- **`Product.ImageURL`** — Mintsoft already holds a product photo. The catalogue can seed
  its images from there instead of us sourcing all of them by hand.
- **`Order.TrackingNumber` and `Order.TrackingURL`** sit on the order itself, so the "track
  my delivery" link is a plain read. No need to assemble it from courier templates.
- **`ASN.EstimatedDelivery`** is the expected-arrival date behind the "Inbound + date"
  chip. Per line, `ASNItem.QuantityExpected` minus `QuantityReceieved` gives what is still
  genuinely coming.
- **`GET /api/Product/StockLevels/UpdatedSince`** and the `LastUpdatedSince` filters make
  incremental syncs cheap, which matters at a 15-minute cadence.
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

**Key lifetime is unknown.** The specification says nothing. The script inspects the
key's shape and, if it turns out to be a JSON Web Token, reads the expiry straight out of
it. If it is opaque, the run still reports whether the key had to be renewed part-way
through, which tells us whether the lifetime is shorter than a few minutes. The client
re-authenticates once on a 401 either way, so a short-lived key does not break anything.

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

Plainly, so nothing here reads as settled:

1. **What "available" means** — which formula actually holds. *The most important one.*
2. **Our `ClientId` and `WarehouseId`**, and whether this login can see other clients'
   stock. If it can, every call must pin the client before Phase 2.
3. **How many products there are**, how many are duplicates, and how bad the worst
   clusters are.
4. **The real order status list** — the ID and name of every status, which is what the
   plain-language timeline ("Sent to warehouse", "On its way") maps onto.
5. **The courier services available**, and which is the sensible default per site.
6. **Whether rate limits bite** at a 15-minute sync cadence.
7. **The API key's lifetime.**
8. **Whether `Product.ImageURL` is actually populated** for our products, or present but
   empty.
9. **What the stock `Breakdown` contains** — batch and expiry data that may or may not
   matter for chopsticks and bowls.

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

**3. One question for Mercium, worth asking early.** Does Mintsoft's `Allocated` figure
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
| **API models** | 45 models generated from the live specification; generator re-run and verified reproducible. |
| **Read-only guarantee** | Enforced by tests, not by convention. |
| **Tests** | 23 passing. |

Run them with `npm test` from `mintsoft-portal/`. They cover the duplicate clustering, the
redaction of delivery addresses, the "available" formula testing — including that a
missing number is never quietly treated as zero — and the safety properties: only GETs,
no write endpoint named anywhere, no credential in any log, and `discovery/` git-ignored.

The one thing tests cannot cover is the live run itself, which is the honest reason this
phase is not finished.

# Handover: making the ordering portal easier to use

You are picking up a working system, not a prototype. It is deployed, it holds real data
about real restaurants, and the people named in it are real colleagues. Nothing here is
half-built — the brief is to make what exists kinder to use, particularly for a General
Manager holding a phone in one hand during service.

Read this file, then `README.md`, then `DEPLOY.md`. `DISCOVERY.md` is the warehouse API
archaeology; you will not need it unless you go near the send path.

---

## 1. What it is, and who is on the other side of it

Maki & Ramen is a UK ramen restaurant group. Stock imported from China sits with a
third-party warehouse, **Mercium**, whose system is **Mintsoft**. Before this portal, a GM
who wanted more bowls emailed somebody. The portal replaces the email: a GM builds a
request, an approver signs it off, and only then does anything reach Mercium.

Three roles, and they do not nest:

| Role | Who | What they do | Where they are |
| --- | --- | --- | --- |
| **GM** | 21 site accounts, shared gmail logins | Build a request, send it for sign-off, track it | A phone, standing up, mid-service |
| **Approver** | Francheska, Lincoln | Review every request, adjust quantities, send to Mercium | A laptop, at a desk |
| **Admin** | Ross | Sites, people, photos, SKU mapping, par levels, recharge, sync health | A laptop |

**Design for the GM.** They are the many, they are the least confident with software, and
they are the ones using it in the worst conditions. An approver will work out a confusing
screen because they are at a desk and they use it daily. A GM will give up and send a
WhatsApp, and then the portal has failed at the only thing it was built for.

### The actual numbers today

| | |
| --- | --- |
| Active products in the catalogue | 93 |
| Products with a photo | 62 — so a third are a name and nothing else |
| Active sites | 22 |
| People with accounts | 24 |
| People who have ever signed in | 3 |
| Orders raised | 6 |
| Orders ever sent to Mercium | **0** |

Those last two lines are the important ones. **This UI has never been used in anger.** Six
orders exist because I raised them while testing. Every usability judgement in this
document, mine and the audit's, is reasoning about the code rather than watching a GM
struggle. Treat it accordingly: it points at the likely problems, not at measured ones.

The reason nobody has signed in is not the UI. Google's OAuth consent screen for the
project is set to **Internal**, which admits only `makiramen.com` Workspace accounts, and
every GM login is a gmail address. It needs changing to External in the Google Cloud
console — `DEPLOY.md` has the whole diagnosis under "When someone cannot sign in". It is
not yours to fix and it is not a code problem, but it is why you cannot ask a real GM to
try your work yet.

---

## 2. Running it

The fastest way to see the real thing with real data:

```sh
cd mintsoft-portal
npm install
npm run demo:serve
```

That builds a local D1 from the actual migrations, seeds it with the live catalogue and
real Witham stock levels (`seed/demo.sql`, ~1,100 rows), builds the front end and serves it
over **HTTPS** on `:8788`. The HTTPS is not fussiness: the session cookie is `__Host-`
prefixed and `Secure`, so a browser silently refuses it over plain HTTP and every sign-in
fails with no error worth reading.

For front-end iteration with hot reload:

```sh
npx wrangler pages dev      # the API, :8788
npm run dev                 # Vite, proxying /api to it
```

Checks, and run **both** — they catch different things:

```sh
npm test         # 641 tests, 38 files
npm run typecheck
```

A type error in a test file passes `vitest` and fails `tsc`. That has caught me out here
before; `npm test` alone is not a green light.

Deploy:

```sh
npm run build
npx wrangler pages deploy dist --project-name mintsoft-portal
```

Live at <https://mintsoft-portal.pages.dev>. (`README.md` still says it is not deployed.
That is stale — fix it while you are in there.)

---

## 3. The shape of the front end

Everything is in `src/client/`, about 2,900 lines across eleven screens.

```
App.tsx            291  shell, header, menu, screen switch, site picker
SignIn.tsx         101  Google Identity Services button
Catalogue.tsx      345  GM: browse 93 products, add to request
Basket.tsx         246  GM: review and send for sign-off
MyOrders.tsx       165  GM: what happened to my requests
ApprovalQueue.tsx  381  approver: sign off, adjust, send to Mercium
StockOverview.tsx  134  what is on hand, allocated, inbound
Mapping.tsx        215  admin: combine duplicate warehouse lines
AdminScreens.tsx   312  admin: par levels, recharge report, sync health
Photos.tsx         226  admin: upload the picture a GM sees
SitesAndPeople.tsx 368  admin: who can sign in, and for which sites
Freshness.tsx       38  the "these numbers are old" banner
api.ts              28  four helpers; every other fetch is inline in its screen
format.ts           49  timeAgo, money
index.css           62  Tailwind 4 entry, brand tokens, base rules
```

Things that are deliberate, so you know what you are changing if you change them:

- **No router.** `App.tsx` holds `openScreen` in `useState`. There is no URL for a screen,
  so no deep link, no browser back, and a refresh returns you to the menu. This was a
  shortcut, it is called out as one in the code, and the audit below has opinions.
- **No component library.** Styling is inline Tailwind strings, with per-file consts like
  `primary` and `secondary` redefined in several places.
- **Tailwind 4, CSS-first.** There is no `tailwind.config.js`. Brand tokens live in
  `@theme` in `src/client/index.css`.
- **The base layer already does real accessibility work.** Every `button`, `input` and
  `select` gets `min-height: 44px`; `:focus-visible` gets a 3px Maki Orange outline. The
  palette in that file is annotated with measured WCAG ratios, including the note that
  white-on-orange fails at 3.14 and must never be used. Do not undo any of that, and read
  the comment before you add a colour.
- **The server decides, the client draws.** `SCREENS` in `App.tsx` controls what is drawn
  per role; every API route enforces the same rules again. Editing the menu in the browser
  changes nothing about what is allowed.

UI tests live beside the rest, in `tests/*.test.tsx` — `catalogue-ui`, `basket-submit`,
`phase3-ui`, `role-screens`, `send-button`, `sites-and-people-ui`, `admin-ui`,
`catalogue-ordering`, `sign-in-config`. They render with Testing Library against jsdom and
stub `fetch`. **One trap:** a shared `Response` object is consumed on first read, so a
screen that fetches twice will fail confusingly if the stub hands back the same instance.
Build a fresh `Response` per call. That has bitten me twice in this repo.

---

## 4. Rules you must not break

These are the user's, not mine, and they are not style preferences.

1. **No write to Mintsoft** unless `MINTSOFT_WRITES_ENABLED=true` **and** the order is
   `approved` by a user whose role is `approver` or `admin`. It is enforced in one place,
   `src/server/orders/write-gate.ts`, and tested. Do not add a second path to it.
2. **Never create an ASN, and never edit, merge or delete a product in Mintsoft.** The
   read-only client works from an explicit allow-list in
   `src/lib/mintsoft/readonly-client.ts` because roughly twenty of Mintsoft's
   state-changing operations are exposed as HTTP GETs. Restricting to GET would not keep
   it read-only. If you genuinely need a new endpoint, check the spec first and add it
   deliberately, with a test.
3. **If anything you are doing would require a write to Mintsoft beyond the single test
   order, stop and ask Ross.** A duplicate order is a second pallet that Mercium picks,
   ships and bills for.
4. **No secrets, tokens, customer addresses or raw API responses in logs or in the repo.**
   `discovery/` and `seed/*.csv` are git-ignored for this reason.

None of this should constrain UI work. If it does, you have wandered.

---

## 5. Things that will bite you

- **D1 free tier is 100,000 row writes a day**, resetting at midnight UTC. Sign-in itself
  writes `last_seen_at`, so a database at its limit presents as "that account cannot sign
  in" — I lost an hour to that. Background sync is capped at 50,000 by
  `src/server/sync/budget.ts` so it can never starve user-facing writes. If you add
  anything that writes per render, you will find the ceiling.
- **`__Host-` cookies need HTTPS even locally.** Use `npm run demo:serve`, not a plain
  Vite server, if you need to be signed in.
- **Mintsoft has no idempotency.** HTTP 200 does not mean created; each element of the
  response array carries its own `Success` flag. Nothing in the UI should offer a retry
  that bypasses `postOrder`.
- **Notification email is not configured.** `RESEND_API_KEY` is unset in production, so
  every notification the code sends quietly does nothing. If your UI work assumes a GM got
  an email, it is assuming wrong. Say so on screen instead.
- **Par levels are all zero** across every site, so any screen that leans on them has
  nothing to show. That is data, not a bug, but it makes those screens look broken.

---
## 6. How to work on this

**Verify every finding before you act on it.** §7 came from ten independent audits, each
re-checked by a second reader who opened the files it cited; §10 says how that went and
where I overruled it. Even so, line numbers drift as you edit and a few counts are
approximate — the ones I checked myself against the live database are marked. Open the file
before you believe the finding.

**Change the screen and the test together.** Every UI change should land with its test.
The existing `tests/*.test.tsx` show the house style: render the real component, stub
`fetch`, assert on what a person would see rather than on implementation. Tests here are
written to explain *why* a behaviour exists — read a few before you add one. Where a
finding below describes a bug, write the failing test first.

**Keep the voice.** The copy in this portal is deliberate: plain, direct, says what will
happen next, never blames the user, and explains a refusal rather than just disabling a
button. `src/client/Freshness.tsx` is a good short example — it tells you the numbers are
old, why, and how to read them. Match that. Avoid "Oops", avoid exclamation marks, avoid
jargon a GM would not say out loud (*SKU*, *despatch*, *allocation*, *par level*, *sync*,
*Mintsoft* — a GM orders from "the warehouse", not from Mintsoft).

**Do not start a rewrite.** No router library, no component library, no CSS framework
swap, no state manager. Every fix below is sized to land in the codebase as it stands.
If you find yourself wanting a router, the finding you are working on wants about forty
lines of `location.hash` and a `popstate` listener instead.

**Small, shippable commits.** This repo's commits explain the reasoning, not the diff —
`git log` is worth reading for the house style. One finding per commit where you can.

---

## 7. What to fix
Ordered by what it does to a GM's day, not by how hard it is. Every line reference was
real when this was written; open the file, do not trust the number.

Two findings below were raised **independently by two different reviewers** looking at
different things — the missing send confirmation, and the screen state not being in the
URL. That is worth knowing: they are the two that were impossible to miss.

### 7.1 The five that matter most

**1. The zombie basket. After sending, the request still looks editable and sendable.**
`blocker` · `S` · `src/client/Basket.tsx:17-22, 76-79, 122-137, 236-243`

`RequestBody['request']` is typed as `{ id, orderNumber, earlyOrderReason }` — **no
`status`** — so the basket cannot tell a draft from a request that has already gone. After
sending, a GM who taps back into "Current request" to check sees their lines, editable
quantity boxes and a "Send for sign-off" button, all of which now do nothing useful. The
catalogue's sticky banner says the same. The server payload already carries the answer:
`toSummary` in `src/server/db/orders.ts:80` includes `status`; it is simply not in the
client type.

I verified this one myself — the field genuinely is absent from the interface.

Add `status` to the type and branch before the editable render: a sent request should show
what was sent, read-only, with a line saying who is looking at it and a button to start a
new one. This is the single most misleading thing in the app, and it is a small fix.

**2. There is no URL for anything, so the phone's back gesture leaves the portal.**
`blocker` · `M` · `src/client/App.tsx:74-75, 107, 216-227`

`openScreen` is `useState`, and the comment on line 74 admits it: *"Kept in state rather
than the URL for now."* Nothing in `src/client` references `history`, `pushState`,
`popstate` or `location`. Three live consequences: the edge-swipe back gesture — the way
phone users go back, without thinking — exits the portal entirely and lands them back at
Google sign-in; a refresh or tab restore dumps you on the menu; and there is no link Ross
can send Francheska that opens the queue.

Roughly fifteen lines: initialise from `location.hash.slice(1)`, `pushState` on open,
a `popstate` listener that reads it back, validated against `screens.find(...)` so an
unknown hash falls to the menu. Put the picked `siteId` in the hash too (`#catalogue/9`)
and finding 10 below comes free. Set `document.title` in the same effect — it is currently
fixed in `index.html:8`, so a backgrounded tab gives no clue what it holds.

**3. Sending produces no confirmation at all.**
`high` · `S` · `src/client/Basket.tsx:55-74`, `src/client/App.tsx:181`, `src/client/MyOrders.tsx:85-89`

`submit()` calls `onSubmitted()`, which is `setOpenScreen('orders')`. The screen swaps, a
"Loading…" flickers, and a list appears. Nothing says it was sent. Nothing points at which
row is theirs. Email notification is unconfigured, so there is no second signal either.

The most consequential action in the app ends in silence, and the natural reading of
silence mid-service is *it did not work* — so they go back and press Send again, which
lands them on the zombie basket from finding 1. These two compound.

`MyOrders` already has the slot: a `message` state rendered as a `role="status"` banner at
`MyOrders.tsx:85-89`, currently only ever set by the reorder handler. Pass the order
number through and seed it.

**4. Every "add" can be silently doubled, and nothing on screen can tell you.**
`high` · `M` · `src/client/Catalogue.tsx:58-137`, `src/client/MyOrders.tsx:137-152`

The catalogue card never shows what is already on the request, so a GM who is interrupted
mid-add, comes back unsure whether the tap registered, and taps again, silently doubles the
quantity. The card cannot distinguish "not added" from "added twice". The same shape
appears on "Order the same again" in My orders: its confirmation renders at the top of the
list, off screen, and a second tap adds the whole order again.

Add `qtyInRequest` to the catalogue response and render "6 already in this request" on the
card. Move the reorder confirmation into the card it belongs to, and give the button a busy
state while it is in flight.

**5. A fifth of the ordering catalogue is furniture for opening new restaurants.**
`high` · `S` · `src/server/db/catalogue.ts:85-95`

Checked against the live database twice. Of 93 active products, **20 are
`stock_type = 'expansion'`** — and all 20 are the `Furniture` category. The catalogue
sorts `ORDER BY COALESCE(p.category, 'zzz'), p.name` (`catalogue.ts:92`), and *Furniture*
is alphabetically first, ahead of Other, Packaging, Signage, Tableware, Uniform and
Utensils.

So it is not that furniture is mixed in. **The first twenty products a GM sees, before
anything a restaurant actually orders, are chairs and tables for opening new sites.** That
is why the first product on screen was `CHAIRS - MRK001` when I walked an order through
the deployed UI as the Aberdeen GM. It puts £45 furniture one mis-tap from a stock request
and buries the tableware.

Filter `stock_type = 'expansion'` out of the ordering catalogue, behind an option so the
approver's stock overview — which legitimately wants everything — is unaffected.

### 7.2 Finding things, and getting around

**6. The search box scrolls away and there is no category filter.** `high` · `M` ·
`Catalogue.tsx:242-294, 321-342`. Search and the in-stock checkbox exist and work, and
products are grouped by category — but the controls scroll off the top, so each product a
GM needs is a separate scroll-to-top-and-search cycle. Put search, the checkbox and a row
of category chips into one `sticky top-0` block; the categories are already derived in the
`groups` memo.

**7. Back is unreachable on long screens.**
`high` · `M` · `App.tsx:199-224`. The header is not sticky and holds exactly one control,
Sign out. The app name is a `<p>`, not a link home. The real back button renders once at
the top of `<main>` and scrolls away. Make the header sticky, move back into it, demote
Sign out.

One qualification, which a verifier caught in my first draft: the catalogue is not as bare
as the rest. `Catalogue.tsx:303-319` renders a `sticky top-2` banner with a "Review and
send" button that stays on screen for the whole scroll — but **only once `inRequest > 0`**.
So a GM who has added nothing, which is everyone at the start, has nothing pinned but Sign
out. Every other screen has nothing pinned at all.

**8. The basket cannot reach the catalogue.** `high` · `S` · `Basket.tsx:77-79`.
Catalogue → basket is one tap. The return is three taps and a scroll — which is exactly
what happens when a GM reviews the request and remembers the chopsticks. Mirror the
existing `onGoToBasket` prop with an `onGoToCatalogue`.

**9. The menu never says whether anything is waiting.** `high` · `M` · `App.tsx:262-285`.
"Current request — Check it over and send it for sign-off" reads identically whether the
basket is empty or holds nine lines from three days ago. The catalogue already fetches and
displays that count. So does the queue. The menu, where every session starts, shows
nothing.

**10. Which site you are acting for vanishes on the menu and on refresh.** `medium` · `M` ·
`App.tsx:86, 167-177`. The "Acting for M9 · Change" banner renders only inside the
catalogue and basket. An admin on the menu sees no site context, then taps "Current
request" and is handed some site's basket. On refresh `siteId` resets — and the basket's
own `requesterName`, `requiredDate`, `notes` and `earlyReason` are plain `useState` with no
persistence, so a GM who refreshes loses the "why this cannot wait" reason they just typed,
with no warning they had anything to lose.

**11. Scroll position carries between screens.** `medium` · `S` · `App.tsx:107`. Nothing in
`src/client` calls `scrollTo`. Tap "Review and send" from 4,000px down a catalogue and the
browser clamps you to the foot of the shorter basket — below the lines, at or past the Send
button, and below the "Your name" field you have to fill in. Two lines, plus moving focus to
the `<h1>` so keyboard and screen-reader users are not left on a button that no longer
exists.

**12. Every empty state is a dead end.** `medium` · `S`. *"Nothing in this request yet. Add
something from the stock list."* names the destination and then does not go there. Same in
My orders and in the catalogue's no-results state. Each needs a real button.

### 7.3 Things a GM cannot do that they will want to

**13. There is no way to cancel a request you have just sent.** `high` · `S` ·
`MyOrders.tsx:137-152`. The API supports it (`src/server/app.ts:387-403`); the UI never
offers it. A GM who realises mid-service that the request is wrong has to phone Ross and
hope. Add it for `submitted`, `approved` and `draft`, behind a confirmation.

**14. Basket quantities save on blur only, and clearing the box deletes the line.**
`high` · `M` · `Basket.tsx:46-53, 120-137`. The input is uncontrolled, so when a save
fails the number does **not** spring back — React will not overwrite a DOM input the user
has typed into. The box goes on showing the quantity the GM chose while the server holds
the old one, and Send does not wait for the save either. The failure mode is therefore not
"my change was lost", which a person would notice; it is a screen that agrees with them
and an order that does not. Give it the same −/+ stepper the catalogue uses, make it
controlled, save on a debounce, and show when a save fails.

### 7.4 For the approver and the admin

**15. "All orders" shows every site's orders with no site name on any card.** `high` · `S` ·
`MyOrders.tsx:16, 94-110`. `siteCode` is declared on the interface and then never rendered.
The requester name is free text and site logins are shared, so it is not a stand-in. One
line to fix, plus a site filter.

**16. "Order the same again" fills a different site's basket than "Current request" opens.**
`high` · `M` · `MyOrders.tsx:137-152`, `src/server/app.ts:355-364`. The server copies into
*the order's* site; the basket screen renders `activeSiteId`. An approver acting for M3 who
reorders an M9 order gets a green confirmation and then an empty M3 basket. At minimum,
name the site in the confirmation; properly, route them to the site they just filled.
`siteId` is already on the wire — `ORDER_SELECT` selects `o.site_id` and `toSummary`
returns it — so this needs no server change.

**17. The admin's eleven menu items are one flat undifferentiated list, and the
"Not built yet / Phase N" card is now unreachable.** `low` · `S` · `App.tsx:21, 273-282`.
Every screen is `ready: true`, so that branch is dead. Delete `phase` and `ready`, and group
the admin menu (Ordering / Approvals / Catalogue / Setup).

### 7.5 Patterns worth fixing once, everywhere

These are mine rather than the audit's, from reading all thirteen client files:

- **Nothing offers a retry.** Nine of the thirteen files in `src/client/` contain no retry
  affordance at all. Every screen handles its fetch failure by rendering a red sentence and
  stopping. On restaurant wifi that is the common case, and the only recovery a user has is
  to find the browser reload button — which, per finding 2, also loses their place.
- **Every loading state is the bare word "Loading…".** No skeletons, no preserved layout.
- **Every screen does its own `fetch` inline.** `api.ts` has four helpers, all
  authentication. There is no shared hook, so error handling, loading state and retry are
  re-invented per screen and are inconsistent between them. One small `useResource` hook
  would remove most of the duplication and is where a retry affordance naturally lives.
- **The approval queue is the best-built screen in the app.** Good context per request,
  the early-order reason surfaced prominently, stock per line, a real send flow. When you
  need a reference for how a screen here should feel, use that one — and spend your effort
  on the GM screens, which are the ones that need it.

### 7.6 The other eight audits

These landed after the first draft: the approver's screens, the admin screens, loading and
error states, accessibility, phone behaviour, the visual system, the copy, and forms and
destructive actions. Ninety-nine findings in total, each re-checked by a second reader who
opened the files: none was refuted outright, nineteen came back imprecise and were
corrected — four of those corrections are folded into §7.1–7.4 above, which is why some of
it reads differently from the first version.

**All of this was re-checked against the code as it stands after the 29 September work in
§11.** Everything below is still live: none of it was fixed by that round, which mostly
touched §7.1–7.4. Two worth calling out because they look as though they should have been
caught: the basket got a proper `QtyStepper`, but **the catalogue's add-control still has
the original snap-back bug** (#18); and `ui.ts` now holds the shared button styles, so most
of #35 is done — what remains there is the tone map and the type scale.

Where several lenses found the same thing independently, I have said so. That agreement is
the most reliable signal in here.

**18. Typing a quantity in the catalogue gives you the wrong number.** `blocker` · `S` ·
`Catalogue.tsx:102-111`

I sat and walked this one because it seemed too bad to be true. The input is controlled at
`value={qtyWanted}`, and `onChange` does `setQtyWanted(n > 0 ? n : 1)`. A GM wanting six of
something backspaces the `1` — the field is now empty, `Number('')` is `0`, so it snaps
straight back to `1` — and then types `6` beside the `1` that reappeared. **They get 16.**
On a phone, backspace-then-type is how you change a number; there is no comfortable
select-all. The most repeated action in the app silently multiplies the order.

Hold the raw string in state, allow it to be empty while editing, and coerce on blur.

**19. After an uncertain send, the button re-arms directly under its own warning.**
`high` · `S` · `ApprovalQueue.tsx:253-281, 299-306`

`finally { setBusy(false) }` runs whatever happened, and the button is gated on `busy`
alone. So after a 202 or a dropped connection, the approver reads *"the order may already
be with Mercium"* and sits looking at a live **Send to Mercium** button. Found twice, by
the approver lens and the states lens.

One correction to what the audit said about it, which I know because I wrote the send path:
this will **not** produce a duplicate order. `postOrder` looks the order up before it
creates anything, and returns `uncertain` rather than creating if it cannot get a
trustworthy answer. So the cost is confusion, not a second pallet — which is why I have it
at `high` rather than `blocker`. It is still wrong for the screen to offer the action its
own message tells you not to take. Keep the button disabled after a `wait` outcome and give
it a reload control instead.

**20. Merging a request and then approving it signs the merged-in lines off at zero.**
`blocker` · `S` · `ApprovalQueue.tsx:45-50, 133-134, 192-194`

The card itself recommends the merge. Take the offer, and the merged-in lines arrive with
`0` in their approve boxes; press Approve — which is what the card is inviting — and those
lines go through at zero. The GM is emailed that their request was approved. The stock does
not come. This is the worst of the new findings because the UI leads you into it.

**21. A failed par-level paste crashes the screen and takes the grid with it.**
`blocker` · `S` · `AdminScreens.tsx:123-134, 170, 177`

`setResult(await res.json() as never)` assumes every response is an import result, so a 401
from an overnight session — the realistic case, Ross pasting a grid in the morning — reads
`result.problems.length` on something that has no `problems`, and the whole admin screen
goes blank. The pasted grid is gone with it. Found by three lenses independently (admin,
states, forms), which is as strong as the agreement gets in here. This is also the one
screen that has to be used to get par levels off zero.

**22. The portal prints the server's internal codes at people.** `blocker` · `M` ·
ten inline `fetch` sites, listed at `Catalogue.tsx:76`, `Basket.tsx:67`,
`ApprovalQueue.tsx:65` and `:267`, `SitesAndPeople.tsx:63` and `:166`, `Mapping.tsx:64`,
`MyOrders.tsx`, `Photos.tsx`, `AdminScreens.tsx`

A lapsed session shows the user the string **`not_signed_in`**. This is the same root as
§7.5's "every screen does its own fetch": there is no shared error boundary, so every
screen invents its own handling and several just render whatever the server said. Fixing
the shared hook fixes this at the same time.

**23. The basket shows "Loading…" forever when its fetch fails.** `high` · `S` ·
`Basket.tsx:39-44, 76`. No error, no retry, no timeout. An expired session on the basket
screen is indistinguishable from a slow one, permanently.

**24. Sign-in can end as a blank page with no button and nothing to press.** `high` · `S` ·
`SignIn.tsx:73-78, 89`. The Google script is polled for ten seconds and then the polling
stops silently. On restaurant wifi — the network this app lives on — that is a white screen
on the first thing a GM ever sees.

**25. An approver can sign an order off at zero on every line.** `high` · `S` ·
`ApprovalQueue.tsx:130-136`, `src/server/orders/send.ts:220-231`. The GM is emailed that it
is approved; the send then refuses it as empty. The guard exists in the right place, but it
fires far too late to help anyone.

**26. A product with no stock is chipped "Inbound" and survives the hide-out-of-stock
filter.** `high` · `S` · `format.ts:47`, `Catalogue.tsx:162, 249`. A GM filtering to what
they can actually order is shown things they cannot.

**27. A site created through the admin screen has no delivery notes and no contact phone.**
`high` · `S` · `SitesAndPeople.tsx:72-129`. The form has no fields for them, and both go to
the warehouse on the order. Ross opens a site, everything looks fine, and the first delivery
arrives at the wrong door with nobody to ring.

**28. Both admin forms throw away the field the server named.** `high` · `S` ·
`SitesAndPeople.tsx:63, 130, 166`. The server says *which* field it rejected; the form
shows one message at the bottom, off screen on a phone. Tapping Save appears to do nothing.

**29. Disabled buttons sit at about 2.6:1** — below the 3:1 floor — `high` · `S` ·
`Basket.tsx:240`, `ApprovalQueue.tsx:196, 221`, `AdminScreens.tsx:165`, `Mapping.tsx:145`.
`disabled:opacity-60` on everglade. These are exactly the buttons that are stopping someone
finishing, so they are the ones that most need to be readable.

**30. The 44px base rule stretches every checkbox into a 16×44 sliver.** `high` · `S` ·
`index.css:51-53`. Found by the visual and mobile lenses independently. The rule is right;
it just needs to exclude `input[type="checkbox"]` and `[type="radio"]`, with the tap target
moved to the wrapping `<label>`. Note that `Catalogue.tsx:285` already wraps correctly and
`Mapping.tsx:103` does not, so the two need different fixes.

**31. The disabled Send button removes itself from the tab order, so the explanation of why
it is disabled is never read.** `high` · `M` · `Basket.tsx:223-243`. There is an
`aria-describedby` saying what is blocking the order. A keyboard user tabs to "Anything
else" and then off the end of the page, having never met the button or its reason.

**32. Whether a basket warning blocks the order is carried by background colour alone.**
`high` · `S` · `Basket.tsx:24-28, 146-167`. Nothing in the text distinguishes "this stops
you sending" from "this is worth knowing".

**33. "Add something from the stock list" names a screen that does not exist.** `high` · `S`
· `Basket.tsx:77-79`. The screen is called **Order stock**. Small, and exactly the kind of
thing that strands someone who is already unsure.

**34. Stock ages freeze at page load.** `medium` · `M` · `Catalogue.tsx:228-240`. The
freshness banner is computed once, so a tab left open for three hours still says the stock
was checked four minutes ago. The banner was written to stop people trusting stale numbers
and currently becomes the thing telling them to.

**35. The visual system, as one job.** `medium` · `M-L`. The primary button is written
**twelve** different ways across the app; Everglade and Maki Orange both mean "primary", so
the irreversible Send button looks like a CSV download link; red/amber/green are defined
four times in four files and the definitions disagree; there is no type scale, so a product
name is the same size as body text in a small-x-height display face; sixteen copies of the
card with three near-misses and three radii. Cherry is never used at all and `paper` is
painted over by `bg-gray-50`. This is one afternoon of extracting `Button`, `Card`, `Field`
and a single tone map — and doing it first will make every other fix in this document
faster.

Smaller things I have not written up individually, all confirmed: the catalogue's empty
state blames a search the user may not have made; "30 also requested by other sites" has no
unit and no product name; the stock overview's five headline figures are warehouse jargon
with no units; removing a product photo is one unconfirmed tap beside "Replace"; switching
the People/Sites tab silently empties a half-filled form; a non-numeric "minimum days
between orders" saves as *no minimum*, quietly removing a site's ordering gap; the mapping
screen can only act on lines its own detector clustered, and counts the rest before throwing
them away; and the recharge report fetches every priced line and renders none of them, so
the unpriced-line warning it shows cannot be acted on.

---

## 8. Where to start

§7.1–7.4 are done — see §11. What follows is what is left, re-verified against the current
code.

Four blockers first. All are `S` effort, and each one either gives somebody the wrong
number or takes a screen away from them:

1. **§7.6 #18 — the catalogue quantity field.** Still exactly as first written: backspace
   the `1`, it snaps back, you type your `6` beside it, you order sixteen. The basket's
   new `QtyStepper` did not reach this control. Most-used input in the app.
2. **§7.6 #20 — merged-in lines approve at zero.** `quantities[line.productId] ?? 0` at
   `ApprovalQueue.tsx:134` and `:194`. The card recommends the merge, so the UI walks the
   approver into signing off stock that will never arrive, and the GM is emailed that it
   was approved.
3. **§7.6 #21 — the par-level paste.** `AdminScreens.tsx:131` is still
   `setResult(await res.json() as never)` with no `res.ok` guard, while lines 40 and 220
   in the same file do guard. An overnight 401 blanks the screen and takes the grid.
4. **§7.6 #22 — `not_signed_in` on screen.** Ten call sites still render `body.error`
   straight through. One shared helper fixes all ten, and is the natural home for the
   retry that §7.5 wanted.

Then **§7.6 #19** (the Send button re-arming under its own warning), **#30** (one line of
CSS — exclude checkboxes from the 44px rule), **#25** (approve-at-zero), **#27** (the site
form has no delivery notes or contact phone, and both go to the warehouse), and **#28**
(both admin forms discard the field the server named).

Then the accessibility pair, **#31** and **#32** — the disabled Send button leaves the tab
order so its own explanation is never read, and blocking-versus-advisory is carried by
colour alone.

Finish **#35** last: `ui.ts` has the buttons, so what is left is the four disagreeing tone
maps and the missing type scale.

## 9. How to know it worked

There is no analytics in this app and no user to watch yet, so you cannot measure your way
to an answer. Use these instead:

- **Walk the whole GM job on a phone-sized viewport, on every change.** Sign in, find three
  specific products, set quantities, review, send, then go back and check it went. Count
  the taps and the scrolls. If you cannot do it one-handed without scrolling to the top of
  the catalogue, it is not done. There is a Playwright setup in this environment —
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'` — and
  `npm run demo:serve` gives you real data to drive it against.
- **After every change, ask: if this failed, would the user know?** That question is what
  most of §7 is really about.
- **`npm test && npm run typecheck`, both, every time.**
- **Read your new copy out loud as if to a GM standing in front of you.** If you would not
  say the sentence, do not ship it.

The real test is a GM sending a real order without asking anyone how. That cannot happen
until the Google consent screen is fixed (§1), so when you are done, say clearly what you
changed and what still needs watching when the first real order goes through.

---

## 10. What this covers, and how much to trust it

Ten systematic audits of `src/client/`, each through one lens: the app shell and
navigation, the GM ordering journey, the approver's screens, the admin screens,
accessibility against WCAG 2.2 AA, phone and touch behaviour, loading and error states, the
visual system, the copy, and forms and destructive actions. Every finding had to cite code
the reviewer had opened.

Each lens was then re-checked by a second reader who opened the same files and tried to
break the findings. **99 findings: none refuted outright, 19 corrected as imprecise.** Four
of those corrections changed things I had already written — the furniture is first because
of category sort order rather than alphabetics; the catalogue does keep one control on
screen, but only once something is in the request; a failed basket save keeps the typed
number rather than reverting it; and `siteId` was already on the wire. §7.1–7.4 have been
edited accordingly.

Zero refutations is a high pass rate and I would treat it with some suspicion, except that
the three findings I checked line by line myself — the missing `status` field, the
expansion-stock counts, the empty-state copy — were all exactly as described, and the
nineteen corrections show the second readers were doing real work rather than nodding
along. **Two things I corrected against the audit from my own knowledge of the code:** the
furniture count is 20, not the 22 a verifier gave (checked twice against the live
database), and the re-arming Send button cannot actually produce a duplicate order, because
`postOrder` looks up before it creates. Findings are a place to start looking, not a
verdict. Open the file.

**The thing to keep in mind through all of it:** no order has ever been sent from this
portal and only three people have ever signed in. Every judgement here is reasoning about
code, not watching a GM struggle. The first hour of watching a real GM will be worth more
than this whole document, and it cannot happen until the Google consent screen is fixed
(§1).

Two things are already good, so do not go looking for problems that are not there:

- **The base accessibility layer is real.** `src/client/index.css` gives every button,
  input and select a 44px minimum height and every focusable thing a 3px focus ring, and
  the palette is annotated with measured WCAG ratios — including the note that
  white-on-Maki-Orange fails at 3.14:1 and must never be used. I re-measured two of the
  riskier combinations in use (`text-gray-300` on the everglade header at 8.0:1,
  `text-gray-600` on `bg-gray-50` at 7.2:1); both pass comfortably. The 44px rule has one
  bug — §7.6 #30, checkboxes — and is otherwise doing its job.
- **The catalogue already has search, an in-stock filter and category grouping**, with
  sensible ARIA on the groups. The problem is that the controls scroll away, not that they
  are missing. Do not rebuild them.

And one screen worth copying rather than fixing: **the approval queue** has the best
information design in the app — real context per request, the early-order reason surfaced,
stock per line. Its problems are all in what happens *after* you press something. Use its
card layout as the reference and spend your effort on the GM screens.

---

## 11. What was done on 29 September 2026

Every finding in §7.1–7.4 has landed, plus the retry and loading patterns from §7.5,
and the brand applied from the Brand Guideline 2024 PDF (Everglade header, Maki Orange
for the one action on a screen, Woodsmoke text, Josefin Sans headings, the bowl logo on
sign-in and the mark in the header). 30 tests were added; `npm test` is 671 and
`npm run typecheck` is clean.

| Finding | Where |
| --- | --- |
| 1 zombie basket | `Basket.tsx` reads `request.status`; a sent request renders read-only with no Send |
| 2 no URL | `App.tsx` keeps `#screen/siteId` in the hash, follows `popstate`, sets `document.title` |
| 3 no confirmation | `Basket` hands the order number to `App`, which seeds `MyOrders`' status banner and highlights the row |
| 4 silent doubling | `/catalogue` returns `qtyInRequest`; the card says "✓ 6 already in this request"; reorder confirms in its own card with a busy state |
| 5 expansion stock | `/catalogue` hides `stock_type = 'expansion'` unless `?include=expansion`, and never for a GM; approvers get a checkbox |
| 6 controls scroll away | search, category chips and the stock filter are `sticky` under the header |
| 7 header | sticky; Back and the app name (home) live in it; Sign out is on the menu only |
| 8 basket → catalogue | `onGoToCatalogue`, as "+ Add more" and in every empty state |
| 9 menu counts | "N products waiting to be sent" and "N requests waiting", in Maki Orange |
| 10 site context | site id in the hash; the "Acting for" strip on the menu; basket fields in `sessionStorage` |
| 11 scroll carries | `scrollTo(0)` and focus to the `<h1>` on every screen change |
| 12 dead ends | every empty state has a button |
| 13 cancel | `MyOrders` offers it for draft, submitted and approved, behind an inline confirmation |
| 14 blur-save | `QtyStepper` in the basket: debounced save, "Saving… / Saved / Not saved", an emptied box is never a removal |
| 15 site on cards | site code and name on every order card; a site filter when there is more than one |
| 16 reorder site | the confirmation names the site it filled |
| 17 admin menu | grouped Approvals / Ordering / Catalogue / Setup; `phase` and `ready` are gone |
| retry | catalogue, basket and my orders each offer "Try again" on a failed load |

Shared styles now live in `src/client/ui.ts` (`btnPrimary`, `btnSecondary`, `btnQuiet`,
`btnDanger`, `card`, `input`, `eyebrow`); the per-file `primary`/`secondary` consts point
at them. A web manifest and icons were added so a GM can put the portal on their home
screen.

Still to watch when the first real order goes through: the Google consent screen (§1) is
unchanged, and `RESEND_API_KEY` is still unset, so the on-screen confirmation is the only
one a GM gets.

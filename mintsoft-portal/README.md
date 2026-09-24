# Mintsoft Ordering Portal

A Maki-owned front end for ordering "China stock" from Mercium, our UK 3PL, whose
warehouse system is Mintsoft.

GMs request stock for their site. Nothing reaches Mintsoft until Ross or Francheska
approves it. The portal then creates the order through the Mintsoft API and tracks it
through to delivery.

**Status: every screen built and deployed; the pilot has not run.** Live at
https://mintsoft-portal.pages.dev against Cloudflare D1, with the sync Worker on three
cron triggers.

| Phase | What it was | State |
| --- | --- | --- |
| 0 | Discovery against the live account | Done. `DISCOVERY.md`. |
| 1 | Database, Google sign-in, role boundary | Done. 22 sites, 24 users, guards tested on both sides. |
| 2 | Catalogue, stock, duplicate mapping | Done. 93 products over 337 Mintsoft lines. |
| 3 | Ordering, approval, one live write | Code done and proven — see the caveat below. |
| 4 | Par levels, recharge, sync health, photos | Screens done; par levels and photos hold no data yet. |
| 5 | Nightly feed, sites-and-people admin, pilot | Feed done and green. Sites and people built. Pilot not started. |

**Phase 3's caveat.** The portal's own code has created a real Mintsoft order — 2322,
order number `MR-M9-20260922-001`, which is this codebase's number format rather than
Mercium's `MRK-nnnn`. But it was driven from a local run against live Mintsoft, so the
*deployed* portal has still never written: `MINTSOFT_WRITES_ENABLED` is `"false"` and the
`orders` table is empty. The order-tracking sync has therefore never exercised its real
path either — it has no posted orders to poll, so it returns "nothing waiting" and
records a success. Order 2322 is still open at Mercium and needs voiding.

**Before a pilot**, three things carry real cost if missed: `mercium_order_fee` is still
`0`, every furniture product is priced at a placeholder £45, and no par levels are set.

## Why this exists

- Sites have no clean way to order today.
- Mintsoft's product list carries duplicate lines from the last 7–9 shipments. The portal
  maps around them; it never tries to fix Mintsoft.
- Mercium charges per order, so the portal is designed to produce fewer, fuller orders.

## What is here so far

| Path | What it is |
| --- | --- |
| `DISCOVERY.md` | Phase 0 findings. Read this before building anything. |
| `migrations/` | D1 schema. Applied with `wrangler d1 migrations apply`. |
| `src/server/` | The API: Hono on Cloudflare Pages Functions. |
| `src/server/auth/` | Google sign-in, signed sessions, and the role and site guards. |
| `src/client/` | The React front end. |
| `seed/` | CSV templates for sites and users, and how to apply them. |
| `scripts/discover.ts` | Phase 0 discovery. Read-only. Dumps a slice of the live account to `./discovery/`. |
| `scripts/gen-types.ts` | Regenerates the Mintsoft API models from the published Swagger spec. |
| `scripts/seed.ts` | Turns the seed CSVs into SQL, validating hard first. |

## Running discovery

Discovery needs the Mintsoft API user's credentials. They are never written to disk,
never logged, and never committed.

```sh
npm install
MINTSOFT_USERNAME='…' MINTSOFT_PASSWORD='…' npm run discover
```

Output lands in `./discovery/` — raw responses plus `SUMMARY.json`. That folder is
git-ignored because the dumps contain real warehouse data and third-party delivery
addresses. Personal fields in the order and ASN dumps are redacted as they are written:
the field *names* are kept, because discovering them is the point, but the values are not.

## Running the portal

```sh
npm install
npm run db:migrate:local                      # create the tables
cp seed/sites.example.csv seed/sites.csv      # then fill them in — see seed/README.md
cp seed/users.example.csv seed/users.csv
npm run seed -- --out seed/seed.sql
npx wrangler d1 execute mintsoft-portal --local --file seed/seed.sql

npx wrangler pages dev                        # the API, on :8788
npm run dev                                   # the front end, proxying /api to it
```

Sign-in needs a Google OAuth client id as a `GOOGLE_CLIENT_ID` secret for the API; the
browser reads it back from `/api/config`, so that one value is enough. `VITE_GOOGLE_CLIENT_ID`
still works locally as a shortcut, and is deliberately not needed for a deploy.
`SESSION_SECRET` signs the session cookie.

The Google client's consent screen has to be **External** and published **In production**.
Site logins are shared gmail accounts, which belong to no Google organisation, so an
Internal consent screen turns every GM away before the portal sees them. DEPLOY.md has the
symptoms.

Other scripts:

```sh
npm run gen:types   # refresh the Mintsoft models from the published spec (no credentials needed)
npm run typecheck
npm test
npm run build
```

## Deploying

Not deployed yet — it needs a Cloudflare account and a Google OAuth client id. See
[DEPLOY.md](DEPLOY.md) for the one-time setup.

## How access works

Sign-in is Google, from any domain — site logins are often shared gmail accounts, so
there is no domain to filter on. The gate is the `users` table: an email that is not
there, or is there but inactive, gets no session.

Three roles, which **do not nest**. An admin is not implicitly an approver; if someone
needs both, that is a decision to make rather than something the portal assumes.

| Role | Sees |
| --- | --- |
| `gm` | The catalogue and orders for their linked sites only. |
| `approver` | The approval queue and stock overview, across all sites. |
| `admin` | Sites, people, catalogue mapping, recharge reporting and sync health. |

Every API route enforces this server-side. What the browser draws is a courtesy — a GM
who edits the JavaScript, or calls the API directly, meets exactly the same checks. The
session cookie carries only a user id and an expiry, so changing someone's role or
switching them off takes effect on their next request rather than when their cookie
lapses.

## Safety rules this repo enforces

These are checked in `tests/readonly-guarantee.test.ts`, so they fail in CI rather than in
the warehouse:

- The discovery client works from an explicit allow-list of read endpoints and refuses
  anything else before the request leaves the process. This matters more than it sounds:
  around twenty of Mintsoft's state-changing operations are exposed as HTTP GETs
  (`MarkDespatched`, `BookIn`, `Cancel`), so restricting a client to GET would not keep it
  read-only. See `DISCOVERY.md`.
- No credential or API key reaches a log or a dump.
- Every address-bearing dump goes through the redactor.
- `discovery/` stays git-ignored.

Beyond Phase 0, one further rule applies: the portal's only write to Mintsoft is
`PUT /api/Order`, and only when `MINTSOFT_WRITES_ENABLED=true` *and* the order has been
approved by a user with the `approver` role. We never create an ASN, and never edit, merge
or delete a product in Mintsoft.

## Where this lives

Inside `MakiManc/ops`, at `mintsoft-portal/`. That was a deliberate choice rather than a
default: the portal sits beside the Ops Command data it will eventually write into, and it
is covered by this repository's CI. There is no plan to split it into a repository of its
own.

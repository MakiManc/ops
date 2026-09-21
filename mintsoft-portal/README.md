# Mintsoft Ordering Portal

A Maki-owned front end for ordering "China stock" from Mercium, our UK 3PL, whose
warehouse system is Mintsoft.

GMs request stock for their site. Nothing reaches Mintsoft until Ross or Francheska
approves it. The portal then creates the order through the Mintsoft API and tracks it
through to delivery.

**Status: Phase 0 (discovery) — nothing is built yet beyond the discovery tooling.**

## Why this exists

- Sites have no clean way to order today.
- Mintsoft's product list carries duplicate lines from the last 7–9 shipments. The portal
  maps around them; it never tries to fix Mintsoft.
- Mercium charges per order, so the portal is designed to produce fewer, fuller orders.

## What is here so far

| Path | What it is |
| --- | --- |
| `scripts/discover.ts` | Phase 0 discovery. Read-only. Dumps a slice of the live account to `./discovery/`. |
| `scripts/gen-types.ts` | Regenerates the API models from Mintsoft's published Swagger spec. |
| `src/lib/mintsoft/types.ts` | Generated API models. Do not hand-edit. |
| `src/lib/mintsoft/readonly-client.ts` | A client that implements no write verbs, by construction. |
| `src/lib/mintsoft/discovery-analysis.ts` | The pure analysis helpers, so they can be tested without credentials. |
| `DISCOVERY.md` | Phase 0 findings. Read this before building anything. |

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

Other scripts:

```sh
npm run gen:types   # refresh the API models from the published spec (no credentials needed)
npm run typecheck
npm test
```

## Safety rules this repo enforces

These are checked in `tests/readonly-guarantee.test.ts`, so they fail in CI rather than in
the warehouse:

- The discovery client issues only GETs, plus the one POST to `/api/Auth`. It implements
  no write verb and names no write endpoint.
- No credential or API key reaches a log or a dump.
- Every address-bearing dump goes through the redactor.
- `discovery/` stays git-ignored.

Beyond Phase 0, one further rule applies: the portal's only write to Mintsoft is
`PUT /api/Order`, and only when `MINTSOFT_WRITES_ENABLED=true` *and* the order has been
approved by a user with the `approver` role. We never create an ASN, and never edit, merge
or delete a product in Mintsoft.

## Where this lives

This currently sits inside `MakiManc/ops` rather than its own `MakiManc/mintsoft-portal`
repo. See the note at the end of `DISCOVERY.md` — it is a decision for Ross, and moving it
later is a routine `git subtree split`.

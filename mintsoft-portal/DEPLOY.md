# Deploying the portal

Everything here is one-time setup that needs a Cloudflare account. Nothing in this file
has been run yet — the portal has only been run locally.

## What you need to hand

- A Cloudflare account with Pages and D1 (the free tier covers this comfortably).
- A Google OAuth **client ID** for a web application, from the Google Cloud console.
  Add the portal's URL to its authorised JavaScript origins.
- A long random string for signing session cookies. Generate one, don't invent one:
  `openssl rand -base64 48`

## Steps

```sh
cd mintsoft-portal
npx wrangler login

# 1. Create the database, then paste the id it prints into wrangler.toml.
npx wrangler d1 create mintsoft-portal

# 2. Create the tables.
npx wrangler d1 migrations apply mintsoft-portal --remote

# 3. Load the sites and people (see seed/README.md for the CSVs).
npm run seed -- --out seed/seed.sql
npx wrangler d1 execute mintsoft-portal --remote --file seed/seed.sql

# 4. Build and publish.
npm run build
npx wrangler pages deploy dist --project-name mintsoft-portal

# 5. Secrets. These never go in a file, and never in git.
npx wrangler pages secret put SESSION_SECRET    --project-name mintsoft-portal
npx wrangler pages secret put GOOGLE_CLIENT_ID  --project-name mintsoft-portal
```

The browser also needs the Google client id at build time, as `VITE_GOOGLE_CLIENT_ID`.
It is not a secret — it is visible in the page source by design — but it does have to
match the one the API checks against, or every sign-in fails.

## Secrets this project uses

| Name | Used by | When |
| --- | --- | --- |
| `SESSION_SECRET` | API | Now. Signs session cookies. |
| `GOOGLE_CLIENT_ID` | API and build | Now. Sign-in fails without it. |
| `MINTSOFT_USERNAME` / `MINTSOFT_PASSWORD` | Sync jobs | Phase 2. |
| `RESEND_API_KEY` | Email | Phase 3. |

`MINTSOFT_WRITES_ENABLED` stays `false` in `wrangler.toml` until Phase 3, and turning it
on is deliberate. Even then, the one write it allows also requires an approver's sign-off
— the flag alone is not enough.

## Rotating SESSION_SECRET

Changing it signs everyone out, and nothing else. That is the right move if it is ever
exposed: `wrangler pages secret put SESSION_SECRET` again, and every existing cookie stops
verifying on its next request.

## A note on the first deploy

Sign in as yourself first and check you land on the admin screens. If sign-in fails, the
usual causes, in order: the client id in the build does not match the one the API checks;
the portal's URL is not in the Google client's authorised origins; or your email is not in
`users.csv`. The portal deliberately gives the same message for all three, so check them
in that order rather than reading anything into the wording.

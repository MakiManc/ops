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

## Where the Mintsoft credentials go

Mintsoft accepts one thing on the wire: an `ms-apikey` header. There are three ways to
end up holding one, and they are not interchangeable.

| Form | What it is | Good for |
| --- | --- | --- |
| `MINTSOFT_USERNAME` + `MINTSOFT_PASSWORD` | The API user's login. `POST /api/Auth` exchanges it for a key, and the client re-exchanges it when that key expires. | Everything, including the scheduled sync. |
| `MINTSOFT_API_KEY` | A key already minted. It dies 24 hours after it was issued and the client cannot renew it. | A one-off run today. |
| `MINTSOFT_PROXY_AUTH=true` | The key is held outside the session and a proxy attaches the header. Nothing in the process ever sees it. | A one-off run today, without the key entering the session. |

Mintsoft states the lifetime itself, in the auth endpoint's description: *"API keys last
24 hours. After that point you'll start receiving 401 unauthorized responses and will
need to renew the API key."* So a bare key is never enough for anything scheduled — the
15-minute sync would stop working by this time tomorrow.

Supply exactly one form. Two at once is refused rather than silently preferred, so that
a failure always names the credential it was about.

Check whichever you have set with:

```bash
npm run check:credentials
```

It reads `/api/Client` and `/api/Warehouse`, prints no secret, writes nothing, and says
per form whether it works and what it is good for. Run it before `npm run discover`.

### Setting them

**In a Claude Code cloud session**, so discovery and the sync can run there. Open
[claude.ai/code](https://claude.ai/code), select the cloud icon showing the environment
name in the row above the message box, hover the environment and select the settings
icon. There is no direct URL for it. Then, in the **Update cloud environment** dialog:

- For the login, use **Environment variables** — `.env` format, one `KEY=value` per line.
  Note the dialog's own warning: anyone who uses the environment can read these values.
- For a bare key, prefer **API credentials** below it (Pro and Max plans, organisation
  admin role). Select **Add credential**, keep **Credential type** as **Bearer**, set
  **Allowed websites** to `api.mintsoft.co.uk`, and under **Custom headers** change the
  header **Name** to `ms-apikey` and **clear the prefix** so the bare value is sent.
  Then set `MINTSOFT_PROXY_AUTH=true` as an environment variable, which tells the client
  to send no header of its own and let the proxy attach it. The key never reaches the
  session, its environment, or any file.

Either way, a session copies the environment's values once at startup. Editing them
affects sessions started afterwards; a session already running keeps what it started
with, so start a new one.

**Locally**, add the lines to `mintsoft-portal/.dev.vars` (git-ignored; `.env.example` is
the template). `wrangler pages dev` reads that file and ignores shell environment
variables, which is a trap worth knowing about.

**For a one-off script run**, prefix the command:

```bash
MINTSOFT_USERNAME='…' MINTSOFT_PASSWORD='…' npm run discover
```

**In production**, two deployables, so four commands:

```bash
npx wrangler pages secret put MINTSOFT_USERNAME --project-name mintsoft-portal
npx wrangler pages secret put MINTSOFT_PASSWORD --project-name mintsoft-portal
npx wrangler secret put MINTSOFT_USERNAME --config wrangler.sync.toml
npx wrangler secret put MINTSOFT_PASSWORD --config wrangler.sync.toml
```

The Pages project serves the API; the sync Worker holds the cron triggers. Neither can
read the other's secrets. The dashboard route is the same thing by hand: Workers & Pages
→ the project → Settings → Variables and Secrets → Add, with the type set to **Secret**
rather than Text. A value added as Text is readable afterwards; a Secret is not. Only the
login belongs here — a 24-hour key would expire before the next deploy.

Nothing above turns on writes. `MINTSOFT_WRITES_ENABLED` stays `"false"`, and with a
valid credential in place the client still refuses every path outside its read
allow-list.

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

# Deploying the portal

Everything here is one-time setup that needs a Cloudflare account. Nothing in this file
has been run yet — the portal has only been run locally.

## What you need to hand

- A Cloudflare account with Pages and D1 (the free tier covers this comfortably).
- A Google OAuth **client ID** for a web application, from the Google Cloud console.
  Add the portal's URL to its authorised JavaScript origins.
- That client's audience set to **External**. This matters more than it sounds: most site
  logins are shared gmail accounts, and a gmail account belongs to no Google organisation
  at all. An Internal audience admits only the makiramen.com Workspace, so every GM is
  turned away by Google before the portal ever sees them. External does not widen who can
  get in — the allow-list in `users` is what does that. Publishing status does not matter
  either way for this app; see "When someone cannot sign in" below for why.
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

The browser gets the client id from the API, at `/api/config`, so `GOOGLE_CLIENT_ID`
above is the only place it is set. It is not a secret — it is visible in the page source
by design. It used to be baked in at build time as `VITE_GOOGLE_CLIENT_ID`, which meant a
build that forgot it shipped a sign-in button that could not work; that is why it moved.

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

Sign in as yourself first and check you land on the admin screens. Then have someone on a
**gmail** account try, before telling any GM the portal is ready. Every successful sign-in
so far being a makiramen.com account is not proof that gmail works — it is equally
consistent with gmail being blocked, which is exactly what happened.

## When someone cannot sign in

Read the message they actually saw, and work out **who** refused first. The two look
nothing alike, and confusing them has cost hours twice.

**Google refused — the message is on a Google page,** and mentions an organisation, a
verification process, or testers. Nothing reached the portal, so there is no log line and
nothing to find in D1. This is the consent screen, not the account: Google Cloud console →
APIs & Services → OAuth consent screen (**Audience** in the newer console).

| What they saw | What it means | Fix |
| --- | --- | --- |
| an organisation is mentioned; HTTP 403, reason `org_internal`, "This client is restricted to users within its organization" | audience is **Internal** | change it to **External** |
| "origin is not allowed", `Error 400: redirect_uri_mismatch` | portal URL missing from the client | add it to authorised JavaScript origins |

The first is not a per-person problem, so there is no point checking one GM's row: if a
single gmail account is blocked that way, every one of them is.

**Publishing status and test users are a blind alley here, and it is worth knowing why
before an hour goes into them.** Google's own wording, on managing an app's audience:

> Projects configured with a publishing status of Testing are limited to up to 100 test
> users listed in the OAuth consent screen. The only exception to this behavior is if
> your app requests a subset of the following: name, email address, and user profile. […]
> For such requests, your users do not need to be in the trusted user list […] and their
> authorizations will not expire after 7 days. If your app uses Sign in with Google to
> authenticate users then this exception also applies.

That exception is exactly this portal. `SignIn.tsx` uses `google.accounts.id` — Sign in
with Google, nothing else. It never calls `initTokenClient`, never names a scope, and
never asks for Drive, Gmail or Calendar, so the only scopes in play are openid, email and
profile. The consequences are worth stating plainly, because each one is a thing not to
go and do:

- **Testing and In production behave identically for us.** Publishing changes nothing.
- **The test user list does nothing.** Adding twenty-four GMs to it will not let one of
  them in, and leaving it empty will not keep anyone out.
- **The 7-day expiry does not apply**, and could not anyway: we verify an ID token once at
  sign-in and then issue our own cookie. There is no refresh token to expire.
- **There is no verification review to wait for.** It is only triggered by sensitive or
  restricted scopes, and we request none.

Google's own comparison of OAuth app states says the same thing from the other side. Of
External + Testing: "Only test users on allowlist (max 100)", and then the exception, "If
the app only requests basic identity scopes (openid, email, profile), any user can access".
Of Internal: "All users within your organization can access."

That is what makes the diagnosis an elimination rather than a guess. If the audience were
External, a GM on gmail would be let in whatever the publishing status — the exception
covers us. They are not being let in. So the audience is Internal, and `Internal` versus
`External` is the whole of it: the only Google setting that can lock a GM out of this
portal.

Which also answers the Publish button, if it will not do anything. Publishing status is a
property of External apps — it is how Google's table is laid out, with Internal a single
row and no Testing/production split — so there is nothing for an Internal app to publish.
It is a symptom, not a second problem. The control to look for is the one that changes the
audience to External, not the one that publishes.

**The portal refused — the message is the portal's own,** "That account cannot sign in to
the ordering portal." Google issued a token and we turned it down. The reason is in the
logs, deliberately not in the browser:

```sh
npx wrangler pages deployment tail --project-name mintsoft-portal
```

Causes, in order: the email is not in `users`; it is there but `active = 0`; the client id
in `/api/config` does not match the one the API verifies against; or D1 is refusing the
write — sign-in stamps `last_seen_at`, so a database at its daily write limit reads as a
rejected account. Check the tail before theorising; it names which one it was.

**Neither — no button, or an error about configuration.** `curl -s
https://mintsoft-portal.pages.dev/api/config` and check `googleClientId` is not empty. If
it is, the secret is missing and nobody can sign in.

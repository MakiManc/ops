# Seed data

Two files decide who can sign in and which sites they can order for.

## Filling them in

Copy the examples and edit:

```sh
cp seed/sites.example.csv seed/sites.csv
cp seed/users.example.csv seed/users.csv
```

Your real `sites.csv` and `users.csv` are git-ignored, because they carry staff email
addresses. The `.example.csv` files are committed as the template.

### sites.csv

One row per site. `code` is the site code (M9, M19, MAF1) and is what the order number
is built from.

- **type** — `restaurant`, `factory` or `franchise`
- **recharge** — `yes` only for franchise sites. Corporate sites are never recharged and
  never see a price. The script rejects the file if these disagree.
- **min_days_between_orders** — leave blank to use the portal-wide default. Mercium bills
  per order, so this is the control on how often a site can order.
- Anything with a comma in it — addresses, delivery notes — must be wrapped in double
  quotes, or the columns after it shift by one.

### users.csv

One row per person who can sign in. Anyone not in this file cannot get in, whatever
Google account they have.

- **role** — `gm`, `approver` or `admin`. The roles do not nest: if someone needs to both
  approve and administer, that is a decision to make, not something the portal assumes.
- **sites** — for GMs only, separated by `;` (e.g. `M9;M19`). Leave blank for approvers
  and admins, who are not site-scoped. A GM with no sites would sign in and see nothing,
  so the script treats that as an error.

## Applying them

```sh
npm run seed -- --out seed/seed.sql          # validate, then write the SQL
npx wrangler d1 execute mintsoft-portal --local --file seed/seed.sql
```

The script never writes to the database itself — it produces SQL you can read first.
Re-running is safe: rows are matched on site code and email, so fixing a typo and
re-seeding updates the row rather than adding a second one.

**These files are the full list, not a set of additions.** Applying the generated SQL
deactivates any user who is not in `users.csv` and closes any site that is not in
`sites.csv`. That is how offboarding works — deleting someone's row is what revokes
their access — so never apply a partial file. Removing a site from a GM's `sites`
column removes their access to that site.

Nothing is ever deleted outright. A departed user is deactivated and a closed site is
marked inactive, so past orders still name who placed them.

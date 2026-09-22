# Data fixes

Hand-written, one-off SQL applied to the live database, kept because a production data
change with no record in the repo becomes a mystery six months later.

Not migrations: nothing here changes the schema, and nothing is applied automatically.
Each file names what it did, to which rows, and why — and each is dated, because the
question people actually ask is "when did this product change?".

Not `seed/`, which is git-ignored: everything there is generated and reproducible, and
none of this is.

Applied with:

    npx wrangler d1 execute mintsoft-portal --remote --file data-fixes/<file>.sql

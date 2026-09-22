# Product photos

**Most of the time, use the Product photos screen in the portal instead of this folder.**
An administrator picks a file, the browser resizes it and it is live immediately — no
commit, no deploy, and it works from a phone. The bytes go to D1; see
`migrations/0006_product_photos.sql`.

This folder is the bulk path, for when a supplier sends the whole catalogue at once and
committing 97 files beats 97 taps. A photo here and a photo uploaded through the screen
both end up in `products.image_url`, so the last one set wins.

Drop photos here, named after the **item code** — the SKU with its `MRK<shipment>`
prefix removed:

    MRK005-BCB, MRK010-BCB, MRK011-BCB   ->   BCB.jpg

One photo covers every shipment of the same item. That is the point of the catalogue
mapping: a GM sees one product, not eight.

`.jpg`, `.jpeg`, `.png` and `.webp` all work, and matching ignores case.

## When two products want the same code

A stem is not an identity — Mercium reuses one across unrelated items. `STS` is both
Sakura Trees and Square Table Top (Copper), so `STS.jpg` cannot mean both. When that
happens the script says so and links neither, because the wrong picture on a product is
worse than none.

Settle it by naming a file after the product instead — `P103.jpg` for product 103. That
beats the code, and the stem file then belongs to whoever is left.

Then:

    npm run photos                        # what is matched, what is missing, what is orphaned
    npm run photos -- --out seed/photos.sql
    npx wrangler d1 execute mintsoft-portal --remote --file seed/photos.sql

It reads the product list from the live database through wrangler, so it needs no
credentials of its own. Add `-- --local` to check against the local database instead.

Vite copies this folder into `dist/`, so a photo is live at `/products/<CODE>.jpg` on the
next deploy. A photo is a commit, the same way a stock refresh is.

## Why these are not Mintsoft's

135 of Mintsoft's 337 product lines carry an `ImageURL`, and every one points at
`om.mintsoft.co.uk/Image/GetImage/<id>`. That host answers HTTP 500 both anonymously and
with a valid API key — it is the web UI's host and wants a browser session, not an API
key. DISCOVERY.md left this open; the answer is that we hold the photos ourselves.

## Keep them small

These load on a phone in a restaurant, often on a bad connection. Roughly 800px on the
long edge is plenty for an 80px thumbnail on a high-density screen. A 4MB photo straight
off a phone is 4MB every GM downloads for no visible gain.

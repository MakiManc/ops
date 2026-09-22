# Product photos

Drop photos here, named after the **item code** — the SKU with its `MRK<shipment>`
prefix removed:

    MRK005-BCB, MRK010-BCB, MRK011-BCB   ->   BCB.jpg

One photo covers every shipment of the same item. That is the point of the catalogue
mapping: a GM sees one product, not eight.

`.jpg`, `.jpeg`, `.png` and `.webp` all work, and matching ignores case.

Then:

    npm run photos                        # what is matched, what is missing, what is orphaned
    npm run photos -- --out seed/photos.sql
    npx wrangler d1 execute mintsoft-portal --remote --file seed/photos.sql

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

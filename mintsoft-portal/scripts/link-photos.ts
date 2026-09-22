/**
 * Matches product photos on disk to Maki products, and emits the SQL to link them.
 *
 *   npm run photos              # report what is matched and what is still missing
 *   npm run photos -- --out seed/photos.sql
 *
 * Mintsoft cannot supply these. 135 of its 337 lines carry an ImageURL, but every one
 * points at om.mintsoft.co.uk/Image/GetImage/<id>, which answers 500 both anonymously
 * and with a valid API key — it is the web UI's host and wants a browser session, not
 * an API key. So the photos are ours to hold, which DISCOVERY.md left open and this
 * settles.
 *
 * Drop files in public/products/ named after the ITEM CODE, which is the SKU with the
 * MRK<shipment> prefix stripped:
 *
 *     MRK005-BCB, MRK010-BCB, MRK011-BCB   ->   BCB.jpg
 *
 * One photo covers every shipment of the same item, which is the whole point of the
 * mapping: a GM sees one product, not eight. Matching is case-insensitive and accepts
 * .jpg .jpeg .png .webp.
 *
 * Vite copies public/ into dist/, so a photo is live at /products/<CODE>.jpg the next
 * time the portal is deployed. No object store, no upload endpoint, no extra
 * credentials — a photo is a commit, the same way a stock refresh is.
 */
import { readdirSync, writeFileSync } from 'node:fs'
import { MintsoftReadOnlyClient } from '../src/lib/mintsoft/readonly-client.ts'

const DIR = new URL('../public/products/', import.meta.url).pathname
const ACCEPTED = /\.(jpe?g|png|webp)$/i

/** The SKU with its shipment prefix removed — the same stem the mapping groups on. */
export const itemCode = (sku: string) =>
  sku.trim().toUpperCase().replace(/^MRK\d+[-\s]+/i, '').trim()

interface Row { id: number; name: string; a_sku: string; lines: number }

function photosOnDisk(): Map<string, string> {
  const found = new Map<string, string>()
  let files: string[] = []
  try { files = readdirSync(DIR) } catch { return found }
  for (const f of files) {
    if (!ACCEPTED.test(f)) continue
    found.set(f.replace(ACCEPTED, '').trim().toUpperCase(), f)
  }
  return found
}

function main(rows: Row[]) {
  const photos = photosOnDisk()
  const outIndex = process.argv.indexOf('--out')
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined

  const matched: { id: number; code: string; file: string; name: string }[] = []
  const missing: { code: string; name: string; lines: number }[] = []

  for (const r of rows) {
    const code = itemCode(r.a_sku)
    const file = photos.get(code)
    if (file) matched.push({ id: r.id, code, file, name: r.name })
    else missing.push({ code, name: r.name, lines: r.lines })
  }

  // A file nobody claims is worth naming: it is usually a typo in the filename, and
  // silence would leave the product looking un-photographed for no visible reason.
  const claimed = new Set(matched.map((m) => m.file))
  const orphans = [...photos.values()].filter((f) => !claimed.has(f))

  console.log(`\n${matched.length} of ${rows.length} products have a photo.`)
  if (missing.length) {
    console.log(`\nStill missing (${missing.length}) — name the file after the code:`)
    for (const m of missing.slice(0, 40)) {
      console.log(`  ${m.code.padEnd(16)}${m.name.slice(0, 46)}`)
    }
    if (missing.length > 40) console.log(`  … and ${missing.length - 40} more`)
  }
  if (orphans.length) {
    console.log(`\n${orphans.length} file(s) match no product — check the filename:`)
    for (const f of orphans) console.log(`  ${f}`)
  }

  if (!matched.length) { console.log('\nNothing to link yet.\n'); return }

  const sql = matched
    .map((m) => `UPDATE products SET image_url = '/products/${m.file.replace(/'/g, "''")}' WHERE id = ${m.id};`)
    .join('\n') + '\n'

  if (out) { writeFileSync(out, sql); console.log(`\nWrote ${matched.length} statement(s) to ${out}\n`) }
  else console.log(`\nRun again with --out <file> to write the ${matched.length} UPDATE statement(s).\n`)
}

// The product list comes from the deployed database via wrangler, piped in as JSON, so
// this script needs no database credentials of its own.
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  const parsed: unknown = JSON.parse(raw)
  const rows = (Array.isArray(parsed) ? parsed[0] : (parsed as { result: unknown[] }).result?.[0]) as
    { results: Row[] }
  main(rows.results)
})

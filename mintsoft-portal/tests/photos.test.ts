/**
 * Product photos: what may be stored, who may store it, and what the browser is told.
 *
 * The bytes live in D1 today. These tests go through the same module the routes use, so
 * moving to object storage later has to keep passing them.
 */
import { describe, expect, it } from 'vitest'
import { FakeD1 } from './helpers/d1.ts'
import {
  ACCEPTED_TYPES, MAX_BYTES, PhotoRejected, assertAcceptable, deletePhoto, etagFor, getPhoto,
  photoStatus, putPhoto,
} from '../src/server/db/photos.ts'
import type { Database } from '../src/server/db/repo.ts'

const db = () => new FakeD1() as unknown as Database

async function seedProduct(d: Database, id: number, name: string, sku?: string) {
  await d.prepare(
    `INSERT INTO products (id, name, stock_type, active) VALUES (?, ?, 'internal', 1)`,
  ).bind(id, name).run()
  if (sku) {
    await d.prepare(
      `INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
       VALUES (?, ?, ?, 1)`,
    ).bind(id, id * 1000, sku).run()
  }
}

const png = (size = 64) => new Uint8Array(size).fill(7)

describe('what may be stored', () => {
  it('refuses a type nobody asked for', () => {
    expect(() => assertAcceptable(png(), 'image/gif')).toThrow(PhotoRejected)
    expect(() => assertAcceptable(png(), 'application/pdf')).toThrow(/not one of/)
    // The ones a phone actually produces all pass.
    for (const t of ACCEPTED_TYPES) expect(() => assertAcceptable(png(), t)).not.toThrow()
  })

  it('refuses an empty upload rather than storing a broken image', () => {
    expect(() => assertAcceptable(new Uint8Array(0), 'image/webp')).toThrow(/empty/)
  })

  it('refuses an unresized photo, naming both sizes', () => {
    try {
      assertAcceptable(png(MAX_BYTES + 1), 'image/webp')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PhotoRejected)
      expect((err as PhotoRejected).reason).toBe('too_large')
      // A message that says only "too large" makes someone guess at the limit.
      expect((err as PhotoRejected).message).toMatch(/512KB/)
    }
  })

  it('accepts a photo exactly at the limit', () => {
    expect(() => assertAcceptable(png(MAX_BYTES), 'image/webp')).not.toThrow()
  })
})

describe('storing and reading back', () => {
  it('round-trips the bytes unchanged', async () => {
    const d = db()
    await seedProduct(d, 1, 'Black Chopsticks')
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 250])

    await putPhoto(d, 1, bytes, 'image/png', null)
    const back = await getPhoto(d, 1)

    expect(back).not.toBeNull()
    expect([...back!.bytes]).toEqual([...bytes])
    expect(back!.contentType).toBe('image/png')
  })

  it('points the product at its photo, so the catalogue needs no change', async () => {
    const d = db()
    await seedProduct(d, 4, 'Donburi Plates')
    await putPhoto(d, 4, png(), 'image/webp', null)

    const row = await d.prepare(`SELECT image_url FROM products WHERE id = 4`)
      .first<{ image_url: string }>()
    expect(row?.image_url).toBe('/api/photos/4')
  })

  it('replaces rather than accumulating, and clears the URL when deleted', async () => {
    const d = db()
    await seedProduct(d, 2, 'Chairs')
    await putPhoto(d, 2, png(10), 'image/webp', null)
    await putPhoto(d, 2, png(20), 'image/jpeg', null)

    const count = await d.prepare(`SELECT COUNT(*) AS n FROM product_photos WHERE product_id = 2`)
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
    expect((await getPhoto(d, 2))?.contentType).toBe('image/jpeg')

    expect(await deletePhoto(d, 2)).toBe(true)
    expect(await getPhoto(d, 2)).toBeNull()
    const row = await d.prepare(`SELECT image_url FROM products WHERE id = 2`)
      .first<{ image_url: string | null }>()
    expect(row?.image_url).toBeNull()
    // Deleting something already gone is not an error worth inventing.
    expect(await deletePhoto(d, 2)).toBe(false)
  })

  it('goes with the product when the product goes', async () => {
    const d = db()
    await seedProduct(d, 3, 'Gone')
    await putPhoto(d, 3, png(), 'image/webp', null)
    await d.prepare(`DELETE FROM products WHERE id = 3`).run()
    expect(await getPhoto(d, 3)).toBeNull()
  })
})

describe('the etag', () => {
  it('changes with the bytes, so a replaced photo cannot be served from a stale cache', async () => {
    const a = await etagFor(new Uint8Array([1, 2, 3]))
    const b = await etagFor(new Uint8Array([1, 2, 4]))
    expect(a).not.toBe(b)
    expect(await etagFor(new Uint8Array([1, 2, 3]))).toBe(a)
    // Quoted, because an ETag header without quotes is not a valid strong tag.
    expect(a).toMatch(/^"[0-9a-f]{32}"$/)
  })
})

describe('the working list', () => {
  it('puts the products still needing a photo first', async () => {
    const d = db()
    await seedProduct(d, 1, 'Aaa Has Photo', 'MRK005-BCB')
    await seedProduct(d, 2, 'Zzz Needs One', 'MRK010-DPD')
    await putPhoto(d, 1, png(120), 'image/webp', null)

    const rows = await photoStatus(d)
    expect(rows.map((r) => r.productName)).toEqual(['Zzz Needs One', 'Aaa Has Photo'])
    expect(rows[0]!.byteSize).toBeNull()
    expect(rows[1]!.byteSize).toBe(120)
  })

  it('shows the item code, with the shipment prefix stripped', async () => {
    const d = db()
    await seedProduct(d, 1, 'Black Chopsticks', 'MRK005-BCB')
    expect((await photoStatus(d))[0]!.code).toBe('BCB')
  })

  it('leaves the code null for a product with no mapped line', async () => {
    const d = db()
    await seedProduct(d, 1, 'Unmapped')
    expect((await photoStatus(d))[0]!.code).toBeNull()
  })

  it('leaves closed products out — they are not orderable, so a photo is wasted effort', async () => {
    const d = db()
    await seedProduct(d, 1, 'Open')
    await seedProduct(d, 2, 'Closed')
    await d.prepare(`UPDATE products SET active = 0 WHERE id = 2`).run()
    expect((await photoStatus(d)).map((r) => r.productName)).toEqual(['Open'])
  })
})

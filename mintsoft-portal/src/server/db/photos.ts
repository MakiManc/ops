/**
 * Product photos: the one place that knows where the bytes live.
 *
 * Today that is a BLOB column in D1, which suits ~97 photos of ~60KB. If the catalogue
 * ever outgrows that, this module is what changes — the routes above it deal in
 * `StoredPhoto` and never in storage.
 *
 * Mintsoft cannot supply these. See migrations/0006_product_photos.sql for what was
 * tried before we decided to hold them ourselves.
 */
import type { Database } from './repo.ts'

/** What a browser is allowed to upload. Anything else is rejected before it is stored. */
export const ACCEPTED_TYPES = Object.freeze(['image/webp', 'image/jpeg', 'image/png'])

/**
 * A GM opens the catalogue on a phone, in a restaurant, often on bad signal. The client
 * resizes before uploading, so anything approaching this cap means the resize did not
 * happen — a 4MB photo straight off a camera is 4MB every GM then downloads.
 */
export const MAX_BYTES = 512 * 1024

export interface StoredPhoto {
  bytes: Uint8Array
  contentType: string
  etag: string
}

export interface PhotoStatus {
  productId: number
  productName: string
  /** The item code the product is known by — its primary line's SKU, prefix stripped. */
  code: string | null
  byteSize: number | null
  uploadedAt: string | null
  uploadedByName: string | null
}

export class PhotoRejected extends Error {
  constructor(readonly reason: 'type' | 'empty' | 'too_large', message: string) {
    super(message)
    this.name = 'PhotoRejected'
  }
}

/**
 * Content-addressed, so replacing a photo always changes the tag and a stale copy can
 * never survive in a cache. SHA-256 over the bytes, truncated — this is a cache key, not
 * a security claim, and 16 bytes is far past any accidental collision at this scale.
 */
export async function etagFor(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `"${hex}"`
}

/** Checks an upload before it reaches the database. Throws rather than returning a flag,
 *  because every caller's only sensible response is to refuse. */
export function assertAcceptable(bytes: Uint8Array, contentType: string): void {
  if (!ACCEPTED_TYPES.includes(contentType)) {
    throw new PhotoRejected('type', `${contentType} is not one of ${ACCEPTED_TYPES.join(', ')}`)
  }
  if (bytes.byteLength === 0) throw new PhotoRejected('empty', 'the upload was empty')
  if (bytes.byteLength > MAX_BYTES) {
    throw new PhotoRejected(
      'too_large',
      `${Math.round(bytes.byteLength / 1024)}KB is over the ${Math.round(MAX_BYTES / 1024)}KB limit`,
    )
  }
}

export async function putPhoto(
  db: Database,
  productId: number,
  bytes: Uint8Array,
  contentType: string,
  uploadedBy: number | null,
): Promise<StoredPhoto> {
  assertAcceptable(bytes, contentType)
  const etag = await etagFor(bytes)

  await db
    .prepare(
      `INSERT INTO product_photos (product_id, bytes, content_type, byte_size, etag, uploaded_by,
                                   uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (product_id) DO UPDATE SET
            bytes = excluded.bytes, content_type = excluded.content_type,
            byte_size = excluded.byte_size, etag = excluded.etag,
            uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
    )
    .bind(productId, bytes, contentType, bytes.byteLength, etag, uploadedBy)
    .run()

  // The catalogue renders products.image_url directly, so pointing it here means every
  // existing screen shows the photo without knowing anything about this table.
  await db
    .prepare(`UPDATE products SET image_url = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               WHERE id = ?`)
    .bind(`/api/photos/${productId}`, productId)
    .run()

  return { bytes, contentType, etag }
}

export async function getPhoto(db: Database, productId: number): Promise<StoredPhoto | null> {
  const row = await db
    .prepare(`SELECT bytes, content_type, etag FROM product_photos WHERE product_id = ?`)
    .bind(productId)
    .first<{ bytes: Uint8Array | ArrayBuffer; content_type: string; etag: string }>()
  if (!row) return null

  return {
    // node:sqlite hands back a Uint8Array; D1 an ArrayBuffer. Normalise so callers do not
    // have to care which one they are talking to.
    bytes: row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes),
    contentType: row.content_type,
    etag: row.etag,
  }
}

export async function deletePhoto(db: Database, productId: number): Promise<boolean> {
  const existing = await db
    .prepare(`SELECT product_id FROM product_photos WHERE product_id = ?`)
    .bind(productId)
    .first<{ product_id: number }>()
  if (!existing) return false

  await db.prepare(`DELETE FROM product_photos WHERE product_id = ?`).bind(productId).run()
  await db
    .prepare(`UPDATE products SET image_url = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               WHERE id = ?`)
    .bind(productId)
    .run()
  return true
}

/**
 * Every active product and whether it has a photo yet — the working list for whoever is
 * filling the gaps. Deliberately does not select the bytes.
 */
export async function photoStatus(db: Database): Promise<PhotoStatus[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id                AS product_id,
              p.name              AS product_name,
              (SELECT m.sku FROM product_mintsoft_map m
                WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.id LIMIT 1) AS sku,
              ph.byte_size        AS byte_size,
              ph.uploaded_at      AS uploaded_at,
              u.name              AS uploaded_by_name
         FROM products p
         LEFT JOIN product_photos ph ON ph.product_id = p.id
         LEFT JOIN users u           ON u.id = ph.uploaded_by
        WHERE p.active = 1
        ORDER BY ph.product_id IS NOT NULL, p.name`,
    )
    .all<{
      product_id: number
      product_name: string
      sku: string | null
      byte_size: number | null
      uploaded_at: string | null
      uploaded_by_name: string | null
    }>()

  return results.map((r) => ({
    productId: r.product_id,
    productName: r.product_name,
    code: r.sku ? r.sku.trim().toUpperCase().replace(/^MRK\d+[-\s]+/i, '').trim() : null,
    byteSize: r.byte_size,
    uploadedAt: r.uploaded_at,
    uploadedByName: r.uploaded_by_name,
  }))
}

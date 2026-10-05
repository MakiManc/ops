/**
 * What is free to allocate, per product, across every Mintsoft line mapped to it.
 *
 * This query was written out in full in two places — the approve route and the send path
 * — and a third caller was about to make it three. It is one read with one subtlety worth
 * keeping in one place: a product whose stock rows are not all readable has an UNKNOWN
 * availability, not a low one, and the two must never be confused. `rows_with_value <
 * rows_seen` means part of the picture is missing, so the answer is null and every caller
 * treats null as "we do not know" rather than as zero.
 */
import type { Database } from '../db/repo.ts'
import type { MappedSku } from './approval.ts'

export async function skusByProduct(db: Database): Promise<Map<number, MappedSku[]>> {
  const { results } = await db
    .prepare(
      `SELECT pmm.product_id, pmm.mintsoft_product_id, pmm.sku, pmm.is_primary,
              SUM(sc.available) AS available, COUNT(sc.id) AS rows_seen,
              COUNT(sc.available) AS rows_with_value
         FROM product_mintsoft_map pmm
         LEFT JOIN stock_cache sc ON sc.mintsoft_product_id = pmm.mintsoft_product_id
        GROUP BY pmm.mintsoft_product_id`,
    )
    .all<{
      product_id: number; mintsoft_product_id: number; sku: string; is_primary: number
      available: number | null; rows_seen: number; rows_with_value: number
    }>()

  const byProduct = new Map<number, MappedSku[]>()
  for (const r of results ?? []) {
    const available = r.rows_seen === 0 || r.rows_with_value < r.rows_seen ? null : r.available
    byProduct.set(r.product_id, [
      ...(byProduct.get(r.product_id) ?? []),
      { mintsoftProductId: r.mintsoft_product_id, sku: r.sku, isPrimary: r.is_primary === 1, available },
    ])
  }
  return byProduct
}

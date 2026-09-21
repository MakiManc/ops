/**
 * Admin: par levels, limits and recharge prices, in bulk.
 *
 * These are edited as a spreadsheet because that is how they are actually maintained —
 * twenty-odd sites against a few dozen products is a grid, not a form. Export, edit,
 * import.
 *
 * The import validates every row before writing any of them. A partial apply would
 * leave half the estate on new numbers and half on old, with nothing on screen to say
 * which was which.
 */
import { parseCsv, type CsvRow } from '../../lib/csv.ts'
import type { Database } from './repo.ts'

export const PAR_COLUMNS = ['site_code', 'product_name', 'par_level', 'max_per_order', 'min_days_between_orders']

export interface ParRow {
  siteCode: string
  siteName: string
  productName: string
  parLevel: number | null
  maxPerOrder: number | null
  minDaysBetweenOrders: number | null
}

/**
 * Every active site against every active product.
 *
 * Includes combinations that have no row yet, so the export is a complete grid to fill
 * in rather than only what somebody already set.
 */
export async function parLevels(db: Database): Promise<ParRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.code AS site_code, s.name AS site_name, p.name AS product_name,
              sp.par_level, sp.max_per_order, sp.min_days_between_orders
         FROM sites s
         CROSS JOIN products p
         LEFT JOIN site_products sp ON sp.site_id = s.id AND sp.product_id = p.id
        WHERE s.active = 1 AND p.active = 1
        ORDER BY s.code, p.name`,
    )
    .all<{
      site_code: string; site_name: string; product_name: string
      par_level: number | null; max_per_order: number | null; min_days_between_orders: number | null
    }>()

  return (results ?? []).map((r) => ({
    siteCode: r.site_code, siteName: r.site_name, productName: r.product_name,
    parLevel: r.par_level, maxPerOrder: r.max_per_order, minDaysBetweenOrders: r.min_days_between_orders,
  }))
}

const csvCell = (v: string | number | null) => {
  if (v === null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function parLevelsCsv(rows: ParRow[]): string {
  const out = [PAR_COLUMNS.join(',')]
  for (const r of rows) {
    out.push([
      csvCell(r.siteCode), csvCell(r.productName), csvCell(r.parLevel),
      csvCell(r.maxPerOrder), csvCell(r.minDaysBetweenOrders),
    ].join(','))
  }
  return out.join('\n') + '\n'
}

export interface ImportProblem { line: number; message: string }
export interface ImportResult { applied: number; cleared: number; problems: ImportProblem[] }

/**
 * Applies an edited par-level sheet.
 *
 * A blank cell means "no limit" and clears the value; it does not mean "leave as is".
 * That is the only reading that lets someone remove a limit, and it is stated on the
 * admin screen next to the upload.
 */
export async function importParLevels(db: Database, csv: string): Promise<ImportResult> {
  let rows: CsvRow[]
  try {
    rows = parseCsv(csv, PAR_COLUMNS)
  } catch (err) {
    return { applied: 0, cleared: 0, problems: [{ line: 1, message: (err as Error).message }] }
  }

  const problems: ImportProblem[] = []

  const { results: sites } = await db.prepare(`SELECT id, code FROM sites WHERE active = 1`).all<{ id: number; code: string }>()
  const { results: products } = await db.prepare(`SELECT id, name FROM products WHERE active = 1`).all<{ id: number; name: string }>()
  const siteByCode = new Map((sites ?? []).map((s) => [s.code.toUpperCase(), s.id]))
  const productByName = new Map((products ?? []).map((p) => [p.name.toLowerCase(), p.id]))

  const number = (value: string, line: number, field: string): number | null | undefined => {
    if (value.trim() === '') return null   // blank clears the limit
    const n = Number(value)
    if (!Number.isInteger(n) || n < 0) {
      problems.push({ line, message: `${field} must be a whole number or left blank (got "${value}")` })
      return undefined
    }
    return n
  }

  const planned: { siteId: number; productId: number; par: number | null; max: number | null; gap: number | null }[] = []

  for (const { line, values } of rows) {
    const siteId = siteByCode.get((values.site_code ?? '').toUpperCase())
    if (!siteId) { problems.push({ line, message: `No active site with code "${values.site_code}"` }); continue }

    const productId = productByName.get((values.product_name ?? '').toLowerCase())
    if (!productId) { problems.push({ line, message: `No active product called "${values.product_name}"` }); continue }

    const par = number(values.par_level ?? '', line, 'par_level')
    const max = number(values.max_per_order ?? '', line, 'max_per_order')
    const gap = number(values.min_days_between_orders ?? '', line, 'min_days_between_orders')
    if (par === undefined || max === undefined || gap === undefined) continue

    if (max !== null && max === 0) {
      problems.push({ line, message: 'max_per_order of 0 would stop this site ordering it at all. Leave it blank for no limit.' })
      continue
    }

    planned.push({ siteId, productId, par, max, gap })
  }

  // Nothing is written unless the whole sheet is good.
  if (problems.length > 0) return { applied: 0, cleared: 0, problems }

  const statements = planned.map((p) =>
    p.par === null && p.max === null && p.gap === null
      // All blank means no limits at all, so the row goes rather than lingering as
      // three nulls that look like a setting.
      ? db.prepare(`DELETE FROM site_products WHERE site_id = ? AND product_id = ?`).bind(p.siteId, p.productId)
      : db.prepare(
          `INSERT INTO site_products (site_id, product_id, par_level, max_per_order, min_days_between_orders)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (site_id, product_id) DO UPDATE SET
             par_level = excluded.par_level, max_per_order = excluded.max_per_order,
             min_days_between_orders = excluded.min_days_between_orders`,
        ).bind(p.siteId, p.productId, p.par, p.max, p.gap),
  )

  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50))

  const cleared = planned.filter((p) => p.par === null && p.max === null && p.gap === null).length
  return { applied: planned.length - cleared, cleared, problems: [] }
}

/**
 * Starts a new request from a past order.
 *
 * Copies the quantities that were actually approved, not what was asked for — the
 * approved figure is the one that turned out to be right.
 */
export async function reorderInto(
  db: Database, { fromOrderId, siteId }: { fromOrderId: number; siteId: number },
): Promise<{ productId: number; qty: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT ol.product_id, COALESCE(ol.qty_approved, ol.qty_requested) AS qty
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id
         JOIN products p ON p.id = ol.product_id
        WHERE ol.order_id = ? AND o.site_id = ? AND p.active = 1
          AND COALESCE(ol.qty_approved, ol.qty_requested) > 0`,
    )
    .bind(fromOrderId, siteId)
    .all<{ product_id: number; qty: number }>()
  return (results ?? []).map((r) => ({ productId: r.product_id, qty: r.qty }))
}

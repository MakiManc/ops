/**
 * The monthly recharge report Finance works from.
 *
 * Everything here reads the snapshot taken at approval — the unit price stored on the
 * order line, not the product's current price. A price rise in November must not change
 * what a franchise was charged in October, and reading the live price would do exactly
 * that, silently, every time the report was re-run.
 *
 * The portal does not raise invoices and does not touch Xero. This produces the numbers;
 * a human decides what to do with them.
 */
import type { Database } from '../db/repo.ts'

export interface RechargeLine {
  orderNumber: string
  siteCode: string
  siteName: string
  approvedAt: string | null
  productName: string
  qty: number
  unitPrice: number | null
  lineTotal: number | null
}

export interface RechargeSiteTotal {
  siteCode: string
  siteName: string
  orderCount: number
  lineCount: number
  itemCount: number
  goodsTotal: number
  orderFees: number
  total: number
  /** Lines whose price was never set, so they contributed nothing. */
  unpricedLines: number
}

export interface RechargeReport {
  month: string
  lines: RechargeLine[]
  siteTotals: RechargeSiteTotal[]
  grandTotal: number
  /** Anything Finance should know before using the numbers. */
  warnings: string[]
}

/** Orders counted in a month are those approved in it, since that is when price was fixed. */
export async function rechargeReport(db: Database, month: string): Promise<RechargeReport> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Month must look like 2026-10, not "${month}".`)

  const { results } = await db
    .prepare(
      `SELECT o.order_number, o.approved_at, o.order_fee, o.recharge_total,
              s.code AS site_code, s.name AS site_name,
              p.name AS product_name,
              COALESCE(ol.qty_approved, ol.qty_requested) AS qty,
              ol.recharge_unit_price AS unit_price
         FROM orders o
         JOIN sites s ON s.id = o.site_id
         JOIN order_lines ol ON ol.order_id = o.id
         JOIN products p ON p.id = ol.product_id
        WHERE o.recharge = 1
          AND o.status IN ('approved', 'posted', 'despatched')
          AND o.approved_at IS NOT NULL
          AND substr(o.approved_at, 1, 7) = ?
        ORDER BY s.code, o.approved_at, p.name`,
    )
    .bind(month)
    .all<{
      order_number: string; approved_at: string | null; order_fee: number | null
      recharge_total: number | null; site_code: string; site_name: string
      product_name: string; qty: number; unit_price: number | null
    }>()

  const rows = results ?? []
  const lines: RechargeLine[] = rows.map((r) => ({
    orderNumber: r.order_number,
    siteCode: r.site_code,
    siteName: r.site_name,
    approvedAt: r.approved_at,
    productName: r.product_name,
    qty: r.qty,
    unitPrice: r.unit_price,
    // Null, not zero: a line with no price contributed nothing and should be visibly
    // absent rather than quietly counted as free.
    lineTotal: r.unit_price === null ? null : round(r.qty * r.unit_price),
  }))

  const bySite = new Map<string, RechargeSiteTotal>()
  const feesSeen = new Map<string, Set<string>>()

  for (const r of rows) {
    const current = bySite.get(r.site_code) ?? {
      siteCode: r.site_code, siteName: r.site_name, orderCount: 0, lineCount: 0,
      itemCount: 0, goodsTotal: 0, orderFees: 0, total: 0, unpricedLines: 0,
    }
    current.lineCount += 1
    current.itemCount += r.qty
    if (r.unit_price === null) current.unpricedLines += 1
    else current.goodsTotal = round(current.goodsTotal + r.qty * r.unit_price)

    // An order fee is per order, not per line, so only count it once however many
    // lines the order has.
    const seen = feesSeen.get(r.site_code) ?? new Set<string>()
    if (!seen.has(r.order_number)) {
      seen.add(r.order_number)
      current.orderCount += 1
      current.orderFees = round(current.orderFees + (r.order_fee ?? 0))
    }
    feesSeen.set(r.site_code, seen)

    bySite.set(r.site_code, current)
  }

  const siteTotals = [...bySite.values()]
    .map((s) => ({ ...s, total: round(s.goodsTotal + s.orderFees) }))
    .sort((a, b) => a.siteCode.localeCompare(b.siteCode))

  const warnings: string[] = []
  const unpriced = siteTotals.reduce((n, s) => n + s.unpricedLines, 0)
  if (unpriced > 0) {
    warnings.push(
      `${unpriced} line${unpriced === 1 ? '' : 's'} had no price set when the order was approved, ` +
      'so they are shown with no value and are not in the totals.',
    )
  }
  if (siteTotals.length === 0) {
    warnings.push(`No franchise orders were approved in ${month}.`)
  }

  return {
    month,
    lines,
    siteTotals,
    grandTotal: round(siteTotals.reduce((n, s) => n + s.total, 0)),
    warnings,
  }
}

const round = (n: number) => Math.round(n * 100) / 100

/** Escapes a value for CSV. Product names contain commas and the odd quote. */
function csvCell(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The report as CSV, for Finance.
 *
 * One row per line, then a blank row, then the per-site totals — so the detail and the
 * summary are in one file and the totals can be checked against the lines that made
 * them rather than taken on trust.
 */
export function rechargeCsv(report: RechargeReport): string {
  const rows: string[] = []

  rows.push(['Site', 'Site name', 'Order', 'Approved', 'Product', 'Quantity', 'Unit price', 'Line total'].join(','))
  for (const line of report.lines) {
    rows.push([
      csvCell(line.siteCode), csvCell(line.siteName), csvCell(line.orderNumber),
      csvCell(line.approvedAt?.slice(0, 10) ?? ''), csvCell(line.productName),
      csvCell(line.qty),
      csvCell(line.unitPrice === null ? '' : line.unitPrice.toFixed(2)),
      csvCell(line.lineTotal === null ? '' : line.lineTotal.toFixed(2)),
    ].join(','))
  }

  rows.push('')
  rows.push(['Site', 'Site name', 'Orders', 'Lines', 'Items', 'Goods', 'Order fees', 'Total'].join(','))
  for (const site of report.siteTotals) {
    rows.push([
      csvCell(site.siteCode), csvCell(site.siteName), csvCell(site.orderCount),
      csvCell(site.lineCount), csvCell(site.itemCount),
      csvCell(site.goodsTotal.toFixed(2)), csvCell(site.orderFees.toFixed(2)),
      csvCell(site.total.toFixed(2)),
    ].join(','))
  }
  rows.push(['', '', '', '', '', '', 'Grand total', report.grandTotal.toFixed(2)].join(','))

  for (const warning of report.warnings) {
    rows.push('')
    rows.push(csvCell(`Note: ${warning}`))
  }

  return rows.join('\n') + '\n'
}

/**
 * What each site has ordered in a month, by product, in quantities.
 *
 * This replaced the recharge report, which had never produced a single row. It filtered
 * to `sites.recharge = 1` and no site has ever had that set, and it priced lines from
 * `order_lines.recharge_unit_price`, which is snapshotted at approval only for recharge
 * sites -- so of 83 order lines, none carried a price. Finance was being offered an empty
 * table and the one question anybody actually asked of it, "how much has this restaurant
 * had", went unanswered for every site in the group.
 *
 * So: every site, no money, quantities.
 *
 * Two choices worth knowing about.
 *
 * It counts the APPROVED quantity, not the requested one. An approver cutting 60 ramekins
 * to 24 means 24 went, and a usage report that said 60 would overstate every site that
 * ever had a request trimmed. A line approved at nothing is not listed at all -- nothing
 * was ordered -- though the count of them is reported, because a site whose requests keep
 * being declined is worth seeing.
 *
 * It buckets on `approved_at`, the month the commitment was made, rather than on despatch.
 * A despatch date moves when the warehouse is slow, and a month's figures that change
 * after the fact are no use to anyone. It also keeps this consistent with the merge guard
 * in db/orders.ts, which refuses to combine two orders approved in different months
 * precisely so a month's numbers cannot shift underneath a report.
 */
import type { Database } from '../db/repo.ts'

export interface OrderedProduct {
  productId: number
  productName: string
  /** The approved quantity, summed across every order this month. */
  qty: number
  /** How many of the site's orders this product appeared on. */
  orders: number
}

export interface OrderedSite {
  siteCode: string
  siteName: string
  /** Corporate or franchise, because it changes who is asking and why. */
  siteType: string
  orderCount: number
  /** Of those, how many have actually reached the warehouse. */
  ordersWithMercium: number
  productCount: number
  itemCount: number
  products: OrderedProduct[]
}

export interface OrderedReport {
  month: string
  sites: OrderedSite[]
  /** The same figures cut the other way: one row per product, across every site. */
  productTotals: OrderedProduct[]
  siteCount: number
  itemCount: number
  /** Anything worth knowing before the numbers are used. */
  warnings: string[]
}

interface Row {
  order_number: string
  status: string
  site_code: string
  site_name: string
  site_type: string
  product_id: number
  product_name: string
  qty_approved: number | null
}

export async function orderedBySite(db: Database, month: string): Promise<OrderedReport> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Month must look like 2026-10, not "${month}".`)

  const { results } = await db
    .prepare(
      `SELECT o.order_number, o.status,
              s.code AS site_code, s.name AS site_name, s.type AS site_type,
              p.id AS product_id, p.name AS product_name,
              ol.qty_approved
         FROM orders o
         JOIN sites s ON s.id = o.site_id
         JOIN order_lines ol ON ol.order_id = o.id
         JOIN products p ON p.id = ol.product_id
        -- Committed orders only. A draft or a request still waiting for sign-off is not
        -- something the site has had, and a cancelled one never will be -- which is also
        -- what keeps an order absorbed by a merge out of here, since merging cancels it.
        WHERE o.status IN ('approved', 'posted', 'despatched')
          AND o.approved_at IS NOT NULL
          AND substr(o.approved_at, 1, 7) = ?
        ORDER BY s.code, p.name`,
    )
    .bind(month)
    .all<Row>()

  const rows = results ?? []

  const bySite = new Map<string, OrderedSite>()
  const ordersSeen = new Map<string, Set<string>>()
  const productOrders = new Map<string, Set<string>>()
  const totals = new Map<number, OrderedProduct>()
  let declined = 0
  let unapproved = 0

  for (const r of rows) {
    const site = bySite.get(r.site_code) ?? {
      siteCode: r.site_code, siteName: r.site_name, siteType: r.site_type,
      orderCount: 0, ordersWithMercium: 0, productCount: 0, itemCount: 0, products: [],
    }

    // One order contributes once to the count however many lines it has.
    const seen = ordersSeen.get(r.site_code) ?? new Set<string>()
    if (!seen.has(r.order_number)) {
      seen.add(r.order_number)
      site.orderCount += 1
      if (r.status === 'posted' || r.status === 'despatched') site.ordersWithMercium += 1
    }
    ordersSeen.set(r.site_code, seen)

    if (r.qty_approved === null) {
      // Should not happen on a committed order -- approveOrder covers every line -- so it
      // is counted and reported rather than quietly treated as nothing.
      unapproved += 1
      bySite.set(r.site_code, site)
      continue
    }
    if (r.qty_approved === 0) {
      // Signed off at nothing: not ordered, so not listed. Worth counting all the same.
      declined += 1
      bySite.set(r.site_code, site)
      continue
    }

    const existing = site.products.find((p) => p.productId === r.product_id)
    const product = existing ?? { productId: r.product_id, productName: r.product_name, qty: 0, orders: 0 }
    product.qty += r.qty_approved
    if (!existing) site.products.push(product)

    const key = `${r.site_code}|${r.product_id}`
    const po = productOrders.get(key) ?? new Set<string>()
    if (!po.has(r.order_number)) { po.add(r.order_number); product.orders += 1 }
    productOrders.set(key, po)

    site.itemCount += r.qty_approved
    bySite.set(r.site_code, site)

    const total = totals.get(r.product_id)
      ?? { productId: r.product_id, productName: r.product_name, qty: 0, orders: 0 }
    total.qty += r.qty_approved
    total.orders += 1
    totals.set(r.product_id, total)
  }

  const sites = [...bySite.values()]
    .map((s) => ({
      ...s,
      productCount: s.products.length,
      products: [...s.products].sort((a, b) => a.productName.localeCompare(b.productName)),
    }))
    .sort((a, b) => a.siteCode.localeCompare(b.siteCode))

  const warnings: string[] = []
  if (sites.length === 0) warnings.push(`No orders were signed off in ${month}.`)
  if (declined > 0) {
    warnings.push(
      `${declined} line${declined === 1 ? '' : 's'} ${declined === 1 ? 'was' : 'were'} signed off at `
        + 'nothing, so nothing was ordered for them and they are not listed.',
    )
  }
  if (unapproved > 0) {
    warnings.push(
      `${unapproved} line${unapproved === 1 ? '' : 's'} on a signed-off order ${unapproved === 1 ? 'has' : 'have'} `
        + 'no approved quantity at all, which should not be possible. They are left out of the '
        + 'figures and want looking at.',
    )
  }

  return {
    month,
    sites,
    productTotals: [...totals.values()].sort((a, b) => b.qty - a.qty || a.productName.localeCompare(b.productName)),
    siteCount: sites.length,
    itemCount: sites.reduce((n, s) => n + s.itemCount, 0),
    warnings,
  }
}

/** Escapes a value for CSV. Product names contain commas and the odd quote. */
function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * One row per site and product, which is the shape a spreadsheet wants: it pivots from
 * there, where a nested report would have to be unpicked by hand first.
 */
export function orderedCsv(report: OrderedReport): string {
  const head = ['Month', 'Site', 'Site name', 'Type', 'Product', 'Quantity', 'Orders']
  const body = report.sites.flatMap((s) =>
    s.products.map((p) => [
      report.month, s.siteCode, s.siteName, s.siteType, p.productName, p.qty, p.orders,
    ]))
  return [head, ...body].map((r) => r.map(csvCell).join(',')).join('\n')
}

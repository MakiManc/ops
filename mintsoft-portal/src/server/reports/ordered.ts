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
 *
 * MONEY
 *
 * It now costs what it can, from product_prices -- the China Stock Price File, loaded by
 * scripts/load-prices.ts. Three things about that:
 *
 * The figure is SUPPLIER COST OF GOODS. It excludes freight, which the supplier quotes per
 * CBM (GBP 200-210) with no per-product volume recorded anywhere in the file, and it
 * excludes UK VAT and duty. It is not what a site should be charged. Every total this
 * returns is labelled accordingly, and `priceBasisNote` is the words to put next to one.
 *
 * It prices from the price table, not from the `recharge_unit_price` snapshot the old
 * recharge report used. That snapshot is taken at approval and only for recharge sites,
 * so it is NULL on all 83 order lines in existence -- which is the whole reason that
 * report never produced a row.
 *
 * Nothing is totalled as though it were complete. 28 of 93 products have no price in the
 * file and each carries the reason why, so a site's cost comes back next to the count of
 * its unpriced products and items. A report that quietly omitted them would understate
 * every site that ordered one, and understating silently is worse than a visible gap.
 */
import type { Database } from '../db/repo.ts'

export interface OrderedProduct {
  productId: number
  productName: string
  /** The approved quantity, summed across every order this month. */
  qty: number
  /** How many of the site's orders this product appeared on. */
  orders: number
  /** Supplier cost per unit, or null when the price file cannot price this product. */
  unitPrice: number | null
  /** qty x unitPrice, or null when there is no price. Never 0 standing in for unknown. */
  cost: number | null
  /** Why there is no price, when there is none. Straight from the price file. */
  gapReason: string | null
  /** Anything a reader of the figure needs to know: a price spread, a pack basis, a note. */
  priceNote: string | null
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
  /** Supplier cost of the products that have a price. Not the whole site -- see below. */
  cost: number
  /** How many of the site's products have no price, so the cost is known to be short. */
  unpricedProducts: number
  /** And how many items those account for. */
  unpricedItems: number
  products: OrderedProduct[]
}

export interface OrderedReport {
  month: string
  sites: OrderedSite[]
  /** The same figures cut the other way: one row per product, across every site. */
  productTotals: OrderedProduct[]
  siteCount: number
  itemCount: number
  /** Supplier cost across every site, for the products that have a price. */
  cost: number
  /** Products with no price, across the month, and the items they account for. */
  unpricedProducts: number
  unpricedItems: number
  /** What the money is and is not. Put this next to any total. */
  priceBasisNote: string
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
  unit_price: number | null
  gap_reason: string | null
  price_note: string | null
  distinct_prices: number | null
  lowest: number | null
  highest: number | null
}

/**
 * What the cost is, in words, for whoever reads a total. Not optional decoration: a
 * figure this far from "what the site pays" has to arrive with the caveat attached.
 */
export const PRICE_BASIS_NOTE =
  'Supplier cost of goods, from the China Stock Price File. Excludes freight '
  + '(quoted per CBM, with no per-product volume on record) and excludes UK VAT and duty.'

/** Money, to the penny. Floating point otherwise leaves 1.9000000000000001 on a report. */
const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * What to say about a price beyond the number. The file's own flag and the map's note come
 * through as `price_note`; a spread is worth adding, because "GBP 99" reads as settled
 * when the documents actually say 99 and 105 and the latest one happened to say 99.
 */
function priceNote(r: Row): string | null {
  const parts: string[] = []
  if (r.price_note) parts.push(r.price_note)
  if ((r.distinct_prices ?? 1) > 1 && r.lowest !== null && r.highest !== null) {
    parts.push(
      `The file holds ${r.distinct_prices} different prices for this, from £${r.lowest} to `
      + `£${r.highest}. The latest was taken.`,
    )
  }
  return parts.join(' ') || null
}

export async function orderedBySite(db: Database, month: string): Promise<OrderedReport> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Month must look like 2026-10, not "${month}".`)

  const { results } = await db
    .prepare(
      `SELECT o.order_number, o.status,
              s.code AS site_code, s.name AS site_name, s.type AS site_type,
              p.id AS product_id, p.name AS product_name,
              ol.qty_approved,
              pp.unit_price, pp.gap_reason, pp.note AS price_note,
              pp.distinct_prices, pp.lowest, pp.highest
         FROM orders o
         JOIN sites s ON s.id = o.site_id
         JOIN order_lines ol ON ol.order_id = o.id
         JOIN products p ON p.id = ol.product_id
         -- LEFT, so a product with no row at all still appears. It is counted as unpriced
         -- with no reason given, and the warnings say how many are in that state, because
         -- "the price file has not been loaded" and "this product cannot be priced" are
         -- different problems and want telling apart.
         LEFT JOIN product_prices pp ON pp.product_id = p.id
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
  /** Products with no price anywhere this month, and how many had no row at all. */
  const unpriced = new Set<number>()
  let noPriceRow = 0
  const seenProduct = new Set<number>()

  for (const r of rows) {
    const site = bySite.get(r.site_code) ?? {
      siteCode: r.site_code, siteName: r.site_name, siteType: r.site_type,
      orderCount: 0, ordersWithMercium: 0, productCount: 0, itemCount: 0,
      cost: 0, unpricedProducts: 0, unpricedItems: 0, products: [],
    }

    // One order contributes once to the count however many lines it has.
    const seen = ordersSeen.get(r.site_code) ?? new Set<string>()
    if (!seen.has(r.order_number)) {
      seen.add(r.order_number)
      site.orderCount += 1
      if (r.status === 'posted' || r.status === 'despatched') site.ordersWithMercium += 1
    }
    ordersSeen.set(r.site_code, seen)

    if (!seenProduct.has(r.product_id)) {
      seenProduct.add(r.product_id)
      // No row at all is different from a row saying why there is no price: it means the
      // price file has not been loaded for this product, not that it cannot be priced.
      if (r.unit_price === null && r.gap_reason === null) noPriceRow += 1
    }

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
    const product = existing ?? {
      productId: r.product_id, productName: r.product_name, qty: 0, orders: 0,
      unitPrice: r.unit_price, cost: null, gapReason: r.gap_reason, priceNote: priceNote(r),
    }
    product.qty += r.qty_approved
    // Recomputed from the running quantity rather than added to, so a product appearing
    // on two orders cannot drift from qty x price.
    product.cost = r.unit_price === null ? null : round2(product.qty * r.unit_price)
    if (!existing) site.products.push(product)

    const key = `${r.site_code}|${r.product_id}`
    const po = productOrders.get(key) ?? new Set<string>()
    if (!po.has(r.order_number)) { po.add(r.order_number); product.orders += 1 }
    productOrders.set(key, po)

    site.itemCount += r.qty_approved
    bySite.set(r.site_code, site)

    const total = totals.get(r.product_id) ?? {
      productId: r.product_id, productName: r.product_name, qty: 0, orders: 0,
      unitPrice: r.unit_price, cost: null, gapReason: r.gap_reason, priceNote: priceNote(r),
    }
    total.qty += r.qty_approved
    total.orders += 1
    total.cost = r.unit_price === null ? null : round2(total.qty * r.unit_price)
    totals.set(r.product_id, total)
    if (r.unit_price === null) unpriced.add(r.product_id)
  }

  const sites = [...bySite.values()]
    .map((s) => ({
      ...s,
      productCount: s.products.length,
      // Summed from the per-product costs so the site total and the lines it is made of
      // can never disagree. Unpriced products contribute nothing and are counted instead.
      cost: round2(s.products.reduce((n, p) => n + (p.cost ?? 0), 0)),
      unpricedProducts: s.products.filter((p) => p.unitPrice === null).length,
      unpricedItems: s.products.filter((p) => p.unitPrice === null).reduce((n, p) => n + p.qty, 0),
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

  const productTotals = [...totals.values()]
    .sort((a, b) => b.qty - a.qty || a.productName.localeCompare(b.productName))
  const unpricedItems = productTotals.filter((p) => p.unitPrice === null).reduce((n, p) => n + p.qty, 0)

  if (unpriced.size > 0) {
    warnings.push(
      `${unpriced.size} of the ${productTotals.length} products ordered ${unpriced.size === 1 ? 'has' : 'have'} `
        + `no price in the China Stock Price File, covering ${unpricedItems} `
        + `item${unpricedItems === 1 ? '' : 's'}. The cost shown leaves ${unpriced.size === 1 ? 'it' : 'them'} `
        + 'out, so it is short by however much they are worth. Each one says why.',
    )
  }
  if (noPriceRow > 0) {
    warnings.push(
      `${noPriceRow} product${noPriceRow === 1 ? '' : 's'} ordered this month ${noPriceRow === 1 ? 'is' : 'are'} `
        + 'not in the price file at all, so there is not even a reason for the gap. Run '
        + '"npm run prices" to load the file, and add the product to prices/build.py if it '
        + 'is still missing afterwards.',
    )
  }

  return {
    month,
    sites,
    productTotals,
    siteCount: sites.length,
    itemCount: sites.reduce((n, s) => n + s.itemCount, 0),
    // Summed from the sites, which are summed from their products, so the three levels
    // of this report always agree with each other.
    cost: round2(sites.reduce((n, s) => n + s.cost, 0)),
    unpricedProducts: unpriced.size,
    unpricedItems,
    priceBasisNote: PRICE_BASIS_NOTE,
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
  const head = [
    'Month', 'Site', 'Site name', 'Type', 'Product', 'Quantity', 'Orders',
    // Blank rather than 0 where there is no price, so a spreadsheet summing the column
    // cannot quietly treat "not known" as "nothing".
    'Unit cost (GBP)', 'Cost (GBP)', 'Why no price',
  ]
  const body = report.sites.flatMap((s) =>
    s.products.map((p) => [
      report.month, s.siteCode, s.siteName, s.siteType, p.productName, p.qty, p.orders,
      p.unitPrice ?? '', p.cost ?? '', p.gapReason ?? '',
    ]))
  return [head, ...body].map((r) => r.map(csvCell).join(',')).join('\n')
}

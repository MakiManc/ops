/**
 * Which warehouse an order is for, and therefore how it gets fulfilled.
 *
 * Two warehouses hold Maki stock. Mercium runs Mintsoft, so an order for their stock
 * becomes a Mintsoft order. The other store has no WMS at all, so an order for its stock
 * is fulfilled by emailing a pick list to the people who walk the shelves.
 *
 * The difference is not cosmetic, and these are the consequences the rest of the code
 * depends on:
 *
 *  1. An order cannot mix the two. The items are in different buildings and ship
 *     separately, while an order here has one status, one required date and one
 *     mintsoft_order_id. A "part posted, part emailed" order has nowhere to record
 *     itself, so the basket refuses the mix and both approval and send re-check it.
 *
 *  2. An email-route product has no Mintsoft stock figure and never will. The stock
 *     guards exist because a figure we cannot read might be hiding stock that exists;
 *     for these products there is nothing to read by design, so applying the guard would
 *     block every order forever. They are exempt, and `routeOf` is the only place that
 *     decides it.
 *
 *  3. An email-route order is only ever 'posted' once an email has actually been
 *     accepted for delivery. The one failure that matters here is marking an order
 *     fulfilled when nobody was told to pick it.
 */

export type SupplyRoute = 'mercium' | 'email'

export const SUPPLY_ROUTES: readonly SupplyRoute[] = ['mercium', 'email']

export const isSupplyRoute = (v: unknown): v is SupplyRoute =>
  typeof v === 'string' && (SUPPLY_ROUTES as readonly string[]).includes(v)

/**
 * The route of a product, defaulting to Mercium.
 *
 * Deliberately total: a row written before the column existed, or by a path that does
 * not know about routes, reads as 'mercium' and behaves exactly as it did before.
 */
export const routeOf = (product: { supplyRoute?: SupplyRoute | null }): SupplyRoute =>
  product.supplyRoute === 'email' ? 'email' : 'mercium'

/** Whether Mintsoft holds a stock figure for this product at all. */
export const hasWarehouseStock = (product: { supplyRoute?: SupplyRoute | null }): boolean =>
  routeOf(product) === 'mercium'

export interface RouteSplit {
  /** The single route of every line, or null when the lines disagree. */
  route: SupplyRoute | null
  mercium: string[]
  email: string[]
}

/**
 * Sorts an order's lines by route so a mixed order can be named in full.
 *
 * An empty set reports 'mercium' rather than null: "no lines" is a different problem,
 * caught by its own guard, and reporting it as a route conflict would be a confusing
 * way to say nothing is in the basket.
 */
export function splitByRoute(
  lines: readonly { productName: string; supplyRoute?: SupplyRoute | null }[],
): RouteSplit {
  const mercium: string[] = []
  const email: string[] = []
  for (const line of lines) {
    (routeOf(line) === 'email' ? email : mercium).push(line.productName)
  }
  if (email.length === 0) return { route: 'mercium', mercium, email }
  if (mercium.length === 0) return { route: 'email', mercium, email }
  return { route: null, mercium, email }
}

/**
 * The message a GM or an approver sees when an order spans both warehouses.
 *
 * It names the items on each side, because "you cannot mix these" is unactionable
 * without knowing which item caused it -- the catalogue gives no hint that two products
 * on the same screen live in different buildings.
 */
export function mixedRouteMessage(
  split: RouteSplit,
  { inBasket = false }: { inBasket?: boolean } = {},
): string {
  const list = (names: string[]) => {
    const unique = [...new Set(names)]
    return unique.length > 3
      ? `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more`
      : unique.join(', ')
  }
  return 'This request mixes stock from two different warehouses, which ship separately: '
    + `${list(split.mercium)} come from Mercium, and ${list(split.email)} come from the other store. `
    // A GM meeting this has a part-built basket in front of them, and "put them on two
    // requests" does not tell them how to get out of the one they are in.
    + (inBasket
      ? 'Send what you have already added first, then start a new request for the rest.'
      : 'Put them on two separate requests.')
}

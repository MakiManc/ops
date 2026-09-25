/**
 * Sending an approved order to Mintsoft. The only write the portal ever makes.
 *
 * Three things from Phase 0 shape this, and each one is a way to lose or duplicate a
 * real order:
 *
 *   1. MINTSOFT HAS NO IDEMPOTENCY. No key header, no dedupe on order number. Send the
 *      same order twice and Mercium picks, ships and bills it twice. Every safeguard is
 *      ours.
 *   2. HTTP 200 DOES NOT MEAN CREATED. PUT /api/Order returns an array, and each element
 *      carries its own Success flag and Message. A failure comes back as a 200 with
 *      Success:false. Treating the status code as the answer loses orders silently,
 *      which is the worst failure this system has: the GM sees "sent" and nothing comes.
 *   3. "NOT FOUND" DOES NOT MEAN "SAFE TO CREATE". Mintsoft's own description of the
 *      lookup's 404 is "Order not found or not accessible" — one status for two very
 *      different situations. If the order exists but our key cannot see it, re-creating
 *      produces exactly the duplicate we were avoiding.
 *
 * So the lookup has three outcomes, not two, and only two of them are safe to act on.
 */
import type { MintsoftReadOnlyClient } from '../../lib/mintsoft/readonly-client.ts'
import type { NewOrderResult, Order } from '../../lib/mintsoft/types.ts'

export type LookupOutcome =
  /** The order is in Mintsoft. Attach it; never create. */
  | { kind: 'found'; mintsoftOrderId: number; mintsoftOrderNumber: string | null }
  /** Mintsoft answered, and it is genuinely not there. Safe to create. */
  | { kind: 'absent' }
  /** We could not get a trustworthy answer. Stop and let a human look. */
  | { kind: 'unknown'; reason: string }

export interface MintsoftWriteClient {
  /** GETs, shared with the read client. */
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>):
    Promise<{ data: T | null; status: number; ms: number; raw: string }>
  /** The single write. Separated so it can be granted only where it is allowed. */
  putOrder(body: unknown): Promise<{ data: NewOrderResult[] | null; status: number; raw: string }>
}

/**
 * The tag every order the portal creates carries. It is what makes our orders findable
 * among Mercium's own without knowing the number Mintsoft gave them.
 */
export const PORTAL_TAG = 'maki-portal'

/** One page of /api/Order/List, and how many we will walk before giving up. */
const LOOKUP_PAGE_SIZE = 200
const LOOKUP_MAX_PAGES = 25

/**
 * Has an order carrying this reference already reached Mintsoft?
 *
 * This used to ask /api/Order/Search, which takes an OrderNumber and nothing else. That
 * worked only while we were choosing the order number ourselves. Mintsoft numbers its
 * own orders now, and we cannot search for a number we have not been told yet — which is
 * precisely the case this check exists for, the send whose reply never arrived.
 *
 * So it asks /api/Order/List for orders tagged as ours and matches on
 * ExternalOrderReference, which still carries MR-<site>-<date>-<seq>. Confirmed live on
 * 2026-09-25: IncludeTags=maki-portal returns our orders and none of Mercium's, and the
 * rows carry ExternalOrderReference.
 *
 * Every uncertainty answers "unknown" rather than "absent". Absent is a licence to
 * create, and a wrong one costs a second pallet.
 */
export async function lookupExistingOrder(
  client: Pick<MintsoftWriteClient, 'get'>,
  reference: string,
  scope: { clientId?: number | null } = {},
): Promise<LookupOutcome> {
  for (let page = 1; page <= LOOKUP_MAX_PAGES; page++) {
    let response
    try {
      response = await client.get<Order[]>('/api/Order/List', {
        IncludeTags: PORTAL_TAG,
        ClientId: scope.clientId ?? undefined,
        PageNo: page,
        Limit: LOOKUP_PAGE_SIZE,
      })
    } catch (err) {
      // A network failure tells us nothing about whether the order exists.
      return { kind: 'unknown', reason: `Could not reach Mintsoft to check: ${err instanceof Error ? err.message : 'unknown error'}` }
    }

    if (response.status === 404) {
      // Mintsoft answered, and its answer is "not found or not accessible". We cannot
      // tell those apart, and only one of them is safe to create against.
      return {
        kind: 'unknown',
        reason: 'Mintsoft returned 404, which means there are no orders to list OR they are not visible to this API user. ' +
          'Those need different actions, so this needs a human.',
      }
    }

    if (response.status !== 200 || !Array.isArray(response.data)) {
      return { kind: 'unknown', reason: `Mintsoft answered with HTTP ${response.status} rather than a list of orders.` }
    }

    const match = response.data.find((o) => o.ExternalOrderReference === reference)
    if (match) {
      if (match.ID == null) {
        return { kind: 'unknown', reason: `Mintsoft returned an order referenced ${reference} with no id.` }
      }
      return { kind: 'found', mintsoftOrderId: match.ID, mintsoftOrderNumber: match.OrderNumber ?? null }
    }

    // A short page is the last page. Having walked all of them without a match, it is
    // genuinely not there.
    if (response.data.length < LOOKUP_PAGE_SIZE) return { kind: 'absent' }
  }

  // Ran out of pages still looking. "Not seen yet" is not "not there", and treating it
  // as absent is how a duplicate gets created.
  return {
    kind: 'unknown',
    reason: `Walked ${LOOKUP_MAX_PAGES} pages of portal orders without reaching the end, so whether ` +
      `${reference} is already in Mintsoft is unanswered. The list needs narrowing before this can be trusted.`,
  }
}

export interface OrderLine { sku: string; quantity: number }

export interface OrderToPost {
  /**
   * Ours, not Mintsoft's: MR-<site>-<date>-<seq>. It goes out as ExternalOrderReference
   * and is what the lookup above matches on. Mintsoft assigns the order number itself.
   */
  reference: string
  siteCode: string
  companyName: string
  contactName: string | null
  address1: string | null
  address2: string | null
  address3: string | null
  town: string | null
  county: string | null
  postcode: string | null
  country: string
  phone: string | null
  deliveryNotes: string | null
  requiredDate: string | null
  comments: string | null
  courierServiceId: number | null
  clientId: number | null
  warehouseId: number | null
  lines: OrderLine[]
}

/** The body Mintsoft expects. Field names and casing are theirs. */
export function buildOrderBody(order: OrderToPost): Record<string, unknown> {
  const [firstName, ...rest] = (order.contactName ?? order.siteCode).trim().split(/\s+/)
  return {
    // No OrderNumber. Mintsoft assigns one -- MRK-<id>, the same shape as every order
    // Mercium raises itself -- so both sides have one name for the order instead of two.
    // Ours stays as the reference, which is what the lookup matches on.
    ExternalOrderReference: order.reference,
    Tags: `${PORTAL_TAG},${order.siteCode}`,
    CompanyName: order.companyName,
    FirstName: firstName || order.siteCode,
    LastName: rest.join(' ') || order.siteCode,
    Address1: order.address1,
    Address2: order.address2,
    Address3: order.address3,
    Town: order.town,
    County: order.county,
    PostCode: order.postcode,
    Country: order.country,
    Phone: order.phone,
    DeliveryNotes: order.deliveryNotes,
    Comments: order.comments,
    RequiredDeliveryDate: order.requiredDate,
    CourierServiceId: order.courierServiceId ?? undefined,
    ClientId: order.clientId ?? undefined,
    WarehouseId: order.warehouseId ?? undefined,
    OrderItems: order.lines.map((l) => ({ SKU: l.sku, Quantity: l.quantity })),
  }
}

export type PostOutcome =
  | { kind: 'created'; mintsoftOrderId: number; mintsoftOrderNumber: string | null }
  | { kind: 'already_exists'; mintsoftOrderId: number; mintsoftOrderNumber: string | null }
  /** Another send holds the order. Nothing was attempted; wait for that one. */
  | { kind: 'in_flight' }
  /** Mintsoft refused it. The message is Mintsoft's own. */
  | { kind: 'rejected'; reason: string }
  /**
   * We do not know whether it was created. The order must NOT be retried blindly —
   * the next attempt re-runs the lookup first, which is the whole point of the number.
   */
  | { kind: 'uncertain'; reason: string }

/**
 * Posts an approved order, exactly once.
 *
 * Always looks first. That is not an optimisation for the retry case: it is the only
 * thing standing between a timed-out request and a second pallet of bowls.
 */
export async function postOrder(
  client: MintsoftWriteClient,
  order: OrderToPost,
  /**
   * Called only once the lookup has said "absent", immediately before the create, and
   * only proceeds if it returns true.
   *
   * It sits here rather than around the whole send because the lookup is a read and is
   * the safe way out of an uncertain order: a retry has to be able to run it and attach
   * what it finds. Guarding the whole send would block that recovery, which is the one
   * path a timed-out order depends on.
   */
  claimBeforeCreate: () => Promise<boolean> = async () => true,
): Promise<PostOutcome> {
  const existing = await lookupExistingOrder(client, order.reference, { clientId: order.clientId })
  if (existing.kind === 'found') {
    return {
      kind: 'already_exists',
      mintsoftOrderId: existing.mintsoftOrderId,
      mintsoftOrderNumber: existing.mintsoftOrderNumber,
    }
  }
  if (existing.kind === 'unknown') {
    return { kind: 'uncertain', reason: existing.reason }
  }

  // The lookup said absent, so this call is about to create. Two sends can both reach
  // here — every check before this point is a read — so exactly one may continue.
  if (!(await claimBeforeCreate())) return { kind: 'in_flight' }

  let response
  try {
    response = await client.putOrder(buildOrderBody(order))
  } catch (err) {
    // The classic dangerous case: the request may well have succeeded before the
    // connection dropped. Never retry from here without looking again.
    return {
      kind: 'uncertain',
      reason: `The request to Mintsoft failed before we saw a reply (${err instanceof Error ? err.message : 'unknown error'}). ` +
        'It may or may not have been created, so the next attempt will look it up rather than send again.',
    }
  }

  if (response.status !== 200 || !Array.isArray(response.data)) {
    return {
      kind: 'uncertain',
      reason: `Mintsoft answered with HTTP ${response.status} rather than a result. ` +
        'Whether the order was created is unknown until it is looked up.',
    }
  }

  if (response.data.length === 0) {
    return { kind: 'uncertain', reason: 'Mintsoft returned an empty result list.' }
  }

  // Every element must succeed. The response is an array even for a single order, and
  // a failure arrives as Success:false inside a 200.
  const failed = response.data.filter((r) => r.Success !== true)
  if (failed.length > 0) {
    const messages = failed.map((r) => r.Message).filter(Boolean)
    return {
      kind: 'rejected',
      reason: messages.length ? messages.join('; ') : 'Mintsoft rejected the order without saying why.',
    }
  }

  const withId = response.data.find((r) => typeof r.OrderId === 'number' && r.OrderId > 0)
  if (!withId?.OrderId) {
    // Reported success but gave us no id to track it by. The order probably exists, so
    // this must not be treated as a failure that invites a retry.
    return {
      kind: 'uncertain',
      reason: 'Mintsoft reported success but returned no order id, so the order cannot be tracked. ' +
        'It has most likely been created — look it up before sending anything again.',
    }
  }

  // Mintsoft echoes the number it assigned. Recording it is what lets Maki and Mercium
  // talk about the same order; without it the portal knows only an internal id.
  return {
    kind: 'created',
    mintsoftOrderId: withId.OrderId,
    mintsoftOrderNumber: withId.OrderNumber ?? null,
  }
}

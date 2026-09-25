import { describe, expect, it, vi } from 'vitest'
import { buildOrderNumber, parseOrderNumber } from '../src/server/orders/order-number.ts'
import {
  buildOrderBody, lookupExistingOrder, postOrder, type MintsoftWriteClient, type OrderToPost,
} from '../src/server/orders/post.ts'
import { mayWriteToMintsoft, writesEnabled, type OrderForWrite } from '../src/server/orders/write-gate.ts'

/**
 * The write path. Mintsoft has no idempotency of its own, so a duplicate here is a
 * second pallet of bowls that Mercium picks, ships and bills for.
 */

const order: OrderToPost = {
  reference: 'MR-M9-20260921-001', siteCode: 'M9', companyName: 'Maki & Ramen Leith Walk',
  contactName: 'Site Manager', address1: '1 Example Street', address2: null, address3: null,
  town: 'Edinburgh', county: null, postcode: 'EH6 5AA', country: 'GB', phone: null,
  deliveryNotes: null, requiredDate: null, comments: null, courierServiceId: 3,
  clientId: 42, warehouseId: 1, lines: [{ sku: 'BOWL-01', quantity: 24 }],
}

/**
 * A Mintsoft that records what it was asked to do.
 *
 * `searchResults` is what /api/Order/List answers with. It answers the same page every
 * time, which is fine while the fixtures are shorter than a page: the lookup stops at
 * the first short page.
 */
function stubMintsoft(opts: {
  searchResults?: unknown[]
  searchStatus?: number
  searchThrows?: Error
  putResult?: unknown
  putStatus?: number
  putThrows?: Error
} = {}) {
  const puts: unknown[] = []
  const client: MintsoftWriteClient = {
    async get<T>(_path: string) {
      if (opts.searchThrows) throw opts.searchThrows
      const status = opts.searchStatus ?? 200
      return { data: (opts.searchResults ?? []) as T, status, ms: 1, raw: '' }
    },
    async putOrder(body: unknown) {
      puts.push(body)
      if (opts.putThrows) throw opts.putThrows
      return {
        data: (opts.putResult ?? [{ Success: true, OrderId: 8811, OrderNumber: 'MRK-8811' }]) as never,
        status: opts.putStatus ?? 200,
        raw: '',
      }
    },
  }
  return { client, puts }
}

describe('the write gate', () => {
  const approved: OrderForWrite = {
    id: 1, orderNumber: 'MR-M9-20260921-001', status: 'approved',
    approvedByRole: 'approver', approvedAt: '2026-09-21T10:00:00Z', mintsoftOrderId: null,
  }

  it('lets an approved order through when writes are on', () => {
    expect(mayWriteToMintsoft(approved, { writesEnabled: true }).allowed).toBe(true)
  })

  it('refuses everything when writes are off, whatever else is true', () => {
    const decision = mayWriteToMintsoft(approved, { writesEnabled: false })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/switched off/)
  })

  it('refuses an order that has not been approved', () => {
    for (const status of ['draft', 'submitted', 'rejected', 'cancelled', 'post_failed'] as const) {
      const d = mayWriteToMintsoft({ ...approved, status }, { writesEnabled: true })
      expect(d.allowed, status).toBe(false)
    }
  })

  it('refuses an order approved by a GM', () => {
    // Status alone could be reached by a bug or a direct database edit, so the sign-off
    // still has to be attributable to a role entitled to give it. A GM never is.
    const d = mayWriteToMintsoft({ ...approved, approvedByRole: 'gm' }, { writesEnabled: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/may not sign off/)
  })

  it('allows an order approved by an admin, who may sign off as well as an approver', () => {
    const d = mayWriteToMintsoft({ ...approved, approvedByRole: 'admin' }, { writesEnabled: true })
    expect(d.allowed).toBe(true)
  })

  it('refuses an order marked approved with nobody recorded as approving it', () => {
    const d = mayWriteToMintsoft({ ...approved, approvedByRole: null }, { writesEnabled: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/nobody is recorded/)
  })

  it('refuses to send an order that is already in Mintsoft', () => {
    const d = mayWriteToMintsoft({ ...approved, mintsoftOrderId: 8811 }, { writesEnabled: true })
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/already in Mintsoft as order 8811/)
  })

  it('reads the flag strictly, so anything but "true" is off', () => {
    expect(writesEnabled('true')).toBe(true)
    for (const v of ['false', 'TRUE', '1', 'yes', '', undefined]) {
      expect(writesEnabled(v), String(v)).toBe(false)
    }
  })
})

describe('order numbers', () => {
  it('builds the documented shape', () => {
    expect(buildOrderNumber('M9', new Date('2026-09-21T14:00:00Z'), 1)).toBe('MR-M9-20260921-001')
    expect(buildOrderNumber('MAF1', new Date('2026-12-05T00:00:00Z'), 42)).toBe('MR-MAF1-20261205-042')
  })

  it('round-trips', () => {
    expect(parseOrderNumber('MR-M9-20260921-007')).toEqual({ siteCode: 'M9', date: '20260921', sequence: 7 })
    expect(parseOrderNumber('not-an-order-number')).toBeNull()
  })

  it('refuses a sequence that would roll over and reuse a number', () => {
    // A reused number is one Mintsoft may already hold, which breaks the only
    // idempotency we have.
    expect(() => buildOrderNumber('M9', new Date(), 1000)).toThrow(/out of range/)
    expect(() => buildOrderNumber('M9', new Date(), 0)).toThrow(/out of range/)
  })
})

describe('looking up an existing order', () => {
  it('finds one that is already there', async () => {
    const { client } = stubMintsoft({
      searchResults: [{ OrderNumber: 'MRK-8811', ExternalOrderReference: order.reference, ID: 8811 }],
    })
    expect(await lookupExistingOrder(client, order.reference))
      .toEqual({ kind: 'found', mintsoftOrderId: 8811, mintsoftOrderNumber: 'MRK-8811' })
  })

  it('reports absent when Mintsoft answers with an empty list', async () => {
    const { client } = stubMintsoft({ searchResults: [] })
    expect(await lookupExistingOrder(client, order.reference)).toEqual({ kind: 'absent' })
  })

  it('treats a 404 as unknown, not as absent', async () => {
    // Mintsoft's own words: "Order not found or not accessible". Those need different
    // actions, and creating against the wrong one makes the duplicate.
    const { client } = stubMintsoft({ searchStatus: 404 })
    const outcome = await lookupExistingOrder(client, order.reference)
    expect(outcome.kind).toBe('unknown')
  })

  it('treats a network failure as unknown', async () => {
    const { client } = stubMintsoft({ searchThrows: new Error('connection reset') })
    expect((await lookupExistingOrder(client, order.reference)).kind).toBe('unknown')
  })

  it('ignores an order whose reference merely resembles ours', async () => {
    const { client } = stubMintsoft({
      searchResults: [{ OrderNumber: 'MRK-9999', ExternalOrderReference: 'MR-M9-20260921-0010', ID: 9999 }],
    })
    expect(await lookupExistingOrder(client, order.reference)).toEqual({ kind: 'absent' })
  })

  it('ignores Mercium\'s own orders, which carry no reference of ours', async () => {
    const { client } = stubMintsoft({
      searchResults: [{ OrderNumber: 'MRK-2313', ExternalOrderReference: null, ID: 2313 }],
    })
    expect(await lookupExistingOrder(client, order.reference)).toEqual({ kind: 'absent' })
  })
})

/**
 * The lookup walks pages, so the end of the list has to be told apart from the end of
 * our patience. Getting that wrong in the wrong direction creates the duplicate.
 */
describe('looking up across pages', () => {
  /** A Mintsoft with `total` portal orders, none of them ours, served 200 at a time. */
  function stubPages(total: number) {
    const calls: number[] = []
    const client = {
      async get<T>(_path: string, query?: Record<string, unknown>) {
        const page = Number(query?.PageNo ?? 1)
        calls.push(page)
        const start = (page - 1) * 200
        const rows = Array.from({ length: Math.max(0, Math.min(200, total - start)) }, (_, i) => ({
          ID: start + i + 1,
          OrderNumber: `MRK-${start + i + 1}`,
          ExternalOrderReference: `MR-OTHER-20260101-${start + i + 1}`,
        }))
        return { data: rows as T, status: 200, ms: 1, raw: '' }
      },
      async putOrder() { throw new Error('must not create during a lookup test') },
    } as unknown as MintsoftWriteClient
    return { client, calls }
  }

  it('keeps going past a full page rather than stopping at the first one', async () => {
    const { client, calls } = stubPages(250)
    expect(await lookupExistingOrder(client, order.reference)).toEqual({ kind: 'absent' })
    expect(calls).toEqual([1, 2])
  })

  it('finds an order sitting on a later page', async () => {
    const { client } = stubPages(250)
    const wrapped = {
      ...client,
      async get<T>(path: string, query?: Record<string, unknown>) {
        const res = await client.get<Record<string, unknown>[]>(path, query as never)
        if (Number(query?.PageNo) === 2 && Array.isArray(res.data)) {
          res.data[0] = { ID: 8811, OrderNumber: 'MRK-8811', ExternalOrderReference: order.reference }
        }
        return res as unknown as { data: T; status: number; ms: number; raw: string }
      },
    } as unknown as MintsoftWriteClient
    expect(await lookupExistingOrder(wrapped, order.reference))
      .toEqual({ kind: 'found', mintsoftOrderId: 8811, mintsoftOrderNumber: 'MRK-8811' })
  })

  it('says unknown, never absent, when it runs out of pages still looking', async () => {
    // The dangerous case. "I have not seen it yet" must never be read as "it is not
    // there", because that reading is what sends a second pallet.
    const { client } = stubPages(200 * 40)
    const outcome = await lookupExistingOrder(client, order.reference)
    expect(outcome.kind).toBe('unknown')
  })

  it('refuses to create when the pages ran out, rather than risking a duplicate', async () => {
    const { client } = stubPages(200 * 40)
    const puts: unknown[] = []
    const watched = { ...client, async putOrder(body: unknown) { puts.push(body); return { data: null, status: 200, raw: '' } } } as unknown as MintsoftWriteClient
    expect((await postOrder(watched, order)).kind).toBe('uncertain')
    expect(puts).toHaveLength(0)
  })
})

describe('posting an order', () => {
  it('creates it and returns the Mintsoft id', async () => {
    const { client, puts } = stubMintsoft()
    expect(await postOrder(client, order))
      .toEqual({ kind: 'created', mintsoftOrderId: 8811, mintsoftOrderNumber: 'MRK-8811' })
    expect(puts).toHaveLength(1)
  })

  it('sends the lines as SKU and quantity', async () => {
    const body = buildOrderBody(order) as { OrderItems: { SKU: string; Quantity: number }[] }
    expect(body.OrderItems).toEqual([{ SKU: 'BOWL-01', Quantity: 24 }])
  })

  it('names no order number, so Mintsoft assigns its own', async () => {
    // Mercium's orders are MRK-<id>. Ours used to arrive as MR-<site>-<date>-<seq>, so
    // the two sides had different names for the same order.
    expect(buildOrderBody(order)).not.toHaveProperty('OrderNumber')
  })

  it('tags the order so it can be found from the Mintsoft side too', async () => {
    const body = buildOrderBody(order) as { Tags: string; ExternalOrderReference: string }
    expect(body.Tags).toContain('maki-portal')
    expect(body.ExternalOrderReference).toBe(order.reference)
  })

  it('treats a 200 carrying Success:false as a rejection, not a success', async () => {
    // The failure that loses orders silently: a GM sees "sent" and nothing arrives.
    const { client } = stubMintsoft({
      putResult: [{ Success: false, Message: 'SKU BOWL-01 is not active' }],
    })
    expect(await postOrder(client, order)).toEqual({
      kind: 'rejected', reason: 'SKU BOWL-01 is not active',
    })
  })

  it('requires every element of the array to succeed', async () => {
    const { client } = stubMintsoft({
      putResult: [{ Success: true, OrderId: 1 }, { Success: false, Message: 'second line failed' }],
    })
    expect((await postOrder(client, order)).kind).toBe('rejected')
  })

  it('will not claim success when Mintsoft returns no order id', async () => {
    const { client } = stubMintsoft({ putResult: [{ Success: true }] })
    const outcome = await postOrder(client, order)
    // Probably created, but untrackable — so not a failure that invites a retry.
    expect(outcome.kind).toBe('uncertain')
  })
})

describe('a timeout after a successful create must not duplicate the order', () => {
  it('reports uncertain rather than failed when the connection drops', async () => {
    const { client } = stubMintsoft({ putThrows: new Error('socket hang up') })
    const outcome = await postOrder(client, order)
    expect(outcome.kind).toBe('uncertain')
    expect(outcome.kind === 'uncertain' && outcome.reason).toMatch(/may or may not have been created/)
  })

  it('attaches the existing order on the retry instead of creating a second one', async () => {
    // The scenario the brief asks to prove. First attempt: Mintsoft creates the order,
    // then the connection dies before we see the reply.
    const first = stubMintsoft({ searchResults: [], putThrows: new Error('socket hang up') })
    const firstOutcome = await postOrder(first.client, order)
    expect(firstOutcome.kind).toBe('uncertain')
    expect(first.puts).toHaveLength(1)   // it really was sent

    // Retry. Mintsoft now has the order, because the create had in fact succeeded.
    const second = stubMintsoft({
      searchResults: [{ OrderNumber: 'MRK-8811', ExternalOrderReference: order.reference, ID: 8811 }],
    })
    const secondOutcome = await postOrder(second.client, order)

    expect(secondOutcome)
      .toEqual({ kind: 'already_exists', mintsoftOrderId: 8811, mintsoftOrderNumber: 'MRK-8811' })
    // The whole point: no second order was sent.
    expect(second.puts).toHaveLength(0)
  })

  it('refuses to create when the retry cannot get a trustworthy answer', async () => {
    // Retry after a timeout, and this time the lookup 404s — which might mean the
    // order is there but invisible. Creating now is how the duplicate happens.
    const { client, puts } = stubMintsoft({ searchStatus: 404 })
    expect((await postOrder(client, order)).kind).toBe('uncertain')
    expect(puts).toHaveLength(0)
  })

  it('does create when the lookup positively says the order is not there', async () => {
    const { client, puts } = stubMintsoft({ searchResults: [] })
    expect((await postOrder(client, order)).kind).toBe('created')
    expect(puts).toHaveLength(1)
  })
})

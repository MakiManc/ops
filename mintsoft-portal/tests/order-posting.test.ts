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
  orderNumber: 'MR-M9-20260921-001', siteCode: 'M9', companyName: 'Maki & Ramen Leith Walk',
  contactName: 'Site Manager', address1: '1 Example Street', address2: null, address3: null,
  town: 'Edinburgh', county: null, postcode: 'EH6 5AA', country: 'GB', phone: null,
  deliveryNotes: null, requiredDate: null, comments: null, courierServiceId: 3,
  clientId: 42, warehouseId: 1, lines: [{ sku: 'BOWL-01', quantity: 24 }],
}

/** A Mintsoft that records what it was asked to do. */
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
        data: (opts.putResult ?? [{ Success: true, OrderId: 8811, OrderNumber: order.orderNumber }]) as never,
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
    const { client } = stubMintsoft({ searchResults: [{ OrderNumber: order.orderNumber, ID: 8811 }] })
    expect(await lookupExistingOrder(client, order.orderNumber)).toEqual({ kind: 'found', mintsoftOrderId: 8811 })
  })

  it('reports absent when Mintsoft answers with an empty list', async () => {
    const { client } = stubMintsoft({ searchResults: [] })
    expect(await lookupExistingOrder(client, order.orderNumber)).toEqual({ kind: 'absent' })
  })

  it('treats a 404 as unknown, not as absent', async () => {
    // Mintsoft's own words: "Order not found or not accessible". Those need different
    // actions, and creating against the wrong one makes the duplicate.
    const { client } = stubMintsoft({ searchStatus: 404 })
    const outcome = await lookupExistingOrder(client, order.orderNumber)
    expect(outcome.kind).toBe('unknown')
  })

  it('treats a network failure as unknown', async () => {
    const { client } = stubMintsoft({ searchThrows: new Error('connection reset') })
    expect((await lookupExistingOrder(client, order.orderNumber)).kind).toBe('unknown')
  })

  it('ignores an order whose number merely resembles ours', async () => {
    const { client } = stubMintsoft({ searchResults: [{ OrderNumber: 'MR-M9-20260921-0010', ID: 9999 }] })
    expect(await lookupExistingOrder(client, order.orderNumber)).toEqual({ kind: 'absent' })
  })
})

describe('posting an order', () => {
  it('creates it and returns the Mintsoft id', async () => {
    const { client, puts } = stubMintsoft()
    expect(await postOrder(client, order)).toEqual({ kind: 'created', mintsoftOrderId: 8811 })
    expect(puts).toHaveLength(1)
  })

  it('sends the lines as SKU and quantity', async () => {
    const body = buildOrderBody(order) as { OrderItems: { SKU: string; Quantity: number }[]; OrderNumber: string }
    expect(body.OrderItems).toEqual([{ SKU: 'BOWL-01', Quantity: 24 }])
    expect(body.OrderNumber).toBe('MR-M9-20260921-001')
  })

  it('tags the order so it can be found from the Mintsoft side too', async () => {
    const body = buildOrderBody(order) as { Tags: string; ExternalOrderReference: string }
    expect(body.Tags).toContain('maki-portal')
    expect(body.ExternalOrderReference).toBe(order.orderNumber)
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
    const second = stubMintsoft({ searchResults: [{ OrderNumber: order.orderNumber, ID: 8811 }] })
    const secondOutcome = await postOrder(second.client, order)

    expect(secondOutcome).toEqual({ kind: 'already_exists', mintsoftOrderId: 8811 })
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

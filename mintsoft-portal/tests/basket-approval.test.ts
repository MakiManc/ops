import { describe, expect, it } from 'vitest'
import { blocksSubmission, checkBasket, type BasketLine } from '../src/server/orders/basket-checks.ts'
import {
  allocateLine, checkApproval, rechargeTotals, type LineToApprove, type MappedSku,
} from '../src/server/orders/approval.ts'

const NOW = new Date('2026-09-21T12:00:00Z')

const line = (over: Partial<BasketLine> = {}): BasketLine => ({
  productId: 1, productName: 'Ramen Bowl', qty: 10, available: 100,
  parLevel: null, maxPerOrder: null, qtyAlreadyInOpenRequest: null, ...over,
})
const ctx = (over = {}) => ({
  siteName: 'M9', lastOrderAt: null, minDaysBetweenOrders: 14,
  earlyOrderReason: null, now: NOW, ...over,
})
const codes = (checks: { code: string }[]) => checks.map((c) => c.code)

describe('basket checks', () => {
  it('passes a straightforward request', () => {
    const checks = checkBasket([line()], ctx())
    expect(blocksSubmission(checks)).toBe(false)
  })

  it('blocks asking for more than is there', () => {
    const checks = checkBasket([line({ qty: 150, available: 100 })], ctx())
    expect(codes(checks)).toContain('over_available')
    expect(blocksSubmission(checks)).toBe(true)
  })

  it('blocks an empty request', () => {
    expect(codes(checkBasket([], ctx()))).toContain('empty')
  })

  it('lets a GM ask for something whose stock we cannot read', () => {
    // Refusing here would make the portal's stale cache into the GM's problem. The
    // approver re-checks against live stock before anything is sent anyway.
    const checks = checkBasket([line({ available: null })], ctx())
    expect(codes(checks)).toContain('unknown_stock')
    expect(blocksSubmission(checks)).toBe(false)
  })

  it('asks for a reason above the per-order cap', () => {
    const checks = checkBasket([line({ qty: 60, maxPerOrder: 48 })], ctx())
    expect(checks.find((c) => c.code === 'over_max')?.severity).toBe('needs_reason')
  })

  it('asks for a reason above the site\'s usual level', () => {
    const checks = checkBasket([line({ qty: 60, parLevel: 24 })], ctx())
    expect(checks.find((c) => c.code === 'over_par')?.severity).toBe('needs_reason')
  })

  it('points out what is already on the open request', () => {
    const checks = checkBasket([line({ qtyAlreadyInOpenRequest: 12 })], ctx())
    expect(checks.find((c) => c.code === 'already_requested')?.message).toMatch(/already on this site's open request/)
  })

  it('reports every problem at once rather than one at a time', () => {
    // A GM adjusting a basket on a phone should see the whole picture.
    const checks = checkBasket([line({ qty: 200, available: 100, maxPerOrder: 48, parLevel: 24 })], ctx())
    expect(codes(checks)).toEqual(expect.arrayContaining(['over_available', 'over_max', 'over_par']))
  })
})

describe('the minimum gap between orders', () => {
  it('asks why when a site orders again too soon', () => {
    // Mercium bills per order, so this costs money a fuller single order would not.
    const checks = checkBasket([line()], ctx({ lastOrderAt: '2026-09-18T12:00:00Z' }))
    const gap = checks.find((c) => c.code === 'too_soon')
    expect(gap?.severity).toBe('needs_reason')
    expect(gap?.message).toMatch(/ordered 3 days ago/)
    expect(gap?.message).toMatch(/delivery fee/)
  })

  it('lets it through once a reason is given, and flags it for the approver', () => {
    const checks = checkBasket([line()], ctx({
      lastOrderAt: '2026-09-18T12:00:00Z', earlyOrderReason: 'Ran out after a coach party',
    }))
    expect(checks.find((c) => c.code === 'too_soon')?.severity).toBe('note')
    expect(blocksSubmission(checks)).toBe(false)
  })

  it('ignores whitespace pretending to be a reason', () => {
    const checks = checkBasket([line()], ctx({
      lastOrderAt: '2026-09-18T12:00:00Z', earlyOrderReason: '   ',
    }))
    expect(checks.find((c) => c.code === 'too_soon')?.severity).toBe('needs_reason')
  })

  it('says nothing once the gap has passed', () => {
    const checks = checkBasket([line()], ctx({ lastOrderAt: '2026-09-01T12:00:00Z' }))
    expect(codes(checks)).not.toContain('too_soon')
  })

  it('says nothing for a site that has never ordered', () => {
    expect(codes(checkBasket([line()], ctx({ lastOrderAt: null })))).not.toContain('too_soon')
  })
})

describe('allocating a line across warehouse SKUs', () => {
  const sku = (id: number, code: string, available: number | null, isPrimary = false): MappedSku =>
    ({ mintsoftProductId: id, sku: code, available, isPrimary })
  const toApprove = (over: Partial<LineToApprove> = {}): LineToApprove => ({
    productId: 1, productName: 'Ramen Bowl', qtyApproved: 30,
    skus: [sku(7001, 'BOWL-01', 100, true)], rechargeUnitPrice: null, ...over,
  })

  it('orders against the primary SKU when it can cover the line', () => {
    const a = allocateLine(toApprove())
    expect(a).toEqual({ kind: 'allocated', productId: 1, parts: [{ sku: 'BOWL-01', qty: 30 }] })
  })

  it('splits across the duplicates when the primary runs short', () => {
    // The duplicates exist because stock arrived in separate shipments, so a split is
    // the normal case rather than an exception.
    const a = allocateLine(toApprove({
      qtyApproved: 30,
      skus: [sku(7001, 'BOWL-01', 10, true), sku(7002, 'BOWL-02', 15), sku(7003, 'BOWL-03', 20)],
    }))
    expect(a).toEqual({
      kind: 'allocated', productId: 1,
      // Primary first, then the biggest remaining holding, to keep the pick simple.
      parts: [{ sku: 'BOWL-01', qty: 10 }, { sku: 'BOWL-03', qty: 20 }],
    })
  })

  it('blocks and says the shortfall when the product as a whole is short', () => {
    const a = allocateLine(toApprove({
      qtyApproved: 50, skus: [sku(7001, 'BOWL-01', 10, true), sku(7002, 'BOWL-02', 15)],
    }))
    expect(a.kind).toBe('short')
    expect(a.kind === 'short' && a.message).toMatch(/only 25 in stock — 25 short/)
  })

  it('refuses to approve against an unknown stock figure', () => {
    // Approving against an unknown total is how an order goes out that cannot be filled.
    const a = allocateLine(toApprove({ skus: [sku(7001, 'BOWL-01', null, true)] }))
    expect(a.kind).toBe('short')
    expect(a.kind === 'short' && a.message).toMatch(/could not be read just now/)
  })

  it('refuses a product mapped to nothing', () => {
    const a = allocateLine(toApprove({ skus: [] }))
    expect(a.kind === 'short' && a.message).toMatch(/not mapped to any warehouse line/)
  })
})

describe('approving an order', () => {
  const corporate = { recharge: false, orderFee: 12, passOrderFeeToFranchise: false }
  const franchise = { recharge: true, orderFee: 12, passOrderFeeToFranchise: true }
  const ok = (over: Partial<LineToApprove> = {}): LineToApprove => ({
    productId: 1, productName: 'Ramen Bowl', qtyApproved: 10,
    skus: [{ mintsoftProductId: 7001, sku: 'BOWL-01', available: 100, isPrimary: true }],
    rechargeUnitPrice: 2.5, ...over,
  })

  it('approves when every line can be filled', () => {
    expect(checkApproval([ok()], corporate).ok).toBe(true)
  })

  it('reports which lines are short, all of them at once', () => {
    const result = checkApproval([
      ok({ productId: 1, productName: 'Bowl', qtyApproved: 500 }),
      ok({ productId: 2, productName: 'Chopsticks', qtyApproved: 900 }),
    ], corporate)
    expect(result.ok).toBe(false)
    expect(result.problems).toHaveLength(2)
  })

  it('surfaces which lines had to be split', () => {
    const result = checkApproval([ok({
      qtyApproved: 30,
      skus: [
        { mintsoftProductId: 7001, sku: 'BOWL-01', available: 10, isPrimary: true },
        { mintsoftProductId: 7002, sku: 'BOWL-02', available: 25, isPrimary: false },
      ],
    })], corporate)
    expect(result.splits).toHaveLength(1)
    expect(result.splits[0]!.parts).toHaveLength(2)
  })

  it('blocks a recharge order with an unpriced line', () => {
    // Never recharge at zero: better to block and have someone set the price.
    const result = checkApproval([ok({ rechargeUnitPrice: null })], franchise)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatch(/no recharge price set/)
  })

  it('does not care about prices at a corporate site', () => {
    expect(checkApproval([ok({ rechargeUnitPrice: null })], corporate).ok).toBe(true)
  })
})

describe('what a franchise is charged', () => {
  const line = (qty: number, price: number | null): LineToApprove => ({
    productId: 1, productName: 'Bowl', qtyApproved: qty,
    skus: [{ mintsoftProductId: 1, sku: 'A', available: 1000, isPrimary: true }],
    rechargeUnitPrice: price,
  })

  it('adds the lines up and adds the order fee when that is passed on', () => {
    const totals = rechargeTotals([line(10, 2.5), line(4, 1.25)], {
      recharge: true, orderFee: 12, passOrderFeeToFranchise: true,
    })
    expect(totals).toEqual({ lineTotal: 30, orderFee: 12, total: 42 })
  })

  it('leaves the order fee off when it is not passed on', () => {
    const totals = rechargeTotals([line(10, 2.5)], {
      recharge: true, orderFee: 12, passOrderFeeToFranchise: false,
    })
    expect(totals).toEqual({ lineTotal: 25, orderFee: 0, total: 25 })
  })

  it('returns nothing at all for a corporate site', () => {
    // Corporate sites are never recharged and never shown a price.
    expect(rechargeTotals([line(10, 2.5)], {
      recharge: false, orderFee: 12, passOrderFeeToFranchise: true,
    })).toBeNull()
  })

  it('rounds to the penny rather than carrying float noise into an invoice', () => {
    const totals = rechargeTotals([line(3, 0.1)], {
      recharge: true, orderFee: 0, passOrderFeeToFranchise: true,
    })
    expect(totals!.total).toBe(0.3)
  })
})

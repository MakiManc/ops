import { describe, expect, it } from 'vitest'
import { combineMappedLines, deriveAvailability, type StockRow } from '../src/server/sync/availability.ts'

/**
 * Mintsoft publishes no availability figure, so this number is entirely ours — and it
 * is the number a GM orders against and an approver signs off. A figure that is quietly
 * too high oversells; one that is quietly too low stops a site ordering what it needs.
 *
 * The rule under test throughout: when we do not know, we say so, rather than producing
 * a confident number from incomplete inputs.
 */

const rows = (...r: StockRow[]) => r

describe('on hand minus allocated', () => {
  it('works out what is free', () => {
    const a = deriveAvailability(rows({ onHand: 12, allocated: 2 }), 'on_hand_minus_allocated')
    expect(a.available).toBe(10)
    expect(a.onHand).toBe(12)
    expect(a.allocated).toBe(2)
    expect(a.basis).toBe('12 on hand less 2 allocated.')
  })

  it('adds up a product split across warehouse locations', () => {
    // Mintsoft's inventory feed carries a LocationId, so one product can arrive on
    // several rows. Reading one would show a single bin as the whole holding.
    const a = deriveAvailability(
      rows({ onHand: 10, allocated: 1 }, { onHand: 5, allocated: 2 }), 'on_hand_minus_allocated',
    )
    expect(a.available).toBe(12)
    expect(a.rowsSeen).toBe(2)
    expect(a.basis).toContain('across 2 locations')
  })

  it('reports nothing rather than an undercount when a location is missing its figure', () => {
    // The dangerous version of this bug adds up the rows it did get and presents the
    // result as the total — a confident number that is too low.
    const a = deriveAvailability(
      rows({ onHand: 10, allocated: 1 }, { onHand: null, allocated: 2 }), 'on_hand_minus_allocated',
    )
    expect(a.available).toBeNull()
    expect(a.basis).toMatch(/did not report stock on hand for every location/)
  })

  it('will not guess what is free when allocations are unknown', () => {
    const a = deriveAvailability(rows({ onHand: 10, allocated: null }), 'on_hand_minus_allocated')
    expect(a.available).toBeNull()
    // We still know what is in the building, and saying so is more useful than nothing.
    expect(a.onHand).toBe(10)
    expect(a.basis).toMatch(/allocations are not/)
  })

  it('floors at zero when more is allocated than held, but flags the position', () => {
    const a = deriveAvailability(rows({ onHand: 5, allocated: 8 }), 'on_hand_minus_allocated')
    // You cannot order from a negative, so a GM sees none available...
    expect(a.available).toBe(0)
    // ...but the over-allocation is real, and the stock overview must not round it away.
    expect(a.oversold).toBe(true)
    expect(a.basis).toMatch(/more is allocated than is held/)
  })

  it('treats zero as a real answer, distinct from unknown', () => {
    const a = deriveAvailability(rows({ onHand: 0, allocated: 0 }), 'on_hand_minus_allocated')
    expect(a.available).toBe(0)
    expect(a.basis).toBe('0 on hand less 0 allocated.')
  })
})

describe('the stock_level formula', () => {
  it('takes Mintsoft at its word when that is how we are configured', () => {
    const a = deriveAvailability(rows({ stockLevel: 8 }), 'stock_level')
    expect(a.available).toBe(8)
    expect(a.basis).toBe('Mintsoft reports 8 free to order.')
  })

  it('sums locations under this formula too', () => {
    const a = deriveAvailability(rows({ stockLevel: 3 }, { stockLevel: 4 }), 'stock_level')
    expect(a.available).toBe(7)
  })

  it('reports unknown when any location is missing a level', () => {
    expect(deriveAvailability(rows({ stockLevel: 3 }, {}), 'stock_level').available).toBeNull()
  })

  it('ignores on-hand and allocated, which this formula does not use', () => {
    const a = deriveAvailability(rows({ stockLevel: 8, onHand: 99, allocated: 99 }), 'stock_level')
    expect(a.available).toBe(8)
  })
})

describe('a product absent from the feed', () => {
  it('is unknown, never zero', () => {
    // Mintsoft's own documentation warns that products with no inventory record simply
    // do not appear. Recording that as "none in stock" is the portal's easiest lie.
    const a = deriveAvailability([], 'on_hand_minus_allocated')
    expect(a.available).toBeNull()
    expect(a.basis).toMatch(/Not in the latest stock feed/)
  })
})

describe('a Maki product mapped to several Mintsoft lines', () => {
  const line = (available: number, onHand: number, allocated: number) =>
    deriveAvailability(rows({ onHand, allocated }), 'on_hand_minus_allocated')

  it('adds the duplicates up into one figure', () => {
    // This is the whole point of the mapping: three shipment duplicates, one product.
    const a = combineMappedLines([line(10, 12, 2), line(5, 5, 0), line(3, 4, 1)])
    expect(a.available).toBe(18)
    expect(a.onHand).toBe(21)
    expect(a.basis).toMatch(/across 3 Mintsoft lines/)
  })

  it('passes a single line straight through with its own explanation', () => {
    const a = combineMappedLines([line(10, 12, 2)])
    expect(a.available).toBe(10)
    expect(a.basis).toBe('12 on hand less 2 allocated.')
  })

  it('is unknown if any mapped line is unknown, and says how many', () => {
    const unknown = deriveAvailability(rows({ onHand: null, allocated: null }), 'on_hand_minus_allocated')
    const a = combineMappedLines([line(10, 12, 2), unknown])
    expect(a.available).toBeNull()
    expect(a.basis).toMatch(/1 of 2/)
  })

  it('says plainly when a product is mapped to nothing at all', () => {
    const a = combineMappedLines([])
    expect(a.available).toBeNull()
    expect(a.basis).toMatch(/not mapped to anything in Mintsoft/)
  })

  it('carries an oversold line up to the product', () => {
    const over = deriveAvailability(rows({ onHand: 2, allocated: 9 }), 'on_hand_minus_allocated')
    expect(combineMappedLines([line(10, 12, 2), over]).oversold).toBe(true)
  })

  it('counts every underlying row, so one bin and all of them read differently', () => {
    const twoLocations = deriveAvailability(rows({ onHand: 1, allocated: 0 }, { onHand: 2, allocated: 0 }), 'on_hand_minus_allocated')
    expect(combineMappedLines([twoLocations, line(5, 5, 0)]).rowsSeen).toBe(3)
  })
})

describe('inputs that are not really numbers', () => {
  it('treats a non-finite value as unknown rather than arithmetic', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
      const a = deriveAvailability(rows({ onHand: bad as number, allocated: 1 }), 'on_hand_minus_allocated')
      expect(a.available, `onHand=${String(bad)}`).toBeNull()
    }
  })
})

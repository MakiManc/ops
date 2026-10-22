/**
 * What a franchise is charged, to the penny.
 *
 * This is the number that reaches a franchisee's invoice, so the rounding is the test.
 * The obvious implementation -- Math.round(cost * markup * 100) / 100 -- underprices
 * every exact half-penny, because 0.50 * 1.15 is 0.575 in decimal and 0.5749999999999999
 * in binary floating point. It would have charged 57p for a 50p item, and nobody queries
 * an invoice that is a penny light.
 */
import { describe, expect, it } from 'vitest'
import { charge } from '../scripts/set-recharge-prices.ts'

describe('cost plus markup, to the penny', () => {
  it('rounds an exact half-penny up, as money does', () => {
    // Each of these lands on a precise half-penny at 15%, and each is the case the
    // naive implementation got wrong.
    expect(charge(0.50)).toBe(0.58)   // 0.575
    expect(charge(1.30)).toBe(1.50)   // 1.495
    expect(charge(0.70)).toBe(0.81)   // 0.805
    expect(charge(3.25)).toBe(3.74)   // 3.7375, rounds down on its own merits
  })

  it('is never below the honest decimal answer', () => {
    // The property that matters: the charge must not come out under what the arithmetic
    // says, which is the direction the bug went and the direction that loses money.
    for (let pence = 1; pence <= 20000; pence++) {
      const cost = pence / 100
      const exact = Math.round(cost * 115) / 100   // integer path, no float halves
      expect(charge(cost), `cost £${cost.toFixed(2)}`).toBeGreaterThanOrEqual(exact - 0.0001)
    }
  })

  it('handles the sub-penny supplier prices the price file really contains', () => {
    // Straws are quoted at 2.5p and takeaway trays at 4.8p; the markup still has to
    // produce a sane penny figure rather than zero.
    expect(charge(0.025)).toBe(0.03)
    expect(charge(0.048)).toBe(0.06)
    expect(charge(0.108)).toBe(0.12)
  })

  it('keeps its nerve on the big ones', () => {
    expect(charge(2850)).toBe(3277.50)
    expect(charge(110)).toBe(126.50)
    expect(charge(41)).toBe(47.15)
  })

  it('charges nothing for nothing', () => {
    expect(charge(0)).toBe(0)
  })

  it('takes the markup as given, so changing it is one number', () => {
    expect(charge(1.00, 1.35)).toBe(1.35)
    expect(charge(1.00, 1.00)).toBe(1.00)
  })
})

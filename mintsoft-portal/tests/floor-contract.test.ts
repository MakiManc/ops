/**
 * The contract between what the catalogue offers and what approval accepts.
 *
 * These are two functions in two files that have to agree, and for three weeks they did
 * not. sync/availability.ts combineMappedLines reports a FLOOR when only some of a
 * product's Mintsoft lines can be read -- "at least 577 free to order, from 7 of the 8
 * Mintsoft lines for this product" -- because Mercium creates a product per shipment and
 * blanking the whole product over one missing record stops a site ordering stock we
 * plainly hold. orders/approval.ts allocateLine refused any line with an unreadable SKU
 * outright. So the catalogue quantified the stock, invited the order, and the approver hit
 * a wall whose advice ("try again once the next sync has run") could never come true.
 *
 * Commit dae73f1 introduced the floor and changed only the display side. Nothing tested
 * the two together, so nothing noticed. That is what this file is for: it drives both
 * halves from ONE set of stock rows and asserts the invariant that connects them.
 *
 * THE INVARIANT: whatever quantity the catalogue tells a site it may order, approval must
 * accept. Not "usually" -- if the screen says a site can have 30, signing off 30 cannot
 * fail on stock.
 */
import { describe, expect, it } from 'vitest'
import { combineMappedLines, deriveAvailability, type StockRow } from '../src/server/sync/availability.ts'
import { allocateLine, type LineToApprove, type MappedSku } from '../src/server/orders/approval.ts'

/** One mapped Mintsoft line: its inventory rows, or null when it is absent from the feed. */
type Line = { sku: string; rows: StockRow[] | null; primary?: boolean }

/**
 * Drives both halves from the same lines, the way production does.
 *
 * The catalogue side runs each line through deriveAvailability and combines them. The
 * approval side gets what orders/stock.ts builds: a per-line availability that is null
 * when the line has no readable rows. Both start from `lines` and nothing else.
 */
function bothSides(lines: Line[]) {
  const present = lines.filter((l) => l.rows !== null)
  const perLine = present.map((l) => deriveAvailability(l.rows!, 'on_hand'))
  const catalogue = combineMappedLines(perLine, {
    linesMissingFromFeed: lines.length - present.length,
  })

  const skus: MappedSku[] = lines.map((l, i) => ({
    mintsoftProductId: 1000 + i,
    sku: l.sku,
    isPrimary: l.primary === true,
    // orders/stock.ts:31 -- no rows at all, or a row whose figure is missing, is null.
    available: l.rows === null ? null : deriveAvailability(l.rows, 'on_hand').available,
  }))

  const approve = (qty: number) =>
    allocateLine({
      productId: 1, productName: 'Tea cups', qtyApproved: qty, skus, rechargeUnitPrice: null,
    } satisfies LineToApprove)

  return { catalogue, approve }
}

const on = (onHand: number, allocated = 0): StockRow[] => [{ onHand, allocated }]

/** The live production shape on 2026-10-12: 8 lines, one absent from the stock feed. */
const TEA_CUPS: Line[] = [
  { sku: 'MRK001-TCT', rows: on(0), primary: true },
  { sku: 'MRK002-TCT', rows: on(10) },
  { sku: 'MRK004-TCT', rows: on(56) },
  { sku: 'MRK005-TCT', rows: on(28) },
  { sku: 'MRK008-TCT', rows: on(157) },
  { sku: 'MRK010-TCT', rows: null },          // no inventory record in Mintsoft, ever
  { sku: 'MRK011-TCT', rows: on(250) },
  { sku: 'MRK013-TCT', rows: on(76, 100) },   // 76 free, 100 more held but spoken for
]

describe('what the catalogue offers, approval accepts', () => {
  it('reproduces the Tea cups bug and shows it fixed', () => {
    const { catalogue, approve } = bothSides(TEA_CUPS)

    // The screen the GM saw, to the number.
    expect(catalogue.available).toBe(577)
    expect(catalogue.linesUnknown).toBe(1)
    expect(catalogue.basis).toBe(
      'At least 577 free to order, from 7 of the 8 Mintsoft lines for this product. '
      + 'The other line has no stock record, so there may be more.',
    )

    // M20 asked for 30 on 2026-10-12 and the approval was blocked outright.
    expect(approve(30).kind).toBe('allocated')
  })

  it('accepts every quantity up to the floor, including the floor itself', () => {
    const { catalogue, approve } = bothSides(TEA_CUPS)
    const floor = catalogue.available!
    for (const qty of [1, 2, 30, 100, 400, floor - 1, floor]) {
      const a = approve(qty)
      expect(a.kind, `the screen offers ${floor} but approving ${qty} was refused`).toBe('allocated')
      // And what it allocates actually adds up to what was approved.
      expect(a.kind === 'allocated' && a.parts.reduce((n, p) => n + p.qty, 0)).toBe(qty)
    }
  })

  it('allocates only against lines with a figure, never the absent one', () => {
    const { approve } = bothSides(TEA_CUPS)
    const a = approve(500)
    expect(a.kind).toBe('allocated')
    const used = a.kind === 'allocated' ? a.parts.map((p) => p.sku) : []
    expect(used).not.toContain('MRK010-TCT')
  })

  it('refuses above the floor, and says so without claiming a shortage', () => {
    const { catalogue, approve } = bothSides(TEA_CUPS)
    const a = approve(catalogue.available! + 1)
    expect(a.kind).toBe('short')
    const message = a.kind === 'short' ? a.message : ''
    // There may well be 578 on the shelf. We cannot see it, so we do not assert either way.
    expect(message).toMatch(/only 577 can be accounted for/)
    expect(message).toMatch(/Approve 577 or fewer/)
    expect(message).not.toMatch(/try again/i)
  })

  it('holds for a product whose absent line is the primary one', () => {
    // SAKURA TREES PLANTERS, live: 2 mapped lines, the primary absent from the feed.
    const { catalogue, approve } = bothSides([
      { sku: 'MRK002-STS-30', rows: null, primary: true },
      { sku: 'MRK002-STS', rows: on(2) },
    ])
    expect(catalogue.available).toBe(2)
    expect(approve(2).kind).toBe('allocated')
  })

  it('holds for a product whose readable lines hold nothing', () => {
    // Round Table Base, live: 7 mapped lines, one absent, the rest reading zero. The
    // floor is 0, so the catalogue offers nothing and approval must refuse anything --
    // but zeroing the line has to let the rest of the order through.
    const { catalogue, approve } = bothSides([
      { sku: 'MRK008-RTR', rows: null },
      { sku: 'MRK001-RTR', rows: on(0), primary: true },
      { sku: 'MRK002-RTR', rows: on(0) },
    ])
    expect(catalogue.available).toBe(0)
    expect(approve(1).kind).toBe('short')
    expect(approve(0)).toEqual({ kind: 'allocated', productId: 1, parts: [] })
  })

  it('refuses everything when no line can be read, which is the one case with no floor', () => {
    const { catalogue, approve } = bothSides([
      { sku: 'A', rows: null, primary: true },
      { sku: 'B', rows: null },
    ])
    expect(catalogue.available).toBeNull()
    expect(approve(1).kind).toBe('short')
    expect(approve(1).kind === 'short' && (approve(1) as { message: string }).message)
      .toMatch(/no stock figure for any of the 2 warehouse lines/)
  })

  it('holds when every line is readable, which is most products', () => {
    const { catalogue, approve } = bothSides([
      { sku: 'A', rows: on(40), primary: true },
      { sku: 'B', rows: on(2) },
    ])
    expect(catalogue.available).toBe(42)
    expect(catalogue.linesUnknown).toBe(0)
    expect(approve(42).kind).toBe('allocated')
    expect(approve(43).kind).toBe('short')
    // With nothing unreadable, a shortfall IS a shortfall and may be stated as one.
    expect(approve(43).kind === 'short' && (approve(43) as { message: string }).message)
      .toMatch(/only 42 in stock — 1 short/)
  })

  it('never offers more than it will accept, across a sweep of shapes', () => {
    // The invariant on its own, over every combination of a few holdings and an absent
    // line. This is the property that was broken; a counterexample here is the bug back.
    const holdings = [[], [0], [5], [0, 5], [5, 7], [0, 0], [5, 0, 7]]
    for (const hs of holdings) {
      for (const absent of [0, 1, 2]) {
        const lines: Line[] = [
          ...hs.map((h, i) => ({ sku: `R${i}`, rows: on(h), primary: i === 0 })),
          ...Array.from({ length: absent }, (_, i) => ({ sku: `X${i}`, rows: null })),
        ]
        if (lines.length === 0) continue
        const { catalogue, approve } = bothSides(lines)
        const offered = catalogue.available
        if (offered === null || offered === 0) continue
        const a = approve(offered)
        expect(
          a.kind,
          `offered ${offered} for holdings [${hs}] with ${absent} absent, but approval refused it`,
        ).toBe('allocated')
      }
    }
  })
})

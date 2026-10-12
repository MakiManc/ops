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
 *
 * The mapping tool then became a THIRD and FOURTH statement of the same rule --
 * stockWarning and productsWithUnreadableLines -- and promptly disagreed with the other
 * two: it counted a line as readable because a stock ROW existed rather than because the
 * row gave a figure, so a product the approval guard refuses outright was described on the
 * mapping screen as merely having empty shelves. Those two are now driven from the same
 * fixtures here, so a fifth statement cannot drift either.
 */
import { describe, expect, it } from 'vitest'
import { combineMappedLines, deriveAvailability, type StockRow } from '../src/server/sync/availability.ts'
import { allocateLine, type LineToApprove, type MappedSku } from '../src/server/orders/approval.ts'
import { productsWithUnreadableLines, stockWarning } from '../src/server/db/mapping.ts'
import type { Database } from '../src/server/db/repo.ts'
import { FakeD1 } from './helpers/d1.ts'

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

/**
 * The same lines, materialised into a real database, so the mapping tool's two statements
 * of the rule are exercised against the real queries rather than a model of them.
 */
async function mappingSides(lines: Line[]) {
  const fake = new FakeD1()
  const db = fake as unknown as Database
  fake.exec(`INSERT INTO products (id, name, stock_type) VALUES (1, 'Tea cups', 'internal')`)
  lines.forEach((l, i) => {
    const id = 1000 + i
    fake.exec(`INSERT INTO mintsoft_products (mintsoft_product_id, sku, name, synced_at)
               VALUES (${id}, '${l.sku}', '${l.sku}', '2026-10-12T10:00:00Z')`)
    fake.exec(`INSERT INTO product_mintsoft_map (product_id, mintsoft_product_id, sku, is_primary)
               VALUES (1, ${id}, '${l.sku}', ${l.primary === true ? 1 : 0})`)
    // rows === null is the line Mintsoft has no inventory record for at all.
    ;(l.rows ?? []).forEach((row, j) => {
      const a = deriveAvailability([row], 'on_hand').available
      fake.exec(`INSERT INTO stock_cache (mintsoft_product_id, warehouse_id, location_id,
                                          on_hand, allocated, available, available_basis, synced_at)
                 VALUES (${id}, 1, ${j + 1}, ${row.onHand ?? 'NULL'}, ${row.allocated ?? 'NULL'},
                         ${a ?? 'NULL'}, 'contract', '2026-10-12T10:00:00Z')`)
    })
  })
  const gaps = await productsWithUnreadableLines(db)
  const warning = stockWarning(lines.map((l, i) => ({
    mintsoftProductId: 1000 + i,
    sku: l.sku,
    hasStockRecord: l.rows !== null && l.rows.length > 0,
    available: l.rows === null ? null : deriveAvailability(l.rows, 'on_hand').available,
  })))
  return { gaps, warning }
}

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

describe('the mapping tool agrees with both of them', () => {
  /** Every shape, driven through all four statements of the rule at once. */
  const SHAPES: { name: string; lines: Line[] }[] = [
    { name: 'Tea cups: one line absent, the rest hold 577', lines: TEA_CUPS },
    {
      name: 'the absent line is the primary',
      lines: [{ sku: 'STS-30', rows: null, primary: true }, { sku: 'STS', rows: on(2) }],
    },
    {
      name: 'readable lines hold nothing',
      lines: [{ sku: 'RTR', rows: null }, { sku: 'A', rows: on(0), primary: true }],
    },
    {
      name: 'a row that exists but gives no figure',
      lines: [{ sku: 'NULLROW', rows: [{ onHand: null, allocated: null }], primary: true }, { sku: 'OK', rows: on(40) }],
    },
    {
      name: 'every line unreadable, one absent and one empty-rowed',
      lines: [{ sku: 'ABSENT', rows: null, primary: true }, { sku: 'NULLROW', rows: [{ onHand: null, allocated: null }] }],
    },
    {
      name: 'nothing unreadable at all',
      lines: [{ sku: 'A', rows: on(40), primary: true }, { sku: 'B', rows: on(2) }],
    },
  ]

  for (const shape of SHAPES) {
    it(`holds for ${shape.name}`, async () => {
      const { catalogue, approve } = bothSides(shape.lines)
      const { gaps, warning } = await mappingSides(shape.lines)
      const floor = catalogue.available

      const noFigure = floor === null

      // A product with nothing unreadable is not listed at all, so there is no panel
      // figure to compare -- assertion 3 below is what pins that case.
      if (gaps.length > 0) {
        // 1. The mapping panel's floor is the catalogue's floor. This is the one that
        //    broke: the panel summed across rows carrying no figure and counted a line
        //    readable because a row existed, so it could print a number above the
        //    catalogue's -- a confident overstatement on the one screen meant to diagnose
        //    exactly this.
        expect(gaps[0]!.readableFloor).toBe(floor ?? 0)

        // 2. "No readable line" on the panel means exactly "no figure" to the approval
        //    guard. These were the two that disagreed: empty shelves and no figure at all
        //    have different causes and different remedies.
        expect(gaps[0]!.readableLines.length === 0).toBe(noFigure)
      }

      // 3. The panel lists a product iff something about it is unreadable, which is iff
      //    the catalogue is reporting a floor rather than a total.
      expect(gaps.length > 0).toBe(catalogue.linesUnknown > 0)

      // 4. The warning speaks iff there is something to warn about, and claims nothing
      //    cannot-be-ordered unless that is true.
      expect(warning !== null).toBe(catalogue.linesUnknown > 0)
      if (warning !== null) {
        expect(/orders for it will be refused/.test(warning)).toBe(noFigure)
      }

      // 5. And the original invariant still holds underneath all of it.
      if (floor !== null && floor > 0) expect(approve(floor).kind).toBe('allocated')
    })
  }
})

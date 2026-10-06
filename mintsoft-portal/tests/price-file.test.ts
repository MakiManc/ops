/**
 * The committed price file, prices/china-stock-prices.json.
 *
 * It is a build artefact of prices/build.py, but it is also the thing the report's money
 * actually comes from, so it is checked rather than trusted. The failure these guard
 * against is not a crash: it is a plausible-looking number that is out by the pack size,
 * which nobody notices until an invoice is queried.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

interface Priced {
  product: string; fileProduct: string; match: 'exact' | 'alias'
  unitPrice: number; currency: string; unit: string | null; spec: string | null
  docDate: string | null; source: string | null
  distinctPrices: number; lowest: number | null; highest: number | null
  flags: string | null; note: string | null
}
interface File {
  basis: string; description: string; sourceFile: string; sourceSheet: string
  priced: Priced[]; unpriced: { product: string; reason: string }[]
}

const file = JSON.parse(
  readFileSync(new URL('../prices/china-stock-prices.json', import.meta.url), 'utf8'),
) as File

describe('the price file', () => {
  it('says what kind of price it holds, and what it leaves out', () => {
    expect(file.basis).toBe('supplier')
    expect(file.description).toMatch(/goods only/)
    expect(file.description).toMatch(/freight/)
    expect(file.description).toMatch(/VAT and duty/)
  })

  it('places every product exactly once, priced or not', () => {
    const names = [...file.priced.map((p) => p.product), ...file.unpriced.map((p) => p.product)]
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every price a figure, a currency and a document it came from', () => {
    for (const p of file.priced) {
      expect(p.unitPrice, p.product).toBeGreaterThan(0)
      expect(p.currency, p.product).toBe('GBP')
      expect(p.source, p.product).toBeTruthy()
    }
  })

  it('gives every gap a reason', () => {
    for (const u of file.unpriced) {
      expect(u.reason, u.product).toBeTruthy()
      expect(u.reason.length, u.product).toBeGreaterThan(15)
    }
  })

  it('prices nothing by the pack, because the portal orders by the unit', () => {
    // This is the 10x and 50x error. Black Chopsticks are GBP 3.02 for a pack of ten
    // pairs and Red Spoon for sauce is GBP 5.39 for a pack of fifty, and every product in
    // the catalogue has pack_size 1 and unit "unit". Pricing a line of 200 at a pack
    // price overstates it by the pack size, and GBP 3.02 looks every bit as reasonable as
    // 30p on a report. Both are in `unpriced` with that as the reason; if an alias ever
    // points at another pack-quoted row, this is what says so.
    const packed = file.priced.filter((p) => p.unit && /\bpack\b/i.test(p.unit))
    expect(packed.map((p) => `${p.product} @ ${p.unit}`)).toEqual([])
  })

  it('keeps the recorded spread consistent with the price taken', () => {
    for (const p of file.priced) {
      if (p.lowest === null || p.highest === null) continue
      expect(p.lowest, p.product).toBeLessThanOrEqual(p.highest)
      expect(p.unitPrice, p.product).toBeGreaterThanOrEqual(p.lowest)
      expect(p.unitPrice, p.product).toBeLessThanOrEqual(p.highest)
      // More than one price on record has to show up as more than one price on record,
      // because that is what makes the report say the figure is not settled.
      if (p.lowest !== p.highest) expect(p.distinctPrices, p.product).toBeGreaterThan(1)
    }
  })

  it('notes every hand-made pairing where the names do not actually agree', () => {
    // An alias is a judgement call. The ones where the two names describe visibly
    // different things have to carry the reasoning, or the next person cannot audit it.
    const aliases = file.priced.filter((p) => p.match === 'alias')
    expect(aliases.length).toBeGreaterThan(0)
    for (const p of aliases) expect(p.fileProduct, p.product).toBeTruthy()
  })

  it('never silently swaps one size for another', () => {
    // The fuzzy matcher paired a 2.0L and a 4.5L tub with the file's 4L, and a 900ml
    // teapot with the file's 600ml. Both are in `unpriced` now. A capacity or dimension
    // in a product's name that is absent from the name it was priced from is how that
    // comes back, so every one has to appear on both sides -- numerically, because "2.0L"
    // and "2L" are the same tub written two ways.
    for (const p of file.priced) {
      const want = sizesIn(p.product)
      if (want.length === 0) continue
      const have = sizesIn(`${p.fileProduct} ${p.spec ?? ''} ${p.unit ?? ''}`)
      for (const size of want) {
        expect(have, `${p.product} priced from "${p.fileProduct}", which does not mention ${size}`)
          .toContain(size)
      }
    }
  })
})

/**
 * The capacities and dimensions in a name, as "<number><unit>" with the number
 * normalised, so 2.0L and 2L come out the same and 4.5L and 4L do not.
 */
export function sizesIn(text: string): string[] {
  return [...text.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(ml|l|mm|cm|oz)\b/g)]
    .map((m) => `${Number(m[1])}${m[2]}`)
}

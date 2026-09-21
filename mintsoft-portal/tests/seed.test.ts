import { describe, expect, it } from 'vitest'
import { CsvError, parseCsv } from '../src/lib/csv.ts'
import { buildSeedSql } from '../src/lib/seed-sql.ts'
import { FakeD1 } from './helpers/d1.ts'

/**
 * The seed files decide who can sign in and which sites they can order for, and they
 * are filled in by hand in a spreadsheet. So the validation is tested on the mistakes
 * a spreadsheet actually produces, and the generated SQL is applied to a real database
 * rather than string-matched.
 */

const SITE_HEADER = 'code,name,type,cluster,address_1,address_2,address_3,town,county,postcode,contact_name,contact_phone,delivery_notes,recharge,min_days_between_orders,active'
const USER_HEADER = 'email,name,role,sites,active'

const site = (over: Partial<Record<string, string>> = {}) => {
  const f = { code: 'M9', name: 'Leith Walk', type: 'restaurant', cluster: '', address_1: '1 St',
    address_2: '', address_3: '', town: 'Edinburgh', county: '', postcode: 'EH6 5AA',
    contact_name: '', contact_phone: '', delivery_notes: '', recharge: 'no',
    min_days_between_orders: '', active: 'yes', ...over }
  return `${SITE_HEADER}\n${[f.code, f.name, f.type, f.cluster, f.address_1, f.address_2, f.address_3,
    f.town, f.county, f.postcode, f.contact_name, f.contact_phone, f.delivery_notes,
    f.recharge, f.min_days_between_orders, f.active].join(',')}`
}
const user = (over: Partial<Record<string, string>> = {}) => {
  const f = { email: 'gm.m9@example.com', name: 'GM', role: 'gm', sites: 'M9', active: 'yes', ...over }
  return `${USER_HEADER}\n${[f.email, f.name, f.role, f.sites, f.active].join(',')}`
}
const messages = (sites: string, users: string) =>
  buildSeedSql(sites, users).problems.map((p) => p.message)

describe('the happy path', () => {
  it('produces SQL that applies to the real schema', () => {
    const { statements, problems } = buildSeedSql(site(), user())
    expect(problems).toEqual([])
    const db = new FakeD1()
    expect(() => db.exec(statements.join('\n'))).not.toThrow()
    expect(db.sqlite.prepare(`SELECT code FROM sites`).get()).toEqual({ code: 'M9' })
  })

  it('is safe to run twice — a correction updates rather than duplicates', () => {
    const db = new FakeD1()
    db.exec(buildSeedSql(site(), user()).statements.join('\n'))
    db.exec(buildSeedSql(site({ name: 'Leith Walk (renamed)' }), user()).statements.join('\n'))
    const rows = db.sqlite.prepare(`SELECT code, name FROM sites`).all()
    expect(rows).toEqual([{ code: 'M9', name: 'Leith Walk (renamed)' }])
  })

  it('removes a GM site link when the site is taken out of their row', () => {
    const twoSites = `${site()}\nM19,Fountainbridge,restaurant,,2 Rd,,,Edinburgh,,EH3 9QG,,,,no,,yes`
    const db = new FakeD1()
    db.exec(buildSeedSql(twoSites, user({ sites: 'M9;M19' })).statements.join('\n'))
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM user_sites`).get()).toEqual({ n: 2 })

    // Taking M19 out of the CSV must actually revoke access, not just stop granting it.
    db.exec(buildSeedSql(twoSites, user({ sites: 'M9' })).statements.join('\n'))
    expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM user_sites`).get()).toEqual({ n: 1 })
  })

  it('accepts a GM covering several sites', () => {
    const twoSites = `${site()}\nM19,Fountainbridge,restaurant,,2 Rd,,,Edinburgh,,EH3 9QG,,,,no,,yes`
    expect(messages(twoSites, user({ sites: 'M9;M19' }))).toEqual([])
  })
})

describe('mistakes a spreadsheet actually produces', () => {
  it('catches a franchise that is not set to recharge', () => {
    expect(messages(site({ code: 'MAF1', type: 'franchise', recharge: 'no' }), user({ sites: 'MAF1' })))
      .toContainEqual(expect.stringContaining('franchise orders are always recharged'))
  })

  it('catches a corporate site marked as recharged', () => {
    // The costly direction: invoicing a site we own.
    expect(messages(site({ recharge: 'yes' }), user()))
      .toContainEqual(expect.stringContaining('corporate sites are never recharged'))
  })

  it('catches a GM pointed at a site that is not in sites.csv', () => {
    expect(messages(site(), user({ sites: 'M99' })))
      .toContainEqual(expect.stringContaining('site M99 is not in sites.csv'))
  })

  it('catches a GM with no sites, who would sign in to an empty portal', () => {
    expect(messages(site(), user({ sites: '' })))
      .toContainEqual(expect.stringContaining('would sign in and see nothing'))
  })

  it('catches sites given to someone who is not site-scoped', () => {
    expect(messages(site(), user({ email: 'ross@example.com', role: 'admin', sites: 'M9' })))
      .toContainEqual(expect.stringContaining('not site-scoped'))
  })

  it('catches a missing postcode', () => {
    expect(messages(site({ postcode: '' }), user()))
      .toContainEqual(expect.stringContaining('no postcode'))
  })

  it('catches a duplicated site code and points at the earlier line', () => {
    const dupe = `${site()}\nM9,Duplicate,restaurant,,1 St,,,Edinburgh,,EH6 5AA,,,,no,,yes`
    expect(messages(dupe, user())).toContainEqual(expect.stringContaining('already used on line 2'))
  })

  it('catches a duplicated email', () => {
    const dupe = `${user()}\ngm.m9@example.com,Again,gm,M9,yes`
    expect(messages(site(), dupe)).toContainEqual(expect.stringContaining('already appears on line 2'))
  })

  it('catches an invented role and an invented site type', () => {
    expect(messages(site(), user({ role: 'supervisor' })))
      .toContainEqual(expect.stringContaining('role must be one of'))
    expect(messages(site({ type: 'popup' }), user()))
      .toContainEqual(expect.stringContaining('type must be one of'))
  })

  it('catches a value that is not yes or no', () => {
    expect(messages(site({ active: 'maybe' }), user()))
      .toContainEqual(expect.stringContaining('active must be yes or no'))
  })

  it('catches a minimum gap that is not a whole number of days', () => {
    expect(messages(site({ min_days_between_orders: 'two weeks' }), user()))
      .toContainEqual(expect.stringContaining('whole number of days'))
  })

  it('catches something that is not an email address', () => {
    expect(messages(site(), user({ email: 'not-an-email' })))
      .toContainEqual(expect.stringContaining('does not look like an email'))
  })

  it('reports every problem at once rather than one per run', () => {
    // Someone filling in a spreadsheet should get the whole list, not a dozen rounds.
    const problems = buildSeedSql(site({ type: 'popup', postcode: '' }), user({ role: 'boss', sites: '' })).problems
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('the CSV itself', () => {
  it('keeps an address containing commas in one column', () => {
    const withComma = `${SITE_HEADER}\nM9,Leith Walk,restaurant,,"1 Example Street, Unit 2",,,Edinburgh,,EH6 5AA,,,"Before 11am, side door",no,,yes`
    const { statements, problems } = buildSeedSql(withComma, user())
    expect(problems).toEqual([])
    // A naive split would have shifted every later column by one and put half a street
    // in the town field — a site that seeds cleanly and delivers to the wrong place.
    expect(statements[0]).toContain("'1 Example Street, Unit 2'")
    expect(statements[0]).toContain("'Before 11am, side door'")
  })

  it('handles a doubled quote inside a quoted value', () => {
    const rows = parseCsv('a,b\n"say ""hello""",2', ['a', 'b'])
    expect(rows[0]!.values.a).toBe('say "hello"')
  })

  it('escapes an apostrophe rather than breaking the SQL', () => {
    const { statements } = buildSeedSql(site({ name: "Maki's Place" }), user())
    expect(statements[0]).toContain("'Maki''s Place'")
    expect(() => new FakeD1().exec(statements.join('\n'))).not.toThrow()
  })

  it('refuses a file whose header is missing a column', () => {
    expect(() => buildSeedSql('code,name\nM9,Leith', user())).toThrow(CsvError)
    expect(() => buildSeedSql('code,name\nM9,Leith', user())).toThrow(/missing column/)
  })

  it('refuses a row with the wrong number of columns, and says why', () => {
    const short = `${SITE_HEADER}\nM9,Leith Walk,restaurant`
    expect(() => buildSeedSql(short, user())).toThrow(/wrap it in double quotes/)
  })

  it('refuses a file that ends inside a quoted value', () => {
    expect(() => parseCsv('a,b\n"unclosed,2', ['a', 'b'])).toThrow(/unclosed/)
  })

  it('ignores a trailing newline rather than reading it as a blank row', () => {
    expect(buildSeedSql(`${site()}\n`, `${user()}\n`).problems).toEqual([])
  })
})

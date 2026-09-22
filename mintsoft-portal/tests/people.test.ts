/**
 * Sites and people — the screen that decides who can sign in.
 *
 * The rules here mirror src/lib/seed-sql.ts on purpose. If the two drifted, this screen
 * could create a row the CSV path rejects, and the next re-seed would fail on data the
 * portal itself wrote.
 *
 * The lock-out tests are the ones that matter. Role comes from this table and Google is
 * the only way in, so an empty admin role is unrecoverable from inside the product.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeD1, seedRoles } from './helpers/d1.ts'
import {
  PeopleError, createPerson, createSite, listPeople, listSites, rechargeFor, updatePerson,
  updateSite, validateSite, validateUser,
} from '../src/server/db/people.ts'
import type { Database } from '../src/server/db/repo.ts'

let raw: FakeD1
let db: Database

beforeEach(() => {
  raw = new FakeD1()
  seedRoles(raw)
  db = raw as unknown as Database
})

const site = (over = {}) => ({
  code: 'M21', name: 'Leeds', type: 'restaurant', postcode: 'LS1 1AA', ...over,
})
const person = (over = {}) => ({
  email: 'new.gm@example.com', name: 'New GM', role: 'gm', ...over,
})

describe('site rules, matching the seed path', () => {
  it('requires a code, a name, a known type and a postcode', () => {
    expect(() => validateSite(site({ code: '  ' }))).toThrow(/code is required/)
    expect(() => validateSite(site({ name: '' }))).toThrow(/name is required/)
    expect(() => validateSite(site({ type: 'popup' }))).toThrow(/restaurant, factory, franchise/)
    // An order with nowhere to go is worse than no site at all.
    expect(() => validateSite(site({ postcode: '' }))).toThrow(/cannot be delivered/)
  })

  it('derives recharge from type rather than trusting the caller', async () => {
    expect(rechargeFor('franchise')).toBe(true)
    expect(rechargeFor('restaurant')).toBe(false)
    expect(rechargeFor('factory')).toBe(false)

    // Even when a caller insists otherwise: the seed path treats the mismatch as an
    // error in both directions, so there is no honest way to set it independently.
    await createSite(db, site({ code: 'MAF9', type: 'franchise', recharge: false } as never))
    const rows = await listSites(db)
    expect(rows.find((r) => r.code === 'MAF9')!.recharge).toBe(true)
  })

  it('refuses a duplicate code, on create and on rename', async () => {
    await createSite(db, site())
    await expect(createSite(db, site({ name: 'Another' }))).rejects.toThrow(/already in use/)

    const m21 = (await listSites(db)).find((s) => s.code === 'M21')!
    await expect(updateSite(db, m21.id, site({ code: 'M9' }))).rejects.toThrow(/already in use/)
    // Keeping its own code is not a clash with itself.
    await expect(updateSite(db, m21.id, site({ name: 'Leeds Central' }))).resolves.toBeUndefined()
  })

  it('uppercases the code, so M21 and m21 cannot both exist', async () => {
    await createSite(db, site({ code: 'm21' }))
    expect((await listSites(db)).some((s) => s.code === 'M21')).toBe(true)
    await expect(createSite(db, site({ code: 'M21' }))).rejects.toThrow(/already in use/)
  })

  it('rejects a fractional or negative ordering gap', () => {
    expect(() => validateSite(site({ minDaysBetweenOrders: 2.5 }))).toThrow(/whole number/)
    expect(() => validateSite(site({ minDaysBetweenOrders: -1 }))).toThrow(/whole number/)
    expect(() => validateSite(site({ minDaysBetweenOrders: 0 }))).not.toThrow()
  })
})

describe('people rules', () => {
  it('requires an email that looks like one, a name and a known role', () => {
    expect(() => validateUser(person({ email: 'not-an-email' }))).toThrow(/does not look like/)
    expect(() => validateUser(person({ name: '' }))).toThrow(/name is required/)
    expect(() => validateUser(person({ role: 'owner' }))).toThrow(/gm, approver, admin/)
  })

  it('lowercases the email, because the table CHECK would otherwise just fail', async () => {
    await createPerson(db, person({ email: 'Mixed.Case@Example.COM' }))
    expect((await listPeople(db)).some((p) => p.email === 'mixed.case@example.com')).toBe(true)
  })

  it('refuses a second account for the same address, whatever its case', async () => {
    await createPerson(db, person())
    await expect(createPerson(db, person({ email: 'NEW.GM@example.com' })))
      .rejects.toThrow(/already has an account/)
  })

  it('links a GM to their sites, and replaces the set on update', async () => {
    const id = await createPerson(db, person({ siteIds: [1, 2] }))
    expect((await listPeople(db)).find((p) => p.id === id)!.siteIds.sort()).toEqual([1, 2])

    await updatePerson(db, id, person({ siteIds: [3] }))
    expect((await listPeople(db)).find((p) => p.id === id)!.siteIds).toEqual([3])
  })

  it('refuses a site that does not exist rather than silently dropping it', async () => {
    await expect(createPerson(db, person({ siteIds: [999] }))).rejects.toThrow(/No site with id 999/)
  })

  it('keeps site links when a GM is promoted, for when they are demoted again', async () => {
    const id = await createPerson(db, person({ siteIds: [1] }))
    await updatePerson(db, id, person({ role: 'approver' }))
    expect((await listPeople(db)).find((p) => p.id === id)!.siteIds).toEqual([1])
  })
})

describe('the last administrator', () => {
  // Seeded: user 3 is the only admin.
  const ADMIN = 3

  it('cannot deactivate themselves out of the portal', async () => {
    await expect(updatePerson(db, ADMIN, {
      email: 'admin@example.com', name: 'Ross', role: 'admin', active: false,
    })).rejects.toThrow(/only administrator left/)
  })

  it('cannot demote themselves either', async () => {
    await expect(updatePerson(db, ADMIN, {
      email: 'admin@example.com', name: 'Ross', role: 'approver', active: true,
    })).rejects.toThrow(/only administrator left/)
  })

  it('says what to do about it, rather than just refusing', async () => {
    try {
      await updatePerson(db, ADMIN, { email: 'admin@example.com', name: 'Ross', role: 'gm' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as PeopleError).message).toMatch(/Making someone else an administrator first/)
      expect((err as PeopleError).field).toBe('role')
    }
  })

  it('allows the demotion once a second administrator exists', async () => {
    await createPerson(db, person({ email: 'second.admin@example.com', role: 'admin' }))
    await expect(updatePerson(db, ADMIN, {
      email: 'admin@example.com', name: 'Ross', role: 'approver',
    })).resolves.toBeUndefined()
  })

  it('does not count a deactivated administrator as cover', async () => {
    const other = await createPerson(db, person({ email: 'dormant@example.com', role: 'admin' }))
    await updatePerson(db, other, person({ email: 'dormant@example.com', role: 'admin', active: false }))
    await expect(updatePerson(db, ADMIN, {
      email: 'admin@example.com', name: 'Ross', role: 'gm',
    })).rejects.toThrow(/only administrator left/)
  })

  it('leaves other people freely editable', async () => {
    await expect(updatePerson(db, 1, {
      email: 'gm.m9@example.com', name: 'GM at M9', role: 'gm', active: false,
    })).resolves.toBeUndefined()
  })
})

describe('the listings', () => {
  it('puts active rows first and counts the people on each site', async () => {
    await createPerson(db, person({ siteIds: [1] }))
    const sites = await listSites(db)
    expect(sites[0]!.active).toBe(true)
    // GM 1 and the deactivated user 5 are both linked to site 1; only the active counts,
    // plus the GM just created.
    expect(sites.find((s) => s.id === 1)!.gmCount).toBe(2)
  })
})

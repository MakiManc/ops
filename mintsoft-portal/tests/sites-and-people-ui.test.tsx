/**
 * @vitest-environment jsdom
 *
 * What the people screen says about sign-in.
 *
 * Twenty-two GMs were set up and not one of them could sign in, because the Google
 * consent screen let in only the makiramen.com Workspace and every site login is a
 * gmail account. Google refuses those on its own page, so nothing reaches the portal
 * and there is nothing in the logs to find. The evidence was sitting in the database
 * the whole time -- every GM with last_seen_at null -- and this screen already fetched
 * it and then said nothing.
 *
 * So it says it now. Not as a diagnosis, because "nobody has signed in yet" is also
 * what a brand new portal looks like, but as the prompt to go and check.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SitesAndPeople } from '../src/client/SitesAndPeople.tsx'

const SITES = [{
  id: 1, code: 'M17', name: 'Maki Lakeside Ltd', type: 'restaurant', cluster: null,
  address1: null, address2: null, address3: null, town: null, county: null, postcode: null,
  contactName: null, contactPhone: null, deliveryNotes: null, minDaysBetweenOrders: null,
  recharge: false, active: true, gmCount: 1,
}]

const person = (over: Record<string, unknown>) => ({
  id: 1, email: 'someone@example.com', name: 'Someone', role: 'gm',
  active: true, lastSeenAt: null, siteIds: [1], ...over,
})

/** A fresh Response per call: the screen fetches on mount and again after a save, and a
 *  shared one is already consumed the second time. */
const serve = (people: unknown[]) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ sites: SITES, people }), { headers: { 'Content-Type': 'application/json' } })))

beforeEach(() => vi.restoreAllMocks())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a person who has never signed in', () => {
  it('is marked, so the row is not indistinguishable from an active one', async () => {
    serve([person({ id: 1, name: 'Lakeside', lastSeenAt: null })])
    render(<SitesAndPeople />)
    await waitFor(() => expect(screen.getByText(/has never signed in/)).toBeDefined())
  })

  it('is not marked once they have', async () => {
    serve([person({ id: 1, lastSeenAt: '2026-09-24T09:38:50Z' })])
    render(<SitesAndPeople />)
    await waitFor(() => expect(screen.getByText(/General Manager/)).toBeDefined())
    expect(screen.queryByText(/has never signed in/)).toBeNull()
  })

  it('says nothing about someone already switched off, who is meant not to sign in', async () => {
    serve([person({ id: 1, active: false, lastSeenAt: null })])
    render(<SitesAndPeople />)
    await waitFor(() => expect(screen.getByText(/cannot sign in/)).toBeDefined())
    expect(screen.queryByText(/has never signed in/)).toBeNull()
  })
})

describe('when no GM has ever signed in', () => {
  it('raises it, because that is the shape of Google refusing all of them', async () => {
    serve([
      person({ id: 1, email: 'a@gmail.com', name: 'A', lastSeenAt: null }),
      person({ id: 2, email: 'b@gmail.com', name: 'B', lastSeenAt: null }),
    ])
    render(<SitesAndPeople />)
    await waitFor(() =>
      expect(screen.getByText(/No general manager has ever signed in/)).toBeDefined())
  })

  it('does not claim to know which it is', async () => {
    serve([person({ id: 1, lastSeenAt: null })])
    render(<SitesAndPeople />)
    await waitFor(() => expect(screen.getByText(/may mean nothing/)).toBeDefined())
  })

  it('stays quiet once one of them has, even though the others have not', async () => {
    serve([
      person({ id: 1, email: 'a@gmail.com', name: 'A', lastSeenAt: '2026-09-24T09:38:50Z' }),
      person({ id: 2, email: 'b@gmail.com', name: 'B', lastSeenAt: null }),
    ])
    render(<SitesAndPeople />)
    await waitFor(() => expect(screen.getByText(/has never signed in/)).toBeDefined())
    expect(screen.queryByText(/No general manager has ever signed in/)).toBeNull()
  })

  it('is not raised by an admin-only portal, where there are no GMs to refuse', async () => {
    serve([person({ id: 1, role: 'admin', email: 'ross@makiramen.com', name: 'Ross', lastSeenAt: null, siteIds: [] })])
    render(<SitesAndPeople />)
    await waitFor(() => expect(screen.getByText(/Administrator/)).toBeDefined())
    expect(screen.queryByText(/No general manager has ever signed in/)).toBeNull()
  })
})

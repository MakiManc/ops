/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/client/App.tsx'
import type { Me } from '../src/client/api.ts'

/**
 * Phase 1 is done when three test users each see only their role's screens. The API
 * tests prove the boundary; these prove the screens, which is the half a person can see.
 *
 * What the browser draws is a courtesy, not a control — the server refuses regardless.
 * But drawing an approver a button they cannot use, or hiding one they need, is its
 * own kind of broken.
 */

const me = (role: Me['user']['role'], sites: Me['sites'] = []): Me => ({
  user: { name: 'Test User', email: `${role}@example.com`, role },
  sites,
})

function signedInAs(body: Me) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/me')) return new Response(JSON.stringify(body), { status: 200 })
    return new Response('{}', { status: 200 })
  })
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('a GM', () => {
  it('sees ordering and their own orders, and nothing belonging to other roles', async () => {
    signedInAs(me('gm', [{ id: 1, code: 'M9', name: 'Leith Walk', type: 'restaurant', recharge: false }]))
    render(<App googleClientId="test" />)

    // "Stock list" rather than "Order stock": until Phase 3 there is nothing to order,
    // and a button promising otherwise is a small lie repeated on every visit.
    await waitFor(() => expect(screen.getByText('Stock list')).toBeDefined())
    expect(screen.getByText('My orders')).toBeDefined()
    expect(screen.queryByText('Approval queue')).toBeNull()
    expect(screen.queryByText('Recharge report')).toBeNull()
    expect(screen.queryByText('Sync health')).toBeNull()
  })

  it('shows the site they order for', async () => {
    signedInAs(me('gm', [{ id: 1, code: 'M9', name: 'Leith Walk', type: 'restaurant', recharge: false }]))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('M9')).toBeDefined())
    expect(screen.getByText('Your site')).toBeDefined()
  })

  it('marks a franchise site as recharged, since those GMs do see prices', async () => {
    signedInAs(me('gm', [{ id: 3, code: 'MAF1', name: 'Franchise One', type: 'franchise', recharge: true }]))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Recharged')).toBeDefined())
  })

  it('does not label a corporate site as recharged', async () => {
    signedInAs(me('gm', [{ id: 1, code: 'M9', name: 'Leith Walk', type: 'restaurant', recharge: false }]))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('M9')).toBeDefined())
    // Corporate sites are never recharged and must never be shown a price.
    expect(screen.queryByText('Recharged')).toBeNull()
  })

  it('says plainly when an account has no site, rather than showing an empty page', async () => {
    signedInAs(me('gm', []))
    render(<App googleClientId="test" />)
    // Otherwise this reads as a broken portal rather than as setup that is not finished.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not linked to a site/i))
  })
})

describe('an approver', () => {
  it('sees the queue and stock, not the GM or admin screens', async () => {
    signedInAs(me('approver'))
    render(<App googleClientId="test" />)

    await waitFor(() => expect(screen.getByText('Approval queue')).toBeDefined())
    expect(screen.getByText('Stock overview')).toBeDefined()
    expect(screen.queryByText('Stock list')).toBeNull()
    expect(screen.queryByText('Sites and people')).toBeNull()
  })
})

describe('an admin', () => {
  it('sees the admin screens', async () => {
    signedInAs(me('admin'))
    render(<App googleClientId="test" />)

    await waitFor(() => expect(screen.getByText('Sites and people')).toBeDefined())
    for (const title of ['Catalogue mapping', 'Recharge report', 'Sync health']) {
      expect(screen.getByText(title)).toBeDefined()
    }
  })

  it('is not shown the approval queue — the roles do not nest', async () => {
    signedInAs(me('admin'))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Sites and people')).toBeDefined())
    expect(screen.queryByText('Approval queue')).toBeNull()
  })
})

describe('signed out', () => {
  it('offers sign-in rather than an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_signed_in' }), { status: 401 }),
    )
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText(/Sign in with the Google account/i)).toBeDefined())
  })

  it('shows a recoverable message when the portal cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not be reached/i))
    expect(screen.getByText('Try again')).toBeDefined()
  })
})

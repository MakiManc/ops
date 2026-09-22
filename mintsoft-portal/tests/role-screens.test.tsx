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

    // Now that Phase 3 exists there really is something to order, so the button says so.
    await waitFor(() => expect(screen.getByText('Order stock')).toBeDefined())
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
  it('sees the queue and stock, and no admin screens', async () => {
    // 'Order stock' used to be asserted absent here. It is deliberately present now:
    // approvers order for any site. What stays out is the admin tooling.
    signedInAs(me('approver'))
    render(<App googleClientId="test" />)

    await waitFor(() => expect(screen.getByText('Approval queue')).toBeDefined())
    expect(screen.getByText('Stock overview')).toBeDefined()
    expect(screen.queryByText('Sites and people')).toBeNull()
  })

  it('gets no admin tools — the nesting does not work upward', async () => {
    // Merging and splitting products, par levels and the recharge report are the
    // administrator's alone. An approver signs orders off; they do not shape the
    // catalogue.
    signedInAs(me('approver'))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Approval queue')).toBeDefined())
    expect(screen.queryByText('Catalogue mapping')).toBeNull()
    expect(screen.queryByText('Par levels and limits')).toBeNull()
    expect(screen.queryByText('Recharge report')).toBeNull()
    expect(screen.queryByText('Sites and people')).toBeNull()
  })

  it('can order for any site, not just sign off', async () => {
    signedInAs(me('approver'))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Approval queue')).toBeDefined())
    expect(screen.getByText('Order stock')).toBeDefined()
    expect(screen.getByText('Current request')).toBeDefined()
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

  it('is shown the approval queue and the ordering screens too', async () => {
    // Changed deliberately: an administrator can do everything an approver can, so
    // that an order does not sit unapproved while the approver is away.
    signedInAs(me('admin'))
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Sites and people')).toBeDefined())
    expect(screen.getByText('Approval queue')).toBeDefined()
    expect(screen.getByText('Order stock')).toBeDefined()
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

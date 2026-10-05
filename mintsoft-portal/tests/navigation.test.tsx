/**
 * @vitest-environment jsdom
 *
 * Where you are lives in the URL.
 *
 * The open screen used to be component state only. On a phone that meant the
 * edge-swipe back gesture — the way people leave a screen without thinking — left the
 * portal entirely and landed on Google sign-in; a refresh dumped everyone on the menu;
 * and there was no link that opened a particular screen. The fragment fixes all three.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/client/App.tsx'
import type { Me } from '../src/client/api.ts'

const gm: Me = {
  user: { name: 'Test User', email: 'gm@example.com', role: 'gm' },
  sites: [{ id: 1, code: 'M9', name: 'Leith Walk', type: 'restaurant', recharge: false }],
}
const admin: Me = {
  user: { name: 'Ross', email: 'ross@example.com', role: 'admin' },
  sites: [
    { id: 1, code: 'M9', name: 'Leith Walk', type: 'restaurant', recharge: false },
    { id: 3, code: 'M3', name: 'Fountainbridge', type: 'restaurant', recharge: false },
  ],
}

function signedInAs(body: Me, extra: Record<string, unknown> = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/me')) return new Response(JSON.stringify(body), { status: 200 })
    for (const [suffix, payload] of Object.entries(extra)) {
      if (url.includes(suffix)) return new Response(JSON.stringify(payload), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
  window.sessionStorage.clear()
})
afterEach(() => cleanup())

describe('the screen and the URL', () => {
  it('opens the screen named in the hash, so a link and a refresh both work', async () => {
    window.history.replaceState(null, '', '/#orders')
    signedInAs(gm, { '/api/my-orders': { orders: [] } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My orders'))
    // Inside the wait, not after it. The heading is render output; the title is set in an
    // effect, which flushes after the render the heading first appears in — asserting it
    // once, synchronously, failed about one run in six.
    await waitFor(() => expect(document.title).toBe('My orders · Maki & Ramen Ordering'))
  })

  it('writes the hash when a screen opens', async () => {
    signedInAs(gm, { '/api/my-orders': { orders: [] } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('My orders')).toBeDefined())
    fireEvent.click(screen.getByText('My orders'))
    await waitFor(() => expect(window.location.hash).toBe('#orders'))
  })

  it('follows the browser back to the menu rather than leaving the portal', async () => {
    signedInAs(gm, { '/api/my-orders': { orders: [] } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('My orders')).toBeDefined())
    fireEvent.click(screen.getByText('My orders'))
    await waitFor(() => expect(window.location.hash).toBe('#orders'))

    // What the back gesture does: the hash goes, popstate fires, the menu returns.
    window.history.replaceState(null, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await waitFor(() => expect(screen.getByText('What you can do')).toBeDefined())
    // Same reason as above: the title is effect-set, so it is polled rather than asserted.
    await waitFor(() => expect(document.title).toBe('Maki & Ramen Ordering'))
  })

  it('ignores a hash that names no screen for this role', async () => {
    window.history.replaceState(null, '', '/#sync')
    signedInAs(gm)
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('What you can do')).toBeDefined())
  })

  it('keeps the chosen site in the URL, so it survives a refresh', async () => {
    window.history.replaceState(null, '', '/#catalogue/3')
    signedInAs(admin, {
      '/catalogue': { site: { id: 3, code: 'M3', name: 'Fountainbridge', recharge: false },
        freshness: { lastSuccessAt: null, minutesOld: null, stale: true }, products: [] },
      '/request': { request: null, lines: [], checks: [] },
    })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText(/Acting for/)).toBeDefined())
    expect(screen.getByText('M3')).toBeDefined()
  })
})

describe('the header', () => {
  it('holds Back on every screen and Sign out only on the menu', async () => {
    signedInAs(gm, { '/api/my-orders': { orders: [] } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Sign out')).toBeDefined())
    fireEvent.click(screen.getByText('My orders'))
    await waitFor(() => expect(screen.getByText('← Back')).toBeDefined())
    // Deep in a long screen the only persistent control used to be Sign out.
    expect(screen.queryByText('Sign out')).toBeNull()
    fireEvent.click(screen.getByText('← Back'))
    await waitFor(() => expect(screen.getByText('Sign out')).toBeDefined())
  })
})

describe('the menu', () => {
  it('says when a request is waiting to be sent', async () => {
    signedInAs(gm, {
      '/request': { request: { id: 1, orderNumber: 'MR-M9-1', status: 'draft' }, lines: [{}, {}, {}], checks: [] },
    })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('3 products waiting to be sent')).toBeDefined())
  })

  it('says nothing when the request has already gone', async () => {
    signedInAs(gm, {
      '/request': { request: { id: 1, orderNumber: 'MR-M9-1', status: 'submitted' }, lines: [{}, {}], checks: [] },
    })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Current request')).toBeDefined())
    expect(screen.queryByText(/waiting to be sent/)).toBeNull()
  })

  it('tells an approver how many requests are waiting', async () => {
    signedInAs({ ...admin, user: { ...admin.user, role: 'approver' } }, {
      '/approvals/queue': { requests: [{}, {}], settings: {} },
    })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('2 requests waiting')).toBeDefined())
  })

  it('groups the administrator\'s screens rather than listing eleven in a row', async () => {
    signedInAs(admin, { '/approvals/queue': { requests: [], settings: {} } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('Sites and people')).toBeDefined())
    for (const group of ['Approvals', 'Ordering', 'Catalogue', 'Setup']) {
      expect(screen.getByRole('heading', { name: group })).toBeDefined()
    }
    expect(screen.queryByText(/Not built yet/)).toBeNull()
  })
})

/**
 * The order page's own address.
 *
 * `#order/9` is the reason this is a page rather than a panel inside the list: it
 * survives a refresh, and Ross can send Francheska a link to the order they are talking
 * about instead of "open the portal and scroll".
 *
 * It needed its own slot in the fragment rather than reusing the one the ordering
 * screens keep a site id in. `go('orders')` carries the picked site forward, so an admin
 * acting for site 3 writes `#orders/3` — and reading that number as an order id would
 * have opened order 3.
 */
describe('one order at its own address', () => {
  const ORDER = {
    id: 9, orderNumber: 'MR-M19-20261002-001', mintsoftOrderNumber: 'MRK-2374',
    siteCode: 'M19', siteName: 'Maki M19', status: 'posted', requesterName: 'GM',
    requiredDate: null, notes: null, earlyOrderReason: null,
    submittedAt: null, approvedAt: null, despatchedAt: null, mergedIntoOrderNumber: null,
    mintsoftStatusId: 1, mintsoftStatusAt: null, trackingNumber: null, trackingUrl: null,
  }
  const LINES = [{ productId: 48, productName: 'Ramekin', qtyRequested: 60, qtyApproved: 60 }]

  it('opens from the link alone, so a refresh and a shared link both work', async () => {
    window.history.replaceState(null, '', '/#order/9')
    signedInAs(gm, { '/api/orders/9': { order: ORDER, lines: LINES } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('MRK-2374')).toBeDefined())
    expect(screen.getByText('Ramekin')).toBeDefined()
  })

  it('titles the page, so a backgrounded tab says what it holds', async () => {
    window.history.replaceState(null, '', '/#order/9')
    signedInAs(gm, { '/api/orders/9': { order: ORDER, lines: LINES } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(document.title).toBe('Order · Maki & Ramen Ordering'))
  })

  it('goes back to the list rather than all the way home', async () => {
    window.history.replaceState(null, '', '/#order/9')
    signedInAs(gm, { '/api/orders/9': { order: ORDER, lines: LINES }, '/api/my-orders': { orders: [] } })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText('MRK-2374')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '← Back' }))
    // Back to the orders list: sending someone home would cost two taps to see the next.
    await waitFor(() => expect(window.location.hash).toBe('#orders'))
  })

  it('says so when the fragment names no order', async () => {
    window.history.replaceState(null, '', '/#order')
    signedInAs(gm)
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText(/does not name an order/)).toBeDefined())
  })

  it('keeps an admin\'s picked site through a visit to an order', async () => {
    // The order fragment has no room for a site, so the site must survive in state --
    // otherwise going back lands a multi-site admin on the picker again.
    window.history.replaceState(null, '', '/#catalogue/3')
    signedInAs(admin, {
      '/api/orders/9': { order: ORDER, lines: LINES },
      '/api/sites/3/catalogue': { site: { id: 3, code: 'M3', name: 'Fountainbridge', recharge: false }, freshness: { lastSuccessAt: null, minutesOld: null, stale: false }, products: [] },
    })
    render(<App googleClientId="test" />)
    await waitFor(() => expect(screen.getByText(/Fountainbridge/)).toBeDefined())

    window.history.pushState(null, '', '/#order/9')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await waitFor(() => expect(screen.getByText('MRK-2374')).toBeDefined())

    window.history.pushState(null, '', '/#catalogue')
    window.dispatchEvent(new PopStateEvent('popstate'))
    // Still acting for M3, not back at "Which site are you ordering for?".
    await waitFor(() => expect(screen.queryByText(/Which site are you/)).toBeNull())
  })
})

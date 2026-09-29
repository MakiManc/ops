/**
 * @vitest-environment jsdom
 *
 * The zombie basket, and what replaced it.
 *
 * After sending, a GM who tapped back into "Current request" to check saw their lines,
 * editable quantity boxes and a live "Send for sign-off" button — none of which did
 * anything useful, and all of which said "it did not go". The server always sent the
 * request's status; the screen never read it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Basket } from '../src/client/Basket.tsx'

function serve(status: 'draft' | 'submitted', lines = 1) {
  const posts: { url: string; body: unknown }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(input), body: JSON.parse(String(init.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, orderNumber: 'MR-M9-20260929-001' }), { status: 200 })
    }
    return new Response(JSON.stringify({
      request: { id: 1, orderNumber: 'MR-M9-20260929-001', earlyOrderReason: null, status },
      lines: Array.from({ length: lines }, (_, i) => ({
        productId: 7 + i, productName: i === 0 ? 'Ramen Bowl' : 'Chopsticks', qtyRequested: 6,
        available: 250, rechargeUnitPrice: null,
      })),
      recharge: false, checks: [],
    }), { status: 200 })
  })
  return posts
}

beforeEach(() => { vi.restoreAllMocks(); window.sessionStorage.clear() })
afterEach(() => cleanup())

describe('a request that has already been sent', () => {
  it('is shown read-only, says who is looking at it, and cannot be sent again', async () => {
    serve('submitted', 2)
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText(/has been sent for sign-off/)).toBeDefined())
    expect(screen.getByText(/Ross or Francheska will look at it/)).toBeDefined()
    expect(screen.getByText('Ramen Bowl')).toBeDefined()
    expect(screen.getAllByText('× 6')).toHaveLength(2)
    // No stepper, no name field, no Send.
    expect(screen.queryByRole('button', { name: 'Send for sign-off' })).toBeNull()
    expect(screen.queryByLabelText(/Your name/)).toBeNull()
    expect(screen.queryByRole('button', { name: /One more/ })).toBeNull()
  })

  it('still offers the way back to the stock list', async () => {
    serve('submitted')
    const onGoToCatalogue = vi.fn()
    render(<Basket siteId={1} onSubmitted={() => {}} onGoToCatalogue={onGoToCatalogue} />)
    await waitFor(() => expect(screen.getByText(/has been sent/)).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Back to the stock list' }))
    expect(onGoToCatalogue).toHaveBeenCalled()
  })
})

describe('sending', () => {
  it('hands the order number back, so the next screen can confirm it', async () => {
    serve('draft')
    const onSubmitted = vi.fn()
    render(<Basket siteId={1} onSubmitted={onSubmitted} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Joe Herrera' } })
    const send = screen.getByRole('button', { name: 'Send for sign-off' }) as HTMLButtonElement
    await waitFor(() => expect(send.disabled).toBe(false))
    fireEvent.click(send)
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('MR-M9-20260929-001'))
  })

  it('remembers the typed name across a reload of the screen', async () => {
    serve('draft')
    const first = render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Joe Herrera' } })
    first.unmount()

    // A refresh mid-service used to lose this, and the "why this cannot wait" reason
    // with it, without a word of warning.
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
    expect((screen.getByLabelText(/Your name/) as HTMLInputElement).value).toBe('Joe Herrera')
  })
})

describe('changing a quantity', () => {
  it('uses the stepper and saves without waiting for blur', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const posts = serve('draft')
      render(<Basket siteId={1} onSubmitted={() => {}} />)
      await vi.waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
      fireEvent.click(screen.getByRole('button', { name: 'One more Ramen Bowl' }))
      // Testing Library's waitFor polls on its own clock, which fights the fake one --
      // it timed out at ~1000ms in roughly one run in five. vi.waitFor understands fake
      // timers, so it advances them instead of racing them.
      await vi.advanceTimersByTimeAsync(600)
      await vi.waitFor(() => expect(posts.some((p) => p.url.endsWith('/lines/7'))).toBe(true))
      expect(posts.find((p) => p.url.endsWith('/lines/7'))?.body).toEqual({ qty: 7 })
    } finally { vi.useRealTimers() }
  })

  it('does not treat an emptied box as a removal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const posts = serve('draft')
      render(<Basket siteId={1} onSubmitted={() => {}} />)
      await vi.waitFor(() => expect(screen.getByText('Ramen Bowl')).toBeDefined())
      fireEvent.change(screen.getByLabelText('Quantity of Ramen Bowl'), { target: { value: '' } })
      await vi.advanceTimersByTimeAsync(600)
      // Clearing the box used to save 0, which deleted the line the GM meant to edit.
      expect(posts.find((p) => p.url.endsWith('/lines/7'))?.body).not.toEqual({ qty: 0 })
    } finally { vi.useRealTimers() }
  })
})

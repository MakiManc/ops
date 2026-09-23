/**
 * @vitest-environment jsdom
 *
 * Why the Send button is off, whenever it is off.
 *
 * A browser walkthrough found it disabled with every check passing and nothing on
 * screen explaining it: the form needs the requester's name, three other fields are
 * marked "(optional)" and that one was marked nothing, and the only two messages both
 * required some other check to be failing already. A GM on a phone would have met a
 * dead button and no way to know what it wanted.
 *
 * So the rule these hold to is not "the name is required" — it is that the button is
 * never off without the screen saying why.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Basket } from '../src/client/Basket.tsx'

interface Check { code: string; severity: 'blocks' | 'needs_reason' | 'note'; message: string; productId?: number }

function serve(checks: Check[] = [], recharge = false) {
  const posts: unknown[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (String(input).includes('/submit')) return new Response('{}', { status: 200 })
    return new Response(JSON.stringify({
      request: { id: 1, orderNumber: 'MR-M13-20260101-001', earlyOrderReason: null },
      lines: [{
        productId: 7, productName: 'Sakura flower Pink', qtyRequested: 2,
        available: 250, rechargeUnitPrice: null,
      }],
      recharge, checks,
    }), { status: 200 })
  })
  return posts
}

const send = () => screen.getByRole('button', { name: 'Send for sign-off' }) as HTMLButtonElement
const ready = () => waitFor(() => expect(screen.getByText('Sakura flower Pink')).toBeDefined())

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('the button is never off in silence', () => {
  it('says the name is what it is waiting for', async () => {
    serve()
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()

    expect(send().disabled).toBe(true)
    // The exact failure found in the browser: nothing was rendered at all here.
    expect(screen.getByText('Put your name above, then you can send this.')).toBeDefined()
  })

  it('marks the field as needed, since the others are marked optional', async () => {
    serve()
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()
    expect(screen.getByText('(needed)')).toBeDefined()
    expect(screen.getByLabelText(/Your name/)).toHaveProperty('ariaRequired', 'true')
  })

  it('enables the button once the name is there', async () => {
    serve()
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()

    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Joe Herrera' } })
    await waitFor(() => expect(send().disabled).toBe(false))
    expect(screen.queryByText(/Put your name above/)).toBeNull()
  })

  it('names a blocking check ahead of the missing name, because that is the first fix', async () => {
    serve([{ code: 'over_available', severity: 'blocks', message: 'Only 0 available.', productId: 7 }])
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()

    expect(send().disabled).toBe(true)
    expect(screen.getByText('Fix the problems above before sending this.')).toBeDefined()
    expect(screen.queryByText(/Put your name above/)).toBeNull()
  })

  it('asks for the early-order reason once the name is in', async () => {
    serve([{ code: 'too_soon', severity: 'needs_reason', message: 'M13 ordered 3 days ago.' }])
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()

    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Joe Herrera' } })
    await waitFor(() =>
      expect(screen.getByText('Say why this cannot wait, then you can send this.')).toBeDefined())
    expect(send().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/Why this cannot wait/), { target: { value: 'Ran out' } })
    await waitFor(() => expect(send().disabled).toBe(false))
  })

  it('points the button at the reason, so it is not only a visual pairing', async () => {
    serve()
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()
    expect(send().getAttribute('aria-describedby')).toBe('cannot-send')
  })

  it('drops the hint entirely when there is nothing to say', async () => {
    serve()
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Joe Herrera' } })

    await waitFor(() => expect(send().disabled).toBe(false))
    expect(send().getAttribute('aria-describedby')).toBeNull()
  })

  it('sends the name it was given', async () => {
    const posts = serve()
    render(<Basket siteId={1} onSubmitted={() => {}} />)
    await ready()

    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Joe Herrera' } })
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(send())

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ requesterName: 'Joe Herrera' })
  })
})

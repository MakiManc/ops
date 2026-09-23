/**
 * @vitest-environment jsdom
 *
 * The Send button.
 *
 * It did not exist. The endpoint was built, guarded and tested; ApprovalQueue called
 * approve, reject and merge and nothing else; so an approved order could never actually
 * reach Mercium. Turning writes on would have changed nothing, because there was no
 * button to press. The same shape as the missing add-to-basket: an endpoint from one
 * phase, no screen ever wired to it, every test green because none asked whether a
 * person could do the thing.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalQueue } from '../src/client/ApprovalQueue.tsx'

const waiting = (over: Record<string, unknown> = {}) => ({
  id: 5, orderNumber: 'MR-M9-20260923-001', siteCode: 'M9', siteName: 'Leith Walk',
  status: 'approved', requesterName: 'Joe Herrera',
  approvedAt: new Date().toISOString(), postError: null, ...over,
})

/** Routes the queue, the awaiting-send list, and the send POST. */
function serve({ orders = [waiting()], sendStatus = 200, sendBody = {} as object } = {}) {
  const sends: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      sends.push(url)
      return new Response(JSON.stringify(sendBody), { status: sendStatus })
    }
    if (url.includes('awaiting-send')) return new Response(JSON.stringify({ orders }), { status: 200 })
    return new Response(JSON.stringify({
      requests: [], settings: { merciumOrderFee: 0, passOrderFeeToFranchise: false },
    }), { status: 200 })
  })
  return sends
}

const button = () => screen.getByRole('button', { name: 'Send to Mercium' })

beforeEach(() => vi.restoreAllMocks())
afterEach(() => cleanup())

describe('reaching Mercium at all', () => {
  it('offers a send for an order that has been signed off', async () => {
    serve()
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByText(/Signed off, not yet sent/)).toBeDefined())
    expect(button()).toBeDefined()
    expect(screen.getByText(/MR-M9-20260923-001/)).toBeDefined()
  })

  it('posts to the send endpoint for that order', async () => {
    const sends = serve({ sendBody: { message: 'Sent to Mercium as order 8811.' } })
    render(<ApprovalQueue />)
    await waitFor(() => expect(button()).toBeDefined())
    fireEvent.click(button())
    await waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0]).toContain('/api/approvals/5/send')
  })

  it('shows nothing to send when there is nothing', async () => {
    serve({ orders: [] })
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByText('Nothing waiting for sign-off.')).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Send to Mercium' })).toBeNull()
  })
})

describe('what it says afterwards', () => {
  it('reports success in the server\'s own words', async () => {
    serve({ sendStatus: 200, sendBody: { message: 'Sent to Mercium as order 8811.' } })
    render(<ApprovalQueue />)
    await waitFor(() => expect(button()).toBeDefined())
    fireEvent.click(button())
    await waitFor(() => expect(screen.getByText('Sent to Mercium as order 8811.')).toBeDefined())
  })

  it('does not make an uncertain outcome look like a failure', async () => {
    // 202. The order may exist at Mercium. Anything that reads like "failed" invites a
    // second press, and a second press is a second pallet.
    serve({
      sendStatus: 202,
      sendBody: { message: 'The request failed before we saw a reply. It may or may not have been created.' },
    })
    render(<ApprovalQueue />)
    await waitFor(() => expect(button()).toBeDefined())
    fireEvent.click(button())

    const note = await screen.findByRole('status')
    expect(note.className).toMatch(/amber/)
    expect(note.className).not.toMatch(/red/)
  })

  it('shows a refusal as a refusal', async () => {
    serve({ sendStatus: 409, sendBody: { message: 'MR-M9-20260923-001 has nothing to send.' } })
    render(<ApprovalQueue />)
    await waitFor(() => expect(button()).toBeDefined())
    fireEvent.click(button())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/nothing to send/)
  })

  it('shows the reason from an error-shaped response too, not just a status code', async () => {
    // The credential guard answers { error }, the send endpoint answers { message }.
    serve({ sendStatus: 503, sendBody: { error: 'Mintsoft credentials are not configured.' } })
    render(<ApprovalQueue />)
    await waitFor(() => expect(button()).toBeDefined())
    fireEvent.click(button())
    await waitFor(() =>
      expect(screen.getByText('Mintsoft credentials are not configured.')).toBeDefined())
  })

  it('surfaces why a previous attempt stopped, so it is not a mystery', async () => {
    serve({ orders: [waiting({ status: 'post_failed', postError: 'Only 0 Chairs available.' })] })
    render(<ApprovalQueue />)
    await waitFor(() => expect(screen.getByText(/Only 0 Chairs available/)).toBeDefined())
    // Still sendable: post_failed means nothing reached Mintsoft, so fixing the cause
    // and pressing again is the right move.
    expect(button()).toBeDefined()
  })

  it('tells the operator to reload rather than retry when contact is lost', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'POST') throw new Error('network down')
      if (String(input).includes('awaiting-send')) {
        return new Response(JSON.stringify({ orders: [waiting()] }), { status: 200 })
      }
      return new Response(JSON.stringify({
        requests: [], settings: { merciumOrderFee: 0, passOrderFeeToFranchise: false },
      }), { status: 200 })
    })
    render(<ApprovalQueue />)
    await waitFor(() => expect(button()).toBeDefined())
    fireEvent.click(button())
    await waitFor(() => expect(screen.getByText(/may already be with Mercium/)).toBeDefined())
  })
})

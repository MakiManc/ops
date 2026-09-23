/**
 * @vitest-environment jsdom
 *
 * The Google client id reaching the browser.
 *
 * It was baked in at build time from VITE_GOOGLE_CLIENT_ID with an empty-string default.
 * Every build I ran omitted it, so every deploy shipped a sign-in page whose Google
 * button carried no client id. Nothing failed at build, nothing failed at deploy, the
 * page looked right, and the only evidence was on Google's own error page: "Access
 * blocked: Missing required parameter: client_id". Francheska found it by trying to log
 * in. Served from the server now, and said out loud when it is missing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignIn } from '../src/client/SignIn.tsx'

beforeEach(() => {
  vi.restoreAllMocks()
  // The real Google script is absent in jsdom; this is the shape SignIn drives.
  ;(window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), cancel: vi.fn() } },
  }
})
afterEach(() => cleanup())

describe('when no client id reaches the browser', () => {
  it('says so, instead of rendering a button that fails on Google\'s page', async () => {
    render(<SignIn clientId="" onSignedIn={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText(/not configured for Google sign-in/)).toBeDefined())
  })

  it('makes clear it is not the person\'s account at fault', async () => {
    render(<SignIn clientId="" onSignedIn={() => {}} />)
    await waitFor(() =>
      expect(screen.getByText(/not a problem with your account/)).toBeDefined())
  })

  it('never initialises Google with an empty client id', async () => {
    const google = (window as unknown as {
      google: { accounts: { id: { initialize: ReturnType<typeof vi.fn> } } }
    }).google
    render(<SignIn clientId="" onSignedIn={() => {}} />)
    await waitFor(() => expect(screen.getByText(/not configured/)).toBeDefined())
    expect(google.accounts.id.initialize).not.toHaveBeenCalled()
  })

  it('initialises normally once there is one', async () => {
    const google = (window as unknown as {
      google: { accounts: { id: { initialize: ReturnType<typeof vi.fn> } } }
    }).google
    render(<SignIn clientId="751734252830-example.apps.googleusercontent.com" onSignedIn={() => {}} />)
    await waitFor(() => expect(google.accounts.id.initialize).toHaveBeenCalled())
    expect(google.accounts.id.initialize.mock.calls[0]?.[0]).toMatchObject({
      client_id: '751734252830-example.apps.googleusercontent.com',
    })
    expect(screen.queryByText(/not configured/)).toBeNull()
  })
})

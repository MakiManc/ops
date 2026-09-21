import { useEffect, useRef, useState } from 'react'
import { signInWithGoogle } from './api.ts'

/**
 * Google sign-in.
 *
 * Any Google account can press the button; only an email on the allow-list gets a
 * session. That is deliberate — site logins are often shared gmail accounts, so there
 * is no domain to filter on.
 *
 * When the server refuses, it does not say whether the account is unknown, switched
 * off, or the token was bad, so neither do we. The message below is written to be
 * useful to a GM in that situation rather than precise about which case it was.
 */
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: { client_id: string; callback: (r: { credential: string }) => void }): void
          renderButton(el: HTMLElement, options: Record<string, unknown>): void
        }
      }
    }
  }
}

export function SignIn({ clientId, onSignedIn }: { clientId: string; onSignedIn: () => void }) {
  const buttonRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false

    const render = () => {
      if (cancelled || !window.google || !buttonRef.current) return false
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          setBusy(true)
          setError(null)
          try {
            await signInWithGoogle(credential)
            onSignedIn()
          } catch {
            setError(
              'That account cannot sign in to the ordering portal. ' +
              'If you think it should, ask Ross to add it.',
            )
          } finally {
            if (!cancelled) setBusy(false)
          }
        },
      })
      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: 'outline', size: 'large', width: 280, text: 'signin_with',
      })
      return true
    }

    // The Google script loads async, so poll briefly rather than racing it.
    if (!render()) {
      const timer = setInterval(() => { if (render()) clearInterval(timer) }, 100)
      setTimeout(() => clearInterval(timer), 10_000)
      return () => { cancelled = true; clearInterval(timer) }
    }
    return () => { cancelled = true }
  }, [clientId, onSignedIn])

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center gap-8 p-6 bg-gray-50">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-gray-900">Maki &amp; Ramen Ordering</h1>
        <p className="mt-2 text-gray-700">Sign in with the Google account for your site.</p>
      </div>

      <div ref={buttonRef} aria-busy={busy} />

      {busy && <p className="text-gray-700">Signing you in…</p>}

      {error && (
        // role="alert" so a screen reader announces this rather than leaving it unread.
        <p role="alert" className="max-w-sm text-center text-red-800 bg-red-50 border border-red-300 rounded-lg p-4">
          {error}
        </p>
      )}
    </main>
  )
}

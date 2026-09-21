import { useCallback, useEffect, useState } from 'react'
import { getMe, NotSignedIn, signOut, type Me } from './api.ts'
import { SignIn } from './SignIn.tsx'

/**
 * Which screens a role gets.
 *
 * This is presentation only. The server enforces the same rules on every route, so
 * editing this in the browser changes what is drawn and nothing about what is allowed.
 * The roles deliberately do not nest: an admin is not shown the approval queue.
 */
const SCREENS: Record<Me['user']['role'], { key: string; title: string; blurb: string; phase: number }[]> = {
  gm: [
    { key: 'catalogue', title: 'Order stock', blurb: 'Browse what your site can order and build a request.', phase: 2 },
    { key: 'orders', title: 'My orders', blurb: 'Track what you have asked for and where it has got to.', phase: 4 },
  ],
  approver: [
    { key: 'queue', title: 'Approval queue', blurb: 'Requests waiting for sign-off, oldest first.', phase: 3 },
    { key: 'stock', title: 'Stock overview', blurb: 'What is on hand, allocated, inbound and how long it will last.', phase: 2 },
  ],
  admin: [
    { key: 'sites', title: 'Sites and people', blurb: 'Who can sign in, and which sites they order for.', phase: 4 },
    { key: 'mapping', title: 'Catalogue mapping', blurb: 'Merge duplicate Mintsoft lines into one product.', phase: 2 },
    { key: 'recharge', title: 'Recharge report', blurb: 'Monthly totals per franchise site, for Finance.', phase: 4 },
    { key: 'sync', title: 'Sync health', blurb: 'Last successful sync per job, and anything that failed.', phase: 4 },
  ],
}

const ROLE_LABEL: Record<Me['user']['role'], string> = {
  gm: 'General Manager', approver: 'Approver', admin: 'Administrator',
}

export function App({ googleClientId }: { googleClientId: string }) {
  const [me, setMe] = useState<Me | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'error'>('loading')

  const load = useCallback(async () => {
    setState('loading')
    try {
      setMe(await getMe())
      setState('ready')
    } catch (err) {
      if (err instanceof NotSignedIn) { setMe(null); setState('signed-out') }
      else setState('error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (state === 'loading') {
    return <p className="p-6 text-gray-700" role="status">Loading…</p>
  }

  if (state === 'error') {
    return (
      <main className="p-6">
        <p role="alert" className="text-red-800 bg-red-50 border border-red-300 rounded-lg p-4">
          The portal could not be reached. Try again in a moment.
        </p>
        <button onClick={() => void load()} className="mt-4 px-4 py-2 rounded-lg bg-gray-900 text-white">
          Try again
        </button>
      </main>
    )
  }

  if (state === 'signed-out' || !me) {
    return <SignIn clientId={googleClientId} onSignedIn={() => void load()} />
  }

  const screens = SCREENS[me.user.role]

  return (
    <div className="min-h-dvh bg-gray-50">
      <header className="bg-gray-900 text-white">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="font-semibold truncate">Maki &amp; Ramen Ordering</p>
            <p className="text-sm text-gray-300 truncate">
              {me.user.name} · {ROLE_LABEL[me.user.role]}
            </p>
          </div>
          <button
            onClick={async () => { await signOut(); void load() }}
            className="px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm whitespace-nowrap"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-4">
        {me.user.role === 'gm' && (
          <section aria-labelledby="your-sites" className="mb-6">
            <h2 id="your-sites" className="text-sm font-semibold uppercase tracking-wide text-gray-600">
              {me.sites.length === 1 ? 'Your site' : 'Your sites'}
            </h2>
            {me.sites.length === 0 ? (
              // An unlinked GM signs in fine and can reach nothing, which looks like a
              // broken portal. Say what it actually is.
              <p role="alert" className="mt-2 text-amber-900 bg-amber-50 border border-amber-300 rounded-lg p-4">
                Your account is not linked to a site yet, so there is nothing to order.
                Ask Ross to link it.
              </p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {me.sites.map((s) => (
                  <li key={s.id} className="px-3 py-2 rounded-lg bg-white border border-gray-300">
                    <span className="font-medium text-gray-900">{s.code}</span>
                    <span className="text-gray-700"> · {s.name}</span>
                    {s.recharge && (
                      // Franchise GMs see prices and a recharge total; corporate ones never do.
                      <span className="ml-2 text-xs font-semibold text-purple-900 bg-purple-100 px-2 py-1 rounded">
                        Recharged
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">What you can do</h2>
        <ul className="mt-2 grid gap-3">
          {screens.map((screen) => (
            <li key={screen.key}>
              <div className="w-full text-left bg-white border border-gray-300 rounded-xl p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-semibold text-gray-900">{screen.title}</h3>
                  <span className="text-xs text-gray-600 whitespace-nowrap">Phase {screen.phase}</span>
                </div>
                <p className="mt-1 text-gray-700">{screen.blurb}</p>
                <p className="mt-2 text-sm text-gray-600">Not built yet.</p>
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}

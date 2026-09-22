import { useCallback, useEffect, useState } from 'react'
import { getMe, NotSignedIn, signOut, type Me } from './api.ts'
import { ParLevels, RechargeReport, SyncHealth } from './AdminScreens.tsx'
import { ApprovalQueue } from './ApprovalQueue.tsx'
import { Basket } from './Basket.tsx'
import { Catalogue } from './Catalogue.tsx'
import { Mapping } from './Mapping.tsx'
import { MyOrders } from './MyOrders.tsx'
import { SignIn } from './SignIn.tsx'
import { StockOverview } from './StockOverview.tsx'

/**
 * Which screens a role gets.
 *
 * This is presentation only. The server enforces the same rules on every route, so
 * editing this in the browser changes what is drawn and nothing about what is allowed.
 * The roles deliberately do not nest: an admin is not shown the approval queue.
 */
interface Screen { key: string; title: string; blurb: string; phase: number; ready?: boolean }

const SCREENS: Record<Me['user']['role'], Screen[]> = {
  gm: [
    { key: 'catalogue', title: 'Order stock', blurb: 'Browse what your site can order and build a request.', phase: 2, ready: true },
    { key: 'basket', title: 'Current request', blurb: 'Check it over and send it for sign-off.', phase: 3, ready: true },
    { key: 'orders', title: 'My orders', blurb: 'Track what you have asked for and where it has got to.', phase: 3, ready: true },
  ],
  approver: [
    { key: 'queue', title: 'Approval queue', blurb: 'Requests waiting for sign-off, oldest first.', phase: 3, ready: true },
    { key: 'stock', title: 'Stock overview', blurb: 'What is on hand, allocated, inbound and how long it will last.', phase: 2, ready: true },
  ],
  // An administrator gets everything: the admin tools, plus the approver's queue and
  // the ordering screens. Ordering needs a site, and an admin is not site-scoped, so
  // the catalogue and basket screens ask which site they are acting for.
  admin: [
    { key: 'queue', title: 'Approval queue', blurb: 'Requests waiting for sign-off, oldest first.', phase: 3, ready: true },
    { key: 'catalogue', title: 'Order stock', blurb: 'Browse and build a request for any site.', phase: 2, ready: true },
    { key: 'basket', title: 'Current request', blurb: 'Check it over and send it for sign-off.', phase: 3, ready: true },
    { key: 'orders', title: 'All orders', blurb: 'Track what every site has asked for and where it has got to.', phase: 3, ready: true },
    { key: 'stock', title: 'Stock overview', blurb: 'What is on hand, allocated, inbound and how long it will last.', phase: 2, ready: true },
    { key: 'mapping', title: 'Catalogue mapping', blurb: 'Combine duplicate warehouse lines into one product.', phase: 2, ready: true },
    { key: 'par', title: 'Par levels and limits', blurb: 'Edit the grid of levels and caps as a spreadsheet.', phase: 4, ready: true },
    { key: 'recharge', title: 'Recharge report', blurb: 'Monthly totals per franchise site, for Finance.', phase: 4, ready: true },
    { key: 'sync', title: 'Sync health', blurb: 'Last successful sync per job, and anything that failed.', phase: 4, ready: true },
    { key: 'sites', title: 'Sites and people', blurb: 'Who can sign in, and which sites they order for.', phase: 5 },
  ],
}

const ROLE_LABEL: Record<Me['user']['role'], string> = {
  gm: 'General Manager', approver: 'Approver', admin: 'Administrator',
}

export function App({ googleClientId }: { googleClientId: string }) {
  const [me, setMe] = useState<Me | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'error'>('loading')
  /** Which screen is open. Null is the menu. Kept in state rather than the URL for now. */
  const [openScreen, setOpenScreen] = useState<string | null>(null)
  /**
   * Which site the ordering screens act for.
   *
   * Null until chosen, and only auto-filled when there is exactly one site to choose.
   * It used to take sites[0] unconditionally, which is silent and wrong for anyone
   * covering more than one: a GM across two sites always ordered for the first, and an
   * administrator — who can see all 22 — would have ordered for Aberdeen without being
   * told. Ordering for the wrong restaurant is not a mistake the screen should be able
   * to make quietly.
   */
  const [siteId, setSiteId] = useState<number | null>(null)

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
        <button onClick={() => void load()} className="mt-4 px-4 py-2 rounded-lg bg-everglade text-paper">
          Try again
        </button>
      </main>
    )
  }

  if (state === 'signed-out' || !me) {
    return <SignIn clientId={googleClientId} onSignedIn={() => void load()} />
  }

  const screens = SCREENS[me.user.role]
  const current = screens.find((s) => s.key === openScreen)

  /** The screens that exist so far. The rest are named but not yet built. */
  /** The site in play: the only one, or the one picked. */
  const activeSiteId = me.sites.length === 1 ? me.sites[0]!.id : siteId
  const activeSite = me.sites.find((s) => s.id === activeSiteId) ?? null

  /** Asks which site to act for, when the answer is not obvious. */
  const sitePicker = (verb: string) => (
    <div className="space-y-3">
      <label htmlFor="site-picker" className="block font-medium text-gray-900">
        Which site are you {verb} for?
      </label>
      <select
        id="site-picker"
        className="w-full min-h-[44px] rounded-lg border border-gray-400 px-3 py-2 bg-white"
        value={activeSiteId ?? ''}
        onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">Choose a site…</option>
        {me.sites.map((s) => (
          <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
        ))}
      </select>
    </div>
  )

  const renderScreen = () => {
    if (current?.key === 'catalogue' || current?.key === 'basket') {
      if (me.sites.length === 0) {
        return <p className="text-gray-700">Your account is not linked to a site yet.</p>
      }
      const verb = current.key === 'catalogue' ? 'ordering' : 'checking the request'
      if (activeSiteId === null) return sitePicker(verb)
      return (
        <div className="space-y-4">
          {me.sites.length > 1 && (
            <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 flex items-center justify-between gap-3">
              <span>Acting for <strong>{activeSite?.code}</strong> · {activeSite?.name}</span>
              <button
                type="button"
                onClick={() => setSiteId(null)}
                className="underline min-h-[44px] px-2"
              >
                Change
              </button>
            </div>
          )}
          {current.key === 'catalogue'
            ? <Catalogue siteId={activeSiteId} />
            : <Basket siteId={activeSiteId} onSubmitted={() => setOpenScreen('orders')} />}
        </div>
      )
    }
    if (current?.key === 'orders') return <MyOrders />
    if (current?.key === 'queue') return <ApprovalQueue />
    if (current?.key === 'stock') return <StockOverview />
    if (current?.key === 'mapping') return <Mapping />
    if (current?.key === 'par') return <ParLevels />
    if (current?.key === 'recharge') return <RechargeReport />
    if (current?.key === 'sync') return <SyncHealth />
    return null
  }

  return (
    <div className="min-h-dvh bg-gray-50">
      <header className="bg-everglade text-paper">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="font-semibold truncate">Maki &amp; Ramen Ordering</p>
            <p className="text-sm text-gray-300 truncate">
              {me.user.name} · {ROLE_LABEL[me.user.role]}
            </p>
          </div>
          <button
            onClick={async () => { await signOut(); void load() }}
            className="px-3 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-paper text-sm whitespace-nowrap"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-4">
        {current?.ready ? (
          <>
            <button
              onClick={() => setOpenScreen(null)}
              className="mb-4 text-gray-800 underline"
            >
              ← Back
            </button>
            <h1 className="text-xl font-semibold text-gray-900 mb-4">{current.title}</h1>
            {renderScreen()}
          </>
        ) : (
        <>
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
              {screen.ready ? (
                <button
                  onClick={() => setOpenScreen(screen.key)}
                  className="w-full text-left bg-white border border-gray-300 rounded-xl p-4 hover:border-gray-500"
                >
                  <h3 className="font-semibold text-gray-900">{screen.title}</h3>
                  <p className="mt-1 text-gray-700">{screen.blurb}</p>
                </button>
              ) : (
                <div className="w-full text-left bg-white border border-gray-300 rounded-xl p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-semibold text-gray-900">{screen.title}</h3>
                    <span className="text-xs text-gray-600 whitespace-nowrap">Phase {screen.phase}</span>
                  </div>
                  <p className="mt-1 text-gray-700">{screen.blurb}</p>
                  <p className="mt-2 text-sm text-gray-600">Not built yet.</p>
                </div>
              )}
            </li>
          ))}
        </ul>
        </>
        )}
      </main>
    </div>
  )
}

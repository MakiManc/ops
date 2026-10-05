import { useCallback, useEffect, useRef, useState } from 'react'
import { getMe, NotSignedIn, signOut, type Me } from './api.ts'
import { ParLevels, RechargeReport, SyncHealth } from './AdminScreens.tsx'
import { Photos } from './Photos.tsx'
import { SitesAndPeople } from './SitesAndPeople.tsx'
import { ApprovalQueue } from './ApprovalQueue.tsx'
import { Basket } from './Basket.tsx'
import { Catalogue } from './Catalogue.tsx'
import { Mapping } from './Mapping.tsx'
import { MyOrders } from './MyOrders.tsx'
import { OrderPage } from './OrderPage.tsx'
import { SignIn } from './SignIn.tsx'
import { StockOverview } from './StockOverview.tsx'
import { btnSecondary, card, eyebrow } from './ui.ts'

/**
 * Which screens a role gets.
 *
 * This is presentation only. The server enforces the same rules on every route, so
 * editing this in the browser changes what is drawn and nothing about what is allowed.
 * The roles deliberately do not nest: an admin is not shown the approval queue.
 *
 * `group` is only used to break the administrator's long menu into sections. A GM's
 * three screens need no headings.
 */
interface Screen { key: string; title: string; blurb: string; group: 'Ordering' | 'Approvals' | 'Catalogue' | 'Setup' }

const SCREENS: Record<Me['user']['role'], Screen[]> = {
  gm: [
    { key: 'catalogue', title: 'Order stock', blurb: 'Browse what your site can order and build a request.', group: 'Ordering' },
    { key: 'basket', title: 'Current request', blurb: 'Check it over and send it for sign-off.', group: 'Ordering' },
    { key: 'orders', title: 'My orders', blurb: 'Track what you have asked for and where it has got to.', group: 'Ordering' },
  ],
  // An approver signs orders off and can order for any site, but gets none of the admin
  // tools: merging and splitting products, par levels and the recharge report are the
  // administrator's alone. Ordering needs no extra permission — approvers were never
  // site-scoped, so the API already allowed it and only the menu withheld it.
  approver: [
    { key: 'queue', title: 'Approval queue', blurb: 'Requests waiting for sign-off, oldest first.', group: 'Approvals' },
    { key: 'stock', title: 'Stock overview', blurb: 'What is on hand, allocated, inbound and how long it will last.', group: 'Approvals' },
    { key: 'catalogue', title: 'Order stock', blurb: 'Browse and build a request for any site.', group: 'Ordering' },
    { key: 'basket', title: 'Current request', blurb: 'Check it over and send it for sign-off.', group: 'Ordering' },
    { key: 'orders', title: 'All orders', blurb: 'Track what every site has asked for and where it has got to.', group: 'Ordering' },
  ],
  // An administrator gets everything: the admin tools, plus the approver's queue and
  // the ordering screens. Ordering needs a site, and an admin is not site-scoped, so
  // the catalogue and basket screens ask which site they are acting for.
  admin: [
    { key: 'queue', title: 'Approval queue', blurb: 'Requests waiting for sign-off, oldest first.', group: 'Approvals' },
    { key: 'stock', title: 'Stock overview', blurb: 'What is on hand, allocated, inbound and how long it will last.', group: 'Approvals' },
    { key: 'catalogue', title: 'Order stock', blurb: 'Browse and build a request for any site.', group: 'Ordering' },
    { key: 'basket', title: 'Current request', blurb: 'Check it over and send it for sign-off.', group: 'Ordering' },
    { key: 'orders', title: 'All orders', blurb: 'Track what every site has asked for and where it has got to.', group: 'Ordering' },
    { key: 'mapping', title: 'Catalogue mapping', blurb: 'Combine duplicate warehouse lines into one product.', group: 'Catalogue' },
    { key: 'photos', title: 'Product photos', blurb: 'Add the picture a GM sees when ordering. The warehouse cannot supply these.', group: 'Catalogue' },
    { key: 'par', title: 'Par levels and limits', blurb: 'Edit the grid of levels and caps as a spreadsheet.', group: 'Catalogue' },
    { key: 'recharge', title: 'Recharge report', blurb: 'Monthly totals per franchise site, for Finance.', group: 'Setup' },
    { key: 'sites', title: 'Sites and people', blurb: 'Who can sign in, and which sites they order for.', group: 'Setup' },
    { key: 'sync', title: 'Sync health', blurb: 'Last successful warehouse check per job, and anything that failed.', group: 'Setup' },
  ],
}

const GROUP_ORDER: Screen['group'][] = ['Approvals', 'Ordering', 'Catalogue', 'Setup']

const ROLE_LABEL: Record<Me['user']['role'], string> = {
  gm: 'GM', approver: 'Approver', admin: 'Admin',
}

/**
 * Where the screen state lives: the URL fragment.
 *
 * `#catalogue` opens a screen; `#catalogue/9` opens it acting for site 9. It used to be
 * plain component state, which meant the phone's edge-swipe back gesture — the way
 * people leave a screen without thinking — left the portal entirely and landed on
 * Google sign-in; a refresh dumped everyone on the menu; and there was no link Ross
 * could send Francheska that opened the queue. The fragment fixes all three without a
 * router: the browser keeps the history, and we read it back on `popstate`.
 */
/**
 * Where we are. The hash holds one number after the screen name, and which thing that
 * number is depends on the screen: a site for the ordering screens, an order for the
 * order page. They are separate fields here because reusing one would have let
 * `#orders/3`, which `go('orders')` writes for an admin acting for site 3, be read as
 * order 3.
 */
interface Route { screen: string | null; siteId: number | null; orderId: number | null }

/** The screen whose number is an order rather than a site. */
const ORDER_SCREEN = 'order'

/**
 * The order page, as a screen the shell understands.
 *
 * Deliberately not in SCREENS: it is not a menu item, nobody arrives at it from the
 * home screen, and it belongs to no role in particular -- the server decides who may
 * read an order. Resolving `current` to this means the sticky header, the Back control,
 * the title, the scroll reset and the focus move all work on it without a special case.
 */
const ORDER_PAGE: Screen = {
  key: ORDER_SCREEN, title: 'Order', blurb: '', group: 'Ordering',
}

function readHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  if (!raw) return { screen: null, siteId: null, orderId: null }
  const [screen, arg] = raw.split('/')
  const n = arg && /^\d+$/.test(arg) ? Number(arg) : null
  return screen === ORDER_SCREEN
    ? { screen, siteId: null, orderId: n }
    : { screen: screen || null, siteId: n, orderId: null }
}

function writeHash(route: Route, replace = false) {
  const arg = route.screen === ORDER_SCREEN ? route.orderId : route.siteId
  const next = route.screen ? `#${route.screen}${arg ? `/${arg}` : ''}` : '#'
  if (window.location.hash === next || (next === '#' && !window.location.hash)) return
  const url = next === '#' ? window.location.pathname + window.location.search : next
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}

export function App({ googleClientId }: { googleClientId: string }) {
  const [me, setMe] = useState<Me | null>(null)
  /**
   * The Google client id, from the server unless the build supplied one.
   *
   * It was previously baked in at build time with an empty-string default, so a build
   * that did not set VITE_GOOGLE_CLIENT_ID shipped a sign-in page with no client id.
   * Nothing failed at build or deploy; people simply met Google's "Access blocked:
   * Missing required parameter: client_id" and there was no sign of it from our side.
   */
  const [clientId, setClientId] = useState(googleClientId)
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'error'>('loading')
  /** Which screen is open (null is the menu) and which site it acts for. Mirrors the URL. */
  const [route, setRoute] = useState<Route>(() => readHash())
  /** What the menu shows beside "Current request" and "Approval queue". */
  const [openLines, setOpenLines] = useState<number | null>(null)
  const [queueCount, setQueueCount] = useState<number | null>(null)
  /** The order number just sent, so My orders can say so and point at the right row. */
  const [justSent, setJustSent] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const load = useCallback(async () => {
    setState('loading')
    if (!googleClientId) {
      // Failure here is not fatal to the rest of the app, and SignIn says plainly when
      // it has no client id rather than rendering a button that cannot work.
      try {
        const res = await fetch('/api/config', { credentials: 'same-origin' })
        if (res.ok) setClientId((await res.json() as { googleClientId?: string }).googleClientId ?? '')
      } catch { /* leaves clientId empty, which SignIn reports */ }
    }
    try {
      setMe(await getMe())
      setState('ready')
    } catch (err) {
      if (err instanceof NotSignedIn) { setMe(null); setState('signed-out') }
      else setState('error')
    }
  }, [googleClientId])

  useEffect(() => { void load() }, [load])

  // The browser's back and forward buttons, and the phone's swipe, change the hash;
  // we follow rather than fight them.
  useEffect(() => {
    const onPop = () => setRoute((prev) => {
      const next = readHash()
      // The order page's hash carries an order id, so it has nowhere to keep the site an
      // admin was acting for. Going back to the catalogue must not make them pick again.
      return { ...next, siteId: next.siteId ?? prev.siteId }
    })
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('hashchange', onPop)
    }
  }, [])

  const go = useCallback((screen: string | null, siteId?: number | null) => {
    setRoute((prev) => {
      const next: Route = {
        screen,
        siteId: siteId === undefined ? prev.siteId : siteId,
        orderId: null,
      }
      writeHash(next)
      return next
    })
  }, [])

  /** Opens one order's own page, at its own address. */
  const goToOrder = useCallback((orderId: number) => {
    setRoute((prev) => {
      const next: Route = { screen: ORDER_SCREEN, siteId: prev.siteId, orderId }
      writeHash(next)
      return next
    })
  }, [])

  const screens = me ? SCREENS[me.user.role] : []
  const current = route.screen === ORDER_SCREEN
    ? ORDER_PAGE
    : screens.find((s) => s.key === route.screen) ?? null

  /**
   * A new screen starts at the top, with focus on its heading. Without this the
   * browser keeps the scroll offset from the last screen: tap "Review and send" from
   * far down the catalogue and you land at the foot of the basket, below the Send
   * button and below the name field you still have to fill in. Moving focus means a
   * keyboard or screen-reader user is not left on a button that no longer exists.
   */
  useEffect(() => {
    if (state !== 'ready') return
    document.title = current ? `${current.title} · Maki & Ramen Ordering` : 'Maki & Ramen Ordering'
    try { window.scrollTo({ top: 0 }) } catch { /* not every environment can scroll */ }
    headingRef.current?.focus({ preventScroll: true })
  }, [current, state])

  /** The site in play: the only one, or the one in the URL. */
  const activeSiteId = me && me.sites.length === 1 ? me.sites[0]!.id : route.siteId
  const activeSite = me?.sites.find((s) => s.id === activeSiteId) ?? null

  // The menu is where every session starts, so it should say whether anything is
  // waiting rather than reading identically for an empty basket and a nine-line one.
  useEffect(() => {
    if (state !== 'ready' || !me || current) return
    let cancelled = false
    if (activeSiteId !== null) {
      fetch(`/api/sites/${activeSiteId}/request`, { credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok) return
          const body = await res.json() as { request: { status?: string } | null; lines?: unknown[] }
          if (!cancelled) setOpenLines(body.request?.status === 'draft' ? body.lines?.length ?? 0 : 0)
        })
        .catch(() => { /* a count is a convenience; the screen is the source of truth */ })
    }
    if (me.user.role !== 'gm') {
      fetch('/api/approvals/queue', { credentials: 'same-origin' })
        .then(async (res) => {
          if (!res.ok) return
          const body = await res.json() as { requests?: unknown[] }
          if (!cancelled) setQueueCount(body.requests?.length ?? 0)
        })
        .catch(() => { /* as above */ })
    }
    return () => { cancelled = true }
  }, [state, me, current, activeSiteId])

  if (state === 'loading') {
    return <p className="p-6 text-gray-700" role="status">Loading…</p>
  }

  if (state === 'error') {
    return (
      <main className="p-6">
        <p role="alert" className="text-red-800 bg-red-50 border border-red-300 rounded-lg p-4">
          The portal could not be reached. Try again in a moment.
        </p>
        <button onClick={() => void load()} className={`mt-4 ${btnSecondary}`}>
          Try again
        </button>
      </main>
    )
  }

  if (state === 'signed-out' || !me) {
    return <SignIn clientId={clientId} onSignedIn={() => void load()} />
  }

  /** Asks which site to act for, when the answer is not obvious. */
  const sitePicker = (verb: string) => (
    <div className={`${card} space-y-3`}>
      <label htmlFor="site-picker" className="block font-medium text-gray-900">
        Which site are you {verb} for?
      </label>
      <select
        id="site-picker"
        className="w-full min-h-[44px] rounded-xl border border-gray-400 px-3 py-2 bg-white"
        value={activeSiteId ?? ''}
        onChange={(e) => go(route.screen, e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">Choose a site…</option>
        {me.sites.map((s) => (
          <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
        ))}
      </select>
    </div>
  )

  /** The "acting for" strip, shown wherever a site is in play and there was a choice. */
  const actingFor = me.sites.length > 1 && activeSite && (
    <div className="rounded-xl bg-cherry/60 px-3 py-2 text-sm text-woodsmoke flex items-center justify-between gap-3">
      <span>Acting for <strong>{activeSite.code}</strong> · {activeSite.name}</span>
      <button
        type="button"
        onClick={() => go(route.screen, null)}
        className="underline min-h-[44px] px-2 font-medium"
      >
        Change
      </button>
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
          {actingFor}
          {current.key === 'catalogue'
            ? (
              <Catalogue
                siteId={activeSiteId}
                canOrderExpansion={me.user.role !== 'gm'}
                onGoToBasket={() => go('basket')}
              />
            )
            : (
              <Basket
                siteId={activeSiteId}
                onSubmitted={(orderNumber) => { setJustSent(orderNumber); go('orders') }}
                onGoToCatalogue={() => go('catalogue')}
              />
            )}
        </div>
      )
    }
    if (current?.key === ORDER_SCREEN) {
      if (route.orderId === null) {
        return (
          <p className="text-gray-700">
            That link does not name an order.{' '}
            <button type="button" className="underline" onClick={() => go('orders')}>
              Open the orders list
            </button>{' '}
            and pick one.
          </p>
        )
      }
      return <OrderPage orderId={route.orderId} onBack={() => go('orders')} />
    }
    if (current?.key === 'orders') {
      return (
        <MyOrders
          justSent={justSent}
          onSeen={() => setJustSent(null)}
          onGoToCatalogue={() => go('catalogue')}
          onOpenOrder={goToOrder}
        />
      )
    }
    if (current?.key === 'queue') return <ApprovalQueue />
    if (current?.key === 'stock') return <StockOverview />
    if (current?.key === 'mapping') return <Mapping />
    if (current?.key === 'par') return <ParLevels />
    if (current?.key === 'recharge') return <RechargeReport />
    if (current?.key === 'photos') return <Photos />
    if (current?.key === 'sites') return <SitesAndPeople />
    if (current?.key === 'sync') return <SyncHealth />
    return null
  }

  /** What to write beside a menu item, when there is something worth saying. */
  const badgeFor = (key: string): string | null => {
    if (key === 'basket' && openLines) return `${openLines} ${openLines === 1 ? 'product' : 'products'} waiting to be sent`
    if (key === 'queue' && queueCount) return `${queueCount} ${queueCount === 1 ? 'request' : 'requests'} waiting`
    return null
  }

  const menuItem = (screen: Screen) => {
    const badge = badgeFor(screen.key)
    return (
      <li key={screen.key}>
        <button
          onClick={() => go(screen.key)}
          className={`w-full text-left ${card} hover:border-everglade active:bg-gray-50 ${badge ? 'border-maki-orange' : ''}`}
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold text-gray-900">{screen.title}</h3>
            <span className="text-everglade text-xl leading-none" aria-hidden="true">›</span>
          </div>
          <p className="mt-1 text-gray-700">{screen.blurb}</p>
          {badge && (
            <p className="mt-2 inline-block rounded-lg bg-maki-orange px-2 py-1 text-sm font-semibold text-woodsmoke">
              {badge}
            </p>
          )}
        </button>
      </li>
    )
  }

  const grouped = me.user.role === 'admin'
  const groups = grouped
    ? GROUP_ORDER.map((g) => [g, screens.filter((s) => s.group === g)] as const).filter(([, s]) => s.length > 0)
    : []

  return (
    <div className="min-h-dvh bg-gray-50">
      {/* Sticky, so Back and the way home are always on screen. Deep in a 93-product
          catalogue the only control used to be Sign out. */}
      <header className="sticky top-0 z-20 bg-everglade text-paper shadow-md">
        <div className="mx-auto max-w-3xl px-3 py-2 flex items-center gap-2">
          {current ? (
            <button
              // From an order, back is the list it came from. Sending someone home from
              // there would cost them two taps to see the next order.
              onClick={() => (current.key === ORDER_SCREEN ? go('orders') : go(null))}
              className="min-h-[44px] min-w-[44px] px-2 rounded-lg hover:bg-white/15 font-medium whitespace-nowrap"
            >
              ← Back
            </button>
          ) : (
            <img src="/mark-white.png" alt="" className="h-8 w-auto shrink-0 ml-1" />
          )}
          <button
            onClick={() => go(null)}
            className="min-w-0 flex-1 text-left min-h-[44px] rounded-lg px-1 hover:bg-white/10"
            aria-label="Maki & Ramen Ordering — home"
          >
            <span className="block font-heading font-semibold leading-tight truncate">
              {current ? current.title : 'Maki & Ramen Ordering'}
            </span>
            <span className="block text-xs text-gray-300 truncate">
              {current ? 'Maki & Ramen Ordering' : `${me.user.name} · ${ROLE_LABEL[me.user.role]}`}
            </span>
          </button>
          {!current && (
            <button
              onClick={async () => { await signOut(); go(null, null); void load() }}
              className="min-h-[44px] px-3 rounded-lg text-sm text-gray-200 hover:bg-white/15 whitespace-nowrap"
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-4 pb-16">
        {current ? (
          <>
            <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-gray-900 mb-4 outline-none">
              {current.title}
            </h1>
            {renderScreen()}
          </>
        ) : (
          <>
            {me.user.role === 'gm' && (
              <section aria-labelledby="your-sites" className="mb-6">
                <h2 id="your-sites" className={eyebrow}>
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
                      <li key={s.id} className="px-3 py-2 rounded-xl bg-white border border-gray-200">
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

            {me.user.role !== 'gm' && activeSite && me.sites.length > 1 && (
              <section className="mb-6">{actingFor}</section>
            )}

            {grouped ? (
              groups.map(([group, items]) => (
                <section key={group} aria-labelledby={`menu-${group}`} className="mb-6">
                  <h2 id={`menu-${group}`} className={eyebrow}>{group}</h2>
                  <ul className="mt-2 grid gap-3">{items.map(menuItem)}</ul>
                </section>
              ))
            ) : (
              <>
                <h2 className={eyebrow}>What you can do</h2>
                <ul className="mt-2 grid gap-3">{screens.map(menuItem)}</ul>
              </>
            )}

            {me.user.role === 'gm' && (
              <p className="mt-8 text-sm text-gray-600">
                Requests go to Ross or Francheska for sign-off before anything is sent to
                the warehouse. Nothing is ordered until they approve it.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}

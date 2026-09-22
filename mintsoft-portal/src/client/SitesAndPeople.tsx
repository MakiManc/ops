/**
 * Sites and people: who can sign in, and which sites they order for.
 *
 * Until this existed, adding one GM meant editing a CSV, running the seed script and
 * executing SQL against production — so it needed a developer, which made the portal
 * something Maki could use but not operate.
 *
 * The rules live on the server (src/server/db/people.ts) and are not repeated here. This
 * shows what the server says: a rejected save puts the message against the field it
 * names, rather than the form guessing at rules that could drift out of step.
 */
import { useCallback, useEffect, useState } from 'react'

interface Site {
  id: number; code: string; name: string; type: string; cluster: string | null
  address1: string | null; address2: string | null; address3: string | null
  town: string | null; county: string | null; postcode: string | null
  contactName: string | null; contactPhone: string | null; deliveryNotes: string | null
  minDaysBetweenOrders: number | null; recharge: boolean; active: boolean; gmCount: number
}
interface Person {
  id: number; email: string; name: string; role: 'gm' | 'approver' | 'admin'
  active: boolean; lastSeenAt: string | null; siteIds: number[]
}

const SITE_TYPES = ['restaurant', 'factory', 'franchise'] as const
const ROLES = ['gm', 'approver', 'admin'] as const
const ROLE_LABEL = { gm: 'General Manager', approver: 'Approver', admin: 'Administrator' }

const field = 'w-full min-h-[44px] rounded-lg border border-gray-400 px-3 py-2'
const label = 'block text-sm font-medium text-gray-900'
const primary = 'min-h-[44px] px-4 rounded-lg bg-everglade text-paper font-semibold disabled:opacity-60'
const secondary = 'min-h-[44px] px-4 rounded-lg border border-gray-400 text-gray-900 disabled:opacity-60'

function Problem({ error }: { error: string | null }) {
  if (!error) return null
  return <p className="text-sm text-red-700 mt-1">{error}</p>
}

function SiteForm({ site, onDone, onCancel }: {
  site: Partial<Site>; onDone: () => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<Partial<Site>>(site)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof Site) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const editing = typeof draft.id === 'number'
      const res = await fetch(editing ? `/api/admin/sites/${draft.id}` : '/api/admin/sites', {
        method: editing ? 'PATCH' : 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          minDaysBetweenOrders: draft.minDaysBetweenOrders === null
            || String(draft.minDaysBetweenOrders ?? '') === ''
            ? null : Number(draft.minDaysBetweenOrders),
        }),
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `Save failed (${res.status}).`)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally { setBusy(false) }
  }

  return (
    <div className="bg-white border border-gray-300 rounded-xl p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="site-code">Code</label>
          <input id="site-code" className={field} value={draft.code ?? ''}
                 onChange={(e) => set('code')(e.target.value)} placeholder="M21" />
        </div>
        <div>
          <label className={label} htmlFor="site-name">Name</label>
          <input id="site-name" className={field} value={draft.name ?? ''}
                 onChange={(e) => set('name')(e.target.value)} placeholder="Leeds" />
        </div>
        <div>
          <label className={label} htmlFor="site-type">Type</label>
          <select id="site-type" className={field} value={draft.type ?? 'restaurant'}
                  onChange={(e) => set('type')(e.target.value)}>
            {SITE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {/* Recharge is derived from type on the server, so it is shown, not asked. */}
          <p className="text-sm text-gray-700 mt-1">
            {draft.type === 'franchise'
              ? 'Franchise sites are recharged for what they order.'
              : 'Corporate sites are never recharged and never shown a price.'}
          </p>
        </div>
        <div>
          <label className={label} htmlFor="site-postcode">Postcode</label>
          <input id="site-postcode" className={field} value={draft.postcode ?? ''}
                 onChange={(e) => set('postcode')(e.target.value)} placeholder="LS1 1AA" />
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="site-a1">Address</label>
          <input id="site-a1" className={field} value={draft.address1 ?? ''}
                 onChange={(e) => set('address1')(e.target.value)} placeholder="Line 1" />
        </div>
        <div>
          <label className={label} htmlFor="site-town">Town</label>
          <input id="site-town" className={field} value={draft.town ?? ''}
                 onChange={(e) => set('town')(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="site-contact">Contact</label>
          <input id="site-contact" className={field} value={draft.contactName ?? ''}
                 onChange={(e) => set('contactName')(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="site-days">Minimum days between orders</label>
          <input id="site-days" className={field} inputMode="numeric"
                 value={draft.minDaysBetweenOrders ?? ''}
                 onChange={(e) => setDraft((d) => ({
                   ...d, minDaysBetweenOrders: e.target.value === '' ? null : Number(e.target.value),
                 }))} placeholder="leave blank to use the default" />
        </div>
        <label className="flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" className="w-4 h-4" checked={draft.active ?? true}
                 onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} />
          Active
        </label>
      </div>
      <Problem error={error} />
      <div className="flex gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save site'}
        </button>
        <button type="button" className={secondary} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function PersonForm({ person, sites, onDone, onCancel }: {
  person: Partial<Person>; sites: Site[]; onDone: () => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<Partial<Person>>(person)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleSite = (id: number) => setDraft((d) => {
    const have = d.siteIds ?? []
    return { ...d, siteIds: have.includes(id) ? have.filter((s) => s !== id) : [...have, id] }
  })

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const editing = typeof draft.id === 'number'
      const res = await fetch(editing ? `/api/admin/people/${draft.id}` : '/api/admin/people', {
        method: editing ? 'PATCH' : 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: draft.email, name: draft.name, role: draft.role ?? 'gm',
          active: draft.active ?? true, siteIds: draft.siteIds ?? [],
        }),
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `Save failed (${res.status}).`)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally { setBusy(false) }
  }

  const role = draft.role ?? 'gm'

  return (
    <div className="bg-white border border-gray-300 rounded-xl p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="p-email">Email</label>
          <input id="p-email" className={field} type="email" value={draft.email ?? ''}
                 onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                 placeholder="name@makiramen.com" />
          <p className="text-sm text-gray-700 mt-1">They sign in with this Google account.</p>
        </div>
        <div>
          <label className={label} htmlFor="p-name">Name</label>
          <input id="p-name" className={field} value={draft.name ?? ''}
                 onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
        </div>
        <div>
          <label className={label} htmlFor="p-role">Role</label>
          <select id="p-role" className={field} value={role}
                  onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value as Person['role'] }))}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 min-h-[44px]">
          <input type="checkbox" className="w-4 h-4" checked={draft.active ?? true}
                 onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} />
          Can sign in
        </label>
      </div>

      <div>
        <p className={label}>Sites</p>
        {role === 'gm' ? (
          <p className="text-sm text-gray-700">A General Manager can order only for the sites ticked here.</p>
        ) : (
          <p className="text-sm text-gray-700">
            {ROLE_LABEL[role]}s can order for every site, so these are kept but not used —
            they matter again only if this person becomes a General Manager.
          </p>
        )}
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {sites.filter((s) => s.active).map((s) => (
            <li key={s.id}>
              <label className="flex items-center gap-2 min-h-[44px]">
                <input type="checkbox" className="w-4 h-4"
                       checked={(draft.siteIds ?? []).includes(s.id)}
                       onChange={() => toggleSite(s.id)} />
                <span><strong>{s.code}</strong> · {s.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <Problem error={error} />
      <div className="flex gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save person'}
        </button>
        <button type="button" className={secondary} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

export function SitesAndPeople() {
  const [sites, setSites] = useState<Site[] | null>(null)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'people' | 'sites'>('people')
  const [editingSite, setEditingSite] = useState<Partial<Site> | null>(null)
  const [editingPerson, setEditingPerson] = useState<Partial<Person> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/people', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`Could not load (${res.status}).`)
      const body = await res.json() as { sites: Site[]; people: Person[] }
      setSites(body.sites); setPeople(body.people)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load.')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <p className="text-red-700">{error}</p>
  if (!sites || !people) return <p className="text-gray-700">Loading…</p>

  const done = () => { setEditingSite(null); setEditingPerson(null); void load() }
  const siteName = (id: number) => sites.find((s) => s.id === id)?.code ?? `#${id}`
  const admins = people.filter((p) => p.active && p.role === 'admin').length

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['people', 'sites'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
                  className={`min-h-[44px] px-4 rounded-lg font-semibold ${
                    tab === t ? 'bg-everglade text-paper' : 'border border-gray-400 text-gray-900'}`}>
            {t === 'people' ? `People (${people.length})` : `Sites (${sites.length})`}
          </button>
        ))}
      </div>

      {tab === 'people' && (
        <>
          {admins === 1 && (
            <p className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800">
              There is one administrator. A second one means nobody is locked out if that
              account goes away.
            </p>
          )}
          {editingPerson
            ? <PersonForm person={editingPerson} sites={sites} onDone={done}
                          onCancel={() => setEditingPerson(null)} />
            : <button type="button" className={primary} onClick={() => setEditingPerson({ role: 'gm', active: true, siteIds: [] })}>
                Add a person
              </button>}
          <ul className="space-y-2">
            {people.map((p) => (
              <li key={p.id} className="bg-white border border-gray-300 rounded-xl p-4
                                        flex flex-wrap gap-3 items-start justify-between">
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900">
                    {p.name}{!p.active && <span className="text-gray-600 font-normal"> · cannot sign in</span>}
                  </h3>
                  <p className="text-sm text-gray-700">{p.email} · {ROLE_LABEL[p.role]}</p>
                  <p className="text-sm text-gray-700">
                    {p.role === 'gm'
                      ? (p.siteIds.length
                          ? p.siteIds.map(siteName).join(', ')
                          : 'No sites yet — they cannot order until one is ticked.')
                      : 'Every site'}
                  </p>
                </div>
                <button type="button" className={secondary} onClick={() => setEditingPerson(p)}>Edit</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'sites' && (
        <>
          {editingSite
            ? <SiteForm site={editingSite} onDone={done} onCancel={() => setEditingSite(null)} />
            : <button type="button" className={primary}
                      onClick={() => setEditingSite({ type: 'restaurant', active: true })}>
                Add a site
              </button>}
          <ul className="space-y-2">
            {sites.map((s) => (
              <li key={s.id} className="bg-white border border-gray-300 rounded-xl p-4
                                        flex flex-wrap gap-3 items-start justify-between">
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900">
                    {s.code} · {s.name}
                    {!s.active && <span className="text-gray-600 font-normal"> · closed</span>}
                  </h3>
                  <p className="text-sm text-gray-700">
                    {s.type}{s.recharge && ' · recharged'} · {s.postcode ?? 'no postcode'}
                  </p>
                  <p className="text-sm text-gray-700">
                    {s.gmCount === 0 ? 'Nobody can order for this site yet.'
                      : `${s.gmCount} ${s.gmCount === 1 ? 'person' : 'people'}`}
                  </p>
                </div>
                <button type="button" className={secondary} onClick={() => setEditingSite(s)}>Edit</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

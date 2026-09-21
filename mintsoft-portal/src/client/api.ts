/** Everything the browser knows about the user. The server decides; this only draws. */
export interface Me {
  user: { name: string; email: string; role: 'gm' | 'approver' | 'admin' }
  sites: { id: number; code: string; name: string; type: string; recharge: boolean }[]
}

export class NotSignedIn extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (res.status === 401) throw new NotSignedIn()
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export const getMe = () => request<Me>('/api/me')

export const signInWithGoogle = (idToken: string) =>
  request<{ user: Me['user'] }>('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })

export const signOut = () => request<{ ok: true }>('/api/auth/signout', { method: 'POST' })

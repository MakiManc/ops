/**
 * Signed session cookies.
 *
 * The cookie carries the user's id and an expiry, signed with SESSION_SECRET. It holds
 * no role and no site list: those are read from the database on every request, so
 * changing someone's role or deactivating them takes effect immediately rather than
 * whenever their cookie happens to expire. A stolen cookie for a deactivated user is
 * worth nothing.
 */

/**
 * The __Host- prefix is load-bearing, not decoration.
 *
 * Browsers refuse to accept a __Host- cookie unless it is Secure, Path=/ and has no
 * Domain — which means a subdomain cannot set one that shadows ours. Without it, a
 * cookie set on a sibling host can sit in front of the real session in the Cookie
 * header, and whoever reads the first match gets the attacker's value.
 */
const COOKIE_NAME = '__Host-mrsession'
const DEFAULT_TTL_SECONDS = 12 * 60 * 60 // a working day, not a fortnight

export interface SessionPayload {
  userId: number
  /** Unix seconds. */
  expiresAt: number
}

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('SESSION_SECRET is not set')
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  )
}

/** Signs a session into a cookie value: `<payload>.<signature>`, both base64url. */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body))
  return `${body}.${toBase64Url(new Uint8Array(signature))}`
}

/**
 * Returns the session, or null for anything that is not a valid unexpired session.
 *
 * Null rather than throwing, and with no reason attached, because every failure here
 * means the same thing to the caller: sign in again. Verification uses WebCrypto's
 * own comparison, which does not leak timing.
 */
export async function verifySession(
  cookieValue: string | undefined,
  secret: string,
  { now = Date.now() }: { now?: number } = {},
): Promise<SessionPayload | null> {
  if (!cookieValue) return null
  const parts = cookieValue.split('.')
  if (parts.length !== 2) return null
  const [body, signature] = parts as [string, string]

  let valid: boolean
  try {
    valid = await crypto.subtle.verify(
      'HMAC', await hmacKey(secret), fromBase64Url(signature), encoder.encode(body),
    )
  } catch {
    return null // malformed base64, not a session
  }
  if (!valid) return null

  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as SessionPayload
    if (typeof payload.userId !== 'number' || typeof payload.expiresAt !== 'number') return null
    if (payload.expiresAt <= Math.floor(now / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export const sessionCookieName = COOKIE_NAME

export function buildSessionCookie(value: string, maxAgeSeconds: number): string {
  // HttpOnly: unreadable from JavaScript, so an XSS bug cannot lift the session.
  // Secure: never sent over plain HTTP.
  // SameSite=Lax: not sent on cross-site POSTs, which blunts CSRF on the write routes.
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
  ].join('; ')
}

export const clearSessionCookie = (): string =>
  `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

export function readSessionCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined
  const found: string[] = []
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE_NAME) found.push(rest.join('='))
  }
  // More than one cookie of this name should be impossible with the __Host- prefix.
  // If it ever happens, something is shadowing the session, and picking either one is
  // worse than picking neither.
  if (found.length !== 1) return undefined
  return found[0]
}

export const sessionTtlSeconds = DEFAULT_TTL_SECONDS

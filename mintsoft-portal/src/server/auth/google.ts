/**
 * Verifies a Google ID token.
 *
 * Sign-in is Google from any domain — site logins are often shared gmail accounts, so
 * there is no domain rule to lean on. That makes this check the only thing standing
 * between a stranger's Google account and the portal, alongside the allow-list in the
 * users table. So the token is verified properly: signature against Google's published
 * keys, then issuer, audience and expiry.
 *
 * We deliberately do not use Google's tokeninfo endpoint. It works, but it puts a
 * network round trip in the sign-in path and trusts Google to say "this token is fine"
 * rather than checking the signature ourselves.
 */

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** The claims we rely on. Google sends more; we ignore what we do not need. */
export interface GoogleIdentity {
  email: string
  emailVerified: boolean
  name?: string
  picture?: string
  subject: string
}

interface Jwk { kid: string; n: string; e: string; alg?: string; kty: string }

const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const decodeJson = (segment: string): unknown =>
  JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)))

/**
 * Google rotates its signing keys, so the set is fetched rather than pinned. Cached in
 * module scope for the lifetime of the isolate; a key we have never seen forces a
 * refetch, which is what makes rotation a non-event.
 */
let cachedKeys: { keys: Jwk[]; fetchedAt: number } | null = null
const KEY_CACHE_MS = 60 * 60 * 1000

async function getSigningKey(kid: string, now: number): Promise<Jwk | null> {
  const fresh = cachedKeys && now - cachedKeys.fetchedAt < KEY_CACHE_MS
  if (fresh) {
    const hit = cachedKeys!.keys.find((k) => k.kid === kid)
    if (hit) return hit
  }

  const res = await fetch(GOOGLE_JWKS_URL)
  if (!res.ok) throw new Error(`Could not fetch Google signing keys: HTTP ${res.status}`)
  const body = (await res.json()) as { keys: Jwk[] }
  cachedKeys = { keys: body.keys ?? [], fetchedAt: now }
  return cachedKeys.keys.find((k) => k.kid === kid) ?? null
}

/** For tests: forget the cached keys so a stubbed fetch is actually consulted. */
export const resetGoogleKeyCache = () => { cachedKeys = null }

export class InvalidIdTokenError extends Error {
  constructor(reason: string) {
    // The reason is for our logs, never for the browser: telling a caller precisely
    // why a token failed is a gift to anyone probing the endpoint.
    super(`Google ID token rejected: ${reason}`)
    this.name = 'InvalidIdTokenError'
  }
}

export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  { now = Date.now() }: { now?: number } = {},
): Promise<GoogleIdentity> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new InvalidIdTokenError('not a three-part JWT')
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

  const header = decodeJson(rawHeader) as { alg?: string; kid?: string }
  // Pinning the algorithm closes the "alg: none" and HMAC-confusion families of attack.
  if (header.alg !== 'RS256') throw new InvalidIdTokenError(`unexpected algorithm ${header.alg}`)
  if (!header.kid) throw new InvalidIdTokenError('no key id')

  const jwk = await getSigningKey(header.kid, now)
  if (!jwk) throw new InvalidIdTokenError('signing key not published by Google')

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  )
  if (!signatureValid) throw new InvalidIdTokenError('signature does not verify')

  const claims = decodeJson(rawPayload) as {
    iss?: string; aud?: string; exp?: number; nbf?: number
    email?: string; email_verified?: boolean | string; name?: string; picture?: string; sub?: string
  }

  if (!claims.iss || !GOOGLE_ISSUERS.includes(claims.iss)) {
    throw new InvalidIdTokenError(`unexpected issuer ${claims.iss}`)
  }
  // Without this the token could be one Google issued for a different application.
  if (claims.aud !== clientId) throw new InvalidIdTokenError('audience is not this app')

  const nowSeconds = Math.floor(now / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
    throw new InvalidIdTokenError('expired')
  }
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds) {
    throw new InvalidIdTokenError('not valid yet')
  }

  if (!claims.email) throw new InvalidIdTokenError('no email claim')
  // Google sends this as a boolean or the string "true" depending on the flow.
  const verified = claims.email_verified === true || claims.email_verified === 'true'
  if (!verified) throw new InvalidIdTokenError('email is not verified')
  if (!claims.sub) throw new InvalidIdTokenError('no subject claim')

  return {
    email: claims.email.toLowerCase(),
    emailVerified: true,
    name: claims.name,
    picture: claims.picture,
    subject: claims.sub,
  }
}

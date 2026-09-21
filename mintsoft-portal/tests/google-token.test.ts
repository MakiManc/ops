import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  InvalidIdTokenError, resetGoogleKeyCache, verifyGoogleIdToken,
} from '../src/server/auth/google.ts'

/**
 * Sign-in accepts any Google domain, so this verification is load-bearing: it is what
 * stops an arbitrary Google account, or a token minted for some other application,
 * from being presented as one of ours.
 *
 * These tests sign real RS256 tokens with a generated key and serve a matching key set,
 * so the actual signature path runs rather than a stubbed approximation of it.
 */

const CLIENT_ID = 'maki-portal.apps.googleusercontent.com'
const KID = 'test-key-1'

let keyPair: CryptoKeyPair
let publicJwk: JsonWebKey

const b64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const encodeSegment = (value: unknown) =>
  b64url(new TextEncoder().encode(JSON.stringify(value)))

/** Mints a token the way Google would, so only the claim under test is unusual. */
async function makeToken(
  claims: Record<string, unknown> = {},
  { header = {}, signingKey = keyPair.privateKey }: { header?: Record<string, unknown>; signingKey?: CryptoKey } = {},
) {
  const now = Math.floor(Date.now() / 1000)
  const head = encodeSegment({ alg: 'RS256', kid: KID, typ: 'JWT', ...header })
  const body = encodeSegment({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: 'gm.m9@example.com',
    email_verified: true,
    name: 'GM at M9',
    exp: now + 3600,
    iat: now,
    ...claims,
  })
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(`${head}.${body}`),
  )
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`
}

function serveKeys(keys: unknown[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ keys }), { status: 200 }))
}

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetGoogleKeyCache()
})

describe('a genuine token', () => {
  it('is accepted, with the email lowercased', async () => {
    serveKeys([{ ...publicJwk, kid: KID }])
    const identity = await verifyGoogleIdToken(await makeToken({ email: 'GM.M9@Example.com' }), CLIENT_ID)
    // The allow-list stores lowercase, so casing must never decide whether someone gets in.
    expect(identity.email).toBe('gm.m9@example.com')
    expect(identity.subject).toBe('1234567890')
  })

  it('is accepted when Google sends email_verified as a string', async () => {
    serveKeys([{ ...publicJwk, kid: KID }])
    const identity = await verifyGoogleIdToken(await makeToken({ email_verified: 'true' }), CLIENT_ID)
    expect(identity.emailVerified).toBe(true)
  })

  it('accepts the bare issuer Google also uses', async () => {
    serveKeys([{ ...publicJwk, kid: KID }])
    await expect(verifyGoogleIdToken(await makeToken({ iss: 'accounts.google.com' }), CLIENT_ID))
      .resolves.toMatchObject({ email: 'gm.m9@example.com' })
  })
})

describe('tokens that must be refused', () => {
  const reject = async (token: string, matching: RegExp) => {
    serveKeys([{ ...publicJwk, kid: KID }])
    await expect(verifyGoogleIdToken(token, CLIENT_ID)).rejects.toThrow(InvalidIdTokenError)
    await expect(verifyGoogleIdToken(token, CLIENT_ID)).rejects.toThrow(matching)
  }

  it('refuses an unsigned token claiming alg none', async () => {
    const now = Math.floor(Date.now() / 1000)
    const head = encodeSegment({ alg: 'none', kid: KID })
    const body = encodeSegment({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'a@b.com', email_verified: true, exp: now + 3600 })
    // The classic: strip the signature and declare it unnecessary.
    await reject(`${head}.${body}.`, /unexpected algorithm/)
  })

  it('refuses a token signed by someone else', async () => {
    const attacker = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair
    await reject(await makeToken({}, { signingKey: attacker.privateKey }), /signature does not verify/)
  })

  it('refuses a token minted for a different application', async () => {
    // A valid Google token from any other site would otherwise sign someone in here.
    await reject(await makeToken({ aud: 'some-other-app.apps.googleusercontent.com' }), /audience is not this app/)
  })

  it('refuses a token from an issuer that is not Google', async () => {
    await reject(await makeToken({ iss: 'https://accounts.evil.example' }), /unexpected issuer/)
  })

  it('refuses an expired token', async () => {
    await reject(await makeToken({ exp: Math.floor(Date.now() / 1000) - 1 }), /expired/)
  })

  it('refuses a token that is not valid yet', async () => {
    await reject(await makeToken({ nbf: Math.floor(Date.now() / 1000) + 600 }), /not valid yet/)
  })

  it('refuses an unverified email', async () => {
    // Google will issue these; an unverified address proves nothing about who holds it.
    await reject(await makeToken({ email_verified: false }), /email is not verified/)
  })

  it('refuses a token with no email at all', async () => {
    await reject(await makeToken({ email: undefined }), /no email claim/)
  })

  it('refuses a token signed with a key Google does not publish', async () => {
    serveKeys([{ ...publicJwk, kid: 'some-other-kid' }])
    await expect(verifyGoogleIdToken(await makeToken(), CLIENT_ID))
      .rejects.toThrow(/signing key not published/)
  })

  it('refuses anything that is not a JWT', async () => {
    serveKeys([{ ...publicJwk, kid: KID }])
    for (const junk of ['', 'abc', 'a.b', 'a.b.c.d']) {
      await expect(verifyGoogleIdToken(junk, CLIENT_ID)).rejects.toThrow(InvalidIdTokenError)
    }
  })
})

describe('Google rotating its signing keys', () => {
  it('refetches when it meets a key id it has not seen', async () => {
    const spy = serveKeys([{ ...publicJwk, kid: KID }])
    await verifyGoogleIdToken(await makeToken(), CLIENT_ID)
    const afterFirst = spy.mock.calls.length

    // A token under a new kid must not fail just because the cache predates it.
    const rotated = await makeToken({}, { header: { kid: 'rotated-key' } })
    spy.mockImplementation(async () => new Response(
      JSON.stringify({ keys: [{ ...publicJwk, kid: 'rotated-key' }] }), { status: 200 },
    ))
    await expect(verifyGoogleIdToken(rotated, CLIENT_ID)).resolves.toMatchObject({ subject: '1234567890' })
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('reuses the cached key set for a kid it already holds', async () => {
    const spy = serveKeys([{ ...publicJwk, kid: KID }])
    await verifyGoogleIdToken(await makeToken(), CLIENT_ID)
    await verifyGoogleIdToken(await makeToken(), CLIENT_ID)
    // One fetch, two sign-ins: the key set is not refetched on every login.
    expect(spy.mock.calls.length).toBe(1)
  })
})

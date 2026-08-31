/**
 * Minimal JWT (HS256) sign/verify — shared by Lambda authorizer and Express.
 * Custom instead of a library (e.g. jose): ~50 lines using only node:crypto,
 * keeps the Lambda esbuild bundle small, and avoids adding a dependency to
 * two deployment targets. HS256-only — the only algorithm we need.
 *
 * Intentionally avoids Luxon (and any other runtime dep). The Lambda
 * authorizer imports verifyJwt — every dependency here enlarges that bundle.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

type JwtBaseClaims = {
  sub: string
  scope: string
  exp: number
}

export type JwtPayload = JwtBaseClaims & {
  /** The authorization server's issuer URL, as advertised in its metadata. */
  iss: string
  /** The RFC 8707 resource identifier the token was minted for. */
  aud: string
  /** RFC 7519 issued-at (Unix seconds). Optional — pre-existing tokens
   *  lack it and are rejected whenever a grant revocation exists for
   *  their client. */
  iat?: number
}

type VerifyJwtOptions = {
  token: string
  secret: string
  /** The value `iss` must equal; a token from another issuer is rejected. */
  expectedIssuer: string
  /** The value `aud` must equal; a token minted for another server is
   *  rejected even when it carries a valid signature under `secret`. */
  expectedAudience: string
}

type VerifyUnboundJwtOptions = {
  token: string
  secret: string
}

const b64url = (buf: Buffer): string => buf.toString("base64url")

const b64urlEncode = (obj: object): string =>
  b64url(Buffer.from(JSON.stringify(obj)))

const HEADER = b64urlEncode({ alg: "HS256", typ: "JWT" })

const hmac = (data: string, secret: string): string =>
  b64url(createHmac("sha256", secret).update(data).digest())

export const signJwt = (payload: JwtPayload, secret: string): string => {
  const body = `${HEADER}.${b64urlEncode(payload)}`
  return `${body}.${hmac(body, secret)}`
}

const isJwtBaseClaims = (value: unknown): value is JwtBaseClaims => {
  if (typeof value !== "object" || value === null) return false
  if (!("sub" in value) || typeof value.sub !== "string") return false
  if (!("scope" in value) || typeof value.scope !== "string") return false
  if (!("exp" in value) || typeof value.exp !== "number") return false
  return true
}

const isJwtPayload = (value: unknown): value is JwtPayload => {
  if (!isJwtBaseClaims(value)) return false
  if (!("iss" in value) || typeof value.iss !== "string") return false
  if (!("aud" in value) || typeof value.aud !== "string") return false
  if ("iat" in value && typeof value.iat !== "number") return false
  return true
}

// exp is Unix seconds. Native Date here, not Luxon: this module is bundled
// into the Lambda authorizer and stays dependency-free — a single epoch read
// doesn't justify the bundle weight.
const isExpired = (claims: JwtBaseClaims): boolean => {
  // eslint-disable-next-line no-restricted-syntax
  return claims.exp < Date.now() / 1000
}

/** The decoded payload of a token whose signature verifies under `secret`,
 *  with no claim checked yet; null when the signature or encoding is bad. */
const payloadWithVerifiedSignature = (
  token: string,
  secret: string,
): unknown => {
  // A valid JWT is exactly three base64url segments: header.payload.signature
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts
  if (!header || !payload || !sig) return null

  const expected = hmac(`${header}.${payload}`, secret)

  const sigBuf = Buffer.from(sig, "base64url")
  const expBuf = Buffer.from(expected, "base64url")
  if (sigBuf.length !== expBuf.length) return null
  if (!timingSafeEqual(sigBuf, expBuf)) return null

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString())
  } catch {
    return null
  }
}

/** Returns the payload when the signature, expiry, issuer, and audience all
 *  check out; null otherwise. Issuer and audience are compared as exact
 *  strings — callers canonicalize before passing them in. */
export const verifyJwt = ({
  token,
  secret,
  expectedIssuer,
  expectedAudience,
}: VerifyJwtOptions): JwtPayload | null => {
  const decoded = payloadWithVerifiedSignature(token, secret)
  if (!isJwtPayload(decoded)) return null
  if (isExpired(decoded)) return null
  if (decoded.iss !== expectedIssuer) return null
  if (decoded.aud !== expectedAudience) return null
  return decoded
}

/** Accepts a token minted before access tokens carried `aud`: signature and
 *  expiry are checked, and the token must carry no `aud` at all — a token
 *  that names any audience goes through `verifyJwt`. Lets clients holding a
 *  pre-binding token reach the server that rejects it with a 401, which is
 *  the signal they refresh on; a gateway-level deny would strand them. */
export const verifyUnboundJwt = ({
  token,
  secret,
}: VerifyUnboundJwtOptions): JwtBaseClaims | null => {
  const decoded = payloadWithVerifiedSignature(token, secret)
  if (!isJwtBaseClaims(decoded)) return null
  if ("aud" in decoded) return null
  if (isExpired(decoded)) return null
  return decoded
}

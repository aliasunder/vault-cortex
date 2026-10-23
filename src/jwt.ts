/**
 * Minimal JWT (HS256) sign/verify — shared by Lambda authorizer and Express.
 * Custom instead of a library (e.g. jose): uses only node:crypto, keeps the
 * Lambda esbuild bundle small, and avoids adding a dependency to two deployment
 * targets. HS256-only — the only algorithm we need.
 *
 * Intentionally avoids Luxon (and any other runtime dep). The Lambda
 * authorizer imports this module — every dependency here enlarges that bundle.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export type JwtPayload = {
  sub: string
  scope: string
  exp: number
  /** The authorization server's issuer URL, as advertised in its metadata. */
  iss: string
  /** The RFC 8707 resource identifier the token was minted for. */
  aud: string
  /** RFC 7519 issued-at (Unix seconds). Optional — when absent, the OAuth
   *  provider rejects the token if a grant revocation exists for the client. */
  iat?: number
}

type VerifyJwtOptions = {
  token: string
  secret: string
  /** Must equal `iss`; take it from `tokenBindingForServer` in auth.ts. */
  expectedIssuer: string
  /** Must equal `aud`; take it from `tokenBindingForServer` in auth.ts. */
  expectedAudience: string
}

type DeploymentJwtVerification =
  | { status: "valid"; payload: JwtPayload }
  | { status: "expired"; payload: JwtPayload }
  | { status: "invalid" }

const encodeJsonAsBase64url = (value: object): string => {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

const HEADER = encodeJsonAsBase64url({ alg: "HS256", typ: "JWT" })

const computeHmacSha256 = (data: string, secret: string): Buffer => {
  return createHmac("sha256", secret).update(data).digest()
}

export const signJwt = (payload: JwtPayload, secret: string): string => {
  const body = `${HEADER}.${encodeJsonAsBase64url(payload)}`
  return `${body}.${computeHmacSha256(body, secret).toString("base64url")}`
}

const isJwtPayload = (value: unknown): value is JwtPayload => {
  if (typeof value !== "object" || value === null) return false
  if (!("sub" in value) || typeof value.sub !== "string") return false
  if (!("scope" in value) || typeof value.scope !== "string") return false
  if (!("exp" in value) || typeof value.exp !== "number") return false
  if (!("iss" in value) || typeof value.iss !== "string") return false
  if (!("aud" in value) || typeof value.aud !== "string") return false
  if ("iat" in value && typeof value.iat !== "number") return false
  return true
}

// - `exp` is Unix seconds, and `now` keeps its milliseconds, so a token
//   counts as expired from the first millisecond of its `exp` second.
// - Native Date, not Luxon: this module is bundled into the Lambda
//   authorizer and stays dependency-free.
const isExpired = (claims: JwtPayload): boolean => {
  // eslint-disable-next-line no-restricted-syntax
  return claims.exp < Date.now() / 1000
}

/** The decoded payload of a token whose signature verifies under `secret`,
 *  with no claim checked yet; null when the signature or encoding is bad. */
const decodeVerifiedPayload = (token: string, secret: string): unknown => {
  // A valid JWT is exactly three base64url segments: header.payload.signature
  const parts = token.split(".")

  if (parts.length !== 3) return null
  const [header, payload, encodedSignature] = parts
  const hasEmptySegment = !header || !payload || !encodedSignature

  if (hasEmptySegment) return null

  // The header's `alg` is never read: every token is checked as HS256, and
  // the signature covers the header, so a token claiming another `alg` fails.
  const expectedSignature = computeHmacSha256(`${header}.${payload}`, secret)
  const signature = Buffer.from(encodedSignature, "base64url")

  if (signature.length !== expectedSignature.length) return null
  if (!timingSafeEqual(signature, expectedSignature)) return null

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString())
  } catch {
    return null
  }
}

/** Checks the signature, then the deployment binding (`iss` and `aud` equal
 *  the expected values), and only then reports expiry. */
export const verifyJwtReportingExpiry = ({
  token,
  secret,
  expectedIssuer,
  expectedAudience,
}: VerifyJwtOptions): DeploymentJwtVerification => {
  const decoded = decodeVerifiedPayload(token, secret)

  if (!isJwtPayload(decoded)) return { status: "invalid" }
  if (decoded.iss !== expectedIssuer) return { status: "invalid" }
  if (decoded.aud !== expectedAudience) return { status: "invalid" }
  if (isExpired(decoded)) return { status: "expired", payload: decoded }
  return { status: "valid", payload: decoded }
}

/** The payload of a correctly signed and bound JWT; null when the token is
 *  invalid or expired. */
export const verifyJwt = (options: VerifyJwtOptions): JwtPayload | null => {
  const verification = verifyJwtReportingExpiry(options)

  if (verification.status !== "valid") return null
  return verification.payload
}

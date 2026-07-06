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

export type JwtPayload = {
  sub: string
  scope: string
  exp: number
  iss: string
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

const isJwtPayload = (value: unknown): value is JwtPayload => {
  return (
    typeof value === "object" &&
    value !== null &&
    "sub" in value &&
    typeof value.sub === "string" &&
    "scope" in value &&
    typeof value.scope === "string" &&
    "exp" in value &&
    typeof value.exp === "number" &&
    "iss" in value &&
    typeof value.iss === "string"
  )
}

export const verifyJwt = (token: string, secret: string): JwtPayload | null => {
  // A valid JWT is exactly three base64url segments: header.payload.signature
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const header = parts[0]
  const payload = parts[1]
  const sig = parts[2]
  if (header === undefined || payload === undefined || sig === undefined)
    return null

  const expected = hmac(`${header}.${payload}`, secret)

  const sigBuf = Buffer.from(sig, "base64url")
  const expBuf = Buffer.from(expected, "base64url")
  if (sigBuf.length !== expBuf.length) return null
  if (!timingSafeEqual(sigBuf, expBuf)) return null

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    )
    if (!isJwtPayload(decoded)) return null
    // Reject expired tokens (exp is Unix seconds)
    if (decoded.exp < Date.now() / 1000) return null
    return decoded
  } catch {
    return null
  }
}

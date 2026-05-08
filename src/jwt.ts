/** Minimal JWT (HS256) sign/verify — shared by Lambda authorizer and Express. */

import { createHmac } from "node:crypto"

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

export const verifyJwt = (token: string, secret: string): JwtPayload | null => {
  const parts = token.split(".")
  if (parts.length !== 3) return null

  const [header, payload, sig] = parts as [string, string, string]
  const expected = hmac(`${header}.${payload}`, secret)

  if (sig.length !== expected.length) return null
  const sigBuf = Buffer.from(sig, "base64url")
  const expBuf = Buffer.from(expected, "base64url")
  if (sigBuf.length !== expBuf.length) return null

  let match = 0
  for (let i = 0; i < sigBuf.length; i++) match |= sigBuf[i]! ^ expBuf[i]!
  if (match !== 0) return null

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as JwtPayload
    if (typeof decoded.exp === "number" && decoded.exp < Date.now() / 1000) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

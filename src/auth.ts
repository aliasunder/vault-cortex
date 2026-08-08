/** Shared bearer-token auth utilities — used by both the Lambda authorizer and Express middleware. */

import { timingSafeEqual } from "node:crypto"
import type { Request } from "express"

/** Constant-time string comparison. Compares against itself on length mismatch to avoid timing leaks. */
export const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a, "utf8")
  const bBuf = Buffer.from(b, "utf8")
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf) // burn the same CPU time to prevent length-based timing leaks
    return false
  }
  return timingSafeEqual(aBuf, bBuf)
}

/** Coerces multi-value Express headers (string[]) to a single string. */
export const headerAsString = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value)

/** Extracts the token from an `Authorization: Bearer <token>` header. Case-insensitive prefix. */
export const parseBearer = (header: string | undefined): string | null => {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/**
 * Real client IP for logging and rate limiting. API Gateway conveys the
 * client IP in the RFC 7239 Forwarded header, which Express never reads —
 * behind the gateway, req.ip resolves to a gateway egress node (verified
 * live against AWS's published API_GATEWAY ranges), so every consumer of
 * a client IP must extract from Forwarded first and fall back to req.ip.
 * With duplicate Forwarded headers Node joins values with ", " and the
 * first `for=` element is the original client per RFC 7239.
 */
export const extractClientIp = (
  req: Pick<Request, "headers" | "ip">,
): string => {
  const forwarded = req.headers["forwarded"]
  if (forwarded) {
    const match = /for="?([^";,]+)"?/i.exec(forwarded)
    if (match?.[1]) return match[1]
  }
  return req.ip ?? "unknown"
}

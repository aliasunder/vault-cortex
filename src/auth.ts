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

/** Bare or quoted `for=` value; capture stops at `"`, `;`, or `,`. */
const FORWARDED_FOR_CLIENT = /for="?([^";,]+)"?/i

/**
 * Real client IP for logging and rate limiting. API Gateway sends it in
 * the RFC 7239 Forwarded header, which Express never reads — behind the
 * gateway, req.ip is the gateway's own egress node. The first `for=`
 * element is the original client (proxies append); req.ip is the
 * fallback for proxies that don't send Forwarded.
 */
export const extractClientIp = (
  req: Pick<Request, "headers" | "ip">,
): string => {
  const forwarded = req.headers["forwarded"]
  if (forwarded) {
    const match = FORWARDED_FOR_CLIENT.exec(forwarded)
    if (match?.[1]) return match[1]
  }
  return req.ip ?? "unknown"
}

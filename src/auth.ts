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
 * The last `for=` value in an RFC 7239 Forwarded header — the claim of the
 * proxy closest to the server. Walking right-to-left matters: a client can
 * prepend its own elements, so the first `for=` is attacker-controlled
 * whenever the edge proxy appends (as API Gateway does) rather than
 * replaces. The last element is the edge proxy's own claim either way.
 */
const lastForwardedClientIp = (forwarded: string): string | undefined => {
  const elements = forwarded.split(",")
  for (let index = elements.length - 1; index >= 0; index--) {
    const match = FORWARDED_FOR_CLIENT.exec(elements[index] ?? "")
    if (match?.[1]) return match[1]
  }
  return undefined
}

/**
 * Real client IP for logging and rate limiting. When `trustForwardedHeader`
 * is set, the deployment has a trusted edge proxy (API Gateway) that sets or
 * appends the RFC 7239 Forwarded header, and the last `for=` element is that
 * proxy's claim about the client. When unset, the header is
 * attacker-controlled and ignored entirely — req.ip, itself governed by the
 * server's trust-proxy hop count, is the only source.
 */
export const extractClientIp = (
  req: Pick<Request, "headers" | "ip">,
  trustForwardedHeader: boolean,
): string => {
  if (trustForwardedHeader) {
    // Node's HTTP parser joins duplicate header lines into one string, but
    // middleware or custom stacks can deliver an array instead — join
    // explicitly so the right-to-left walk spans every line, never just the
    // first.
    const forwardedHeader = req.headers["forwarded"]
    const forwarded = Array.isArray(forwardedHeader)
      ? forwardedHeader.join(", ")
      : forwardedHeader
    if (forwarded) {
      const clientIp = lastForwardedClientIp(forwarded)
      if (clientIp) return clientIp
    }
  }
  return req.ip ?? "unknown"
}

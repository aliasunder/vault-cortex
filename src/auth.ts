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
 * The `for=` value `hops` elements from the end of an RFC 7239 Forwarded
 * header. Counting from the end matters: a client can prepend its own
 * elements whenever the edge proxy appends (as API Gateway does) rather
 * than replaces, so only the trailing elements are proxy-written. A chain
 * shorter than `hops` yields its first element — the same rule Express
 * applies to X-Forwarded-For when every hop is trusted.
 */
const forwardedClientIpBehindHops = (
  forwarded: string,
  hops: number,
): string | undefined => {
  const forValues = forwarded
    .split(",")
    .map((element) => FORWARDED_FOR_CLIENT.exec(element)?.[1])
    .filter((forValue) => forValue !== undefined)
  const clientIndex = Math.max(0, forValues.length - hops)
  return forValues[clientIndex]
}

/**
 * Real client IP for logging and rate limiting.
 *
 * `trustForwardedHops` is how many trailing `for=` elements of the RFC 7239
 * Forwarded header (https://www.rfc-editor.org/rfc/rfc7239) were written by
 * proxies the deployment controls — the same shape as Express's `trust
 * proxy` hop count for X-Forwarded-For. Any client can send a `Forwarded`
 * header, so it is only safe to read when the proxy connecting to this
 * server writes it.
 *
 * - `0` — ignore the header entirely.
 * - `1` — one trusted proxy; its appended peer is the client.
 * - `2` — a CDN fronts the proxy; the peer is the CDN and the client is
 *   the element before it.
 */
export const extractClientIp = (
  req: Pick<Request, "headers" | "ip">,
  trustForwardedHops: number,
): string => {
  if (trustForwardedHops > 0) {
    // Node's HTTP parser joins duplicate header lines into one string, but
    // middleware or custom stacks can deliver an array instead — join
    // explicitly so the element count spans every line, never just the
    // first.
    const forwardedHeader = req.headers["forwarded"]
    const forwarded = Array.isArray(forwardedHeader)
      ? forwardedHeader.join(", ")
      : forwardedHeader
    if (forwarded) {
      const clientIp = forwardedClientIpBehindHops(
        forwarded,
        trustForwardedHops,
      )
      if (clientIp) return clientIp
    }
  }
  return req.ip ?? "unknown"
}

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

/**
 * An RFC 8707 resource identifier in the canonical form the MCP spec
 * defines for a server URI: lowercase scheme and host (URL parsing does
 * that), default port dropped, no query, no fragment, no trailing slash.
 * Both sides of an audience comparison pass through this, so a client
 * that sends `…/mcp/` still matches a server that mints `…/mcp`.
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#canonical-server-uri
 */
export const canonicalResourceUri = (resource: URL): string => {
  const pathWithoutTrailingSlash = resource.pathname.replace(/\/+$/, "")
  return `${resource.origin}${pathWithoutTrailingSlash}`
}

/** The MCP endpoint's URL, derived from a deployment's public URL. Resolved
 *  as an absolute path, so a path prefix on the public URL is not carried
 *  over. */
export const mcpResourceUrl = (serverUrl: URL): URL =>
  new URL("/mcp", serverUrl)

export type TokenBinding = {
  /** The `iss` claim: the issuer URL as the metadata advertises it. */
  issuer: string
  /** The `aud` claim: the MCP endpoint's canonical resource URI. */
  audience: string
}

/**
 * The claims that tie an access token to one deployment. Express mints
 * them and the Lambda authorizer checks them, each from its own copy of
 * PUBLIC_URL, so both must come from this one derivation.
 */
export const tokenBindingForServer = (serverUrl: URL): TokenBinding => ({
  issuer: serverUrl.href,
  audience: canonicalResourceUri(mcpResourceUrl(serverUrl)),
})

/** Extracts the token from an `Authorization: Bearer <token>` header. Case-insensitive prefix. */
export const parseBearer = (header: string | undefined): string | null => {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/** Bare or quoted `for=` value; capture stops at `"`, `;`, or `,`. */
const FORWARDED_FOR_CLIENT = /for="?([^";,]+)"?/i

/**
 * RFC 7239 §6 node value: a bracketed IPv6 address (`[2001:db8::17]`) or
 * an IPv4 address / obfuscated identifier, either followed by an optional
 * `:port`. `ipv6` captures the address without its brackets; `ipv4` the
 * unbracketed form. A value with more than one colon and no brackets is
 * not a node (a bare IPv6 from a non-compliant proxy) and does not match.
 * The regex is the floor here: `URL.parse` keeps the brackets on an IPv6
 * hostname.
 */
const FORWARDED_NODE = /^(?:\[(?<ipv6>[^\]]+)\]|(?<ipv4>[^:]+))(?::[^:]*)?$/

/**
 * The address part of an RFC 7239 node: brackets and port stripped, so an
 * IPv6 visitor keys the rate limiter and logs the same way an IPv4 visitor
 * does. A value that is not a well-formed node is returned unchanged.
 */
const forwardedNodeAddress = (forValue: string): string => {
  const node = FORWARDED_NODE.exec(forValue)?.groups
  if (!node) return forValue
  // "[2001:db8::17]:4711" → "2001:db8::17"
  if (node.ipv6) return node.ipv6
  // "203.0.113.7:4711" → "203.0.113.7"
  if (node.ipv4) return node.ipv4
  return forValue
}

/**
 * The client's `for=` value in an RFC 7239 Forwarded header, counting
 * `hops` elements back from the end. The proxy that writes the header
 * appends its own peer last, so with one trusted proxy the client is the
 * last element; with a CDN in front of that proxy the last element is the
 * CDN and the client is the one before it:
 *
 *     for=203.0.113.7, for=172.69.1.1        hops=1 → 172.69.1.1 (the CDN)
 *     ^ client          ^ CDN                 hops=2 → 203.0.113.7 (the client)
 *
 * Counting from the end matters: a client can prepend its own elements
 * whenever the edge proxy appends (as API Gateway does) rather than
 * replaces, so only the trailing elements are proxy-written. A chain
 * shorter than `hops` yields its first element — the same rule Express
 * applies to X-Forwarded-For when every hop is trusted.
 */
const forwardedClientIpBehindHops = ({
  forwarded,
  hops,
}: {
  forwarded: string
  hops: number
}): string | undefined => {
  const forValues = forwarded
    .split(",")
    .map((element) => FORWARDED_FOR_CLIENT.exec(element)?.[1])
    .filter((forValue) => forValue !== undefined)
    .map(forwardedNodeAddress)
  // hops=1 is the last element, hops=2 the one before it, and so on; a
  // chain shorter than hops clamps to the first element.
  const clientIndexFromStart = forValues.length - hops
  const clientIndex = Math.max(0, clientIndexFromStart)
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
      const clientIp = forwardedClientIpBehindHops({
        forwarded,
        hops: trustForwardedHops,
      })
      if (clientIp) return clientIp
    }
  }
  return req.ip ?? "unknown"
}

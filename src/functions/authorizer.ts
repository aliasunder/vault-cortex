/**
 * Smart Lambda authorizer for API Gateway HTTP API (payload format 2.0).
 *
 * Path-aware: OAuth discovery endpoints pass through unauthenticated
 * (required by the MCP/OAuth spec). All other paths validate the
 * bearer token — accepts both the static McpAuthToken and JWT access
 * tokens signed with it (defense in depth with Express).
 *
 * Key facts:
 *   - API Gateway HTTP API v2 LOWERCASES all header names.
 *   - Simple response format: just return { isAuthorized: boolean }.
 *   - `event.rawPath` gives the request path without query string.
 */

import { Resource } from "sst"
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda"
import { safeEqual, parseBearer } from "../auth.js"
import { verifyJwt } from "../jwt.js"

const OPEN_PATH_PREFIXES = [
  "/.well-known/",
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/oauth/",
  "/healthz",
]

const isOpenPath = (path: string): boolean =>
  OPEN_PATH_PREFIXES.some((p) => path === p || path.startsWith(p))

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<{ isAuthorized: boolean }> => {
  const path = event.rawPath ?? "/"

  if (isOpenPath(path)) {
    return { isAuthorized: true }
  }

  const token = parseBearer(event.headers?.authorization)
  if (!token) {
    console.warn("auth_failed: missing or malformed Authorization header", {
      path,
    })
    return { isAuthorized: false }
  }

  const secret = Resource.McpAuthToken.value
  if (!secret) {
    console.error("auth_failed: McpAuthToken secret is empty")
    return { isAuthorized: false }
  }

  if (safeEqual(token, secret)) {
    return { isAuthorized: true }
  }

  if (verifyJwt(token, secret)) {
    return { isAuthorized: true }
  }

  console.warn("auth_failed: token invalid", { path })
  return { isAuthorized: false }
}

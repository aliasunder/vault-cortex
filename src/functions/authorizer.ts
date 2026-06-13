/**
 * Lambda authorizer for API Gateway HTTP API (payload format 2.0).
 *
 * Attached only to protected routes (see sst.config.ts) — the OAuth
 * discovery endpoints are separate unauthenticated routes that never
 * invoke this Lambda. Validates the bearer token: accepts both the
 * static McpAuthToken and JWT access tokens signed with it (defense
 * in depth with Express).
 *
 * The route config registers the Authorization header as the identity
 * source, so API Gateway answers tokenless requests with an automatic
 * 401 BEFORE invoking this Lambda — that 401 is what lets MCP clients
 * enter the OAuth connect flow (a Lambda deny is a fixed 403 that HTTP
 * APIs cannot customize, which clients treat as a broken server).
 * The open-path branch below is therefore dead code in the current
 * wiring (open routes never invoke this Lambda). The parse-failure
 * branch stays reachable: the identity source only requires the header
 * to be present, so a malformed Authorization header (e.g. "Basic …")
 * still reaches parseBearer and is denied there. Both are kept as
 * defense in depth in case the wiring ever changes.
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
import { logger as rootLogger } from "../logger.js"

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
  const requestId = event.requestContext?.requestId
  const sourceIp = event.requestContext?.http?.sourceIp
  const logger = rootLogger.child({ requestId, sourceIp, path })

  if (isOpenPath(path)) {
    return { isAuthorized: true }
  }

  const token = parseBearer(event.headers?.authorization)
  if (!token) {
    logger.warn("auth_failed: missing or malformed Authorization header")
    return { isAuthorized: false }
  }

  const secret = Resource.McpAuthToken.value
  if (!secret) {
    logger.error("auth_failed: McpAuthToken secret is empty")
    return { isAuthorized: false }
  }

  if (safeEqual(token, secret)) {
    logger.info("auth_success", { method: "static" })
    return { isAuthorized: true }
  }

  if (verifyJwt(token, secret)) {
    logger.info("auth_success", { method: "jwt" })
    return { isAuthorized: true }
  }

  logger.warn("auth_failed: token invalid")
  return { isAuthorized: false }
}

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
import env from "env-var"
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda"
import { safeEqual, parseBearer, tokenBindingForServer } from "../auth.js"
import { urlHasCredentials } from "../utils/url-has-credentials.js"
import { classifyDeploymentJwt, verifyLegacyJwt } from "../jwt.js"
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
  OPEN_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))

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

  // sst.config.ts gives this function the same PUBLIC_URL that Express uses.
  const publicUrl = env.get("PUBLIC_URL").asString()

  if (!publicUrl) {
    logger.error("auth_failed: PUBLIC_URL is empty")
    return { isAuthorized: false }
  }
  // A value that is not a URL must deny, not throw: a throw here is a
  // gateway 500 with no auth_failed line to find.
  const serverUrl = URL.parse(publicUrl)

  if (!serverUrl) {
    logger.error("auth_failed: PUBLIC_URL is not a URL")
    return { isAuthorized: false }
  }
  // Credentials in the URL would become part of the expected `iss`
  // claim; the deploy validation rejects them, so a value carrying them
  // here is misconfiguration — deny rather than compare against it.
  if (urlHasCredentials(serverUrl)) {
    logger.error("auth_failed: PUBLIC_URL contains credentials")
    return { isAuthorized: false }
  }
  // The issuer is PUBLIC_URL with its normalized trailing slash; the audience
  // is that origin plus /mcp. A token from another deployment fails either
  // exact comparison even when both deployments share a secret.
  const { issuer: expectedIssuer, audience: expectedAudience } = tokenBindingForServer(serverUrl)
  const deploymentJwt = classifyDeploymentJwt({
    token,
    secret,
    expectedIssuer,
    expectedAudience,
  })

  if (deploymentJwt.status === "valid") {
    logger.info("auth_success", { method: "jwt" })
    return { isAuthorized: true }
  }

  // Express enforces expiry and returns the 401 challenge that prompts
  // clients to refresh. Every other JWT check still runs at both layers.
  if (deploymentJwt.status === "expired") {
    logger.info("auth_success", { method: "jwt-expired" })
    return { isAuthorized: true }
  }

  // A token minted before issuer and audience binding was added is
  // let through to Express, which rejects it with a 401 so the client
  // refreshes into a deployment-bound token. Denying it here would be a 403, which
  // clients never recover from on their own. Only tokens minted before
  // an upgrade can lack binding claims, so this path goes quiet within one
  // access-token TTL of upgrading.
  const legacyJwt = verifyLegacyJwt({ token, secret })

  if (legacyJwt) {
    logger.info("auth_success", { method: "jwt-legacy" })
    return { isAuthorized: true }
  }

  logger.warn("auth_failed: token invalid")
  return { isAuthorized: false }
}

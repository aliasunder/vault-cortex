/** OAuth HTTP routes — SDK auth router + consent form handler. */

import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js"
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import { extractClientIp, safeEqual } from "../../auth.js"
import type { ForwardedHeaderTrust } from "../../auth.js"
import { renderConsentPage } from "./consent-page.js"
import type { OAuthProvider } from "./oauth-provider.js"
import type { Logger } from "../../logger.js"

type OAuthRoutesOptions = {
  authToken: string
  serverUrl: URL
  oauthProvider: OAuthProvider
  serviceDocumentationUrl: string
  /** Whether — and how far from its end — the RFC 7239 Forwarded header
   *  is read for the client IP (rate limiting + logs); from
   *  TRUST_FORWARDED_HEADER and TRUST_FORWARDED_HOPS. Only trusted where a
   *  known edge proxy (API Gateway) sets or appends it. */
  forwardedHeaderTrust: ForwardedHeaderTrust
  logger: Logger
}

export const createOAuthRoutes = ({
  authToken,
  serverUrl,
  oauthProvider,
  serviceDocumentationUrl,
  forwardedHeaderTrust,
  logger,
}: OAuthRoutesOptions): Router => {
  const routeLogger = logger.child({ component: "oauth-routes" })
  const { provider, getPendingRequest, approveRequest, deletePendingRequest } =
    oauthProvider
  const router = Router()

  // 5 req/min per client IP on each flow endpoint (/authorize, /token,
  // /register, /revoke — each mounts its own limiter), far tighter than
  // the SDK's per-endpoint defaults: a complete OAuth flow touches each
  // endpoint at most twice per minute, so 5/min absorbs reconnect storms
  // while shutting down brute force. windowMs/max mirror the exact keys
  // the SDK sets before spreading this config, so the spread replaces
  // them outright. Don't rename `max` to `limit` (its modern alias):
  // the options would then carry both keys, with no guarantee ours wins.
  const rateLimit = {
    windowMs: 60 * 1000,
    max: 5,
    // Bucket by client IP via extractClientIp: when the deployment trusts
    // the Forwarded header (API Gateway), the gateway's claim is the key —
    // the library default (req.ip) would merge every client into a single
    // gateway-egress bucket. Elsewhere req.ip, governed by the server's
    // trust-proxy hop count, is the key.
    keyGenerator: (req: Request) => extractClientIp(req, forwardedHeaderTrust),
    // The default handler sends the 429 silently — log the offender, then
    // send the SDK's per-endpoint message unchanged. The query string is
    // stripped from the logged path (authorize carries client_id/state).
    handler: (
      req: Request,
      res: Response,
      _next: NextFunction,
      options: { statusCode: number; message: unknown },
    ) => {
      const requestPath =
        URL.parse(req.originalUrl, "http://localhost")?.pathname ??
        req.originalUrl
      routeLogger.warn("oauth_rate_limited", {
        clientIp: extractClientIp(req, forwardedHeaderTrust),
        path: requestPath,
      })
      res.status(options.statusCode).send(options.message)
    },
    validate: false as const,
  }

  const scopesSupported = ["vault"]

  // RFC 9728 §3.1: a metadata document's `resource` must equal the resource
  // identifier its well-known URL derives from, so this suffixed document
  // advertises <origin>/mcp rather than copying the root document. It is an
  // additive second mount (before mcpAuthRouter, via the SDK's own
  // metadataHandler so CORS/OPTIONS/405 behavior matches the root route)
  // because the SDK registers only ONE metadata path — steering it via
  // `resourceServerUrl` would move the route and break every client that
  // discovers via the root form.
  const mcpResourceMetadata: OAuthProtectedResourceMetadata = {
    resource: new URL("/mcp", serverUrl).href,
    authorization_servers: [serverUrl.href],
    scopes_supported: scopesSupported,
    resource_documentation: new URL(serviceDocumentationUrl).href,
  }
  router.use(
    "/.well-known/oauth-protected-resource/mcp",
    metadataHandler(mcpResourceMetadata),
  )

  // SDK-managed OAuth routes — /.well-known/*, /authorize, /token, /register, /revoke
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: serverUrl,
      serviceDocumentationUrl: new URL(serviceDocumentationUrl),
      scopesSupported,
      authorizationOptions: { rateLimit },
      clientRegistrationOptions: { rateLimit },
      revocationOptions: { rateLimit },
      tokenOptions: { rateLimit },
    }),
  )

  // Consent form submission (unauthenticated — part of authorize flow)
  router.post(
    "/oauth/decide",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const body: Record<string, unknown> = req.body
      const { request_id, token, action } = body
      const hasStringFields =
        typeof request_id === "string" &&
        typeof token === "string" &&
        typeof action === "string"
      if (!hasStringFields) {
        res.status(400).send("Invalid form submission.")
        return
      }
      const clientIp = extractClientIp(req, forwardedHeaderTrust)
      const pending = getPendingRequest(
        request_id,
        routeLogger.child({ clientIp, requestId: request_id }),
      )

      if (!pending) {
        routeLogger.warn("oauth_consent_expired", {
          clientIp,
          requestId: request_id,
        })
        res.status(400).send("Authorization request expired or invalid.")
        return
      }

      const clientId = pending.client.client_id
      const consentLogger = routeLogger.child({
        clientIp,
        requestId: request_id,
        clientId,
      })

      if (action !== "approve") {
        consentLogger.info("oauth_consent_denied_by_user")
        deletePendingRequest(request_id)
        const redirectUrl = new URL(pending.params.redirectUri)
        redirectUrl.searchParams.set("error", "access_denied")
        if (pending.params.state)
          redirectUrl.searchParams.set("state", pending.params.state)
        res.redirect(redirectUrl.toString())
        return
      }

      // Tolerate whitespace introduced when the token is copied from a
      // terminal: a 64-character token wraps across lines in a narrow
      // terminal, and selecting it captures the wrap as an embedded
      // newline (plus possible leading/trailing spaces). A valid
      // MCP_AUTH_TOKEN never contains whitespace, so stripping it is safe
      // and keeps the consent flow forgiving — mirroring the trim()
      // already applied to bearer-header auth in parseBearer().
      const submittedToken = token?.replace(/\s+/g, "") ?? ""
      if (!submittedToken || !safeEqual(submittedToken, authToken)) {
        consentLogger.warn("oauth_consent_bad_token")
        res.type("html").send(
          renderConsentPage({
            clientName: pending.client.client_name ?? pending.client.client_id,
            clientId,
            scopes: pending.params.scopes ?? [],
            requestId: request_id,
            error: "Invalid token. Please try again.",
          }),
        )
        return
      }

      const code = approveRequest(request_id, consentLogger)
      consentLogger.info("oauth_consent_completed")
      const redirectUrl = new URL(pending.params.redirectUri)
      redirectUrl.searchParams.set("code", code)
      if (pending.params.state)
        redirectUrl.searchParams.set("state", pending.params.state)
      res.redirect(redirectUrl.toString())
    },
  )

  return router
}

/** OAuth HTTP routes — SDK auth router + consent form handler. */

import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { ipKeyGenerator, rateLimit } from "express-rate-limit"
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js"
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"
import { extractClientIp, safeEqual, tokenBindingForServer } from "../../auth.js"
import { createAuthorizeGuard } from "./authorize-guard.js"
import { renderConsentPage } from "./consent-page.js"
import { VAULT_SCOPE, type OAuthProvider } from "./oauth-provider.js"
import type { Logger } from "../../logger.js"

type OAuthRoutesOptions = {
  authToken: string
  serverUrl: URL
  oauthProvider: OAuthProvider
  serviceDocumentationUrl: string
  /** How many trailing `for=` elements of the RFC 7239 Forwarded header
   *  (https://www.rfc-editor.org/rfc/rfc7239) were written by trusted
   *  proxies. With a value of N, the client IP used for rate limiting and
   *  logs is the Nth element from the end of that list; 0 ignores the
   *  header. The value comes from TRUST_FORWARDED_HOPS. Keep it at 0 unless
   *  a known edge proxy (API Gateway) writes or appends the header. */
  trustForwardedHops: number
  logger: Logger
}

// The largest registration a real client has stored is under 500 bytes; the
// consent-request cap (MAX_PENDING_REQUEST_PARAMS_BYTES) uses the same figure.
const REGISTRATION_BODY_LIMIT = "8kb"

export const createOAuthRoutes = ({
  authToken,
  serverUrl,
  oauthProvider,
  serviceDocumentationUrl,
  trustForwardedHops,
  logger,
}: OAuthRoutesOptions): Router => {
  const routeLogger = logger.child({ component: "oauth-routes" })
  const { provider, getPendingRequest, approveRequest, deletePendingRequest } = oauthProvider
  const router = Router()

  // 5 req/min per client IP on each flow endpoint (/authorize through its
  // guard, /token, /register, /revoke, /oauth/decide — each mounts its own
  // limiter), far
  // tighter than the SDK's per-endpoint defaults: a complete OAuth flow
  // touches each endpoint at most twice per minute, so 5/min absorbs
  // reconnect storms while shutting down brute force. windowMs/max mirror
  // the exact keys the SDK sets before spreading this config, so the spread
  // replaces them outright.
  const oauthRateLimitOptions = {
    windowMs: 60 * 1000,
    max: 5,
    // The key is the client IP from extractClientIp:
    // - With the Forwarded header trusted (trustForwardedHops > 0), it is
    //   the resolved visitor. The library default (req.ip) would put every
    //   client in one bucket, the gateway's egress address.
    // - Otherwise it is req.ip, set by the server's trust-proxy hop count.
    // - ipKeyGenerator keys an IPv6 address by its /56, as the library
    //   default does. One host often holds a /64 and could otherwise rotate
    //   through its addresses for a fresh budget on every request.
    keyGenerator: (req: Request) => ipKeyGenerator(extractClientIp(req, trustForwardedHops)),
    // The default handler sends the 429 silently — log the offender, then
    // send each limiter's own message unchanged. The query string is
    // stripped from the logged path (authorize carries client_id/state).
    handler: (
      req: Request,
      res: Response,
      _next: NextFunction,
      options: { statusCode: number; message: unknown },
    ) => {
      const requestPath =
        URL.parse(req.originalUrl, "http://localhost")?.pathname ?? req.originalUrl
      routeLogger.warn("oauth_rate_limited", {
        clientIp: extractClientIp(req, trustForwardedHops),
        path: requestPath,
      })
      res.status(options.statusCode).send(options.message)
    },
  }

  const scopesSupported = [VAULT_SCOPE]

  // The same derivation the provider mints tokens from, so metadata and
  // tokens can't disagree.
  const { issuer: serverRootUrl, audience: mcpEndpointUrl } = tokenBindingForServer(serverUrl)
  const mcpResourceMetadata: OAuthProtectedResourceMetadata = {
    resource: mcpEndpointUrl,
    authorization_servers: [serverRootUrl],
    scopes_supported: scopesSupported,
    resource_documentation: new URL(serviceDocumentationUrl).href,
  }

  // A second, path-suffixed metadata mount, separate from the SDK's root
  // document:
  // - RFC 9728 §3.1: a metadata document's `resource` must equal the
  //   resource identifier its well-known URL derives from — so this one
  //   advertises the /mcp resource instead of copying the root document.
  // - The SDK registers only ONE metadata path, so this is an additive
  //   second mount; steering the SDK via `resourceServerUrl` would move
  //   the route and break every client that discovers via the root form.
  // - The SDK's own metadataHandler serves it, so CORS/OPTIONS/405
  //   behavior matches the root route.
  router.use("/.well-known/oauth-protected-resource/mcp", metadataHandler(mcpResourceMetadata))

  // This document replaces the SDK's own:
  // - The SDK includes public-client auth, but our registrations require a secret.
  // - mcpAuthRouter below serves this path too. Express answers with the first
  //   matching route, so mounting this one first makes it the one clients get.
  router.use(
    "/.well-known/oauth-authorization-server",
    metadataHandler({
      ...createOAuthMetadata({
        provider,
        issuerUrl: serverUrl,
        serviceDocumentationUrl: new URL(serviceDocumentationUrl),
        scopesSupported,
      }),
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      revocation_endpoint_auth_methods_supported: ["client_secret_post"],
    }),
  )

  // Ahead of the SDK's /authorize handler: it carries that endpoint's rate
  // limit (the SDK's own is off below, so a request is counted once), shows
  // a person whose client registration is gone how to reconnect, and
  // answers every error the SDK would otherwise redirect to the client's
  // registered address.
  router.use(
    "/authorize",
    createAuthorizeGuard({
      rateLimitOptions: oauthRateLimitOptions,
      clientsStore: provider.clientsStore,
      trustForwardedHops,
      logger,
    }),
  )

  // Ahead of the SDK's /register handler, whose own JSON parser accepts 100 KB
  // and whose metadata schema caps no field. The SDK's parser finds the body
  // already read and keeps it. /register needs no sign-in, so without the cap
  // anyone could store 100 KB per registration until the sweep ran.
  router.post("/register", express.json({ limit: REGISTRATION_BODY_LIMIT }))

  // SDK-managed OAuth routes — /.well-known/*, /authorize, /token, /register, /revoke
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: serverUrl,
      serviceDocumentationUrl: new URL(serviceDocumentationUrl),
      scopesSupported,
      authorizationOptions: { rateLimit: false },
      clientRegistrationOptions: { rateLimit: oauthRateLimitOptions },
      revocationOptions: { rateLimit: oauthRateLimitOptions },
      tokenOptions: { rateLimit: oauthRateLimitOptions },
    }),
  )

  // No consent decision response may be cached: the re-rendered page holds the
  // request ID, and the redirect holds the authorization code. Mounted ahead of
  // the form parser so the response to a parser error, such as an oversized
  // form, carries it too.
  router.use("/oauth/decide", (_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "no-store")
    next()
  })

  /**
   * - Token guesses are limited before the form parser, so rejected submissions need no parsing.
   * - The header options match the SDK's OAuth limiters.
   */
  const consentDecisionLimiter = rateLimit({
    ...oauthRateLimitOptions,
    standardHeaders: true,
    legacyHeaders: false,
  })

  // Consent form submission (unauthenticated — part of authorize flow)
  router.post(
    "/oauth/decide",
    consentDecisionLimiter,
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const formFields: Record<string, unknown> = req.body ?? {}
      const { request_id: requestId, token, action } = formFields

      /** The form submits all three fields for either action; only approval checks the token. */
      const hasStringFields =
        typeof requestId === "string" && typeof token === "string" && typeof action === "string"

      if (!hasStringFields) {
        res.status(400).send("Invalid form submission.")
        return
      }

      const clientIp = extractClientIp(req, trustForwardedHops)
      const pendingRequest = getPendingRequest(
        requestId,
        routeLogger.child({ clientIp, requestId }),
      )

      if (!pendingRequest) {
        routeLogger.warn("oauth_consent_expired", {
          clientIp,
          requestId,
        })
        res.status(400).send("Authorization request expired or invalid.")
        return
      }

      const clientId = pendingRequest.client.client_id
      const consentLogger = routeLogger.child({
        clientIp,
        requestId,
        clientId,
      })

      // Any action but an explicit Approve denies, so an unexpected form
      // value can never grant access.
      if (action !== "approve") {
        consentLogger.info("oauth_consent_denied_by_user")
        deletePendingRequest(requestId)
        const redirectUrl = new URL(pendingRequest.params.redirectUri)
        redirectUrl.searchParams.set("error", "access_denied")
        if (pendingRequest.params.state) {
          redirectUrl.searchParams.set("state", pendingRequest.params.state)
        }
        res.redirect(redirectUrl.toString())
        return
      }

      // Tolerate whitespace introduced when the token is copied from a
      // terminal: a 64-character token wraps across lines in a narrow
      // terminal, and selecting it captures the wrap as an embedded
      // newline (plus possible leading/trailing spaces). A valid
      // MCP_AUTH_TOKEN never contains whitespace, so stripping all of it is
      // safe and keeps the consent flow forgiving. parseBearer() trims only
      // the ends of a bearer header, which carries no line wrap.
      const submittedToken = token.replace(/\s+/g, "")
      const hasValidToken = Boolean(submittedToken) && safeEqual(submittedToken, authToken)

      if (!hasValidToken) {
        consentLogger.warn("oauth_consent_bad_token")
        res.type("html").send(
          renderConsentPage({
            clientName: pendingRequest.client.client_name,
            clientId,
            redirectUri: pendingRequest.params.redirectUri,
            requestId,
            error: "Invalid token. Please try again.",
          }),
        )
        return
      }

      const code = approveRequest(requestId, consentLogger)
      consentLogger.info("oauth_consent_completed")
      const redirectUrl = new URL(pendingRequest.params.redirectUri)
      redirectUrl.searchParams.set("code", code)
      if (pendingRequest.params.state) {
        redirectUrl.searchParams.set("state", pendingRequest.params.state)
      }
      res.redirect(redirectUrl.toString())
    },
  )

  return router
}

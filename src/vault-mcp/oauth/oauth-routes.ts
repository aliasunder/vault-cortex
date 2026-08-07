/** OAuth HTTP routes — SDK auth router + consent form handler. */

import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { safeEqual } from "../../auth.js"
import { renderConsentPage } from "./consent-page.js"
import type { OAuthProvider } from "./oauth-provider.js"
import type { Logger } from "../../logger.js"

type OAuthRoutesOptions = {
  authToken: string
  serverUrl: URL
  oauthProvider: OAuthProvider
  serviceDocumentationUrl: string
  logger: Logger
}

export const createOAuthRoutes = ({
  authToken,
  serverUrl,
  oauthProvider,
  serviceDocumentationUrl,
  logger,
}: OAuthRoutesOptions): Router => {
  const routeLogger = logger.child({ component: "oauth-routes" })
  const { provider, getPendingRequest, approveRequest, deletePendingRequest } =
    oauthProvider
  const router = Router()

  // API Gateway sends the real client IP in the RFC 7239 Forwarded header,
  // but Express only reads X-Forwarded-For. Extract from Forwarded first,
  // falling back to req.ip. Used by both rate limiting and audit logging
  // so both identify the same client.
  const extractClientIp = (req: Request): string => {
    const forwarded = req.headers["forwarded"]
    if (forwarded) {
      const match = /for="?([^";,]+)"?/i.exec(forwarded)
      if (match?.[1]) return match[1]
    }
    return req.ip ?? "unknown"
  }

  // Explicit 5 req/min per client IP on each flow endpoint (/authorize,
  // /token, /register, /revoke — each mounts its own limiter). The SDK's
  // per-endpoint defaults are far looser (authorize 100/15 min, token +
  // revoke 50/15 min, register 20/hr); for a single-user server a
  // complete OAuth flow touches each endpoint at most twice per minute,
  // so 5/min absorbs client reconnect storms while shutting down brute
  // force.
  // windowMs/max are the exact keys the SDK sets before spreading this
  // config — overriding them (rather than `limit`) leaves no dual-key
  // ambiguity about which value wins.
  const rateLimit = {
    windowMs: 60 * 1000,
    max: 5,
    keyGenerator: extractClientIp,
    // A tripped limiter is silent by default — express-rate-limit just
    // sends the 429 — yet it's the brute-force signal the limit exists
    // to catch. Log the offender, then send the SDK's per-endpoint 429
    // message exactly as the default handler would. The path comes from
    // originalUrl with the query string stripped: authorize carries
    // client_id/state in its query, which doesn't belong in logs.
    handler: (
      req: Request,
      res: Response,
      _next: NextFunction,
      options: { statusCode: number; message: unknown },
    ) => {
      const requestPath = req.originalUrl.split("?")[0] ?? req.originalUrl
      routeLogger.warn("oauth_rate_limited", {
        clientIp: extractClientIp(req),
        path: requestPath,
      })
      res.status(options.statusCode).send(options.message)
    },
    validate: false as const,
  }

  // SDK-managed OAuth routes — /.well-known/*, /authorize, /token, /register, /revoke
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: serverUrl,
      serviceDocumentationUrl: new URL(serviceDocumentationUrl),
      scopesSupported: ["vault"],
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
      const clientIp = extractClientIp(req)
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

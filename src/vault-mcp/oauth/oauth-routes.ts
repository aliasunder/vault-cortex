/** OAuth HTTP routes — SDK auth router + consent form handler. */

import express, { Router } from "express"
import type { Request, Response } from "express"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { safeEqual } from "../../auth.js"
import { renderConsentPage } from "./consent-page.js"
import type { OAuthProvider } from "./oauth-provider.js"
import type { Logger } from "../../logger.js"

export type OAuthRoutesOptions = {
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

  const rateLimit = {
    keyGenerator: extractClientIp,
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
      const { request_id, token, action } = req.body as Record<string, string>
      const clientIp = extractClientIp(req)
      const pending = getPendingRequest(request_id)

      if (!pending) {
        routeLogger.warn("oauth_consent_expired", {
          clientIp,
          requestId: request_id,
        })
        res.status(400).send("Authorization request expired or invalid.")
        return
      }

      const clientId = pending.client.client_id

      if (action !== "approve") {
        routeLogger.info("oauth_consent_denied_by_user", {
          clientIp,
          requestId: request_id,
          clientId,
        })
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
        routeLogger.warn("oauth_consent_bad_token", {
          clientIp,
          requestId: request_id,
          clientId,
        })
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

      const code = approveRequest(request_id)
      routeLogger.info("oauth_consent_completed", {
        clientIp,
        requestId: request_id,
        clientId,
      })
      const redirectUrl = new URL(pending.params.redirectUri)
      redirectUrl.searchParams.set("code", code)
      if (pending.params.state)
        redirectUrl.searchParams.set("state", pending.params.state)
      res.redirect(redirectUrl.toString())
    },
  )

  return router
}

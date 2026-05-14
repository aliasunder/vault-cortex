/** OAuth HTTP routes — SDK auth router + consent form handler. */

import express, { Router } from "express"
import type { Request, Response } from "express"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { safeEqual } from "../../auth.js"
import { renderConsentPage } from "./consent-page.js"
import type { OAuthProvider } from "./oauth-provider.js"

export type OAuthRoutesOptions = {
  authToken: string
  serverUrl: URL
  oauthProvider: OAuthProvider
}

export const createOAuthRoutes = ({
  authToken,
  serverUrl,
  oauthProvider,
}: OAuthRoutesOptions): Router => {
  const { provider, getPendingRequest, approveRequest, deletePendingRequest } =
    oauthProvider
  const router = Router()

  // Rate limiting for OAuth endpoints (SDK default: 5 req/min per IP).
  // API Gateway sends the real client IP in the Forwarded header, but
  // express-rate-limit doesn't parse it by default — so we extract it
  // here. Validation suppressed because we handle proxy headers ourselves.
  const rateLimitKeyGenerator = (req: Request): string => {
    const forwarded = req.headers["forwarded"]
    if (forwarded) {
      const match = /for="?([^";,]+)"?/i.exec(forwarded)
      if (match?.[1]) return match[1]
    }
    return req.ip ?? "unknown"
  }

  const rateLimit = {
    keyGenerator: rateLimitKeyGenerator,
    validate: false as const,
  }

  // SDK-managed OAuth routes — /.well-known/*, /authorize, /token, /register, /revoke
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: serverUrl,
      serviceDocumentationUrl: new URL(
        "https://github.com/aliasunder/vault-cortex",
      ),
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
      const pending = getPendingRequest(request_id)

      if (!pending) {
        res.status(400).send("Authorization request expired or invalid.")
        return
      }

      if (action !== "approve") {
        deletePendingRequest(request_id)
        const redirectUrl = new URL(pending.params.redirectUri)
        redirectUrl.searchParams.set("error", "access_denied")
        if (pending.params.state)
          redirectUrl.searchParams.set("state", pending.params.state)
        res.redirect(redirectUrl.toString())
        return
      }

      if (!token || !safeEqual(token, authToken)) {
        res.type("html").send(
          renderConsentPage({
            clientName: pending.client.client_name ?? pending.client.client_id,
            clientId: pending.client.client_id,
            scopes: pending.params.scopes ?? [],
            requestId: request_id,
            error: "Invalid token. Please try again.",
          }),
        )
        return
      }

      const code = approveRequest(request_id)
      const redirectUrl = new URL(pending.params.redirectUri)
      redirectUrl.searchParams.set("code", code)
      if (pending.params.state)
        redirectUrl.searchParams.set("state", pending.params.state)
      res.redirect(redirectUrl.toString())
    },
  )

  return router
}

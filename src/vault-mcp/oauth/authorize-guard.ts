/** The /authorize guard — mounted ahead of the SDK's authorization handler.
 *  It counts every request against the endpoint's rate limit, shows a page
 *  when the client's registration is gone, then turns each error redirect
 *  the SDK would send into a direct response. */

import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { rateLimit, type Options as RateLimitOptions } from "express-rate-limit"
import { TooManyRequestsError } from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js"
import { extractClientIp } from "../../auth.js"
import type { Logger } from "../../logger.js"
import { renderUnknownClientPage } from "./unknown-client-page.js"

type AuthorizeGuardOptions = {
  /** The window, limit, key and 429 handler every OAuth endpoint shares. */
  rateLimitOptions: Partial<RateLimitOptions>
  clientsStore: OAuthRegisteredClientsStore
  trustForwardedHops: number
  logger: Logger
}

/** The client_id of a GET's query or a POST's form, when the request names one. */
const requestedClientId = (req: Request): string | undefined => {
  const params: unknown = req.method === "POST" ? req.body : req.query
  const clientId =
    typeof params === "object" && params !== null && "client_id" in params
      ? params.client_id
      : undefined
  return typeof clientId === "string" && clientId ? clientId : undefined
}

/** The redirect the SDK builds, read back as the response it becomes. */
type RedirectedError = {
  status: 400 | 500
  body: { error: string; error_description: string; error_uri?: string }
}

// The SDK's catch-all code for a thrown non-OAuth exception; every other
// code reports a bad request.
const SERVER_ERROR_CODE = "server_error"

const DEFAULT_ERROR_DESCRIPTION = "Invalid authorization request"

/** Reads the OAuth error out of the redirect URL the SDK built. A redirect
 *  that names no error is refused all the same, so no redirect a later SDK
 *  version adds can send the visitor on to the client's address. */
const redirectedErrorFromUrl = (redirectUrl: string | undefined): RedirectedError => {
  const parsedUrl = redirectUrl ? URL.parse(redirectUrl) : null
  const errorCode = parsedUrl?.searchParams.get("error")

  if (!parsedUrl || !errorCode) {
    return {
      status: 400,
      body: { error: "invalid_request", error_description: DEFAULT_ERROR_DESCRIPTION },
    }
  }
  const errorUri = parsedUrl.searchParams.get("error_uri")
  const errorDescription = parsedUrl.searchParams.get("error_description")

  return {
    status: errorCode === SERVER_ERROR_CODE ? 500 : 400,
    body: {
      error: errorCode,
      error_description: errorDescription ?? DEFAULT_ERROR_DESCRIPTION,
      ...(errorUri ? { error_uri: errorUri } : {}),
    },
  }
}

/** On /authorize a valid request only renders the consent page; the SDK
 *  redirects only to report an error to the client's registered address.
 *  Anyone can register an address, so such a redirect would send a visitor
 *  from this server's domain to any site. The guard answers the error here
 *  instead (RFC 9700 §4.11.2 permits refusing to redirect). */
export const createAuthorizeGuard = ({
  rateLimitOptions,
  clientsStore,
  trustForwardedHops,
  logger,
}: AuthorizeGuardOptions): Router => {
  const guard = Router()

  // Replaces the SDK's own /authorize limiter, which sits behind this guard
  // and would otherwise never see a request the guard answers. The message
  // and header options are copied from the SDK's authorizationHandler, so
  // the 429 is unchanged for clients.
  guard.use(
    rateLimit({
      ...rateLimitOptions,
      standardHeaders: true,
      legacyHeaders: false,
      message: new TooManyRequestsError(
        "You have exceeded the rate limit for authorization requests",
      ).toResponseObject(),
    }),
  )

  // The unknown-client check below reads a POST's client_id from its form.
  // The SDK's handler parses the form too; its parser finds the body
  // already read and keeps it.
  guard.use(express.urlencoded({ extended: false }))

  // A browser reaches this page when the MCP client that opened the browser
  // holds a client_id the server no longer stores: the server's data was
  // reset, or the registration never signed in and was swept. The SDK would
  // answer a JSON error the person cannot act on.
  guard.use(async (req: Request, res: Response, next: NextFunction) => {
    const clientId = requestedClientId(req)

    // A request that names no client is left to the SDK, whose JSON error
    // is read by a client, not a person.
    if (!clientId) {
      next()
      return
    }
    const client = await clientsStore.getClient(clientId)

    if (client) {
      next()
      return
    }
    logger.warn("oauth_authorize_rejected", {
      clientIp: extractClientIp(req, trustForwardedHops),
      reason: "unknown_client",
    })
    res.status(400).set("Cache-Control", "no-store").type("html").send(renderUnknownClientPage())
  })

  guard.use((req: Request, res: Response, next: NextFunction) => {
    // An own property on this response shadows Express's prototype method
    // for this request only. The SDK calls res.redirect(302, url); Express
    // also accepts (url) and (url, status), so the URL is whichever argument
    // is the string.
    res.redirect = (...redirectArgs: ReadonlyArray<string | number>): void => {
      const redirectUrl = redirectArgs.find((argument) => typeof argument === "string")
      const { status, body } = redirectedErrorFromUrl(redirectUrl)
      const clientIp = extractClientIp(req, trustForwardedHops)

      if (body.error === SERVER_ERROR_CODE) {
        logger.error("oauth_authorize_failed", { clientIp, error: body.error_description })
      } else {
        logger.warn("oauth_authorize_rejected", { clientIp, reason: body.error })
      }
      res.status(status).set("Cache-Control", "no-store").json(body)
    }
    next()
  })

  return guard
}

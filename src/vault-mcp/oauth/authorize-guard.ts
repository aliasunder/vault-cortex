/** The /authorize guard — mounted ahead of the SDK's authorization handler.
 *  It leaves every check to the SDK and rewrites two of the SDK's answers:
 *  the JSON error for an unknown client becomes a page a person can act on,
 *  and every error redirect becomes a direct response. */

import { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { extractClientIp } from "../../auth.js"
import type { Logger } from "../../logger.js"
import { renderUnknownClientPage } from "./unknown-client-page.js"

type AuthorizeGuardOptions = {
  trustForwardedHops: number
  logger: Logger
}

/** The redirect the SDK builds, read back as the response it becomes. */
type RedirectedError = {
  status: 400 | 500
  body: { error: string; error_description: string }
}

// The SDK's catch-all code for a thrown non-OAuth exception; every other
// code reports a bad request.
const SERVER_ERROR_CODE = "server_error"

// The SDK's /authorize handler answers this code, as JSON, only for a
// client_id it does not store.
const UNKNOWN_CLIENT_CODE = "invalid_client"

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
  const errorDescription = parsedUrl.searchParams.get("error_description")

  return {
    status: errorCode === SERVER_ERROR_CODE ? 500 : 400,
    body: { error: errorCode, error_description: errorDescription ?? DEFAULT_ERROR_DESCRIPTION },
  }
}

const isUnknownClientAnswer = (body: unknown): boolean => {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === UNKNOWN_CLIENT_CODE
  )
}

/** On /authorize a valid request only renders the consent page; the SDK
 *  redirects only to report an error to the client's registered address.
 *  Anyone can register an address, so such a redirect would send a visitor
 *  from this server's domain to any site. The guard answers the error here
 *  instead (RFC 9700 §4.11.2 permits refusing to redirect). */
export const createAuthorizeGuard = ({
  trustForwardedHops,
  logger,
}: AuthorizeGuardOptions): Router => {
  const guard = Router()

  // No /authorize answer may be cached. Set first, so the SDK limiter's and
  // form parser's refusals carry it too.
  guard.use((_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "no-store")
    next()
  })

  guard.use((req: Request, res: Response, next: NextFunction) => {
    const clientIp = extractClientIp(req, trustForwardedHops)
    // Own properties on this response shadow Express's prototype methods for
    // this request only; the originals are kept to send the rewritten answers.
    const sendJson = res.json.bind(res)

    // A browser reaches this page when the MCP client that opened the browser
    // holds a client_id the server no longer stores: the server's data was
    // reset, or the registration never signed in and was swept. The SDK
    // answers a JSON error the person cannot act on; every other JSON answer
    // is read by a client and goes through unchanged.
    res.json = (body: unknown): Response => {
      if (!isUnknownClientAnswer(body)) return sendJson(body)
      logger.warn("oauth_authorize_rejected", { clientIp, reason: "unknown_client" })
      return res.type("html").send(renderUnknownClientPage())
    }

    // The SDK calls res.redirect(302, url), and Express also accepts
    // res.redirect(url), so the URL is whichever argument is the string.
    res.redirect = (...redirectArgs: ReadonlyArray<string | number>): void => {
      const redirectUrl = redirectArgs.find((argument) => typeof argument === "string")
      const { status, body } = redirectedErrorFromUrl(redirectUrl)

      // The provider logs its own refusals with the client ID, but the SDK's
      // parameter checks log nothing, so this line records the error and its
      // description.
      const answeredErrorFields = {
        clientIp,
        error: body.error,
        errorDescription: body.error_description,
      }

      if (body.error === SERVER_ERROR_CODE) {
        logger.error("oauth_authorize_failed", answeredErrorFields)
      } else {
        logger.warn("oauth_authorize_error_answered", answeredErrorFields)
      }
      res.status(status)
      sendJson(body)
    }
    next()
  })

  return guard
}

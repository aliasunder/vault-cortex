import { describe, it, expect, afterEach, onTestFinished, vi } from "vitest"
import type { Server } from "node:http"
import express from "express"
import { createAuthorizeGuard } from "../authorize-guard.js"
import { renderUnknownClientPage } from "../unknown-client-page.js"
import { logger } from "../../../logger.js"

/** Serves /authorize through the guard, then through `answerWith`, which
 *  stands in for the SDK's handler and answers as it is told to. */
const startGuardedAuthorize = async (
  answerWith: (res: express.Response) => void,
): Promise<{ authorizeUrl: string }> => {
  const app = express()
  app.use(
    "/authorize",
    createAuthorizeGuard({ trustForwardedHops: 0, logger }),
    (_req: express.Request, res: express.Response) => {
      answerWith(res)
    },
  )
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  onTestFinished(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const serverAddress = server.address()

  if (!serverAddress || typeof serverAddress === "string") {
    throw new Error("expected a TCP address from a listening server")
  }
  return { authorizeUrl: `http://127.0.0.1:${serverAddress.port}/authorize?client_id=some-client` }
}

/** The status, JSON body, redirect target and cache directive of the
 *  guard's answer. */
const fetchAnswer = async (
  authorizeUrl: string,
): Promise<{ status: number; body: unknown; location: string | null; cache: string | null }> => {
  const response = await fetch(authorizeUrl, { redirect: "manual" })
  return {
    status: response.status,
    body: await response.json(),
    location: response.headers.get("location"),
    cache: response.headers.get("cache-control"),
  }
}

const DENIED_REDIRECT =
  "https://client.example/callback?error=access_denied&error_description=Denied"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createAuthorizeGuard — redirects answered directly", () => {
  it.each([
    {
      label: "a status and a URL",
      redirectWith: (res: express.Response) => {
        res.redirect(302, DENIED_REDIRECT)
      },
    },
    {
      label: "a URL alone",
      redirectWith: (res: express.Response) => {
        res.redirect(DENIED_REDIRECT)
      },
    },
  ])(
    "answers an error redirect given $label with a 400 and no Location",
    async ({ redirectWith }) => {
      vi.spyOn(logger, "warn").mockImplementation(() => {})
      const { authorizeUrl } = await startGuardedAuthorize(redirectWith)

      expect(await fetchAnswer(authorizeUrl)).toEqual({
        status: 400,
        body: { error: "access_denied", error_description: "Denied" },
        location: null,
        cache: "no-store",
      })
    },
  )

  // The SDK redirects only to report an error, but a redirect of any other
  // kind must not send the visitor to the client's address either.
  it.each([
    {
      label: "a success redirect carrying a code",
      redirectUrl: "https://client.example/callback?code=issued-code&state=xyz",
    },
    { label: "a relative path", redirectUrl: "/elsewhere" },
  ])("refuses $label with a 400 invalid_request and no Location", async ({ redirectUrl }) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    const { authorizeUrl } = await startGuardedAuthorize((res) => {
      res.redirect(302, redirectUrl)
    })

    expect(await fetchAnswer(authorizeUrl)).toEqual({
      status: 400,
      body: { error: "invalid_request", error_description: "Invalid authorization request" },
      location: null,
      cache: "no-store",
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("oauth_authorize_error_answered", {
      clientIp: "127.0.0.1",
      error: "invalid_request",
      errorDescription: "Invalid authorization request",
    })
  })

  it("fills in a description when the redirect names an error without one", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {})
    const { authorizeUrl } = await startGuardedAuthorize((res) => {
      res.redirect(302, "https://client.example/callback?error=access_denied")
    })

    expect(await fetchAnswer(authorizeUrl)).toEqual({
      status: 400,
      body: { error: "access_denied", error_description: "Invalid authorization request" },
      location: null,
      cache: "no-store",
    })
  })
})

describe("createAuthorizeGuard — JSON answers", () => {
  it("rewrites the SDK's unknown-client answer into the recovery page", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    const { authorizeUrl } = await startGuardedAuthorize((res) => {
      res.status(400).json({ error: "invalid_client", error_description: "Invalid client_id" })
    })

    const response = await fetch(authorizeUrl)

    expect({
      status: response.status,
      contentType: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"),
      html: await response.text(),
    }).toEqual({
      status: 400,
      contentType: "text/html; charset=utf-8",
      cache: "no-store",
      html: renderUnknownClientPage(),
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("oauth_authorize_rejected", {
      clientIp: "127.0.0.1",
      reason: "unknown_client",
    })
  })

  it("passes every other JSON answer through unchanged", async () => {
    const { authorizeUrl } = await startGuardedAuthorize((res) => {
      res
        .status(400)
        .json({ error: "invalid_request", error_description: "Unregistered redirect_uri" })
    })

    expect(await fetchAnswer(authorizeUrl)).toEqual({
      status: 400,
      body: { error: "invalid_request", error_description: "Unregistered redirect_uri" },
      location: null,
      cache: "no-store",
    })
  })
})

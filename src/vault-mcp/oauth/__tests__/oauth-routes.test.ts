import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Response } from "express"
import express from "express"
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import { createOAuthProvider } from "../oauth-provider.js"
import type { OAuthProvider } from "../oauth-provider.js"
import { createOAuthRoutes } from "../oauth-routes.js"

// The documented local-dev placeholder (.gitleaks.toml allowlist, also used in
// README/CONTRIBUTING) — allowlisted by the secret scanner, never a real key.
const AUTH_TOKEN = "local-dev-token"
const REDIRECT_URI = "http://localhost:9999/callback"

/** Pulls the hidden request_id out of the rendered consent HTML. */
const REQUEST_ID_PATTERN = /name="request_id"\s+value="([^"]+)"/

describe("OAuth consent token submission", () => {
  let dir: string
  let oauth: OAuthProvider
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-routes-test-"))
    oauth = createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
    })
    const app = express()
    app.use(router)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    const { port } = server.address() as AddressInfo
    baseUrl = `http://localhost:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  // Register a client and start an authorization request directly through
  // the provider (the HTTP /register and /authorize routes are rate-limited;
  // /oauth/decide, the route under test, is not).
  const startPendingRequest = async (): Promise<string> => {
    const client = await oauth.provider.clientsStore!.registerClient!({
      client_name: "Test Client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
    const params: AuthorizationParams = {
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      redirectUri: REDIRECT_URI,
      scopes: ["vault"],
      state: "test-state",
    }
    let capturedHtml = ""
    const res = {
      type: () => res,
      send: (html: string) => {
        capturedHtml = html
        return res
      },
    }
    await oauth.provider.authorize(client, params, res as unknown as Response)
    const requestId = REQUEST_ID_PATTERN.exec(capturedHtml)?.[1]
    if (!requestId) throw new Error("no request_id in consent HTML")
    return requestId
  }

  const submitToken = async (requestId: string, token: string) =>
    fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId,
        token,
        action: "approve",
      }),
      redirect: "manual",
    })

  const approvalScenarios = [
    { name: "exact token", token: AUTH_TOKEN },
    {
      name: "token with leading and trailing whitespace",
      token: `  ${AUTH_TOKEN}\n`,
    },
    {
      name: "token broken by an embedded newline (terminal wrap)",
      token: `${AUTH_TOKEN.slice(0, Math.floor(AUTH_TOKEN.length / 2))}\n${AUTH_TOKEN.slice(Math.floor(AUTH_TOKEN.length / 2))}`,
    },
  ]

  it.each(approvalScenarios)("approves $name", async ({ token }) => {
    const requestId = await startPendingRequest()
    const response = await submitToken(requestId, token)
    expect(response.status).toBe(302)
    const locationHeader = response.headers.get("location")
    expect(locationHeader).not.toBeNull()
    const location = new URL(locationHeader!)
    const code = location.searchParams.get("code")
    expect(typeof code).toBe("string")
    expect(code!.length).toBeGreaterThan(0)
    expect(location.searchParams.get("state")).toBe("test-state")
  })

  const rejectionScenarios = [
    { name: "genuinely wrong token", token: "not-the-token" },
    {
      name: "all-whitespace token (must not normalize to an empty match)",
      token: "   \n  ",
    },
  ]

  it.each(rejectionScenarios)(
    "rejects $name without redirecting or issuing a code",
    async ({ token }) => {
      const requestId = await startPendingRequest()
      const response = await submitToken(requestId, token)
      expect(response.status).toBe(200)
      expect(response.headers.get("location")).toBeNull()
      const body = await response.text()
      expect(body).toContain("Invalid token. Please try again.")
    },
  )
})

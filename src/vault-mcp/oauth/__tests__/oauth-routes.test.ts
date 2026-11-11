import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Server } from "node:http"
import express from "express"
import {
  OAuthProtectedResourceMetadataSchema,
  OAuthMetadataSchema,
  OAuthClientInformationFullSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { createOAuthProvider } from "../oauth-provider.js"
import type { OAuthProvider } from "../oauth-provider.js"
import { createOAuthRoutes } from "../oauth-routes.js"
import { renderUnknownClientPage } from "../unknown-client-page.js"
import { logger, type Logger } from "../../../logger.js"

type LogCall = {
  level: "debug" | "info" | "warn" | "error"
  message: string
  data: Record<string, unknown>
}
const recordingLogger = (sink: LogCall[]): Logger => {
  const captureLine = (chunk: string | Uint8Array): boolean => {
    const {
      timestamp: _timestamp,
      name: _name,
      source: _source,
      level,
      message,
      ...data
    } = JSON.parse(String(chunk))
    sink.push({ level, message, data })
    return true
  }
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(captureLine)
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(captureLine)
  onTestFinished(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })
  return logger
}

// The documented local-dev placeholder (.gitleaks.toml allowlist, also used in
// README/CONTRIBUTING) — allowlisted by the secret scanner, never a real key.
const AUTH_TOKEN = "local-dev-token"
const TEST_URLS = { serverUrl: new URL("http://localhost:8000") }
const REDIRECT_URI = "http://localhost:9999/callback"
// What the consent page shows for REDIRECT_URI and for the grant
const REDIRECT_DESTINATION = "http://localhost:9999"
const GRANT_TEXT = "Everything this server's tools can do in your vault"
// A test request's peer address is loopback, in a form that varies by
// platform (127.0.0.1, ::1, or IPv4-mapped).
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"]

/** Pulls the hidden request_id out of the rendered consent HTML. */
const REQUEST_ID_PATTERN = /name="request_id"\s+value="([^"]+)"/

/**
 * Resolves a listening server's TCP port. A bound HTTP server always
 * reports an object-form address, so string/null narrows to a throw
 * instead of a type assertion.
 */
const getListeningPort = (server: Server): number => {
  const serverAddress = server.address()

  if (!serverAddress || typeof serverAddress === "string") {
    throw new Error("expected a TCP address from a listening server")
  }
  return serverAddress.port
}

const startAuthorization = async ({
  oauth,
  baseUrl,
  clientName,
  scopes = ["vault"],
}: {
  oauth: OAuthProvider
  baseUrl: string
  clientName: string
  scopes?: string[]
}): Promise<{ requestId: string; clientId: string }> => {
  const clientsStore = oauth.provider.clientsStore

  if (!clientsStore?.registerClient) throw new Error("clientsStore.registerClient not available")
  const client = await clientsStore.registerClient({
    client_name: clientName,
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  })
  const authorizeUrl = new URL(`${baseUrl}/authorize`)
  authorizeUrl.search = new URLSearchParams({
    client_id: client.client_id,
    response_type: "code",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(" "),
    state: "test-state",
  }).toString()
  const response = await fetch(authorizeUrl)
  expect(response.status).toBe(200)
  const requestId = REQUEST_ID_PATTERN.exec(await response.text())?.[1]

  if (!requestId) throw new Error("no request_id in consent HTML")
  return { requestId, clientId: client.client_id }
}

describe("OAuth consent token submission", () => {
  let dir: string
  let oauth: OAuthProvider
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-routes-test-"))
    oauth = createOAuthProvider({
      ...TEST_URLS,
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHops: 0,
      logger,
    })
    const app = express()
    app.use(router)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    baseUrl = `http://localhost:${getListeningPort(server)}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  // Registration uses the provider directly so setup leaves the HTTP registration budget intact.
  const startPendingRequest = (scopes: string[] = ["vault"]) => {
    return startAuthorization({ oauth, baseUrl, clientName: "Test Client", scopes })
  }

  const submitToken = async (requestId: string, token: string) => {
    return fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId,
        token,
        action: "approve",
      }),
      redirect: "manual",
    })
  }

  const midpoint = Math.floor(AUTH_TOKEN.length / 2)
  const wrappedToken = `${AUTH_TOKEN.slice(0, midpoint)}\n${AUTH_TOKEN.slice(midpoint)}`

  const approvalScenarios = [
    { name: "exact token", token: AUTH_TOKEN },
    {
      name: "token with leading and trailing whitespace",
      token: `  ${AUTH_TOKEN}\n`,
    },
    {
      name: "token broken by an embedded newline (terminal wrap)",
      token: wrappedToken,
    },
  ]

  it.each(approvalScenarios)("approves $name", async ({ token }) => {
    const { requestId } = await startPendingRequest()
    const response = await submitToken(requestId, token)
    expect(response.status).toBe(302)
    const locationHeader = response.headers.get("location")

    if (!locationHeader) throw new Error("expected Location header on 302")
    const location = new URL(locationHeader)
    const code = location.searchParams.get("code")

    if (!code) throw new Error("expected code query param in redirect")
    expect(code).toMatch(/^[a-f0-9]{64}$/)
    expect(location.searchParams.get("state")).toBe("test-state")
  })

  const rejectionScenarios = [
    { name: "genuinely wrong token", token: "not-the-token" },
    {
      name: "all-whitespace token (must not normalize to an empty match)",
      token: "   \n  ",
    },
  ]

  // Reads the values the route fills into the re-rendered consent page with
  // test-owned patterns, so a regression in the renderer fails these tests too.
  const readConsentPage = (html: string) => {
    return {
      error: /<div class="error">([^<]*)<\/div>/.exec(html)?.[1],
      values: [...html.matchAll(/<div class="value">([^<]*)<\/div>/g)].map((match) => match[1]),
      requestId: REQUEST_ID_PATTERN.exec(html)?.[1],
    }
  }

  it.each(rejectionScenarios)(
    "rejects $name without redirecting or issuing a code",
    async ({ token }) => {
      const { requestId, clientId } = await startPendingRequest()
      const response = await submitToken(requestId, token)
      expect(response.status).toBe(200)
      expect(response.headers.get("location")).toBeNull()
      expect(readConsentPage(await response.text())).toEqual({
        error: "Invalid token. Please try again.",
        values: ["Test Client", clientId, REDIRECT_DESTINATION, GRANT_TEXT],
        requestId,
      })
    },
  )

  it("counts wrong-token re-renders toward the consent submission limit", async () => {
    const { requestId } = await startPendingRequest()

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await submitToken(requestId, "wrong-token")
      expect(response.status).toBe(200)
      expect(readConsentPage(await response.text()).error).toBe("Invalid token. Please try again.")
    }
    const sixth = await submitToken(requestId, AUTH_TOKEN)

    expect(sixth.status).toBe(429)
    expect(await sixth.text()).toBe("Too many requests, please try again later.")
    expect(sixth.headers.get("location")).toBeNull()
  })

  it("counts successful approvals toward the consent submission limit", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { requestId } = await startPendingRequest()
      const response = await submitToken(requestId, AUTH_TOKEN)

      expect(response.status).toBe(302)
    }
    const sixth = await submitToken("already-approved-request", AUTH_TOKEN)

    expect(sixth.status).toBe(429)
    expect(await sixth.text()).toBe("Too many requests, please try again later.")
  })

  it("accepts the same pending consent when the exhausted minute ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const windowStart = Date.UTC(2026, 0, 1)
    vi.setSystemTime(windowStart)
    const { requestId } = await startPendingRequest()

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await submitToken(requestId, "wrong-token")
      expect(response.status).toBe(200)
    }
    const blocked = await submitToken(requestId, AUTH_TOKEN)
    expect(blocked.status).toBe(429)

    vi.setSystemTime(windowStart + 59_999)
    const beforeReset = await submitToken(requestId, AUTH_TOKEN)
    expect(beforeReset.status).toBe(429)

    vi.setSystemTime(windowStart + 60_000)
    const afterReset = await submitToken(requestId, AUTH_TOKEN)
    expect(afterReset.status).toBe(302)
    const location = afterReset.headers.get("location")

    if (!location) throw new Error("expected consent approval redirect")
    const redirect = new URL(location)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI)
    expect(redirect.searchParams.get("state")).toBe("test-state")
    expect(redirect.searchParams.get("code")).toMatch(/^[a-f0-9]{64}$/)
  })

  it("re-renders the consent page without the scope the request named after a wrong token", async () => {
    const { requestId, clientId } = await startPendingRequest(["admin-zq9"])

    const response = await submitToken(requestId, "not-the-token")
    const html = await response.text()

    expect(readConsentPage(html)).toEqual({
      error: "Invalid token. Please try again.",
      values: ["Test Client", clientId, REDIRECT_DESTINATION, GRANT_TEXT],
      requestId,
    })
    expect(html).not.toContain("admin-zq9")
  })

  it.each([
    { label: "approval redirect", token: AUTH_TOKEN, expectedStatus: 302 },
    { label: "wrong-token re-render", token: "not-the-token", expectedStatus: 200 },
  ])("marks the $label as not cacheable", async ({ token, expectedStatus }) => {
    const { requestId } = await startPendingRequest()

    const response = await submitToken(requestId, token)

    expect(response.status).toBe(expectedStatus)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("OAuth consent body validation", () => {
  let dir: string
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-body-val-"))
    const oauth = createOAuthProvider({
      ...TEST_URLS,
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHops: 0,
      logger,
    })
    const app = express()
    app.use(router)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    baseUrl = `http://localhost:${getListeningPort(server)}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it("returns 400 for duplicate form fields that produce arrays", async () => {
    const response = await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "request_id=a&request_id=b&token=t&action=approve",
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toBe("Invalid form submission.")
  })

  it("returns 400 when required fields are missing", async () => {
    const response = await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "request_id=a",
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toBe("Invalid form submission.")
  })

  it.each([
    { label: "a request without a body", requestOptions: {} },
    {
      label: "an unsupported content type",
      requestOptions: {
        headers: { "content-type": "text/plain" },
        body: "request_id=a&token=t&action=approve",
      },
    },
  ])("returns 400 for $label", async ({ requestOptions }) => {
    const response = await fetch(`${baseUrl}/oauth/decide`, {
      ...requestOptions,
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toBe("Invalid form submission.")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("ratelimit-remaining")).toBe("4")
  })

  it("returns 400 for a request ID with no pending request", async () => {
    const response = await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "request_id=nonexistent-id&token=t&action=approve",
    })

    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toBe("Authorization request expired or invalid.")
  })

  it.each([
    {
      label: "400 for duplicate form fields",
      body: "request_id=a&request_id=b&token=t&action=approve",
      expectedStatus: 400,
    },
    { label: "400 for missing fields", body: "request_id=a", expectedStatus: 400 },
    {
      label: "400 for a request ID with no pending request",
      body: "request_id=nonexistent-id&token=t&action=approve",
      expectedStatus: 400,
    },
    {
      // The body exceeds express.urlencoded's default 100 KB limit. This router
      // alone answers the parser's 413; the full server's error middleware
      // turns the same error into a 500, and no-store holds either way.
      label: "form parser's 413 for an oversized form",
      body: `request_id=a&token=${"t".repeat(200 * 1024)}&action=approve`,
      expectedStatus: 413,
    },
  ])("marks the $label as not cacheable", async ({ body, expectedStatus }) => {
    const response = await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    })

    expect(response.status).toBe(expectedStatus)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("OAuth consent audit logging", () => {
  let dir: string
  let logs: LogCall[]
  let oauth: OAuthProvider
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-audit-routes-"))
    logs = []
    const testLogger = recordingLogger(logs)
    oauth = createOAuthProvider({
      ...TEST_URLS,
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger: testLogger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHops: 0,
      logger: testLogger,
    })
    const app = express()
    app.use(router)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    baseUrl = `http://localhost:${getListeningPort(server)}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  const startPendingRequest = () => {
    return startAuthorization({ oauth, baseUrl, clientName: "Audit Client" })
  }

  it("logs oauth_consent_completed on approved consent", async () => {
    const { requestId, clientId } = await startPendingRequest()
    logs.length = 0

    await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId,
        token: AUTH_TOKEN,
        action: "approve",
      }),
      redirect: "manual",
    })

    const event = logs.find((log) => log.message === "oauth_consent_completed")
    expect(event).toEqual({
      level: "info",
      message: "oauth_consent_completed",
      data: {
        component: "oauth-routes",
        clientIp: expect.toBeOneOf(LOOPBACK_ADDRESSES),
        requestId,
        clientId,
      },
    })
  })

  it("logs oauth_consent_bad_token on invalid token submission", async () => {
    const { requestId, clientId } = await startPendingRequest()
    logs.length = 0

    await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId,
        token: "wrong-token",
        action: "approve",
      }),
      redirect: "manual",
    })

    const event = logs.find((log) => log.message === "oauth_consent_bad_token")
    expect(event).toEqual({
      level: "warn",
      message: "oauth_consent_bad_token",
      data: {
        component: "oauth-routes",
        clientIp: expect.toBeOneOf(LOOPBACK_ADDRESSES),
        requestId,
        clientId,
      },
    })
  })

  it("logs oauth_consent_denied_by_user on deny action", async () => {
    const { requestId, clientId } = await startPendingRequest()
    logs.length = 0

    await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId,
        token: AUTH_TOKEN,
        action: "deny",
      }),
      redirect: "manual",
    })

    const event = logs.find((log) => log.message === "oauth_consent_denied_by_user")
    expect(event).toEqual({
      level: "info",
      message: "oauth_consent_denied_by_user",
      data: {
        component: "oauth-routes",
        clientIp: expect.toBeOneOf(LOOPBACK_ADDRESSES),
        requestId,
        clientId,
      },
    })
  })

  it("logs oauth_consent_expired on expired request", async () => {
    logs.length = 0

    await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: "nonexistent-id",
        token: AUTH_TOKEN,
        action: "approve",
      }),
      redirect: "manual",
    })

    const event = logs.find((log) => log.message === "oauth_consent_expired")
    expect(event).toEqual({
      level: "warn",
      message: "oauth_consent_expired",
      data: {
        component: "oauth-routes",
        clientIp: expect.toBeOneOf(LOOPBACK_ADDRESSES),
        requestId: "nonexistent-id",
      },
    })
  })

  it("caps the submitted request ID in consent rejection logs", async () => {
    const response = await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: "🎉".repeat(1_000),
        token: AUTH_TOKEN,
        action: "approve",
      }),
    })

    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 400,
      body: "Authorization request expired or invalid.",
    })
    expect(logs.filter((log) => log.message === "oauth_consent_expired")).toEqual([
      {
        level: "warn",
        message: "oauth_consent_expired",
        data: {
          component: "oauth-routes",
          clientIp: expect.toBeOneOf(LOOPBACK_ADDRESSES),
          requestId: "🎉".repeat(255) + "…",
        },
      },
    ])
  })
})

describe("OAuth endpoint rate limiting", () => {
  let dir: string
  let logs: LogCall[]
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-rate-limit-"))
    logs = []
    const testLogger = recordingLogger(logs)
    const oauth = createOAuthProvider({
      ...TEST_URLS,
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger: testLogger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      // These tests simulate distinct clients through the Forwarded header,
      // which only works when the deployment trusts it.
      trustForwardedHops: 1,
      logger: testLogger,
    })
    const app = express()
    app.use(router)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    baseUrl = `http://localhost:${getListeningPort(server)}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  // Without forwardedClientIp all requests share the loopback peer; with it,
  // the RFC 7239 Forwarded header drives extractClientIp, so distinct values
  // are distinct rate-limit identities.
  const register = (forwardedClientIp?: string) => {
    return fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(forwardedClientIp ? { forwarded: `for=${forwardedClientIp}` } : {}),
      },
      body: JSON.stringify({
        client_name: "Rate Limit Client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
  }

  it("serves 5 requests in a minute from one client IP, then returns 429", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await register()
      expect(response.status).toBe(201)
    }
    const sixth = await register()
    expect(sixth.status).toBe(429)
  })

  it("logs oauth_rate_limited with the offending client IP when the limit trips", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await register("203.0.113.9")
    }
    logs.length = 0
    const sixth = await register("203.0.113.9")
    expect(sixth.status).toBe(429)
    const event = logs.find((log) => log.message === "oauth_rate_limited")
    expect(event).toEqual({
      level: "warn",
      message: "oauth_rate_limited",
      data: {
        component: "oauth-routes",
        clientIp: "203.0.113.9",
        path: "/register",
      },
    })
  })

  it("caps the request path and forwarded client IP in rate-limit logs", async () => {
    const clientIp = "x".repeat(1_000)
    const path = "/register/" + "x".repeat(1_000)
    const statuses: number[] = []

    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(`${baseUrl}${path}?state=private`, {
        method: "POST",
        headers: { forwarded: `for=${clientIp}` },
      })
      await response.text()
      statuses.push(response.status)
    }

    expect(statuses).toEqual([404, 404, 404, 404, 404, 429])
    expect(logs.filter((log) => log.message === "oauth_rate_limited")).toEqual([
      {
        level: "warn",
        message: "oauth_rate_limited",
        data: {
          component: "oauth-routes",
          clientIp: "x".repeat(255) + "…",
          path: "/register/" + "x".repeat(245) + "…",
        },
      },
    ])
  })

  it("keys the limit by client IP, so exhausting one client leaves another unaffected", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await register("203.0.113.7")
      expect(response.status).toBe(201)
    }
    const sixthFromSameClient = await register("203.0.113.7")
    expect(sixthFromSameClient.status).toBe(429)
    const firstFromOtherClient = await register("203.0.113.8")
    expect(firstFromOtherClient.status).toBe(201)
  })

  const submitConsent = (forwardedClientIp: string, body = new URLSearchParams()) => {
    return fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        forwarded: `for=${forwardedClientIp}`,
      },
      body,
      redirect: "manual",
    })
  }

  it("serves 5 consent submissions per client IP, then returns an uncached 429 with OAuth headers", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await submitConsent("203.0.113.9")
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("Invalid form submission.")
    }
    const sixth = await submitConsent("203.0.113.9")

    expect(sixth.status).toBe(429)
    const retryAfter = sixth.headers.get("retry-after")

    expect(retryAfter).toMatch(/^(?:[1-9]|[1-5][0-9]|60)$/)
    const isLimitHeader = ([name]: [string, string]) => {
      return (
        name === "cache-control" ||
        name === "retry-after" ||
        name.startsWith("ratelimit") ||
        name.startsWith("x-ratelimit")
      )
    }
    expect(Object.fromEntries([...sixth.headers].filter(isLimitHeader))).toEqual({
      "cache-control": "no-store",
      "retry-after": retryAfter,
      "ratelimit-limit": "5",
      "ratelimit-remaining": "0",
      "ratelimit-reset": retryAfter,
      "ratelimit-policy": "5;w=60",
    })
    expect(await sixth.text()).toBe("Too many requests, please try again later.")
  })

  it("logs oauth_rate_limited with the client IP and consent decision path", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await submitConsent("203.0.113.9")
      expect(response.status).toBe(400)
    }
    const sixth = await submitConsent("203.0.113.9")

    expect(sixth.status).toBe(429)
    expect(logs.filter((log) => log.message === "oauth_rate_limited")).toEqual([
      {
        level: "warn",
        message: "oauth_rate_limited",
        data: {
          component: "oauth-routes",
          clientIp: "203.0.113.9",
          path: "/oauth/decide",
        },
      },
    ])
  })

  it("leaves another client's consent allowance available after one client exhausts its budget", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await submitConsent("203.0.113.7")
      expect(response.status).toBe(400)
    }
    const sixthFromSameClient = await submitConsent("203.0.113.7")

    expect(sixthFromSameClient.status).toBe(429)
    const firstFromOtherClient = await submitConsent("203.0.113.8")

    expect(firstFromOtherClient.status).toBe(400)
    expect(await firstFromOtherClient.text()).toBe("Invalid form submission.")
  })

  it("keeps the consent submission budget independent of the registration budget", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await register("203.0.113.9")).status).toBe(201)
    }
    expect((await register("203.0.113.9")).status).toBe(429)

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await submitConsent("203.0.113.9")
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("Invalid form submission.")
    }
    expect((await submitConsent("203.0.113.9")).status).toBe(429)
  })

  it("shares the consent budget across IPv6 addresses in one /56 and separates the next /56", async () => {
    for (const hostPart of ["::1", "::2", "::3", "::4", "::5"]) {
      const response = await submitConsent(`"[2001:db8${hostPart}]"`)
      expect(response.status).toBe(400)
    }
    expect((await submitConsent('"[2001:db8:0:ff::6]"')).status).toBe(429)
    const otherSubnet = await submitConsent('"[2001:db8:0:100::1]"')
    expect(otherSubnet.status).toBe(400)
    expect(await otherSubnet.text()).toBe("Invalid form submission.")
  })

  it("rate-limits an oversized consent form before the form parser rejects it", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await submitConsent("203.0.113.9")
      expect(response.status).toBe(400)
    }
    const oversizedForm = new URLSearchParams({ token: "x".repeat(101 * 1024) })
    const response = await submitConsent("203.0.113.9", oversizedForm)

    expect(response.status).toBe(429)
    expect(await response.text()).toBe("Too many requests, please try again later.")
  })

  // A /56 spans the first three groups and the top byte of the fourth, so
  // 2001:db8:0:ff:: shares the budget of 2001:db8::1 and 2001:db8:0:100::
  // does not.
  it("keys IPv6 clients by their /56, so rotating addresses inside it shares one budget", async () => {
    const addressesInOneSubnet = ["::1", "::2", "::3", "::4", "::5"].map(
      (hostPart) => `"[2001:db8${hostPart}]"`,
    )
    for (const address of addressesInOneSubnet) {
      const response = await register(address)
      expect(response.status).toBe(201)
    }
    const sixthFromSameSubnet = await register(`"[2001:db8:0:ff::6]"`)
    expect(sixthFromSameSubnet.status).toBe(429)
    const firstFromOtherSubnet = await register(`"[2001:db8:0:100::1]"`)
    expect(firstFromOtherSubnet.status).toBe(201)
  })

  // Each flow endpoint mounts its own limiter with its own counter, so the
  // per-endpoint tests below exercise four independent limiters — register
  // passing does not prove authorize/token/revoke are limited. The requests
  // are deliberately invalid: the limiter runs before request validation,
  // so invalid requests still count toward the window, and the pre-limit
  // status is each endpoint's own validation error.
  it("rate-limits /authorize after 5 requests from one client IP, with the SDK's 429 body and headers", async () => {
    // An unknown client gets the recovery page, which counts like any request.
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`${baseUrl}/authorize?client_id=unknown`)
      expect({ status: response.status, type: response.headers.get("content-type") }).toEqual({
        status: 400,
        type: "text/html; charset=utf-8",
      })
    }
    const sixth = await fetch(`${baseUrl}/authorize?client_id=unknown`)
    expect({
      status: sixth.status,
      body: await sixth.json(),
      rateLimitHeader: sixth.headers.get("ratelimit-limit"),
      legacyHeader: sixth.headers.get("x-ratelimit-limit"),
    }).toEqual({
      status: 429,
      body: {
        error: "too_many_requests",
        error_description: "You have exceeded the rate limit for authorization requests",
      },
      rateLimitHeader: "5",
      legacyHeader: null,
    })
  })

  it("rate-limits /token after 5 requests from one client IP", async () => {
    const requestToken = () => {
      return fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code" }),
      })
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await requestToken()
      expect(response.status).toBe(400)
    }
    const sixth = await requestToken()
    expect(sixth.status).toBe(429)
  })

  it("rate-limits /revoke after 5 requests from one client IP", async () => {
    const revoke = () => {
      return fetch(`${baseUrl}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "nonexistent-token" }),
      })
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await revoke()
      expect(response.status).toBe(400)
    }
    const sixth = await revoke()
    expect(sixth.status).toBe(429)
  })

  it("leaves /.well-known discovery metadata unlimited past 5 requests", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
      expect(response.status).toBe(200)
    }
  })
})

describe("OAuth rate limiting when the Forwarded header is not trusted (default)", () => {
  let dir: string
  let logs: LogCall[]
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-rate-limit-untrusted-"))
    logs = []
    const testLogger = recordingLogger(logs)
    const oauth = createOAuthProvider({
      ...TEST_URLS,
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger: testLogger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHops: 0,
      logger: testLogger,
    })
    const app = express()
    app.use(router)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    baseUrl = `http://localhost:${getListeningPort(server)}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  const registerWithSpoofedIp = (spoofedIp: string) => {
    return fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        forwarded: `for=${spoofedIp}`,
      },
      body: JSON.stringify({
        client_name: "Rate Limit Client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
  }

  // A distinct spoofed Forwarded value per request must NOT mint a fresh
  // rate-limit bucket — all six share the real peer's bucket, so the sixth
  // is 429.
  it("spoofed Forwarded headers do not bypass the /register rate limit", async () => {
    for (let hostNumber = 1; hostNumber <= 5; hostNumber++) {
      const response = await registerWithSpoofedIp(`198.51.100.${hostNumber}`)
      expect(response.status).toBe(201)
    }
    const sixth = await registerWithSpoofedIp("198.51.100.6")
    expect(sixth.status).toBe(429)
  })

  it("ignores spoofed Forwarded addresses when counting consent submissions", async () => {
    const submit = (hostNumber: number) => {
      return fetch(`${baseUrl}/oauth/decide`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          forwarded: `for=198.51.100.${hostNumber}`,
        },
        body: new URLSearchParams(),
      })
    }
    for (let hostNumber = 1; hostNumber <= 5; hostNumber++) {
      const response = await submit(hostNumber)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("Invalid form submission.")
    }
    const sixth = await submit(6)
    expect(sixth.status).toBe(429)
    expect(await sixth.text()).toBe("Too many requests, please try again later.")
    expect(logs.filter((log) => log.message === "oauth_rate_limited")).toEqual([
      {
        level: "warn",
        message: "oauth_rate_limited",
        data: {
          component: "oauth-routes",
          clientIp: expect.toBeOneOf(LOOPBACK_ADDRESSES),
          path: "/oauth/decide",
        },
      },
    ])
  })

  it("logs the real peer IP — not the spoofed value — when the limit trips", async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await registerWithSpoofedIp("198.51.100.9")
    }
    logs.length = 0
    const sixth = await registerWithSpoofedIp("198.51.100.9")
    expect(sixth.status).toBe(429)
    const event = logs.find((log) => log.message === "oauth_rate_limited")
    // The logged IP must be the real peer, never the client-supplied
    // Forwarded value.
    expect(event).toEqual({
      level: "warn",
      message: "oauth_rate_limited",
      data: {
        component: "oauth-routes",
        clientIp: expect.toBeOneOf(LOOPBACK_ADDRESSES),
        path: "/register",
      },
    })
  })
})

describe("OAuth protected resource metadata", () => {
  let dir: string
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-metadata-test-"))
    const oauth = createOAuthProvider({
      ...TEST_URLS,
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHops: 0,
      logger,
    })
    const app = express()
    app.use(router)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    baseUrl = `http://localhost:${getListeningPort(server)}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  // Test-owned expected document (drift-catching — not imported from
  // production): the values are the harness inputs above after URL
  // normalization, which appends a trailing slash to origin-only URLs.
  const ROOT_DOCUMENT = {
    resource: "http://localhost:8000/",
    authorization_servers: ["http://localhost:8000/"],
    scopes_supported: ["vault"],
    resource_documentation: "https://example.com/",
  }
  const SUFFIXED_RESOURCE = "http://localhost:8000/mcp"

  it("advertises only client_secret_post while retaining S256 PKCE", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
    expect(response.status).toBe(200)
    const metadata = OAuthMetadataSchema.parse(await response.json())
    expect({
      tokenAuthMethods: metadata.token_endpoint_auth_methods_supported,
      revocationAuthMethods: metadata.revocation_endpoint_auth_methods_supported,
      codeChallengeMethods: metadata.code_challenge_methods_supported,
    }).toEqual({
      tokenAuthMethods: ["client_secret_post"],
      revocationAuthMethods: ["client_secret_post"],
      codeChallengeMethods: ["S256"],
    })
  })

  // Also the guard against a future `resourceServerUrl` pass to
  // mcpAuthRouter: that would MOVE the SDK's metadata route to the suffixed
  // path and this root fetch would 404.
  it("serves the root discovery document unchanged", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ROOT_DOCUMENT)
  })

  it("serves the RFC 9728 path-suffixed document with the /mcp resource identifier", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...ROOT_DOCUMENT,
      resource: SUFFIXED_RESOURCE,
    })
  })

  // Relational guard that survives SDK bumps: if a future SDK adds a field
  // to the root document, this fails until the suffixed document gains it.
  it("keeps the suffixed document identical to the live root document except for resource", async () => {
    const rootResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
    const suffixedResponse = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
    const rootDocument = OAuthProtectedResourceMetadataSchema.parse(await rootResponse.json())
    const suffixedDocument = OAuthProtectedResourceMetadataSchema.parse(
      await suffixedResponse.json(),
    )
    expect(suffixedDocument).toEqual({
      ...rootDocument,
      resource: SUFFIXED_RESOURCE,
    })
  })

  it("serves the suffixed route with CORS enabled for browser-based clients", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("rejects non-GET methods on the suffixed route with 405 and an Allow header", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
      method: "POST",
    })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET, OPTIONS")
  })

  it("answers a browser CORS preflight on the suffixed route", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://claude.ai",
        "Access-Control-Request-Method": "GET",
      },
    })
    expect(response.status).toBe(204)
    expect({
      allowOrigin: response.headers.get("access-control-allow-origin"),
      allowMethods: response.headers.get("access-control-allow-methods"),
    }).toEqual({
      allowOrigin: "*",
      allowMethods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    })
  })

  it("leaves the suffixed discovery route unlimited past 5 requests", async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)
      expect(response.status).toBe(200)
    }
  })
})

describe("OAuth refresh over HTTP", () => {
  type RegisteredClient = { client_id: string; client_secret: string }
  type IssuedTokens = { access_token: string; refresh_token: string }

  const isRegisteredClient = (value: unknown): value is RegisteredClient => {
    return (
      typeof value === "object" &&
      value !== null &&
      "client_id" in value &&
      "client_secret" in value
    )
  }

  const isIssuedTokens = (value: unknown): value is IssuedTokens => {
    return (
      typeof value === "object" &&
      value !== null &&
      "access_token" in value &&
      "refresh_token" in value
    )
  }

  const base64Url = (buffer: Buffer): string => {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  }

  const createRefreshTest = async (): Promise<{ baseUrl: string; oauth: OAuthProvider }> => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-refresh-http-"))
    const oauth = createOAuthProvider({
      ...TEST_URLS,
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHops: 1,
      logger,
    })
    const app = express()
    app.use(router)
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening))
    })
    onTestFinished(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    })
    return { baseUrl: `http://localhost:${getListeningPort(server)}`, oauth }
  }

  // Each registration carries its own Forwarded address so two clients in one
  // test don't share a rate-limit bucket.
  const registerClient = async (
    baseUrl: string,
    forwardedClientIp: string,
    redirectUri = REDIRECT_URI,
  ): Promise<RegisteredClient> => {
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        forwarded: `for=${forwardedClientIp}`,
      },
      body: JSON.stringify({
        client_name: "refresh-test",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    expect(response.status).toBe(201)
    const registered: unknown = await response.json()

    if (!isRegisteredClient(registered)) throw new Error("malformed client")
    return registered
  }

  const issueCode = async (
    baseUrl: string,
    client: RegisteredClient,
    forwardedClientIp: string,
  ): Promise<{ code: string; verifier: string }> => {
    const verifier = base64Url(randomBytes(32))
    const challenge = base64Url(createHash("sha256").update(verifier).digest())
    const authorizeUrl = new URL(`${baseUrl}/authorize`)
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "vault",
    }).toString()
    const consentHtml = await (
      await fetch(authorizeUrl, {
        headers: { forwarded: `for=${forwardedClientIp}` },
      })
    ).text()
    const requestId = REQUEST_ID_PATTERN.exec(consentHtml)?.[1]

    if (!requestId) throw new Error("consent page carried no request_id")
    const decision = await fetch(`${baseUrl}/oauth/decide`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        forwarded: `for=${forwardedClientIp}`,
      },
      body: new URLSearchParams({
        request_id: requestId,
        token: AUTH_TOKEN,
        action: "approve",
      }),
      redirect: "manual",
    })
    const location = decision.headers.get("location")
    const code = location ? new URL(location).searchParams.get("code") : null

    if (!code) throw new Error(`consent did not redirect with a code`)
    return { code, verifier }
  }

  /** The parameters of a request the SDK accepts up to the consent page. */
  const validAuthorizeParams = (client: RegisteredClient): Record<string, string> => ({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: base64Url(randomBytes(32)),
    code_challenge_method: "S256",
    state: "test-state",
  })

  /** What the guard answers: the status and body, whether a Location header
   *  was sent, and the cache directive. */
  const authorizeOutcome = async (
    response: Response,
  ): Promise<{ status: number; body: unknown; location: string | null; cache: string | null }> => ({
    status: response.status,
    body: await response.json(),
    location: response.headers.get("location"),
    cache: response.headers.get("cache-control"),
  })

  const authorizeByGet = (
    baseUrl: string,
    params: Record<string, string>,
    forwardedClientIp: string,
  ): Promise<Response> => {
    const authorizeUrl = new URL(`${baseUrl}/authorize`)
    authorizeUrl.search = new URLSearchParams(params).toString()
    return fetch(authorizeUrl, {
      headers: { forwarded: `for=${forwardedClientIp}` },
      redirect: "manual",
    })
  }

  describe("authorization errors answered directly, never by redirect", () => {
    const withoutCodeChallenge = (params: Record<string, string>): Record<string, string> => {
      const { code_challenge: _omitted, ...rest } = params
      return rest
    }

    it.each([
      {
        label: "a wrong response_type",
        malform: (params: Record<string, string>) => ({ ...params, response_type: "token" }),
        error: "invalid_request",
      },
      {
        label: "a missing code_challenge",
        malform: withoutCodeChallenge,
        error: "invalid_request",
      },
      {
        label: "a plain code_challenge_method",
        malform: (params: Record<string, string>) => ({
          ...params,
          code_challenge_method: "plain",
        }),
        error: "invalid_request",
      },
      {
        label: "a resource naming another server",
        malform: (params: Record<string, string>) => ({
          ...params,
          resource: "https://other.example/mcp",
        }),
        error: "invalid_target",
      },
      {
        label: "parameters over 8 KB",
        malform: (params: Record<string, string>) => ({ ...params, state: "s".repeat(9000) }),
        error: "invalid_request",
      },
    ])("answers $label with a 400 and no Location", async ({ malform, error }) => {
      const { baseUrl } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.40")
      const params = malform(validAuthorizeParams(client))

      const outcome = await authorizeOutcome(await authorizeByGet(baseUrl, params, "203.0.113.40"))

      expect(outcome).toEqual({
        status: 400,
        body: { error, error_description: expect.any(String) },
        location: null,
        cache: "no-store",
      })
    })

    it("answers a repeated state parameter with a 400 and no Location", async () => {
      const { baseUrl } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.41")
      const authorizeUrl = new URL(`${baseUrl}/authorize`)
      authorizeUrl.search = `${new URLSearchParams(validAuthorizeParams(client)).toString()}&state=second`

      const response = await fetch(authorizeUrl, {
        headers: { forwarded: "for=203.0.113.41" },
        redirect: "manual",
      })

      expect(await authorizeOutcome(response)).toEqual({
        status: 400,
        body: { error: "invalid_request", error_description: expect.any(String) },
        location: null,
        cache: "no-store",
      })
    })

    it("answers a request whose registered redirect address alone pushes the stored parameters over 8 KB with a 400", async () => {
      const { baseUrl } = await createRefreshTest()
      // A registration well under 8 KB, so a registration body cap would not
      // refuse it, whose redirect address fills most of the 8 KB the held
      // consent request may hold; the state supplies the rest.
      const longRedirectUri = `${REDIRECT_URI}?pad=${"p".repeat(7000)}`
      const client = await registerClient(baseUrl, "203.0.113.42", longRedirectUri)
      const { redirect_uri: _omitted, ...params } = validAuthorizeParams(client)

      const outcome = await authorizeOutcome(
        await authorizeByGet(baseUrl, { ...params, state: "s".repeat(1500) }, "203.0.113.42"),
      )

      expect(outcome).toEqual({
        status: 400,
        body: {
          error: "invalid_request",
          error_description: "Authorization request parameters are too large",
        },
        location: null,
        cache: "no-store",
      })
    })

    it("answers a malformed POST the same way as a GET", async () => {
      const { baseUrl } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.43")

      const response = await fetch(`${baseUrl}/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          forwarded: "for=203.0.113.43",
        },
        body: new URLSearchParams({ ...validAuthorizeParams(client), response_type: "token" }),
        redirect: "manual",
      })

      expect(await authorizeOutcome(response)).toEqual({
        status: 400,
        body: { error: "invalid_request", error_description: expect.any(String) },
        location: null,
        cache: "no-store",
      })
    })

    it("logs the rejection with the error code and client IP", async () => {
      const logs: LogCall[] = []
      recordingLogger(logs)
      const { baseUrl } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.44")
      logs.length = 0

      await authorizeByGet(
        baseUrl,
        { ...validAuthorizeParams(client), resource: "https://other.example/mcp" },
        "203.0.113.44",
      )

      expect(logs.filter((log) => log.message === "oauth_authorize_rejected")).toEqual([
        {
          level: "warn",
          message: "oauth_authorize_rejected",
          data: { clientIp: "203.0.113.44", reason: "invalid_target" },
        },
      ])
    })

    it("answers a failure inside authorization with a 500 and logs it as an error", async () => {
      const logs: LogCall[] = []
      recordingLogger(logs)
      const { baseUrl, oauth } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.45")
      vi.spyOn(oauth.provider, "authorize").mockRejectedValue(new Error("store unavailable"))
      logs.length = 0

      const outcome = await authorizeOutcome(
        await authorizeByGet(baseUrl, validAuthorizeParams(client), "203.0.113.45"),
      )

      expect(outcome).toEqual({
        status: 500,
        body: { error: "server_error", error_description: "Internal Server Error" },
        location: null,
        cache: "no-store",
      })
      expect(logs.filter((log) => log.message === "oauth_authorize_failed")).toEqual([
        {
          level: "error",
          message: "oauth_authorize_failed",
          data: { clientIp: "203.0.113.45", error: "Internal Server Error" },
        },
      ])
    })

    it.each([{ method: "GET" }, { method: "POST" }])(
      "shows a person whose client registration is gone the recovery page on a $method request",
      async ({ method }) => {
        const logs: LogCall[] = []
        recordingLogger(logs)
        const { baseUrl } = await createRefreshTest()
        const client = await registerClient(baseUrl, "203.0.113.47")
        const params = { ...validAuthorizeParams(client), client_id: "swept-client" }
        logs.length = 0

        const response =
          method === "GET"
            ? await authorizeByGet(baseUrl, params, "203.0.113.47")
            : await fetch(`${baseUrl}/authorize`, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  forwarded: "for=203.0.113.47",
                },
                body: new URLSearchParams(params),
                redirect: "manual",
              })

        expect({
          status: response.status,
          contentType: response.headers.get("content-type"),
          cache: response.headers.get("cache-control"),
          location: response.headers.get("location"),
          html: await response.text(),
        }).toEqual({
          status: 400,
          contentType: "text/html; charset=utf-8",
          cache: "no-store",
          location: null,
          html: renderUnknownClientPage(),
        })
        expect(logs.filter((log) => log.message === "oauth_authorize_rejected")).toEqual([
          {
            level: "warn",
            message: "oauth_authorize_rejected",
            data: { clientIp: "203.0.113.47", reason: "unknown_client" },
          },
        ])
      },
    )

    it("leaves a request that names no client to the SDK's JSON error", async () => {
      const { baseUrl } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.48")
      const { client_id: _omitted, ...params } = validAuthorizeParams(client)

      const outcome = await authorizeOutcome(await authorizeByGet(baseUrl, params, "203.0.113.48"))

      expect(outcome).toEqual({
        status: 400,
        body: { error: "invalid_request", error_description: expect.any(String) },
        location: null,
        cache: "no-store",
      })
    })

    it("still renders the consent page for a valid request", async () => {
      const { baseUrl } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.46")

      const response = await authorizeByGet(baseUrl, validAuthorizeParams(client), "203.0.113.46")

      expect(response.status).toBe(200)
      expect(REQUEST_ID_PATTERN.test(await response.text())).toBe(true)
    })
  })

  /** Consent page → approve → PKCE code exchange, all over HTTP. */
  const issueTokens = async (
    baseUrl: string,
    client: RegisteredClient,
    forwardedClientIp: string,
  ): Promise<IssuedTokens> => {
    const { code, verifier } = await issueCode(baseUrl, client, forwardedClientIp)
    const tokenResponse = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        forwarded: `for=${forwardedClientIp}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: REDIRECT_URI,
      }),
    })
    expect(tokenResponse.status).toBe(200)
    const issued: unknown = await tokenResponse.json()

    if (!isIssuedTokens(issued)) throw new Error("malformed token response")
    return issued
  }

  const refresh = ({
    baseUrl,
    client,
    refreshToken,
    scope,
    forwardedClientIp,
  }: {
    baseUrl: string
    client: RegisteredClient
    refreshToken: string
    scope?: string
    forwardedClientIp: string
  }): Promise<globalThis.Response> => {
    return fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        forwarded: `for=${forwardedClientIp}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.client_id,
        client_secret: client.client_secret,
        ...(scope ? { scope } : {}),
      }),
    })
  }

  it.each([
    { label: "public-client request", method: "none" },
    { label: "client-secret request", method: "client_secret_post" },
    { label: "omitted method", method: undefined },
  ])("returns the effective registration method for $label", async ({ method }) => {
    const { baseUrl } = await createRefreshTest()
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        ...(method ? { token_endpoint_auth_method: method } : {}),
      }),
    })
    expect(response.status).toBe(201)
    const client = OAuthClientInformationFullSchema.parse(await response.json())
    expect(client.token_endpoint_auth_method).toBe("client_secret_post")
    expect(client.client_secret).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each(["authorization_code", "refresh_token"])(
    "rejects missing and wrong secrets without consuming the %s grant",
    async (grantType) => {
      const { baseUrl } = await createRefreshTest()
      const client = await registerClient(baseUrl, "203.0.113.10")
      const createGrant = async (): Promise<Record<string, string>> => {
        if (grantType === "authorization_code") {
          const { code, verifier } = await issueCode(baseUrl, client, "203.0.113.10")
          return { code, code_verifier: verifier, redirect_uri: REDIRECT_URI }
        }
        const { refresh_token } = await issueTokens(baseUrl, client, "203.0.113.10")
        return { refresh_token }
      }
      const grant = await createGrant()
      const exchange = (secret?: string) => {
        return fetch(`${baseUrl}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: grantType,
            client_id: client.client_id,
            ...grant,
            ...(secret ? { client_secret: secret } : {}),
          }),
        })
      }

      const missing = await exchange()
      expect(missing.status).toBe(400)
      expect(await missing.json()).toEqual({
        error: "invalid_client",
        error_description: "Client secret is required",
      })
      const wrong = await exchange("incorrect-secret")
      expect(wrong.status).toBe(400)
      expect(await wrong.json()).toEqual({
        error: "invalid_client",
        error_description: "Invalid client_secret",
      })
      const accepted = await exchange(client.client_secret)
      expect(accepted.status).toBe(200)
      const tokens: unknown = await accepted.json()
      // access_token and refresh_token are random; assert the full key set
      // with expect.any(String) for the nondeterministic values.
      expect(tokens).toEqual({
        token_type: "Bearer",
        scope: "vault",
        expires_in: 21600,
        access_token: expect.any(String),
        refresh_token: expect.any(String),
      })
    },
  )

  it("rejects an incorrect PKCE verifier even when the client secret is valid", async () => {
    const { baseUrl } = await createRefreshTest()
    const client = await registerClient(baseUrl, "203.0.113.11")
    const { code } = await issueCode(baseUrl, client, "203.0.113.11")
    const response = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: "incorrect-verifier",
        redirect_uri: REDIRECT_URI,
      }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_grant",
      error_description: "code_verifier does not match the challenge",
    })
  })

  it("rejects an authorization code redeemed by a different client with invalid_grant", async () => {
    const { baseUrl } = await createRefreshTest()
    const owner = await registerClient(baseUrl, "203.0.113.12")
    const other = await registerClient(baseUrl, "203.0.113.13")
    const { code, verifier } = await issueCode(baseUrl, owner, "203.0.113.12")
    const redeemCode = (
      client: RegisteredClient,
      forwardedClientIp: string,
    ): Promise<globalThis.Response> => {
      return fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          forwarded: `for=${forwardedClientIp}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          client_secret: client.client_secret,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        }),
      })
    }

    const rejected = await redeemCode(other, "203.0.113.13")

    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({
      error: "invalid_grant",
      error_description: "Authorization code expired or invalid",
    })
    const redeemedByOwner = await redeemCode(owner, "203.0.113.12")
    expect(redeemedByOwner.status).toBe(200)
  })

  it("rejects a refresh token presented by a different client with invalid_grant", async () => {
    const { baseUrl } = await createRefreshTest()
    const owner = await registerClient(baseUrl, "203.0.113.1")
    const other = await registerClient(baseUrl, "203.0.113.2")
    const issued = await issueTokens(baseUrl, owner, "203.0.113.1")

    const response = await refresh({
      baseUrl,
      client: other,
      refreshToken: issued.refresh_token,
      forwardedClientIp: "203.0.113.2",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token expired or invalid",
    })
    const stillValid = await refresh({
      baseUrl,
      client: owner,
      refreshToken: issued.refresh_token,
      forwardedClientIp: "203.0.113.1",
    })
    expect(stillValid.status).toBe(200)
  })

  it("rejects a refresh that widens the scope with invalid_scope and consumes the token", async () => {
    const { baseUrl } = await createRefreshTest()
    const owner = await registerClient(baseUrl, "203.0.113.3")
    const issued = await issueTokens(baseUrl, owner, "203.0.113.3")

    const response = await refresh({
      baseUrl,
      client: owner,
      refreshToken: issued.refresh_token,
      scope: "vault admin",
      forwardedClientIp: "203.0.113.3",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_scope",
      error_description: "Requested scope exceeds the granted scope",
    })
    // Token is burned — retry is a plain miss, not a reuse revocation
    const consumed = await refresh({
      baseUrl,
      client: owner,
      refreshToken: issued.refresh_token,
      forwardedClientIp: "203.0.113.3",
    })
    expect(consumed.status).toBe(400)
    expect(await consumed.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token expired or invalid",
    })
  })
})

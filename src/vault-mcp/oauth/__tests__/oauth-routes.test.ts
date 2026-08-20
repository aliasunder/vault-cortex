import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Server } from "node:http"
import type { Response } from "express"
import express from "express"
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js"
import { createOAuthProvider } from "../oauth-provider.js"
import type { OAuthProvider } from "../oauth-provider.js"
import { createOAuthRoutes } from "../oauth-routes.js"
import { logger, type Logger } from "../../../logger.js"

type LogCall = {
  level: "debug" | "info" | "warn" | "error"
  message: string
  data: Record<string, unknown>
}
const recordingLogger = (sink: LogCall[]): Logger => {
  const make = (props: Record<string, unknown>): Logger => ({
    debug: (message, data = {}) =>
      sink.push({ level: "debug", message, data: { ...props, ...data } }),
    info: (message, data = {}) =>
      sink.push({ level: "info", message, data: { ...props, ...data } }),
    warn: (message, data = {}) =>
      sink.push({ level: "warn", message, data: { ...props, ...data } }),
    error: (message, data = {}) =>
      sink.push({ level: "error", message, data: { ...props, ...data } }),
    child: (childProps) => make({ ...props, ...childProps }),
  })
  return make({})
}

// The documented local-dev placeholder (.gitleaks.toml allowlist, also used in
// README/CONTRIBUTING) — allowlisted by the secret scanner, never a real key.
const AUTH_TOKEN = "local-dev-token"
const REDIRECT_URI = "http://localhost:9999/callback"

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
      logger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHeader: false,
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

  // Register a client and start an authorization request directly through
  // the provider (the HTTP /register and /authorize routes are rate-limited;
  // /oauth/decide, the route under test, is not).
  const startPendingRequest = async (): Promise<string> => {
    const clientsStore = oauth.provider.clientsStore
    if (!clientsStore?.registerClient)
      throw new Error("clientsStore.registerClient not available")
    const client = await clientsStore.registerClient({
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
    const requestId = await startPendingRequest()
    const response = await submitToken(requestId, token)
    expect(response.status).toBe(302)
    const locationHeader = response.headers.get("location")
    if (!locationHeader) throw new Error("expected Location header on 302")
    const location = new URL(locationHeader)
    const code = location.searchParams.get("code")
    if (!code) throw new Error("expected code query param in redirect")
    expect(code.length).toBeGreaterThan(0)
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

describe("OAuth consent body validation", () => {
  let dir: string
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-body-val-"))
    const oauth = createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHeader: false,
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
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger: testLogger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHeader: false,
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

  const startPendingRequest = async (): Promise<string> => {
    const clientsStore = oauth.provider.clientsStore
    if (!clientsStore?.registerClient)
      throw new Error("clientsStore.registerClient not available")
    const client = await clientsStore.registerClient({
      client_name: "Audit Client",
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

  it("logs oauth_consent_completed on approved consent", async () => {
    const requestId = await startPendingRequest()
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
    expect(event).toMatchObject({
      level: "info",
      message: "oauth_consent_completed",
      data: expect.objectContaining({
        requestId,
        clientIp: expect.any(String),
      }),
    })
  })

  it("logs oauth_consent_bad_token on invalid token submission", async () => {
    const requestId = await startPendingRequest()
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
    expect(event).toMatchObject({
      level: "warn",
      message: "oauth_consent_bad_token",
      data: expect.objectContaining({ requestId }),
    })
  })

  it("logs oauth_consent_denied_by_user on deny action", async () => {
    const requestId = await startPendingRequest()
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

    const event = logs.find(
      (log) => log.message === "oauth_consent_denied_by_user",
    )
    expect(event).toMatchObject({
      level: "info",
      message: "oauth_consent_denied_by_user",
      data: expect.objectContaining({ requestId }),
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
    expect(event).toMatchObject({
      level: "warn",
      message: "oauth_consent_expired",
      data: expect.objectContaining({
        requestId: "nonexistent-id",
      }),
    })
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
      trustForwardedHeader: true,
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
  const register = (forwardedClientIp?: string) =>
    fetch(`${baseUrl}/register`, {
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

  it("serves 5 requests in a minute from one client IP, then returns 429", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await register()
      expect(response.status).toBe(201)
    }
    const sixth = await register()
    expect(sixth.status).toBe(429)
  })

  it("logs oauth_rate_limited with the offending client IP when the limit trips", async () => {
    for (let i = 0; i < 5; i++) {
      await register("203.0.113.9")
    }
    logs.length = 0
    const sixth = await register("203.0.113.9")
    expect(sixth.status).toBe(429)
    const event = logs.find((log) => log.message === "oauth_rate_limited")
    expect(event).toMatchObject({
      level: "warn",
      message: "oauth_rate_limited",
      data: expect.objectContaining({
        clientIp: "203.0.113.9",
        path: "/register",
      }),
    })
  })

  it("keys the limit by client IP, so exhausting one client leaves another unaffected", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await register("203.0.113.7")
      expect(response.status).toBe(201)
    }
    const sixthFromSameClient = await register("203.0.113.7")
    expect(sixthFromSameClient.status).toBe(429)
    const firstFromOtherClient = await register("203.0.113.8")
    expect(firstFromOtherClient.status).toBe(201)
  })

  // Each flow endpoint mounts its own limiter with its own counter, so the
  // per-endpoint tests below exercise four independent limiters — register
  // passing does not prove authorize/token/revoke are limited. The requests
  // are deliberately invalid: the limiter runs before request validation,
  // so invalid requests still count toward the window, and the pre-limit
  // status is each endpoint's own validation error.
  it("rate-limits /authorize after 5 requests from one client IP", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${baseUrl}/authorize?client_id=unknown`)
      expect(response.status).toBe(400)
    }
    const sixth = await fetch(`${baseUrl}/authorize?client_id=unknown`)
    expect(sixth.status).toBe(429)
  })

  it("rate-limits /token after 5 requests from one client IP", async () => {
    const requestToken = () =>
      fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code" }),
      })
    for (let i = 0; i < 5; i++) {
      const response = await requestToken()
      expect(response.status).toBe(400)
    }
    const sixth = await requestToken()
    expect(sixth.status).toBe(429)
  })

  it("rate-limits /revoke after 5 requests from one client IP", async () => {
    const revoke = () =>
      fetch(`${baseUrl}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "nonexistent-token" }),
      })
    for (let i = 0; i < 5; i++) {
      const response = await revoke()
      expect(response.status).toBe(400)
    }
    const sixth = await revoke()
    expect(sixth.status).toBe(429)
  })

  it("leaves /.well-known discovery metadata unlimited past 5 requests", async () => {
    for (let i = 0; i < 6; i++) {
      const response = await fetch(
        `${baseUrl}/.well-known/oauth-authorization-server`,
      )
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
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger: testLogger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHeader: false,
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

  const registerWithSpoofedIp = (spoofedIp: string) =>
    fetch(`${baseUrl}/register`, {
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

  // A distinct spoofed Forwarded value per request must NOT mint a fresh
  // rate-limit bucket — all six share the real peer's bucket, so the sixth
  // is 429.
  it("spoofed Forwarded headers do not bypass the /register rate limit", async () => {
    for (let i = 1; i <= 5; i++) {
      const response = await registerWithSpoofedIp(`198.51.100.${i}`)
      expect(response.status).toBe(201)
    }
    const sixth = await registerWithSpoofedIp("198.51.100.6")
    expect(sixth.status).toBe(429)
  })

  it("logs the real peer IP — not the spoofed value — when the limit trips", async () => {
    for (let i = 1; i <= 5; i++) {
      await registerWithSpoofedIp("198.51.100.9")
    }
    logs.length = 0
    const sixth = await registerWithSpoofedIp("198.51.100.9")
    expect(sixth.status).toBe(429)
    const event = logs.find((log) => log.message === "oauth_rate_limited")
    expect(event).toMatchObject({
      level: "warn",
      message: "oauth_rate_limited",
      data: expect.objectContaining({ path: "/register" }),
    })
    // The loopback form varies by platform (::1 / 127.0.0.1 / v4-mapped) —
    // the security property is that the logged IP is the real peer, never
    // the client-supplied header value.
    expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).toContain(
      event?.data.clientIp,
    )
  })
})

describe("OAuth protected resource metadata", () => {
  let dir: string
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-metadata-test-"))
    const oauth = createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath: join(dir, "oauth.db"),
      logger,
    })
    const router = createOAuthRoutes({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("http://localhost:8000"),
      oauthProvider: oauth,
      serviceDocumentationUrl: "https://example.com",
      trustForwardedHeader: false,
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

  // Also the guard against a future `resourceServerUrl` pass to
  // mcpAuthRouter: that would MOVE the SDK's metadata route to the suffixed
  // path and this root fetch would 404.
  it("serves the root discovery document unchanged", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ROOT_DOCUMENT)
  })

  it("serves the RFC 9728 path-suffixed document with the /mcp resource identifier", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ...ROOT_DOCUMENT,
      resource: SUFFIXED_RESOURCE,
    })
  })

  // Relational guard that survives SDK bumps: if a future SDK adds a field
  // to the root document, this fails until the suffixed document gains it.
  it("keeps the suffixed document identical to the live root document except for resource", async () => {
    const rootResponse = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    )
    const suffixedResponse = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    )
    const rootDocument = OAuthProtectedResourceMetadataSchema.parse(
      await rootResponse.json(),
    )
    const suffixedDocument = OAuthProtectedResourceMetadataSchema.parse(
      await suffixedResponse.json(),
    )
    expect(suffixedDocument).toEqual({
      ...rootDocument,
      resource: SUFFIXED_RESOURCE,
    })
  })

  it("serves the suffixed route with CORS enabled for browser-based clients", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    )
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("rejects non-GET methods on the suffixed route with 405 and an Allow header", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
      { method: "POST" },
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET, OPTIONS")
  })

  it("answers a browser CORS preflight on the suffixed route", async () => {
    const response = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "GET",
        },
      },
    )
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET,HEAD,PUT,PATCH,POST,DELETE",
    )
  })

  it("leaves the suffixed discovery route unlimited past 5 requests", async () => {
    for (let i = 0; i < 6; i++) {
      const response = await fetch(
        `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
      )
      expect(response.status).toBe(200)
    }
  })
})

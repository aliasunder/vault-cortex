/** OAuth challenge, rotation, sweep, reuse, and scope behavior over real HTTP. */

import { describe, it, expect, onTestFinished, vi } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import { signJwt, verifyJwt } from "../../jwt.js"
import {
  startServer,
  freePort,
  readSecurityHeaders,
  EXPECTED_SECURITY_HEADERS,
} from "./test-harness.js"

const REDIRECT_URI = "http://127.0.0.1/callback"
const TOKEN_A = "integration-token-before-rotation"
const TOKEN_B = "integration-token-after-rotation"

const base64Url = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

type RegisteredClient = { client_id: string; client_secret: string }
type IssuedTokens = { access_token: string; refresh_token: string; scope: string }

const isRegisteredClient = (value: unknown): value is RegisteredClient =>
  typeof value === "object" && value !== null && "client_id" in value && "client_secret" in value

const isIssuedTokens = (value: unknown): value is IssuedTokens =>
  typeof value === "object" &&
  value !== null &&
  "access_token" in value &&
  "refresh_token" in value &&
  "scope" in value

/** Initialize over /mcp with the transport's required Accept header, so
 *  a valid bearer is distinguishable (200) from a rejected one (401). */
const mcpResponseWithBearer = (port: number, bearer: string): Promise<Response> => {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  })
}

const mcpStatusWithBearer = async (port: number, bearer: string): Promise<number> => {
  const response = await mcpResponseWithBearer(port, bearer)
  return response.status
}

const registerClient = async (port: number): Promise<RegisteredClient> => {
  const response = await fetch(`http://127.0.0.1:${port}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "integration-test",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })

  if (response.status !== 201) throw new Error(`register: ${response.status}`)
  const registered: unknown = await response.json()

  if (!isRegisteredClient(registered)) throw new Error("malformed client")
  return registered
}

const buildAuthorizeUrl = ({
  port,
  client,
  challenge,
  scope,
}: {
  port: number
  client: RegisteredClient
  challenge: string
  scope: string
}): URL => {
  const authorizeUrl = new URL(`http://127.0.0.1:${port}/authorize`)
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope,
  }).toString()
  return authorizeUrl
}

/** Consent page → approve with the auth token → PKCE code exchange. */
const authorize = async ({
  port,
  client,
  authToken,
  scope = "vault",
}: {
  port: number
  client: RegisteredClient
  authToken: string
  scope?: string
}): Promise<IssuedTokens> => {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash("sha256").update(verifier).digest())
  const authorizeUrl = buildAuthorizeUrl({ port, client, challenge, scope })
  const consentHtml = await (await fetch(authorizeUrl)).text()
  const requestId = /name="request_id"\s+value="([^"]+)"/.exec(consentHtml)?.[1]

  if (!requestId) throw new Error("consent page carried no request_id")

  const decision = await fetch(`http://127.0.0.1:${port}/oauth/decide`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request_id: requestId,
      token: authToken,
      action: "approve",
    }),
    redirect: "manual",
  })
  const location = decision.headers.get("location")
  const code = location ? new URL(location).searchParams.get("code") : null

  if (!code) {
    throw new Error(`consent did not redirect with a code: ${decision.status}`)
  }

  const tokenResponse = await fetch(`http://127.0.0.1:${port}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: REDIRECT_URI,
    }),
  })

  if (tokenResponse.status !== 200) {
    throw new Error(`token exchange: ${tokenResponse.status}`)
  }
  const issued: unknown = await tokenResponse.json()

  if (!isIssuedTokens(issued)) throw new Error("malformed token response")
  return issued
}

const refresh = ({
  port,
  client,
  refreshToken,
  scope,
}: {
  port: number
  client: RegisteredClient
  refreshToken: string
  scope?: string
}): Promise<Response> => {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.client_id,
    client_secret: client.client_secret,
  })

  if (scope) params.set("scope", scope)
  return fetch(`http://127.0.0.1:${port}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  })
}

describe("JSON parser placement", () => {
  it.each([{ path: "/token" }, { path: "/revoke" }])(
    "returns the SDK OAuth 400 for a JSON body on $path",
    async ({ path }) => {
      const server = await startServer(await freePort(), { MCP_AUTH_TOKEN: TOKEN_A })
      onTestFinished(server.cleanup)
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: "json-client", token: "json-token" }),
      })

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 400,
        body: {
          error: "invalid_request",
          error_description: JSON.stringify(
            [
              {
                expected: "object",
                code: "invalid_type",
                path: [],
                message: "Invalid input: expected object, received undefined",
              },
            ],
            null,
            2,
          ),
        },
      })
      await server.cleanup()
      expect(server.stdout()).not.toContain('"message":"unhandled_error"')
      expect(server.stderr()).not.toContain('"message":"unhandled_error"')
    },
  )

  it.each([
    { label: "health check", method: "GET", path: "/healthz", status: 200, body: { ok: true } },
    {
      label: "MCP event stream",
      method: "GET",
      path: "/mcp",
      status: 405,
      body: { error: "method not allowed: this server does not offer a standalone SSE stream" },
    },
    {
      label: "MCP session deletion",
      method: "DELETE",
      path: "/mcp",
      status: 404,
      body: { error: "session not found" },
    },
  ])("ignores malformed JSON on the $label route", async ({ method, path, status, body }) => {
    const server = await startServer(await freePort(), { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(server.cleanup)
    // fetch forbids GET bodies; node:http sends the request the server must ignore.
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolveResponse, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${server.port}${path}`,
          {
            method,
            headers: {
              "content-type": "application/json",
              "content-length": "1",
              authorization: `Bearer ${TOKEN_A}`,
            },
          },
          (reply) => {
            const chunks: Buffer[] = []
            reply.on("data", (chunk: Buffer) => chunks.push(chunk))
            reply.on("error", reject)
            reply.on("end", () => {
              resolveResponse({
                status: reply.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
              })
            })
          },
        )
        request.on("error", reject)
        request.end("{")
      },
    )

    expect({ status: response.status, body: JSON.parse(response.body) }).toEqual({ status, body })
    await server.cleanup()
    expect(server.stdout()).not.toContain('"message":"request_body_rejected"')
    expect(server.stderr()).not.toContain('"message":"unhandled_error"')
  })

  it.each([
    { label: "authenticated MCP", path: "/mcp" },
    { label: "public registration", path: "/register" },
  ])("answers malformed $label JSON with 400", async ({ path }) => {
    const server = await startServer(await freePort(), { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(server.cleanup)
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_A}` },
      body: "{",
    })

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: { error: "invalid request body" },
    })
    await vi.waitFor(() => {
      expect(server.stdout()).toContain('"message":"request_body_rejected"')
    })
    await server.cleanup()
    const rejectionRecords = server
      .stdout()
      .trim()
      .split("\n")
      .map((line): Record<string, unknown> => JSON.parse(line))
      .filter((record) => record.message === "request_body_rejected")

    expect(rejectionRecords).toEqual([
      {
        timestamp: expect.any(String),
        level: "warn",
        name: "vault-cortex",
        message: "request_body_rejected",
        source: expect.stringMatching(/^http-error-middleware\.ts:\d+$/),
        clientIp: "127.0.0.1",
        method: "POST",
        path,
        type: "entity.parse.failed",
        status: 400,
      },
    ])
    expect(server.stderr()).not.toContain('"message":"unhandled_error"')
  })

  it.each([
    { label: "authenticated MCP", path: "/mcp", bytes: 6 * 1024 * 1024 },
    // One byte over the 8 KB registration cap, well under the 100 KB the
    // SDK's own parser would accept.
    { label: "public registration", path: "/register", bytes: 8 * 1024 + 1 },
  ])("answers oversized $label JSON with 413", async ({ path, bytes }) => {
    const server = await startServer(await freePort(), { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(server.cleanup)
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ body: "a".repeat(bytes) }),
    })

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 413,
      body: { error: "request body too large" },
    })
  })

  it.each([
    { label: "malformed", body: "{" },
    { label: "oversized", body: JSON.stringify({ body: "a".repeat(6 * 1024 * 1024) }) },
  ])("rejects tokenless $label MCP JSON before parsing or logging a request", async ({ body }) => {
    const server = await startServer(await freePort())
    onTestFinished(server.cleanup)
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 401,
      body: {
        error: "invalid_token",
        error_description: "Missing Authorization header",
      },
    })
    await server.cleanup()
    expect(server.stderr()).not.toContain('"message":"unhandled_error"')
    expect(server.stdout()).not.toContain('"message":"mcp_request"')
    expect(server.stdout()).not.toContain('"message":"request_body_rejected"')
  })

  it("rejects malformed JSON consent as an invalid form without an unhandled error", async () => {
    const server = await startServer(await freePort())
    onTestFinished(server.cleanup)
    const response = await fetch(`http://127.0.0.1:${server.port}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })

    expect({
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.text(),
    }).toEqual({ status: 400, cacheControl: "no-store", body: "Invalid form submission." })
    await server.cleanup()
    expect(server.stderr()).not.toContain('"message":"unhandled_error"')
  })
})

// ── Consent page response headers ──────────────────────────────

describe("consent page response headers", () => {
  it("serves the consent page with the security headers, not cacheable and without X-Powered-By", async () => {
    const port = await freePort()
    const server = await startServer(port, { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(() => server.cleanup())
    const client = await registerClient(port)
    const challenge = base64Url(createHash("sha256").update("header-check").digest())

    const response = await fetch(buildAuthorizeUrl({ port, client, challenge, scope: "vault" }))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("<h1>Authorize access</h1>")
    expect(readSecurityHeaders(response)).toEqual(EXPECTED_SECURITY_HEADERS)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("answers an oversized consent form with a 413 that is not cacheable", async () => {
    const port = await freePort()
    const server = await startServer(port, { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(() => server.cleanup())

    // The body exceeds express.urlencoded's default 100 KB limit, and the
    // server's error middleware answers the parser's error.
    const response = await fetch(`http://127.0.0.1:${port}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `request_id=a&token=${"t".repeat(200 * 1024)}&action=approve`,
    })

    expect({
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.json(),
    }).toEqual({
      status: 413,
      cacheControl: "no-store",
      body: { error: "request body too large" },
    })
  })
})

// ── Authorization errors never redirect ───────────────────────

describe("authorization errors answered directly", () => {
  // Anyone can register a client whose redirect address is their own site.
  const registerAttackerClient = async (port: number): Promise<RegisteredClient> => {
    const response = await fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "attacker",
        redirect_uris: ["https://attacker.example/landing"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })

    if (response.status !== 201) throw new Error(`register: ${response.status}`)
    const registered: unknown = await response.json()

    if (!isRegisteredClient(registered)) throw new Error("malformed client")
    return registered
  }

  it.each([
    {
      label: "a link carrying only the client_id",
      query: {},
      error: "invalid_request",
    },
    {
      label: "a request naming another server as the resource",
      query: {
        response_type: "code",
        code_challenge: base64Url(createHash("sha256").update("attacker").digest()),
        code_challenge_method: "S256",
        resource: "https://other.example/mcp",
      },
      error: "invalid_target",
    },
  ])(
    "answers $label with a 400 instead of a redirect to the registered address",
    async ({ query, error }) => {
      const port = await freePort()
      const server = await startServer(port, { MCP_AUTH_TOKEN: TOKEN_A })
      onTestFinished(() => server.cleanup())
      const client = await registerAttackerClient(port)
      const authorizeUrl = new URL(`http://127.0.0.1:${port}/authorize`)
      authorizeUrl.search = new URLSearchParams({
        client_id: client.client_id,
        ...query,
      }).toString()

      const response = await fetch(authorizeUrl, { redirect: "manual" })

      expect({
        status: response.status,
        location: response.headers.get("location"),
        cacheControl: response.headers.get("cache-control"),
        body: await response.json(),
      }).toEqual({
        status: 400,
        location: null,
        cacheControl: "no-store",
        body: { error, error_description: expect.any(String) },
      })
      expect(readSecurityHeaders(response)).toEqual(EXPECTED_SECURITY_HEADERS)
    },
  )

  it("shows the recovery page when the client's registration is gone", async () => {
    const port = await freePort()
    const server = await startServer(port, { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(() => server.cleanup())
    const authorizeUrl = new URL(`http://127.0.0.1:${port}/authorize`)
    authorizeUrl.search = new URLSearchParams({ client_id: "registration-swept" }).toString()

    const response = await fetch(authorizeUrl, { redirect: "manual" })

    expect({
      status: response.status,
      contentType: response.headers.get("content-type"),
      location: response.headers.get("location"),
      cacheControl: response.headers.get("cache-control"),
      heading: /<h1>([^<]*)<\/h1>/.exec(await response.text())?.[1],
    }).toEqual({
      status: 400,
      contentType: "text/html; charset=utf-8",
      location: null,
      cacheControl: "no-store",
      heading: "This sign-in can't continue",
    })
    expect(readSecurityHeaders(response)).toEqual(EXPECTED_SECURITY_HEADERS)
  })
})

// ── MCP endpoint guards ───────────────────────────────────────

describe("MCP endpoint Origin check", () => {
  it("refuses a request from another origin even with a valid token", async () => {
    const server = await startServer(await freePort(), { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(server.cleanup)

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN_A}`,
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    })

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { error: "origin not allowed" },
    })
  })
})

describe("MCP endpoint failed sign-in limiter", () => {
  // 64 hex characters, the length every documented install path generates,
  // against a token under the 32-character gate. (TOKEN_A is 33 characters,
  // so the other suites run with the limiter off.)
  const GENERATED_TOKEN = "a".repeat(64)
  const SHORT_TOKEN = "short-token"

  const wrongTokenStatuses = async (port: number, count: number): Promise<number[]> => {
    const statuses: number[] = []

    for (let attempt = 0; attempt < count; attempt++) {
      statuses.push(await mcpStatusWithBearer(port, `wrong-${attempt}`))
    }
    return statuses
  }

  it("answers the 31st wrong token in a minute with 429 and warns at boot when the token is short", async () => {
    const server = await startServer(await freePort(), { MCP_AUTH_TOKEN: SHORT_TOKEN })
    onTestFinished(server.cleanup)

    expect(await wrongTokenStatuses(server.port, 30)).toEqual(Array(30).fill(401))
    expect(await mcpStatusWithBearer(server.port, "wrong-31")).toBe(429)
    expect(server.stdout()).toContain(
      '"message":"MCP_AUTH_TOKEN is shorter than 32 characters, so failed sign-in attempts on /mcp are rate-limited; a generated token needs no limiter"',
    )
  })

  it("never rate-limits and never warns when the token is a generated one", async () => {
    const server = await startServer(await freePort(), { MCP_AUTH_TOKEN: GENERATED_TOKEN })
    onTestFinished(server.cleanup)

    expect(await wrongTokenStatuses(server.port, 31)).toEqual(Array(31).fill(401))
    expect(server.stdout()).not.toContain("failed sign-in attempts on /mcp are rate-limited")
  })
})

// ── Expired access token challenge ─────────────────────────────

describe("expired access token challenge", () => {
  it("returns the OAuth resource challenge for an expired bound JWT", async () => {
    const port = await freePort()
    const server = await startServer(port, { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(() => server.cleanup())
    const token = signJwt(
      {
        sub: "expired-client",
        scope: "vault",
        exp: DateTime.now().minus({ minutes: 1 }).toUnixInteger(),
        iss: `http://127.0.0.1:${port}/`,
        aud: `http://127.0.0.1:${port}/mcp`,
      },
      TOKEN_A,
    )

    const response = await mcpResponseWithBearer(port, token)

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", error_description="Token expired or invalid", resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`,
    )
  })
})

// ── Rotating MCP_AUTH_TOKEN ends every OAuth session ───────────

describe("rotating MCP_AUTH_TOKEN", () => {
  it("rejects every refresh token issued under the old token and accepts a fresh consent", async () => {
    // The OAuth database lives beside INDEX_DB_PATH, so a test-owned data
    // directory survives the first server's cleanup and the second boot
    // opens the same oauth.db under the new token.
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-rotation-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const indexDbPath = join(dataDir, "search.db")
    const port = await freePort()

    const before = await startServer(port, {
      MCP_AUTH_TOKEN: TOKEN_A,
      INDEX_DB_PATH: indexDbPath,
    })
    onTestFinished(before.cleanup)
    const client = await registerClient(port)
    const issued = await authorize({ port, client, authToken: TOKEN_A })
    expect(await mcpStatusWithBearer(port, issued.access_token)).toBe(200)
    const rotated = await refresh({
      port,
      client,
      refreshToken: issued.refresh_token,
    })
    expect(rotated.status).toBe(200)
    const rotatedTokens: unknown = await rotated.json()

    if (!isIssuedTokens(rotatedTokens)) throw new Error("malformed refresh")
    await before.cleanup()

    // A fresh port: the first server's socket can linger after exit, and
    // only the data directory needs to carry over. PUBLIC_URL stays on the
    // first port so the old access token's audience still matches — its
    // 401 below must come from the rotated key, not from a changed URL.
    const rotatedPort = await freePort()
    const after = await startServer(rotatedPort, {
      MCP_AUTH_TOKEN: TOKEN_B,
      INDEX_DB_PATH: indexDbPath,
      PUBLIC_URL: `http://127.0.0.1:${port}`,
    })
    onTestFinished(() => after.cleanup())

    const rejected = await refresh({
      port: rotatedPort,
      client,
      refreshToken: rotatedTokens.refresh_token,
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token expired or invalid",
    })
    expect(await mcpStatusWithBearer(rotatedPort, rotatedTokens.access_token)).toBe(401)

    const reissued = await authorize({
      port: rotatedPort,
      client,
      authToken: TOKEN_B,
    })
    expect(await mcpStatusWithBearer(rotatedPort, reissued.access_token)).toBe(200)
    const refreshedAgain = await refresh({
      port: rotatedPort,
      client,
      refreshToken: reissued.refresh_token,
    })
    expect(refreshedAgain.status).toBe(200)
  }, 60_000)
})

// ── Client registration sweep ─────────────────────────────────

describe("client registration sweep", () => {
  it("sweeps an hour-old registration that never signed in on the next boot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-sweep-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const sameDataDir = { INDEX_DB_PATH: join(dataDir, "search.db") }
    const port = await freePort()

    const before = await startServer(port, sameDataDir)
    onTestFinished(before.cleanup)
    const stale = await registerClient(port)
    const kept = await registerClient(port)
    await before.cleanup()

    // Backdate both past the sweep's one-hour age on disk, and mark `kept`
    // as signed in, so only `stale` is swept.
    const oauthDb = new Database(join(dataDir, "oauth.db"))
    onTestFinished(() => {
      oauthDb.close()
    })
    const twoHoursAgo = DateTime.now().minus({ hours: 2 }).toUnixInteger()
    const backdate = oauthDb.prepare(
      "UPDATE clients SET data = json_set(data, '$.client_id_issued_at', ?) WHERE client_id = ?",
    )
    backdate.run(twoHoursAgo, stale.client_id)
    backdate.run(twoHoursAgo, kept.client_id)
    oauthDb
      .prepare("UPDATE clients SET signed_in_at = ? WHERE client_id = ?")
      .run(twoHoursAgo, kept.client_id)

    const rebootedPort = await freePort()
    const after = await startServer(rebootedPort, sameDataDir)
    onTestFinished(() => after.cleanup())
    await fetch(`http://127.0.0.1:${rebootedPort}/healthz`)

    const registeredClientIds = oauthDb
      .prepare<[], { client_id: string }>("SELECT client_id FROM clients")
      .all()
      .map((clientRow) => clientRow.client_id)
    expect(registeredClientIds).toEqual([kept.client_id])
  }, 60_000)
})

// ── Refresh-token reuse detection ─────────────────────────────

describe("refresh-token reuse detection", () => {
  it("revokes the grant when a rotated refresh token is replayed", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-reuse-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const port = await freePort()
    const server = await startServer(port, {
      MCP_AUTH_TOKEN: TOKEN_A,
      INDEX_DB_PATH: join(dataDir, "search.db"),
    })
    onTestFinished(() => server.cleanup())

    const client = await registerClient(port)
    const issued = await authorize({ port, client, authToken: TOKEN_A })
    const originalRefresh = issued.refresh_token

    // Rotate: consumes the original, issues a new pair
    const rotated = await refresh({
      port,
      client,
      refreshToken: originalRefresh,
    })
    expect(rotated.status).toBe(200)
    const rotatedTokens: unknown = await rotated.json()

    if (!isIssuedTokens(rotatedTokens)) throw new Error("malformed refresh")

    // Replay the original (consumed) — triggers reuse detection
    const replay = await refresh({
      port,
      client,
      refreshToken: originalRefresh,
    })
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token expired or invalid",
    })

    // The rotated refresh token is also dead — the whole grant was
    // revoked, not just the replayed token.
    const rotatedRefresh = await refresh({
      port,
      client,
      refreshToken: rotatedTokens.refresh_token,
    })
    expect(rotatedRefresh.status).toBe(400)

    // Re-consent produces a working grant
    const reissued = await authorize({ port, client, authToken: TOKEN_A })
    expect(await mcpStatusWithBearer(port, reissued.access_token)).toBe(200)
  }, 60_000)

  it("keeps a revoked client's registration through the sweep, so it signs in again under the same client_id", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-reuse-sweep-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const sameDataDir = { MCP_AUTH_TOKEN: TOKEN_A, INDEX_DB_PATH: join(dataDir, "search.db") }
    const port = await freePort()

    const before = await startServer(port, sameDataDir)
    onTestFinished(before.cleanup)
    const client = await registerClient(port)
    const issued = await authorize({ port, client, authToken: TOKEN_A })
    const rotated = await refresh({ port, client, refreshToken: issued.refresh_token })
    expect(rotated.status).toBe(200)
    const replay = await refresh({ port, client, refreshToken: issued.refresh_token })
    expect(replay.status).toBe(400)
    // Never signs in, so the reboot's sweep deletes it.
    const neverSignedIn = await registerClient(port)
    await before.cleanup()

    // The state a week later: registered well past the sweep's one-hour age,
    // no refresh token left after the revocation, and the revocation record
    // purged after six hours.
    const oauthDb = new Database(join(dataDir, "oauth.db"))
    onTestFinished(() => {
      oauthDb.close()
    })
    const eightDaysAgo = DateTime.now().minus({ days: 8 }).toUnixInteger()
    const backdate = oauthDb.prepare(
      "UPDATE clients SET data = json_set(data, '$.client_id_issued_at', ?) WHERE client_id = ?",
    )
    backdate.run(eightDaysAgo, client.client_id)
    backdate.run(eightDaysAgo, neverSignedIn.client_id)
    oauthDb.prepare("DELETE FROM revoked_clients WHERE client_id = ?").run(client.client_id)
    const remainingTokenRows = oauthDb
      .prepare<[string], { token: string }>("SELECT token FROM refresh_tokens WHERE client_id = ?")
      .all(client.client_id)
    expect(remainingTokenRows).toEqual([])

    // The reboot's sweep runs before any request.
    const rebootedPort = await freePort()
    const after = await startServer(rebootedPort, sameDataDir)
    onTestFinished(() => after.cleanup())

    const registeredClientIds = oauthDb
      .prepare<[], { client_id: string }>("SELECT client_id FROM clients")
      .all()
      .map((clientRow) => clientRow.client_id)
    expect(registeredClientIds).toEqual([client.client_id])
    const reissued = await authorize({ port: rebootedPort, client, authToken: TOKEN_A })
    expect(await mcpStatusWithBearer(rebootedPort, reissued.access_token)).toBe(200)
  }, 60_000)
})

// ── Granted scope ─────────────────────────────────────────────

describe("granted scope", () => {
  it("grants vault to a sign-in that asks for another scope, and keeps it on refresh", async () => {
    const port = await freePort()
    const server = await startServer(port, { MCP_AUTH_TOKEN: TOKEN_A })
    onTestFinished(() => server.cleanup())
    const client = await registerClient(port)

    const issued = await authorize({ port, client, authToken: TOKEN_A, scope: "admin-zq9" })
    const accessTokenPayload = verifyJwt({
      token: issued.access_token,
      secret: TOKEN_A,
      expectedIssuer: `http://127.0.0.1:${port}/`,
      expectedAudience: `http://127.0.0.1:${port}/mcp`,
    })
    const refreshed = await refresh({ port, client, refreshToken: issued.refresh_token })
    const refreshedTokens: unknown = await refreshed.json()

    if (!isIssuedTokens(refreshedTokens)) throw new Error("malformed refresh")
    expect(issued.scope).toBe("vault")
    expect(accessTokenPayload?.scope).toBe("vault")
    expect(refreshed.status).toBe(200)
    expect(refreshedTokens.scope).toBe("vault")
  }, 60_000)
})

// ── Scope-widening refresh ────────────────────────────────────

describe("scope-widening refresh", () => {
  it("consumes the token on scope widening and rejects a retry with the granted scope", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-scope-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const port = await freePort()
    const server = await startServer(port, {
      MCP_AUTH_TOKEN: TOKEN_A,
      INDEX_DB_PATH: join(dataDir, "search.db"),
    })
    onTestFinished(() => server.cleanup())

    const client = await registerClient(port)
    const issued = await authorize({ port, client, authToken: TOKEN_A })

    // Scope widening: rejected with invalid_scope
    const widened = await refresh({
      port,
      client,
      refreshToken: issued.refresh_token,
      scope: "vault admin",
    })
    expect(widened.status).toBe(400)
    expect(await widened.json()).toEqual({
      error: "invalid_scope",
      error_description: "Requested scope exceeds the granted scope",
    })

    // Retry with the granted scope: token was consumed, plain miss
    const retried = await refresh({
      port,
      client,
      refreshToken: issued.refresh_token,
    })
    expect(retried.status).toBe(400)
    expect(await retried.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token expired or invalid",
    })
  }, 60_000)
})

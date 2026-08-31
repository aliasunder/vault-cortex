/** OAuth integration tests — token rotation, client sweep, and reuse
 *  detection exercised over real HTTP against a real server. */

import { describe, it, expect, onTestFinished } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import { startServer, freePort } from "./test-harness.js"

const REDIRECT_URI = "http://127.0.0.1/callback"
const TOKEN_A = "integration-token-before-rotation"
const TOKEN_B = "integration-token-after-rotation"

const base64Url = (buffer: Buffer): string =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

type RegisteredClient = { client_id: string; client_secret: string }
type IssuedTokens = { access_token: string; refresh_token: string }

const isRegisteredClient = (value: unknown): value is RegisteredClient =>
  typeof value === "object" &&
  value !== null &&
  "client_id" in value &&
  "client_secret" in value

const isIssuedTokens = (value: unknown): value is IssuedTokens =>
  typeof value === "object" &&
  value !== null &&
  "access_token" in value &&
  "refresh_token" in value

/** Initialize over /mcp with the transport's required Accept header, so
 *  a valid bearer is distinguishable (200) from a rejected one (401). */
const mcpStatusWithBearer = async (
  port: number,
  bearer: string,
): Promise<number> => {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
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

/** Consent page → approve with the auth token → PKCE code exchange. */
const authorize = async ({
  port,
  client,
  authToken,
}: {
  port: number
  client: RegisteredClient
  authToken: string
}): Promise<IssuedTokens> => {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash("sha256").update(verifier).digest())
  const authorizeUrl = new URL(`http://127.0.0.1:${port}/authorize`)
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "vault",
  }).toString()
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
}: {
  port: number
  client: RegisteredClient
  refreshToken: string
}): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
      client_secret: client.client_secret,
    }),
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
    expect(
      await mcpStatusWithBearer(rotatedPort, rotatedTokens.access_token),
    ).toBe(401)

    const reissued = await authorize({
      port: rotatedPort,
      client,
      authToken: TOKEN_B,
    })
    expect(await mcpStatusWithBearer(rotatedPort, reissued.access_token)).toBe(
      200,
    )
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
  it("sweeps a week-old registration that never consented on the next boot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-sweep-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const sameDataDir = { INDEX_DB_PATH: join(dataDir, "search.db") }
    const port = await freePort()

    const before = await startServer(port, sameDataDir)
    const stale = await registerClient(port)
    const kept = await registerClient(port)
    await before.cleanup()

    // Backdate both past the sweep's one-week age on disk. Only `stale`
    // is tokenless: `kept` gets a refresh token row seeded under an
    // unrelated key, the state a rotation leaves behind.
    const oauthDb = new Database(join(dataDir, "oauth.db"))
    onTestFinished(() => {
      oauthDb.close()
    })
    const eightDaysAgo = DateTime.now().minus({ days: 8 }).toUnixInteger()
    const backdate = oauthDb.prepare(
      "UPDATE clients SET data = json_set(data, '$.client_id_issued_at', ?) WHERE client_id = ?",
    )
    backdate.run(eightDaysAgo, stale.client_id)
    backdate.run(eightDaysAgo, kept.client_id)
    oauthDb
      .prepare(
        "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "hmac-sha256:unreachable-after-rotation",
        kept.client_id,
        "vault",
        DateTime.now().plus({ days: 60 }).toUnixInteger(),
      )

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
})

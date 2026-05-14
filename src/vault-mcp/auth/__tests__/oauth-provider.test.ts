import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import { createOAuthProvider } from "../oauth-provider.js"
import type { OAuthProvider } from "../oauth-provider.js"
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js"

const AUTH_TOKEN = "test-static-token"

const seedClient = (db: Database.Database): OAuthClientInformationFull => {
  const client = {
    client_id: "test-client",
    client_id_issued_at: DateTime.now().toUnixInteger(),
    client_secret: "test-secret",
    client_secret_expires_at: 0,
    redirect_uris: ["https://example.com/cb"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  } as OAuthClientInformationFull
  db.prepare("INSERT INTO clients (client_id, data) VALUES (?, ?)").run(
    client.client_id,
    JSON.stringify(client),
  )
  return client
}

const seedRefreshToken = (
  db: Database.Database,
  token: string,
  clientId: string,
  scopes: string[],
  expiresAt: number,
): void => {
  db.prepare(
    "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
  ).run(token, clientId, scopes.join(" "), expiresAt)
}

describe("OAuth refresh token sliding expiry", () => {
  let dir: string
  let dbPath: string
  let oauth: OAuthProvider
  let db: Database.Database
  let client: OAuthClientInformationFull

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-test-"))
    dbPath = join(dir, "oauth.db")
    oauth = createOAuthProvider({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("https://example.com"),
      dbPath,
    })
    db = new Database(dbPath)
    client = seedClient(db)
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("accepts a refresh token used within the 60-day window", async () => {
    seedRefreshToken(
      db,
      "fresh-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    const tokens = await oauth.provider.exchangeRefreshToken!(
      client,
      "fresh-token",
    )

    expect(tokens.refresh_token).toBeDefined()
    expect(tokens.refresh_token).not.toBe("fresh-token")
    expect(tokens.scope).toBe("vault")
  })

  it("rejects a refresh token past its expires_at", async () => {
    seedRefreshToken(
      db,
      "expired-token",
      client.client_id,
      ["vault"],
      DateTime.now().minus({ seconds: 1 }).toUnixInteger(),
    )

    await expect(
      oauth.provider.exchangeRefreshToken!(client, "expired-token"),
    ).rejects.toThrow("Refresh token expired or invalid")
  })

  it("removes an expired token from the DB on read", async () => {
    seedRefreshToken(
      db,
      "expired-token",
      client.client_id,
      ["vault"],
      DateTime.now().minus({ seconds: 1 }).toUnixInteger(),
    )

    await expect(
      oauth.provider.exchangeRefreshToken!(client, "expired-token"),
    ).rejects.toThrow()

    const row = db
      .prepare("SELECT * FROM refresh_tokens WHERE token = ?")
      .get("expired-token")
    expect(row).toBeUndefined()
  })

  it("rotates to a new token with a fresh 60-day window on use", async () => {
    seedRefreshToken(
      db,
      "first-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    const tokens = await oauth.provider.exchangeRefreshToken!(
      client,
      "first-token",
    )
    const newToken = tokens.refresh_token
    expect(newToken).toBeDefined()

    const row = db
      .prepare("SELECT expires_at FROM refresh_tokens WHERE token = ?")
      .get(newToken!) as { expires_at: number } | undefined
    expect(row).toBeDefined()

    // The new token's expires_at should be ~60 days from "now" — i.e.
    // a fresh window, not inherited from the old token's expires_at.
    const expected = DateTime.now().plus({ days: 60 }).toUnixInteger()
    expect(row!.expires_at).toBeGreaterThanOrEqual(expected - 5)
    expect(row!.expires_at).toBeLessThanOrEqual(expected + 5)
  })

  it("invalidates the old token after rotation (single-use)", async () => {
    seedRefreshToken(
      db,
      "first-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    await oauth.provider.exchangeRefreshToken!(client, "first-token")

    await expect(
      oauth.provider.exchangeRefreshToken!(client, "first-token"),
    ).rejects.toThrow("Refresh token expired or invalid")
  })

  it("treats a row with expires_at=0 as expired (migration default)", async () => {
    seedRefreshToken(db, "pre-migration-token", client.client_id, ["vault"], 0)

    await expect(
      oauth.provider.exchangeRefreshToken!(client, "pre-migration-token"),
    ).rejects.toThrow("Refresh token expired or invalid")
  })

  it("rejects a non-existent refresh token", async () => {
    await expect(
      oauth.provider.exchangeRefreshToken!(client, "never-existed"),
    ).rejects.toThrow("Refresh token expired or invalid")
  })
})

describe("OAuth refresh token schema migration", () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oauth-migration-test-"))
    dbPath = join(dir, "oauth.db")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("adds expires_at to a pre-sliding-expiry refresh_tokens table", () => {
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE refresh_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL
      );
      INSERT INTO refresh_tokens (token, client_id, scopes)
      VALUES ('legacy-token', 'legacy-client', 'vault');
    `)
    oldDb.close()

    createOAuthProvider({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("https://example.com"),
      dbPath,
    })

    const db = new Database(dbPath)
    try {
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('refresh_tokens')")
        .all() as { name: string }[]
      expect(columns.map((c) => c.name)).toContain("expires_at")

      const row = db
        .prepare("SELECT expires_at FROM refresh_tokens WHERE token = ?")
        .get("legacy-token") as { expires_at: number } | undefined
      expect(row).toBeDefined()
      expect(row!.expires_at).toBe(0) // DEFAULT 0 — treated as expired
    } finally {
      db.close()
    }
  })

  it("is idempotent — re-running on a migrated DB doesn't error", () => {
    createOAuthProvider({
      authToken: AUTH_TOKEN,
      serverUrl: new URL("https://example.com"),
      dbPath,
    })

    expect(() =>
      createOAuthProvider({
        authToken: AUTH_TOKEN,
        serverUrl: new URL("https://example.com"),
        dbPath,
      }),
    ).not.toThrow()
  })
})

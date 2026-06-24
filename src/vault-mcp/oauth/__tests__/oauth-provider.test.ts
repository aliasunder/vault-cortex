import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  onTestFinished,
} from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import { signJwt } from "../../../jwt.js"
import { createOAuthProvider } from "../oauth-provider.js"
import type { OAuthProvider } from "../oauth-provider.js"
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js"
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

const seedRevokedToken = (db: Database.Database, token: string): void => {
  db.prepare(
    "INSERT INTO revoked_tokens (token, revoked_at) VALUES (?, ?)",
  ).run(token, DateTime.now().toUnixInteger())
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
      dbPath,
      logger,
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

    expect(typeof tokens.refresh_token).toBe("string")
    expect(tokens.refresh_token!.length).toBeGreaterThan(0)
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
    ).rejects.toThrow("Refresh token expired or invalid")

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
    expect(typeof newToken).toBe("string")
    expect(newToken!.length).toBeGreaterThan(0)

    const row = db
      .prepare("SELECT expires_at FROM refresh_tokens WHERE token = ?")
      .get(newToken!) as { expires_at: number } | undefined
    expect(row).not.toBeUndefined()

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
      dbPath,
      logger,
    })

    const db = new Database(dbPath)
    try {
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('refresh_tokens')")
        .all() as { name: string }[]
      expect(columns.map((column) => column.name)).toContain("expires_at")

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
      dbPath,
      logger,
    })

    expect(() =>
      createOAuthProvider({
        authToken: AUTH_TOKEN,
        dbPath,
        logger,
      }),
    ).not.toThrow()
  })
})

// Each test gets a fresh OAuth provider + SQLite DB in a temp directory.
// The second DB connection (`db`) is for seeding test state (revoked tokens)
// without going through the provider's API — isolating what we're testing.
describe("verifyAccessToken", () => {
  let dir: string
  let dbPath: string
  let oauth: OAuthProvider
  let db: Database.Database

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "verify-token-test-"))
    dbPath = join(dir, "oauth.db")
    oauth = createOAuthProvider({ authToken: AUTH_TOKEN, dbPath, logger })
    db = new Database(dbPath)
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("accepts the static auth token", async () => {
    const result = await oauth.provider.verifyAccessToken!(AUTH_TOKEN)
    expect(result.clientId).toBe("static")
    expect(result.scopes).toEqual(["vault"])
    expect(result.token).toBe(AUTH_TOKEN)
  })

  it("gives the static token a future expiresAt so requireBearerAuth accepts it", async () => {
    const result = await oauth.provider.verifyAccessToken!(AUTH_TOKEN)
    // requireBearerAuth rejects any AuthInfo where expiresAt is not a number,
    // or is in the past. The static token must carry a future numeric expiry.
    expect(typeof result.expiresAt).toBe("number")
    expect(result.expiresAt!).toBeGreaterThan(DateTime.now().toUnixInteger())
  })

  it("returns correct auth info for a valid JWT", async () => {
    const token = signJwt(
      {
        sub: "client-123",
        scope: "vault",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: "vault-cortex",
      },
      AUTH_TOKEN,
    )

    const result = await oauth.provider.verifyAccessToken!(token)
    expect(result.clientId).toBe("client-123")
    expect(result.scopes).toEqual(["vault"])
    expect(result.token).toBe(token)
    expect(typeof result.expiresAt).toBe("number")
    expect(result.expiresAt!).toBeGreaterThan(DateTime.now().toUnixInteger())
  })

  it("parses multiple scopes from JWT scope claim", async () => {
    const token = signJwt(
      {
        sub: "client-456",
        scope: "vault read write",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: "vault-cortex",
      },
      AUTH_TOKEN,
    )

    const result = await oauth.provider.verifyAccessToken!(token)
    expect(result.scopes).toEqual(["vault", "read", "write"])
  })

  it("returns empty scopes when JWT scope claim is empty", async () => {
    const token = signJwt(
      {
        sub: "client-789",
        scope: "",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: "vault-cortex",
      },
      AUTH_TOKEN,
    )

    const result = await oauth.provider.verifyAccessToken!(token)
    expect(result.scopes).toEqual([])
  })

  it("rejects a revoked JWT", async () => {
    const token = signJwt(
      {
        sub: "client-123",
        scope: "vault",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: "vault-cortex",
      },
      AUTH_TOKEN,
    )
    seedRevokedToken(db, token)

    await expect(oauth.provider.verifyAccessToken!(token)).rejects.toThrow(
      "Token has been revoked",
    )
  })

  it("rejects an expired JWT", async () => {
    const token = signJwt(
      {
        sub: "client-123",
        scope: "vault",
        exp: DateTime.now().minus({ seconds: 10 }).toUnixInteger(),
        iss: "vault-cortex",
      },
      AUTH_TOKEN,
    )

    await expect(oauth.provider.verifyAccessToken!(token)).rejects.toThrow(
      "Token expired or invalid",
    )
  })

  it("rejects a garbage token", async () => {
    await expect(
      oauth.provider.verifyAccessToken!("not-a-jwt-not-the-static-token"),
    ).rejects.toThrow("Token expired or invalid")
  })
})

const setupAuditTest = async (): Promise<{
  logs: LogCall[]
  oauth: OAuthProvider
  db: Database.Database
  client: OAuthClientInformationFull
}> => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-audit-test-"))
  const dbPath = join(dir, "oauth.db")
  const logs: LogCall[] = []
  const oauth = createOAuthProvider({
    authToken: AUTH_TOKEN,
    dbPath,
    logger: recordingLogger(logs),
  })
  const db = new Database(dbPath)
  const client = seedClient(db)
  onTestFinished(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { logs, oauth, db, client }
}

describe("OAuth audit logging", () => {
  it("logs oauth_client_registered on dynamic client registration", async () => {
    const { logs, oauth } = await setupAuditTest()

    const registered = await oauth.provider.clientsStore!.registerClient!({
      client_name: "Audit Test Client",
      redirect_uris: ["https://example.com/cb"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })

    const event = logs.find((log) => log.message === "oauth_client_registered")
    expect(event).toBeDefined()
    expect(event!.level).toBe("info")
    expect(event!.data.clientId).toBe(registered.client_id)
    expect(event!.data.clientName).toBe("Audit Test Client")
  })

  it("logs oauth_code_exchanged on successful authorization code exchange", async () => {
    const { logs, oauth, client } = await setupAuditTest()
    const requestId = await startAuthFlow(oauth, client)
    const code = oauth.approveRequest(requestId)
    logs.length = 0

    await oauth.provider.exchangeAuthorizationCode!(client, code)

    const event = logs.find((log) => log.message === "oauth_code_exchanged")
    expect(event).toBeDefined()
    expect(event!.level).toBe("info")
    expect(event!.data.clientId).toBe(client.client_id)
  })

  it("logs oauth_code_exchange_failed when auth code is expired", async () => {
    const { logs, oauth, client } = await setupAuditTest()

    await expect(
      oauth.provider.exchangeAuthorizationCode!(client, "bogus-code"),
    ).rejects.toThrow("Authorization code expired or invalid")

    const event = logs.find(
      (log) => log.message === "oauth_code_exchange_failed",
    )
    expect(event).toBeDefined()
    expect(event!.level).toBe("warn")
    expect(event!.data.reason).toBe("expired_or_invalid")
  })

  it("logs oauth_token_refreshed on successful refresh", async () => {
    const { logs, oauth, db, client } = await setupAuditTest()
    seedRefreshToken(
      db,
      "audit-refresh",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )
    logs.length = 0

    await oauth.provider.exchangeRefreshToken!(client, "audit-refresh")

    const event = logs.find((log) => log.message === "oauth_token_refreshed")
    expect(event).toBeDefined()
    expect(event!.level).toBe("info")
    expect(event!.data.clientId).toBe(client.client_id)
  })

  it("logs oauth_token_refresh_failed when refresh token is invalid", async () => {
    const { logs, oauth, client } = await setupAuditTest()

    await expect(
      oauth.provider.exchangeRefreshToken!(client, "nonexistent"),
    ).rejects.toThrow("Refresh token expired or invalid")

    const event = logs.find(
      (log) => log.message === "oauth_token_refresh_failed",
    )
    expect(event).toBeDefined()
    expect(event!.level).toBe("warn")
    expect(event!.data.reason).toBe("expired_or_invalid")
  })

  it("logs oauth_token_revoked on revocation", async () => {
    const { logs, oauth, client } = await setupAuditTest()

    await oauth.provider.revokeToken!(client, {
      token: "some-token",
      token_type_hint: "access_token",
    })

    const event = logs.find((log) => log.message === "oauth_token_revoked")
    expect(event).toBeDefined()
    expect(event!.level).toBe("info")
  })

  it("logs oauth_token_rejected when a revoked token is verified", async () => {
    const { logs, oauth, db, client } = await setupAuditTest()
    const validJwt = signJwt(
      {
        sub: client.client_id,
        scope: "vault",
        exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
        iss: "vault-cortex",
      },
      AUTH_TOKEN,
    )
    seedRevokedToken(db, validJwt)

    await expect(oauth.provider.verifyAccessToken!(validJwt)).rejects.toThrow(
      "Token has been revoked",
    )

    const event = logs.find((log) => log.message === "oauth_token_rejected")
    expect(event).toBeDefined()
    expect(event!.level).toBe("warn")
    expect(event!.data.reason).toBe("revoked")
  })

  it("logs oauth_consent_approved on consent approval", async () => {
    const { logs, oauth, client } = await setupAuditTest()
    const requestId = await startAuthFlow(oauth, client)

    oauth.approveRequest(requestId)

    const event = logs.find((log) => log.message === "oauth_consent_approved")
    expect(event).toBeDefined()
    expect(event!.level).toBe("info")
    expect(event!.data.clientId).toBe(client.client_id)
    expect(event!.data.requestId).toBe(requestId)
  })

  it("logs oauth_consent_approve_failed when no pending request exists", async () => {
    const { logs, oauth } = await setupAuditTest()

    expect(() => oauth.approveRequest("nonexistent")).toThrow(
      "No pending request",
    )

    const event = logs.find(
      (log) => log.message === "oauth_consent_approve_failed",
    )
    expect(event).toBeDefined()
    expect(event!.level).toBe("warn")
    expect(event!.data.reason).toBe("no_pending_request")
  })
})

/** Starts an authorization flow and returns the requestId extracted from
 *  the rendered consent HTML. */
const startAuthFlow = async (
  oauth: OAuthProvider,
  client: OAuthClientInformationFull,
): Promise<string> => {
  let capturedHtml = ""
  const res = {
    type: () => res,
    send: (html: string) => {
      capturedHtml = html
      return res
    },
  }
  await oauth.provider.authorize(
    client,
    {
      codeChallenge: "test-challenge",
      redirectUri: "https://example.com/cb",
      scopes: ["vault"],
    },
    res as never,
  )
  const match = /name="request_id"\s+value="([^"]+)"/.exec(capturedHtml)
  if (!match?.[1]) throw new Error("no request_id in consent HTML")
  return match[1]
}

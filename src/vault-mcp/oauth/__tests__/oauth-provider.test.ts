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
import { createHmac } from "node:crypto"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import { signJwt } from "../../../jwt.js"
import { createOAuthProvider } from "../oauth-provider.js"
import type { OAuthProvider } from "../oauth-provider.js"
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
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
const OTHER_AUTH_TOKEN = "rotated-static-token"

// Mirrors the provider's storage-key derivation so tests can seed and
// inspect rows without importing production as its own oracle.
const refreshTokenKey = (token: string, secret = AUTH_TOKEN): string =>
  "hmac-sha256:" +
  createHmac("sha256", secret).update(`refresh-token:${token}`).digest("hex")

const storedRefreshTokenKeys = (db: Database.Database): string[] =>
  db
    .prepare<[], { token: string }>(
      "SELECT token FROM refresh_tokens ORDER BY token",
    )
    .all()
    .map((refreshTokenRow) => refreshTokenRow.token)

const storedRevokedTokens = (db: Database.Database): string[] =>
  db
    .prepare<[], { token: string }>(
      "SELECT token FROM revoked_tokens ORDER BY token",
    )
    .all()
    .map((revokedTokenRow) => revokedTokenRow.token)

const exchangeRefreshToken = (
  oauth: OAuthProvider,
  client: OAuthClientInformationFull,
  refreshToken: string,
): Promise<OAuthTokens> =>
  oauth.provider.exchangeRefreshToken(client, refreshToken)

// revokeToken is optional on the SDK's provider type; this provider
// always implements it.
const revokeToken = async (
  oauth: OAuthProvider,
  client: OAuthClientInformationFull,
  token: string,
): Promise<void> => {
  if (!oauth.provider.revokeToken)
    throw new Error("revokeToken not implemented")
  await oauth.provider.revokeToken(client, { token })
}

/** Runs the real consent → code → token flow and returns the issued tokens. */
const issueTokens = async (
  oauth: OAuthProvider,
  client: OAuthClientInformationFull,
): Promise<OAuthTokens> => {
  const requestId = await startAuthFlow(oauth, client)
  const code = oauth.approveRequest(requestId, logger)
  return oauth.provider.exchangeAuthorizationCode(client, code)
}

const issuedRefreshToken = async (
  oauth: OAuthProvider,
  client: OAuthClientInformationFull,
): Promise<string> => {
  const tokens = await issueTokens(oauth, client)
  if (!tokens.refresh_token) throw new Error("no refresh token issued")
  return tokens.refresh_token
}

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
  ).run(refreshTokenKey(token), clientId, scopes.join(" "), expiresAt)
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

    const tokens = await oauth.provider.exchangeRefreshToken(
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
      oauth.provider.exchangeRefreshToken(client, "expired-token"),
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
      oauth.provider.exchangeRefreshToken(client, "expired-token"),
    ).rejects.toThrow("Refresh token expired or invalid")

    expect(storedRefreshTokenKeys(db)).toEqual([])
  })

  it("rotates to a new token with a fresh 60-day window on use", async () => {
    // Seeded far from a fresh window so a rotated token that inherited
    // this expiry would miss the assertion below by ~59 days.
    seedRefreshToken(
      db,
      "first-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 1 }).toUnixInteger(),
    )

    const tokens = await exchangeRefreshToken(oauth, client, "first-token")
    const newToken = tokens.refresh_token
    if (!newToken) throw new Error("no refresh token issued")

    const row = db
      .prepare<[string], { expires_at: number }>(
        "SELECT expires_at FROM refresh_tokens WHERE token = ?",
      )
      .get(refreshTokenKey(newToken))
    if (!row) throw new Error("rotated refresh token was not stored")

    // The new token's expires_at should be ~60 days from "now" — i.e.
    // a fresh window, not inherited from the old token's expires_at.
    const expected = DateTime.now().plus({ days: 60 }).toUnixInteger()
    expect(row.expires_at).toBeGreaterThanOrEqual(expected - 5)
    expect(row.expires_at).toBeLessThanOrEqual(expected + 5)
  })

  it("invalidates the old token after rotation (single-use)", async () => {
    seedRefreshToken(
      db,
      "first-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    await oauth.provider.exchangeRefreshToken(client, "first-token")

    await expect(
      oauth.provider.exchangeRefreshToken(client, "first-token"),
    ).rejects.toThrow("Refresh token expired or invalid")
  })

  it("treats a row with expires_at=0 as expired (migration default)", async () => {
    seedRefreshToken(db, "pre-migration-token", client.client_id, ["vault"], 0)

    await expect(
      oauth.provider.exchangeRefreshToken(client, "pre-migration-token"),
    ).rejects.toThrow("Refresh token expired or invalid")
  })

  it("rejects a non-existent refresh token", async () => {
    await expect(
      oauth.provider.exchangeRefreshToken(client, "never-existed"),
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
    `)
    oldDb.close()

    createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath,
      logger,
    })

    const db = new Database(dbPath)
    onTestFinished(() => {
      db.close()
    })
    const columns = db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('refresh_tokens')",
      )
      .all()
    expect(columns.map((column) => column.name)).toEqual([
      "token",
      "client_id",
      "scopes",
      "expires_at",
    ])
  })

  it("clears raw refresh tokens written by a version that stored them in plaintext", () => {
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE refresh_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
    oldDb
      .prepare(
        "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "legacy-token",
        "legacy-client",
        "vault",
        DateTime.now().plus({ days: 60 }).toUnixInteger(),
      )
    oldDb.close()

    createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath,
      logger,
    })

    const db = new Database(dbPath)
    onTestFinished(() => {
      db.close()
    })
    expect(storedRefreshTokenKeys(db)).toEqual([])
  })

  it("clears raw refresh tokens written after a rollback beside keyed rows it keeps", async () => {
    createOAuthProvider({ authToken: AUTH_TOKEN, dbPath, logger })
    const db = new Database(dbPath)
    onTestFinished(() => {
      db.close()
    })
    const client = seedClient(db)
    seedRefreshToken(
      db,
      "keyed-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )
    db.prepare(
      "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
    ).run(
      "raw-token-from-rollback",
      client.client_id,
      "vault",
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    const reopened = createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath,
      logger,
    })

    expect(storedRefreshTokenKeys(db)).toEqual([refreshTokenKey("keyed-token")])
    const tokens = await exchangeRefreshToken(reopened, client, "keyed-token")
    expect(tokens.scope).toBe("vault")
  })

  it("logs oauth_refresh_tokens_cleared when clearing raw tokens", () => {
    const oldDb = new Database(dbPath)
    oldDb.exec(`
      CREATE TABLE refresh_tokens (
        token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
    oldDb
      .prepare(
        "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "legacy-token",
        "legacy-client",
        "vault",
        DateTime.now().plus({ days: 60 }).toUnixInteger(),
      )
    oldDb.close()

    const logs: LogCall[] = []
    const testLogger = recordingLogger(logs)
    createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath,
      logger: testLogger,
    })

    const event = logs.find(
      (log) => log.message === "oauth_refresh_tokens_cleared",
    )
    expect(event).toEqual(
      expect.objectContaining({
        level: "info",
        message: "oauth_refresh_tokens_cleared",
        data: expect.objectContaining({
          reason: "plaintext_rows",
          rows: 1,
        }),
      }),
    )
  })

  it("keeps keyed refresh tokens when the provider is re-opened", async () => {
    createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath,
      logger,
    })
    const db = new Database(dbPath)
    onTestFinished(() => {
      db.close()
    })
    const client = seedClient(db)
    seedRefreshToken(
      db,
      "live-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    const reopened = createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath,
      logger,
    })

    expect(storedRefreshTokenKeys(db)).toEqual([refreshTokenKey("live-token")])
    const tokens = await exchangeRefreshToken(reopened, client, "live-token")
    expect(tokens.scope).toBe("vault")
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
  testLogger: Logger
  oauth: OAuthProvider
  db: Database.Database
  client: OAuthClientInformationFull
}> => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-audit-test-"))
  const dbPath = join(dir, "oauth.db")
  const logs: LogCall[] = []
  const testLogger = recordingLogger(logs)
  const oauth = createOAuthProvider({
    authToken: AUTH_TOKEN,
    dbPath,
    logger: testLogger,
  })
  const db = new Database(dbPath)
  const client = seedClient(db)
  onTestFinished(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { logs, testLogger, oauth, db, client }
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
    const { logs, testLogger, oauth, client } = await setupAuditTest()
    const requestId = await startAuthFlow(oauth, client)
    const code = oauth.approveRequest(
      requestId,
      testLogger.child({ clientId: client.client_id }),
    )
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

    await oauth.provider.exchangeRefreshToken(client, "audit-refresh")

    const event = logs.find((log) => log.message === "oauth_token_refreshed")
    expect(event).toBeDefined()
    expect(event!.level).toBe("info")
    expect(event!.data.clientId).toBe(client.client_id)
  })

  it("logs oauth_token_refresh_failed when refresh token is invalid", async () => {
    const { logs, oauth, client } = await setupAuditTest()

    await expect(
      oauth.provider.exchangeRefreshToken(client, "nonexistent"),
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
    const { logs, testLogger, oauth, client } = await setupAuditTest()
    const requestId = await startAuthFlow(oauth, client)
    const consentLogger = testLogger.child({
      clientIp: "127.0.0.1",
      requestId,
      clientId: client.client_id,
    })

    oauth.approveRequest(requestId, consentLogger)

    const event = logs.find((log) => log.message === "oauth_consent_approved")
    expect(event).toBeDefined()
    expect(event!.level).toBe("info")
    expect(event!.data.clientId).toBe(client.client_id)
    expect(event!.data.requestId).toBe(requestId)
  })

  it("logs oauth_consent_approve_failed when no pending request exists", async () => {
    const { logs, testLogger, oauth } = await setupAuditTest()
    const reqLogger = testLogger.child({ requestId: "nonexistent" })

    expect(() => oauth.approveRequest("nonexistent", reqLogger)).toThrow(
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

describe("OAuth refresh token storage keyed by the auth token", () => {
  const createKeyedStorageTest = async (): Promise<{
    dbPath: string
    oauth: OAuthProvider
    db: Database.Database
    client: OAuthClientInformationFull
  }> => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-keyed-test-"))
    const dbPath = join(dir, "oauth.db")
    const oauth = createOAuthProvider({ authToken: AUTH_TOKEN, dbPath, logger })
    const db = new Database(dbPath)
    onTestFinished(async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    })
    const client = seedClient(db)
    return { dbPath, oauth, db, client }
  }

  it("stores an issued refresh token only under its HMAC key", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()

    const refreshToken = await issuedRefreshToken(oauth, client)

    expect(storedRefreshTokenKeys(db)).toEqual([refreshTokenKey(refreshToken)])
  })

  it("rejects a refresh token issued under a different auth token and leaves its row in place", async () => {
    const { dbPath, oauth, db, client } = await createKeyedStorageTest()
    const firstToken = await issuedRefreshToken(oauth, client)
    const secondToken = await issuedRefreshToken(oauth, client)
    const rotated = createOAuthProvider({
      authToken: OTHER_AUTH_TOKEN,
      dbPath,
      logger,
    })

    await expect(
      exchangeRefreshToken(rotated, client, firstToken),
    ).rejects.toThrow("Refresh token expired or invalid")

    expect(storedRefreshTokenKeys(db)).toEqual(
      [refreshTokenKey(firstToken), refreshTokenKey(secondToken)].sort(),
    )
    const tokens = await exchangeRefreshToken(oauth, client, secondToken)
    expect(tokens.scope).toBe("vault")
  })

  it("purges expired rows when a refresh token is issued", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    seedRefreshToken(
      db,
      "expired-token",
      client.client_id,
      ["vault"],
      DateTime.now().minus({ seconds: 1 }).toUnixInteger(),
    )
    seedRefreshToken(
      db,
      "live-token",
      client.client_id,
      ["vault"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    const issued = await issuedRefreshToken(oauth, client)

    expect(storedRefreshTokenKeys(db)).toEqual(
      [refreshTokenKey("live-token"), refreshTokenKey(issued)].sort(),
    )
  })

  it("revoking a refresh token removes its row without recording it in revoked_tokens", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    const refreshToken = await issuedRefreshToken(oauth, client)

    await revokeToken(oauth, client, refreshToken)

    expect(storedRefreshTokenKeys(db)).toEqual([])
    expect(storedRevokedTokens(db)).toEqual([])
    await expect(
      exchangeRefreshToken(oauth, client, refreshToken),
    ).rejects.toThrow("Refresh token expired or invalid")
  })

  it("revoking an access token records it in revoked_tokens and rejects it afterwards", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    const { access_token: accessToken } = await issueTokens(oauth, client)

    await revokeToken(oauth, client, accessToken)

    expect(storedRevokedTokens(db)).toEqual([accessToken])
    await expect(oauth.provider.verifyAccessToken(accessToken)).rejects.toThrow(
      "Token has been revoked",
    )
  })

  it("rejects a refresh token presented by a client other than the one it was issued to and leaves its row in place", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    const refreshToken = await issuedRefreshToken(oauth, client)
    const otherClient: OAuthClientInformationFull = {
      ...client,
      client_id: "other-client",
    }

    await expect(
      exchangeRefreshToken(oauth, otherClient, refreshToken),
    ).rejects.toThrow("Refresh token expired or invalid")

    expect(storedRefreshTokenKeys(db)).toEqual([refreshTokenKey(refreshToken)])
    const tokens = await exchangeRefreshToken(oauth, client, refreshToken)
    expect(tokens.scope).toBe("vault")
  })

  it("rejects a refresh that requests a scope outside the granted scope", async () => {
    const { oauth, client } = await createKeyedStorageTest()
    const refreshToken = await issuedRefreshToken(oauth, client)

    await expect(
      oauth.provider.exchangeRefreshToken(client, refreshToken, [
        "vault",
        "admin",
      ]),
    ).rejects.toThrow("Requested scope exceeds the granted scope")
  })

  it("consumes the refresh token even when scope validation rejects", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    const refreshToken = await issuedRefreshToken(oauth, client)

    await expect(
      oauth.provider.exchangeRefreshToken(client, refreshToken, [
        "vault",
        "admin",
      ]),
    ).rejects.toThrow("Requested scope exceeds the granted scope")

    expect(storedRefreshTokenKeys(db)).toEqual([])
    await expect(
      exchangeRefreshToken(oauth, client, refreshToken),
    ).rejects.toThrow("Refresh token expired or invalid")
  })

  it("issues the stored scope when a refresh requests none", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    seedRefreshToken(
      db,
      "two-scope-token",
      client.client_id,
      ["vault", "extra"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    const tokens = await exchangeRefreshToken(oauth, client, "two-scope-token")

    expect(tokens.scope).toBe("vault extra")
  })

  it("narrows the issued scope when a refresh requests a subset", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    seedRefreshToken(
      db,
      "two-scope-token",
      client.client_id,
      ["vault", "extra"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )

    const tokens = await oauth.provider.exchangeRefreshToken(
      client,
      "two-scope-token",
      ["vault"],
    )

    expect(tokens.scope).toBe("vault")
  })

  it("keeps a narrowed scope on the rotated refresh token", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()
    seedRefreshToken(
      db,
      "two-scope-token",
      client.client_id,
      ["vault", "extra"],
      DateTime.now().plus({ days: 60 }).toUnixInteger(),
    )
    const narrowed = await oauth.provider.exchangeRefreshToken(
      client,
      "two-scope-token",
      ["vault"],
    )
    if (!narrowed.refresh_token) throw new Error("no refresh token issued")

    const tokens = await exchangeRefreshToken(
      oauth,
      client,
      narrowed.refresh_token,
    )

    expect(tokens.scope).toBe("vault")
  })

  it("issues the stored scope when a refresh sends a blank scope", async () => {
    const { oauth, client } = await createKeyedStorageTest()
    const refreshToken = await issuedRefreshToken(oauth, client)

    const tokens = await oauth.provider.exchangeRefreshToken(
      client,
      refreshToken,
      [""],
    )

    expect(tokens.scope).toBe("vault")
  })

  it("revoking an unknown string records nothing", async () => {
    const { oauth, db, client } = await createKeyedStorageTest()

    await revokeToken(oauth, client, "not-a-token")

    expect(storedRevokedTokens(db)).toEqual([])
    expect(storedRefreshTokenKeys(db)).toEqual([])
  })

  it("logs scope_exceeds_grant reason when a refresh widens scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-keyed-log-test-"))
    const dbPath = join(dir, "oauth.db")
    const logs: LogCall[] = []
    const testLogger = recordingLogger(logs)
    const oauth = createOAuthProvider({
      authToken: AUTH_TOKEN,
      dbPath,
      logger: testLogger,
    })
    const db = new Database(dbPath)
    onTestFinished(async () => {
      db.close()
      await rm(dir, { recursive: true, force: true })
    })
    const client = seedClient(db)
    const refreshToken = await issuedRefreshToken(oauth, client)
    logs.length = 0

    await expect(
      oauth.provider.exchangeRefreshToken(client, refreshToken, [
        "vault",
        "admin",
      ]),
    ).rejects.toThrow("Requested scope exceeds the granted scope")

    const event = logs.find(
      (log) => log.message === "oauth_token_refresh_failed",
    )
    expect(event).toEqual(
      expect.objectContaining({
        level: "warn",
        message: "oauth_token_refresh_failed",
        data: expect.objectContaining({
          reason: "scope_exceeds_grant",
          clientId: client.client_id,
        }),
      }),
    )
  })
})

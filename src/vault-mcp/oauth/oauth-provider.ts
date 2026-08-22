/**
 * OAuth 2.1 provider for vault-cortex.
 *
 * - Dynamic client registration (Claude Desktop, Perplexity self-register)
 * - Authorization code flow with PKCE
 * - JWT access tokens (HS256, verifiable by Lambda + Express)
 * - Backward-compatible static token verification (MCP_AUTH_TOKEN)
 * - SQLite persistence for refresh tokens + clients (survives restarts);
 *   refresh tokens are stored keyed by an HMAC under MCP_AUTH_TOKEN, so
 *   rotating the token ends every session and the DB holds no usable token
 * - Consent page gated by the server's auth token
 */

import Database from "better-sqlite3"
import { createHmac, randomUUID, randomBytes } from "node:crypto"
import { DateTime } from "luxon"
import type { Response } from "express"
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  OAuthError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"
import { safeEqual } from "../../auth.js"
import { signJwt, verifyJwt } from "../../jwt.js"
import { renderConsentPage } from "./consent-page.js"
import type { Logger } from "../../logger.js"

// 24 hours
const ACCESS_TOKEN_TTL_S = 24 * 60 * 60
// 60 days. Sliding (inactivity) expiry — each use rotates the token
// AND resets the countdown, so a daily user never sees it and a
// dormant client re-auths after 60 days. Bounds the blast radius of
// a leaked refresh token without inconveniencing active sessions.
const REFRESH_TOKEN_TTL_S = 60 * 24 * 60 * 60
// 10 minutes — OAuth spec recommends short auth code lifetimes.
const AUTH_CODE_TTL_S = 10 * 60

type PendingAuthRequest = {
  client: OAuthClientInformationFull
  params: AuthorizationParams
  createdAt: DateTime
}

type StoredAuthCode = {
  clientId: string
  codeChallenge: string
  params: AuthorizationParams
  expiresAt: DateTime
}

type OAuthProviderOptions = {
  authToken: string
  dbPath: string
  /** Maximum rows in the clients table; registration is refused beyond it. */
  maxClients: number
  logger: Logger
}

// Every stored refresh-token key starts with this prefix. Raw tokens
// are bare hex, so the prefix is what tells a keyed row from one written
// by a version that stored tokens in plaintext — including rows written
// after a rollback to such a version.
const REFRESH_TOKEN_KEY_PREFIX = "hmac-sha256:"
// Prepended to the token before hashing, so this HMAC can never equal the
// JWT signature, which uses the same key (see jwt.ts).
const REFRESH_TOKEN_KEY_LABEL = "refresh-token:"

/** Registration refused because the clients table is at its cap. The SDK
 *  maps any OAuthError thrown by registerClient to a 400 carrying this
 *  code; RFC 7591 defines no code for a full server, so this one is
 *  vault-cortex's own. */
class RegistrationLimitError extends OAuthError {
  static override errorCode = "registration_limit_reached"
}

// Fraction of the client cap at which each registration logs a warning,
// so an operator sees the cap approaching before it refuses anyone.
const CLIENT_CAP_WARNING_FRACTION = 0.8

const initDb = (dbPath: string, logger: Logger): Database.Database => {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL") // concurrent reads during writes
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      token TEXT PRIMARY KEY,
      revoked_at INTEGER NOT NULL
    );
  `)
  // Migration for DBs created before sliding expiry: add expires_at
  // with DEFAULT 0 so any pre-migration row is treated as expired on
  // first read. Accepted trade-off — a one-time forced re-auth for any
  // currently-active session — and it keeps the new column NOT NULL
  // without an arbitrary backfill timestamp.
  const hasExpiresAt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('refresh_tokens') WHERE name = 'expires_at'",
    )
    .get()
  if (!hasExpiresAt) {
    db.exec(
      "ALTER TABLE refresh_tokens ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0",
    )
  }
  // Rows whose key lacks the prefix hold raw tokens written by a version
  // that stored them in plaintext; the keyed lookup can never match them,
  // so clear them on every boot. Each affected client re-authorizes once
  // through the consent page.
  const { changes: rawRowsCleared } = db
    .prepare("DELETE FROM refresh_tokens WHERE token NOT LIKE ?")
    .run(`${REFRESH_TOKEN_KEY_PREFIX}%`)
  if (rawRowsCleared > 0) {
    logger.info("oauth_refresh_tokens_cleared", {
      reason: "plaintext_rows",
      rows: rawRowsCleared,
    })
  }
  return db
}

class SqliteClientsStore implements OAuthRegisteredClientsStore {
  private readonly selectClientStmt: Database.Statement<
    [string],
    { data: string }
  >
  private readonly countClientsStmt: Database.Statement<[], { count: number }>
  private readonly insertClientStmt: Database.Statement<[string, string]>
  /** Counts, checks the cap, and inserts in one transaction so concurrent
   *  registrations cannot overshoot it. Returns the row count after the
   *  insert; throws RegistrationLimitError when the table is full. */
  private readonly insertClientWithinCap: (
    clientId: string,
    data: string,
  ) => number

  constructor(
    private db: Database.Database,
    private maxClients: number,
    private logger: Logger,
  ) {
    this.selectClientStmt = db.prepare(
      "SELECT data FROM clients WHERE client_id = ?",
    )
    this.countClientsStmt = db.prepare("SELECT COUNT(*) AS count FROM clients")
    this.insertClientStmt = db.prepare(
      "INSERT INTO clients (client_id, data) VALUES (?, ?)",
    )
    this.insertClientWithinCap = db.transaction(
      (clientId: string, data: string): number => {
        const countRow = this.countClientsStmt.get()
        if (!countRow) throw new Error("COUNT(*) returned no row")
        const registeredClients = countRow.count
        if (registeredClients >= this.maxClients) {
          throw new RegistrationLimitError("Client registration limit reached")
        }
        this.insertClientStmt.run(clientId, data)
        return registeredClients + 1
      },
    )
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.selectClientStmt.get(clientId)
    if (!row) return undefined
    const parsed: OAuthClientInformationFull = JSON.parse(row.data)
    return parsed
  }

  registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: DateTime.now().toUnixInteger(),
      client_secret: randomBytes(32).toString("hex"),
      client_secret_expires_at: 0,
    }
    // Logged before re-throwing: the SDK turns the error into a 400 and
    // the refused client never sees why.
    let registeredClients: number
    try {
      registeredClients = this.insertClientWithinCap(
        full.client_id,
        JSON.stringify(full),
      )
    } catch (error) {
      if (error instanceof RegistrationLimitError) {
        this.logger.warn("oauth_client_registration_refused", {
          reason: "limit_reached",
          maxClients: this.maxClients,
        })
      }
      throw error
    }
    this.logger.info("oauth_client_registered", {
      clientId: full.client_id,
      clientName: full.client_name ?? null,
    })
    const nearingCap =
      registeredClients >= this.maxClients * CLIENT_CAP_WARNING_FRACTION
    if (nearingCap) {
      this.logger.warn("oauth_client_cap_nearing", {
        registeredClients,
        maxClients: this.maxClients,
      })
    }
    return full
  }
}

export type OAuthProvider = {
  provider: OAuthServerProvider
  getPendingRequest: (
    id: string,
    logger: Logger,
  ) => PendingAuthRequest | undefined
  approveRequest: (requestId: string, logger: Logger) => string
  deletePendingRequest: (id: string) => void
}

export const createOAuthProvider = ({
  authToken,
  dbPath,
  maxClients,
  logger,
}: OAuthProviderOptions): OAuthProvider => {
  const oauthLogger = logger.child({ component: "oauth" })
  const db = initDb(dbPath, oauthLogger)
  const store = new SqliteClientsStore(db, maxClients, oauthLogger)
  const pendingRequests = new Map<string, PendingAuthRequest>()
  const authCodes = new Map<string, StoredAuthCode>()

  /** Storage key for a refresh token: an HMAC of the token under the
   *  auth token. Rows are only reachable under the secret that wrote
   *  them, so rotating MCP_AUTH_TOKEN ends every session, and a copied
   *  DB holds no token a client could present. */
  const refreshTokenStorageKey = (token: string): string => {
    const digest = createHmac("sha256", authToken)
      .update(REFRESH_TOKEN_KEY_LABEL + token)
      .digest("hex")
    return REFRESH_TOKEN_KEY_PREFIX + digest
  }

  const insertRefreshTokenStmt = db.prepare<[string, string, string, number]>(
    "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
  )
  const deleteExpiredRefreshTokensStmt = db.prepare<[number]>(
    "DELETE FROM refresh_tokens WHERE expires_at < ?",
  )
  const selectRefreshTokenStmt = db.prepare<
    [string, string],
    { scopes: string; expires_at: number }
  >(
    "SELECT scopes, expires_at FROM refresh_tokens WHERE token = ? AND client_id = ?",
  )
  const deleteRefreshTokenStmt = db.prepare<[string]>(
    "DELETE FROM refresh_tokens WHERE token = ?",
  )
  const insertRevokedTokenStmt = db.prepare<[string, number]>(
    "INSERT OR IGNORE INTO revoked_tokens (token, revoked_at) VALUES (?, ?)",
  )
  const selectRevokedTokenStmt = db.prepare<[string]>(
    "SELECT 1 FROM revoked_tokens WHERE token = ?",
  )

  const issueAccessToken = (clientId: string, scopes: string[]): string =>
    signJwt(
      {
        sub: clientId,
        scope: scopes.join(" "),
        exp: DateTime.now()
          .plus({ seconds: ACCESS_TOKEN_TTL_S })
          .toUnixInteger(),
        iss: "vault-cortex",
      },
      authToken,
    )

  /** Stores a refresh token under its storage key. Expired rows are
   *  purged here as well as on read: a row is only read when its own
   *  token is presented, so rows left by dormant clients — or made
   *  unreachable by a rotation — would otherwise stay forever. */
  const saveRefreshToken = ({
    token,
    clientId,
    scopes,
  }: {
    token: string
    clientId: string
    scopes: string[]
  }): void => {
    const now = DateTime.now()
    deleteExpiredRefreshTokensStmt.run(now.toUnixInteger())
    insertRefreshTokenStmt.run(
      refreshTokenStorageKey(token),
      clientId,
      scopes.join(" "),
      now.plus({ seconds: REFRESH_TOKEN_TTL_S }).toUnixInteger(),
    )
  }

  /** Refresh token rotation with sliding expiry. Tokens are single-use
   *  (consumed on read to prevent replay) AND time-bounded (rejected
   *  past expires_at). A successful refresh issues a new token whose
   *  expires_at is REFRESH_TOKEN_TTL_S from now — every use resets the
   *  countdown, so active clients never expire. A token issued under a
   *  different auth token derives a different key and is never found. */
  const consumeRefreshToken = ({
    token,
    clientId,
  }: {
    token: string
    clientId: string
  }): { scopes: string[] } | null => {
    const storageKey = refreshTokenStorageKey(token)
    const row = selectRefreshTokenStmt.get(storageKey, clientId)
    if (!row) return null
    deleteRefreshTokenStmt.run(storageKey)
    if (row.expires_at < DateTime.now().toUnixInteger()) return null
    return { scopes: row.scopes.split(" ") }
  }

  const isRevoked = (token: string): boolean =>
    !!selectRevokedTokenStmt.get(token)

  // Methods below implement OAuthServerProvider from the MCP SDK.
  // They appear unused locally but are called by mcpAuthRouter() and
  // requireBearerAuth() in server.ts during the OAuth lifecycle.
  const provider: OAuthServerProvider = {
    get clientsStore(): OAuthRegisteredClientsStore {
      return store
    },

    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response,
    ): Promise<void> {
      const requestId = randomUUID()
      pendingRequests.set(requestId, {
        client,
        params,
        createdAt: DateTime.now(),
      })

      oauthLogger.info("oauth_authorize_started", {
        clientId: client.client_id,
        requestId,
        scopes: params.scopes ?? [],
      })
      res.type("html").send(
        renderConsentPage({
          clientName: client.client_name ?? client.client_id,
          clientId: client.client_id,
          scopes: params.scopes ?? [],
          requestId,
        }),
      )
    },

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const stored = authCodes.get(authorizationCode)
      if (!stored || stored.expiresAt < DateTime.now()) {
        oauthLogger.warn("oauth_challenge_failed", {
          reason: "expired_or_invalid",
        })
        throw new InvalidGrantError("Authorization code expired or invalid")
      }
      return stored.codeChallenge
    },

    async exchangeAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      _redirectUri?: string,
      _resource?: URL,
    ): Promise<OAuthTokens> {
      const stored = authCodes.get(authorizationCode)
      if (!stored || stored.expiresAt < DateTime.now()) {
        oauthLogger.warn("oauth_code_exchange_failed", {
          reason: "expired_or_invalid",
        })
        throw new InvalidGrantError("Authorization code expired or invalid")
      }
      authCodes.delete(authorizationCode)

      const scopes = stored.params.scopes ?? []
      const accessToken = issueAccessToken(stored.clientId, scopes)
      const refreshToken = randomBytes(32).toString("hex")
      saveRefreshToken({
        token: refreshToken,
        clientId: stored.clientId,
        scopes,
      })

      oauthLogger.info("oauth_code_exchanged", {
        clientId: stored.clientId,
        scopes,
      })
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_S,
        refresh_token: refreshToken,
        scope: scopes.join(" "),
      }
    },

    /** RFC 6749 §6: the refresh token must have been issued to the
     *  authenticated client, and a requested scope may narrow but never
     *  widen the scope originally granted.
     *  https://www.rfc-editor.org/rfc/rfc6749#section-6 */
    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[],
      _resource?: URL,
    ): Promise<OAuthTokens> {
      const clientId = client.client_id
      const stored = consumeRefreshToken({ token: refreshToken, clientId })
      if (!stored) {
        oauthLogger.warn("oauth_token_refresh_failed", {
          reason: "expired_or_invalid",
          clientId,
        })
        throw new InvalidGrantError("Refresh token expired or invalid")
      }

      // An omitted or empty scope means the stored scope (RFC 6749 §6, linked
      // above). The SDK splits `scope=` into [""], so blank entries count
      // as empty.
      const requestedScopes = (scopes ?? []).filter((scope) => scope !== "")
      const grantedScopes =
        requestedScopes.length > 0 ? requestedScopes : stored.scopes
      const requestedScopeWidens = grantedScopes.some(
        (scope) => !stored.scopes.includes(scope),
      )
      if (requestedScopeWidens) {
        oauthLogger.warn("oauth_token_refresh_failed", {
          reason: "scope_exceeds_grant",
          clientId,
        })
        throw new InvalidScopeError("Requested scope exceeds the granted scope")
      }
      const accessToken = issueAccessToken(clientId, grantedScopes)
      const newRefreshToken = randomBytes(32).toString("hex")
      saveRefreshToken({
        token: newRefreshToken,
        clientId,
        scopes: grantedScopes,
      })

      oauthLogger.info("oauth_token_refreshed", {
        clientId,
        scopes: grantedScopes,
      })
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_S,
        refresh_token: newRefreshToken,
        scope: grantedScopes.join(" "),
      }
    },

    /** Three-tier verification: static token (fast path for CLI) → revocation check → JWT. */
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (safeEqual(token, authToken)) {
        oauthLogger.debug("oauth_token_verified", { method: "static" })
        // The static token never expires, but the SDK's requireBearerAuth
        // rejects any AuthInfo without a numeric expiresAt ("Token has no
        // expiration time"). Hand it a far-future timestamp so the static
        // token is accepted while remaining effectively perpetual.
        return {
          token,
          clientId: "static",
          scopes: ["vault"],
          expiresAt: DateTime.now().plus({ years: 10 }).toUnixInteger(),
        }
      }

      if (isRevoked(token)) {
        oauthLogger.warn("oauth_token_rejected", { reason: "revoked" })
        throw new InvalidTokenError("Token has been revoked")
      }

      const payload = verifyJwt(token, authToken)
      if (payload) {
        oauthLogger.debug("oauth_token_verified", {
          method: "jwt",
          clientId: payload.sub,
        })
        return {
          token,
          clientId: payload.sub,
          scopes: payload.scope ? payload.scope.split(" ") : [],
          expiresAt: payload.exp,
        }
      }

      oauthLogger.warn("oauth_token_rejected", {
        reason: "invalid_or_expired",
      })
      throw new InvalidTokenError("Token expired or invalid")
    },

    /** RFC 7009: revoke whatever the client presents. A refresh token is
     *  removed by its storage key; only a currently-valid access JWT is
     *  added to the revocation list, so revoked_tokens never holds a
     *  refresh token or an arbitrary string in plaintext.
     *  https://www.rfc-editor.org/rfc/rfc7009 */
    async revokeToken(
      client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      const { changes: refreshTokensDeleted } = deleteRefreshTokenStmt.run(
        refreshTokenStorageKey(request.token),
      )
      const isValidAccessToken = verifyJwt(request.token, authToken) !== null
      if (isValidAccessToken) {
        insertRevokedTokenStmt.run(
          request.token,
          DateTime.now().toUnixInteger(),
        )
      }
      // Logged from what the revoke matched, not the client's hint.
      const revokedTokenType = (): string => {
        if (isValidAccessToken) return "access_token"
        if (refreshTokensDeleted > 0) return "refresh_token"
        return "unknown"
      }
      oauthLogger.info("oauth_token_revoked", {
        clientId: client.client_id,
        tokenType: revokedTokenType(),
      })
    },
  }

  const getPendingRequest = (
    id: string,
    reqLogger: Logger,
  ): PendingAuthRequest | undefined => {
    const pending = pendingRequests.get(id)
    if (!pending) return undefined
    if (pending.createdAt.plus({ seconds: AUTH_CODE_TTL_S }) < DateTime.now()) {
      pendingRequests.delete(id)
      reqLogger.info("oauth_request_expired")
      return undefined
    }
    return pending
  }

  const approveRequest = (requestId: string, reqLogger: Logger): string => {
    const pending = pendingRequests.get(requestId)
    if (!pending) {
      reqLogger.warn("oauth_consent_approve_failed", {
        reason: "no_pending_request",
      })
      throw new Error("No pending request")
    }
    pendingRequests.delete(requestId)

    const code = randomBytes(32).toString("hex")
    authCodes.set(code, {
      clientId: pending.client.client_id,
      codeChallenge: pending.params.codeChallenge,
      params: pending.params,
      expiresAt: DateTime.now().plus({ seconds: AUTH_CODE_TTL_S }),
    })
    reqLogger.info("oauth_consent_approved")
    return code
  }

  const deletePendingRequest = (id: string): void => {
    pendingRequests.delete(id)
  }

  return { provider, getPendingRequest, approveRequest, deletePendingRequest }
}

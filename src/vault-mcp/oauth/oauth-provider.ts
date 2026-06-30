/**
 * OAuth 2.1 provider for vault-cortex.
 *
 * - Dynamic client registration (Claude Desktop, Perplexity self-register)
 * - Authorization code flow with PKCE
 * - JWT access tokens (HS256, verifiable by Lambda + Express)
 * - Backward-compatible static token verification (MCP_AUTH_TOKEN)
 * - SQLite persistence for refresh tokens + clients (survives restarts)
 * - Consent page gated by the server's auth token
 */

import Database from "better-sqlite3"
import { randomUUID, randomBytes } from "node:crypto"
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
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js"
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
  logger: Logger
}

const initDb = (dbPath: string): Database.Database => {
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
  return db
}

class SqliteClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db
      .prepare("SELECT data FROM clients WHERE client_id = ?")
      .get(clientId) as { data: string } | undefined
    return row
      ? (JSON.parse(row.data) as OAuthClientInformationFull)
      : undefined
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
    this.db
      .prepare("INSERT INTO clients (client_id, data) VALUES (?, ?)")
      .run(full.client_id, JSON.stringify(full))
    this.logger.info("oauth_client_registered", {
      clientId: full.client_id,
      clientName: full.client_name ?? null,
    })
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
  logger,
}: OAuthProviderOptions): OAuthProvider => {
  const oauthLogger = logger.child({ component: "oauth" })
  const db = initDb(dbPath)
  const store = new SqliteClientsStore(db, oauthLogger)
  const pendingRequests = new Map<string, PendingAuthRequest>()
  const authCodes = new Map<string, StoredAuthCode>()

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

  const saveRefreshToken = (
    token: string,
    clientId: string,
    scopes: string[],
  ): void => {
    db.prepare(
      "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
    ).run(
      token,
      clientId,
      scopes.join(" "),
      DateTime.now().plus({ seconds: REFRESH_TOKEN_TTL_S }).toUnixInteger(),
    )
  }

  /** Refresh token rotation with sliding expiry. Tokens are single-use
   *  (consumed on read to prevent replay) AND time-bounded (rejected
   *  past expires_at). A successful refresh issues a new token whose
   *  expires_at is REFRESH_TOKEN_TTL_S from now — every use resets the
   *  countdown, so active clients never expire. Expired rows are still
   *  deleted on read so the table self-cleans. */
  const consumeRefreshToken = (
    token: string,
  ): { clientId: string; scopes: string[] } | null => {
    const row = db
      .prepare(
        "SELECT client_id, scopes, expires_at FROM refresh_tokens WHERE token = ?",
      )
      .get(token) as
      | { client_id: string; scopes: string; expires_at: number }
      | undefined
    if (!row) return null
    db.prepare("DELETE FROM refresh_tokens WHERE token = ?").run(token)
    if (row.expires_at < DateTime.now().toUnixInteger()) return null
    return { clientId: row.client_id, scopes: row.scopes.split(" ") }
  }

  const isRevoked = (token: string): boolean =>
    !!db.prepare("SELECT 1 FROM revoked_tokens WHERE token = ?").get(token)

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
      saveRefreshToken(refreshToken, stored.clientId, scopes)

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

    async exchangeRefreshToken(
      _client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[],
      _resource?: URL,
    ): Promise<OAuthTokens> {
      const stored = consumeRefreshToken(refreshToken)
      if (!stored) {
        oauthLogger.warn("oauth_token_refresh_failed", {
          reason: "expired_or_invalid",
        })
        throw new InvalidGrantError("Refresh token expired or invalid")
      }

      const grantedScopes = scopes ?? stored.scopes
      const accessToken = issueAccessToken(stored.clientId, grantedScopes)
      const newRefreshToken = randomBytes(32).toString("hex")
      saveRefreshToken(newRefreshToken, stored.clientId, grantedScopes)

      oauthLogger.info("oauth_token_refreshed", {
        clientId: stored.clientId,
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
        const { InvalidTokenError } =
          await import("@modelcontextprotocol/sdk/server/auth/errors.js")
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
      const { InvalidTokenError } =
        await import("@modelcontextprotocol/sdk/server/auth/errors.js")
      throw new InvalidTokenError("Token expired or invalid")
    },

    async revokeToken(
      _client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest,
    ): Promise<void> {
      db.prepare(
        "INSERT OR IGNORE INTO revoked_tokens (token, revoked_at) VALUES (?, ?)",
      ).run(request.token, DateTime.now().toUnixInteger())
      db.prepare("DELETE FROM refresh_tokens WHERE token = ?").run(
        request.token,
      )
      oauthLogger.info("oauth_token_revoked")
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

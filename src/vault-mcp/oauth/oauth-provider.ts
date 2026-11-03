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
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"
import { canonicalResourceUri, safeEqual, tokenBindingForServer } from "../../auth.js"
import { signJwt, verifyJwt, type JwtPayload } from "../../jwt.js"
import { renderConsentPage } from "./consent-page.js"
import type { Logger } from "../../logger.js"

// 6 hours
const ACCESS_TOKEN_TTL_S = 6 * 60 * 60
// 60 days. Sliding (inactivity) expiry — each use rotates the token
// AND resets the countdown, so a daily user never sees it and a
// dormant client re-auths after 60 days. Bounds the blast radius of
// a leaked refresh token without inconveniencing active sessions.
const REFRESH_TOKEN_TTL_S = 60 * 24 * 60 * 60
// 10 minutes — OAuth spec recommends short auth code lifetimes.
const AUTH_CODE_TTL_S = 10 * 60
// 10 minutes for the user to approve a consent request before it expires.
const PENDING_REQUEST_TTL_S = 10 * 60
// Every rejected code gets this one message, so a code issued to another
// client looks the same as an unknown one.
const INVALID_AUTH_CODE_MESSAGE = "Authorization code expired or invalid"
// The scope granted to a request that names none (see authorize); also what
// the static token carries (see verifyAccessToken) and what the metadata
// advertises as scopes_supported.
export const DEFAULT_SCOPE = "vault" as const

/** `authorize` fills in the default scope before storing a request, so scopes is always set. */
type GrantedAuthorizationParams = AuthorizationParams & { scopes: string[] }

type PendingAuthRequest = {
  client: OAuthClientInformationFull
  params: GrantedAuthorizationParams
  createdAt: DateTime
}

type StoredAuthCode = {
  clientId: string
  params: GrantedAuthorizationParams
  expiresAt: DateTime
}

type OAuthProviderOptions = {
  authToken: string
  dbPath: string
  /** The deployment's public URL. Its issuer and MCP resource URI are
   *  stamped on every access token as `iss` and `aud`, and a client's
   *  `resource` param is compared against the latter. */
  serverUrl: URL
  logger: Logger
}

// Every stored refresh-token key starts with this prefix. Raw tokens
// are bare hex, so the prefix is what tells a keyed row from one written
// by a version that stored tokens in plaintext — including rows written
// after a rollback to such a version.
const REFRESH_TOKEN_KEY_PREFIX = "hmac-sha256:"
// Prepended to the token before hashing. JWTs are signed with HMAC-SHA256
// under the same key (see jwt.ts), and the label keeps the two uses apart:
// no refresh-token storage key is ever computed over a JWT's signing input.
const REFRESH_TOKEN_KEY_LABEL = "refresh-token:"

// A registration older than this that never signed in is swept:
// - a client has signed in once the server has saved a refresh token for it;
// - signing in follows registration within minutes, so a row not signed in
//   after a week never finished consent. Clients register more than once per
//   connect, and only one of those registrations signs in.
const NEVER_SIGNED_IN_CLIENT_MAX_AGE_S = 7 * 24 * 60 * 60

/** Adds clients.signed_in_at to a database created before it existed and
 *  marks every existing client signed in. */
const addSignedInAtColumnAndMarkExistingClients = (db: Database.Database, logger: Logger): void => {
  // The column and its marks commit together. A column added without them
  // would let the sweep delete every signed-in client registered more than a
  // week before the upgrade, and the next boot would find the column and
  // never mark them.
  const addColumnAndMarkClients = db.transaction((): number => {
    const hasSignedInAt = db
      .prepare("SELECT 1 FROM pragma_table_info('clients') WHERE name = 'signed_in_at'")
      .get()

    if (hasSignedInAt) return 0
    db.exec("ALTER TABLE clients ADD COLUMN signed_in_at INTEGER")
    // Every row is marked because the old schema cannot tell which clients
    // signed in: one whose tokens were already purged looks like one that
    // never did.
    const { changes: markedClientCount } = db
      .prepare("UPDATE clients SET signed_in_at = ?")
      .run(DateTime.now().toUnixInteger())
    return markedClientCount
  })

  const markedClientCount = addColumnAndMarkClients()

  if (markedClientCount > 0) {
    logger.info("oauth_clients_marked_signed_in", { markedClientCount })
  }
}

const initDb = (dbPath: string, logger: Logger): Database.Database => {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL") // concurrent reads during writes
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      signed_in_at INTEGER
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
    CREATE TABLE IF NOT EXISTS consumed_refresh_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revoked_clients (
      client_id TEXT PRIMARY KEY,
      revoked_at INTEGER NOT NULL
    );
  `)
  // Migration for DBs created before sliding expiry: add expires_at
  // with DEFAULT 0 so any pre-migration row is treated as expired on
  // first read. Accepted trade-off — a one-time forced re-auth for any
  // currently-active session — and it keeps the new column NOT NULL
  // without an arbitrary backfill timestamp.
  const hasExpiresAt = db
    .prepare("SELECT 1 FROM pragma_table_info('refresh_tokens') WHERE name = 'expires_at'")
    .get()

  if (!hasExpiresAt) {
    db.exec("ALTER TABLE refresh_tokens ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0")
  }

  addSignedInAtColumnAndMarkExistingClients(db, logger)

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
  private readonly selectClientStmt: Database.Statement<[string], { data: string }>
  private readonly insertClientStmt: Database.Statement<[string, string]>
  private readonly markSignedInStmt: Database.Statement<[number, string]>
  private readonly deleteNeverSignedInClientsStmt: Database.Statement<[number]>

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
    this.selectClientStmt = db.prepare("SELECT data FROM clients WHERE client_id = ?")
    this.insertClientStmt = db.prepare("INSERT INTO clients (client_id, data) VALUES (?, ?)")
    this.markSignedInStmt = db.prepare("UPDATE clients SET signed_in_at = ? WHERE client_id = ?")
    this.deleteNeverSignedInClientsStmt = db.prepare(`
      DELETE FROM clients
      WHERE signed_in_at IS NULL
        AND json_extract(data, '$.client_id_issued_at') < ?
    `)
    this.sweepNeverSignedInClients()
  }

  /** Deletes every registration older than NEVER_SIGNED_IN_CLIENT_MAX_AGE_S
   *  that never signed in.
   *
   *  A client that signed in is never swept. It keeps presenting its
   *  client_id, and /authorize rejects an unknown one in the browser, where
   *  the client never sees the error. A swept client would retry the dead ID
   *  forever. */
  private sweepNeverSignedInClients(): void {
    const issuedBefore = DateTime.now().toUnixInteger() - NEVER_SIGNED_IN_CLIENT_MAX_AGE_S
    const { changes: sweptClientCount } = this.deleteNeverSignedInClientsStmt.run(issuedBefore)

    if (sweptClientCount === 0) return
    this.logger.info("oauth_clients_swept", {
      sweptClientCount,
      maxAgeSeconds: NEVER_SIGNED_IN_CLIENT_MAX_AGE_S,
    })
  }

  markSignedIn(clientId: string): void {
    this.markSignedInStmt.run(DateTime.now().toUnixInteger(), clientId)
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.selectClientStmt.get(clientId)

    if (!row) return undefined
    const parsed: OAuthClientInformationFull = JSON.parse(row.data)

    // registerClient always issues a secret; a row without one is database
    // corruption. The SDK's authenticateClient middleware skips the secret
    // check when client.client_secret is falsy, so returning the row would
    // allow unauthenticated token requests — return undefined instead.
    if (!parsed.client_secret) return undefined

    // Rows written before this field was stored at registration time lack it;
    // inject at read so the SDK enforces secret-based auth for every client.
    return { ...parsed, token_endpoint_auth_method: "client_secret_post" }
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      token_endpoint_auth_method: "client_secret_post",
      client_id: randomUUID(),
      client_id_issued_at: DateTime.now().toUnixInteger(),
      client_secret: randomBytes(32).toString("hex"),
      // RFC 7591 §3.2.1 defines 0 as a secret that never expires.
      client_secret_expires_at: 0,
    }
    // The /register rate limit bounds how fast rows arrive; sweeping on each
    // registration bounds how long the ones that never sign in stay.
    this.sweepNeverSignedInClients()
    this.insertClientStmt.run(full.client_id, JSON.stringify(full))
    this.logger.info("oauth_client_registered", {
      clientId: full.client_id,
      clientName: full.client_name ?? null,
    })
    return full
  }
}

export type OAuthProvider = {
  provider: OAuthServerProvider
  getPendingRequest: (requestId: string, logger: Logger) => PendingAuthRequest | undefined
  approveRequest: (requestId: string, logger: Logger) => string
  deletePendingRequest: (requestId: string) => void
}

export const createOAuthProvider = ({
  authToken,
  dbPath,
  serverUrl,
  logger,
}: OAuthProviderOptions): OAuthProvider => {
  const oauthLogger = logger.child({ component: "oauth" })
  const db = initDb(dbPath, oauthLogger)
  const store = new SqliteClientsStore(db, oauthLogger)
  const pendingRequests = new Map<string, PendingAuthRequest>()
  const authCodes = new Map<string, StoredAuthCode>()
  const { issuer, audience } = tokenBindingForServer(serverUrl)
  // The root discovery document (/.well-known/oauth-protected-resource,
  // served by the SDK) advertises the server URL itself as its resource
  // identifier, so a client that discovers there sends this value.
  const rootResource = canonicalResourceUri(serverUrl)

  /** RFC 8707: a `resource` the client names must be this server — either
   *  identifier the server advertises, the MCP endpoint or the root. An
   *  absent `resource` is accepted — clients that predate the parameter
   *  still connect, and the token is bound to this server regardless.
   *  https://www.rfc-editor.org/rfc/rfc8707#section-2 */
  const assertResourceIsThisServer = (resource: URL | undefined, clientId: string): void => {
    if (!resource) return
    const requestedResource = canonicalResourceUri(resource)

    // tokenBindingForServer builds audience with canonicalResourceUri too,
    // so both identifiers compare in canonical form.
    if (requestedResource === audience) return
    if (requestedResource === rootResource) return
    oauthLogger.warn("oauth_resource_rejected", {
      clientId,
      resource: resource.href,
    })
    throw new InvalidTargetError("The resource parameter is not this server")
  }

  const verifyAccessJwt = (token: string): JwtPayload | null => {
    return verifyJwt({
      token,
      secret: authToken,
      expectedIssuer: issuer,
      expectedAudience: audience,
    })
  }

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

  const insertRefreshTokenStmt = db.prepare<
    [{ storageKey: string; clientId: string; scopes: string; expiresAt: number }]
  >(
    "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (@storageKey, @clientId, @scopes, @expiresAt)",
  )
  const deleteExpiredRefreshTokensStmt = db.prepare<[number]>(
    "DELETE FROM refresh_tokens WHERE expires_at < ?",
  )
  const selectRefreshTokenStmt = db.prepare<
    [string, string],
    { scopes: string; expires_at: number }
  >("SELECT scopes, expires_at FROM refresh_tokens WHERE token = ? AND client_id = ?")
  const deleteRefreshTokenStmt = db.prepare<[string]>("DELETE FROM refresh_tokens WHERE token = ?")
  const insertRevokedTokenStmt = db.prepare<[string, number]>(
    "INSERT OR IGNORE INTO revoked_tokens (token, revoked_at) VALUES (?, ?)",
  )
  const selectRevokedTokenStmt = db.prepare<[string]>(
    "SELECT 1 FROM revoked_tokens WHERE token = ?",
  )
  const deleteExpiredRevokedTokensStmt = db.prepare<[number]>(
    "DELETE FROM revoked_tokens WHERE revoked_at < ?",
  )
  const insertConsumedRefreshTokenStmt = db.prepare<
    [{ storageKey: string; clientId: string; expiresAt: number }]
  >(
    "INSERT OR IGNORE INTO consumed_refresh_tokens (token, client_id, expires_at) VALUES (@storageKey, @clientId, @expiresAt)",
  )
  // The expires_at bound makes an expired replay a plain invalid_grant no
  // matter when the purge last ran — past the token's own expiry no
  // legitimate holder exists, so there is no grant left to protect.
  const selectConsumedRefreshTokenStmt = db.prepare<[string, number], { client_id: string }>(
    "SELECT client_id FROM consumed_refresh_tokens WHERE token = ? AND expires_at >= ?",
  )
  const deleteExpiredConsumedTokensStmt = db.prepare<[number]>(
    "DELETE FROM consumed_refresh_tokens WHERE expires_at < ?",
  )
  const deleteConsumedRefreshTokenStmt = db.prepare<[string]>(
    "DELETE FROM consumed_refresh_tokens WHERE token = ?",
  )
  const deleteClientRefreshTokensStmt = db.prepare<[string]>(
    "DELETE FROM refresh_tokens WHERE client_id = ?",
  )
  const deleteClientConsumedTokensStmt = db.prepare<[string]>(
    "DELETE FROM consumed_refresh_tokens WHERE client_id = ?",
  )
  // revoked_clients is a mint-time cutoff, not a ban: only access tokens
  // with iat strictly before revoked_at are rejected, so a re-consented
  // client keeps working under the same client_id.
  const insertRevokedClientStmt = db.prepare<[string, number]>(
    "INSERT OR REPLACE INTO revoked_clients (client_id, revoked_at) VALUES (?, ?)",
  )
  const selectRevokedClientStmt = db.prepare<[string], { revoked_at: number }>(
    "SELECT revoked_at FROM revoked_clients WHERE client_id = ?",
  )
  const deleteExpiredRevokedClientsStmt = db.prepare<[number]>(
    "DELETE FROM revoked_clients WHERE revoked_at < ?",
  )
  /** - A revoked access JWT outlives its revocation by at most its own
   *    lifetime, so rows older than that can never be presented again.
   *  - The same bound holds for a client revocation: every token minted at
   *    or before it has expired by then.
   *  - Runs at boot and before each new revocation, the only times these
   *    tables grow, so no timer is needed. */
  const purgeExpiredRevocations = (): void => {
    const revocationCutoff = DateTime.now().toUnixInteger() - ACCESS_TOKEN_TTL_S
    const { changes: purgedTokenCount } = deleteExpiredRevokedTokensStmt.run(revocationCutoff)

    if (purgedTokenCount > 0) {
      oauthLogger.info("oauth_revoked_tokens_purged", {
        purgedTokenCount,
        maxAgeSeconds: ACCESS_TOKEN_TTL_S,
      })
    }
    const { changes: purgedClientCount } = deleteExpiredRevokedClientsStmt.run(revocationCutoff)

    if (purgedClientCount > 0) {
      oauthLogger.info("oauth_revoked_clients_purged", {
        purgedClientCount,
        maxAgeSeconds: ACCESS_TOKEN_TTL_S,
      })
    }
  }
  purgeExpiredRevocations()

  /** Revokes everything the grant issued: the client's live refresh rows,
   *  its consumed-token history (so one consumed token cannot re-trigger
   *  revocation after the user re-consents), and — via the revoked_clients
   *  cutoff — every access token minted before revokedAt. One transaction:
   *  a partial write would leave refresh rows deleted with access tokens
   *  still valid, the exact state this control exists to prevent. */
  const revokeClientGrant = db.transaction(
    ({ ownerClientId, revokedAt }: { ownerClientId: string; revokedAt: number }): void => {
      deleteClientRefreshTokensStmt.run(ownerClientId)
      deleteClientConsumedTokensStmt.run(ownerClientId)
      insertRevokedClientStmt.run(ownerClientId, revokedAt)
    },
  )

  const issueAccessToken = (clientId: string, scopes: string[]): string => {
    const issuedAt = DateTime.now()
    return signJwt(
      {
        sub: clientId,
        scope: scopes.join(" "),
        iat: issuedAt.toUnixInteger(),
        exp: issuedAt.plus({ seconds: ACCESS_TOKEN_TTL_S }).toUnixInteger(),
        iss: issuer,
        aud: audience,
      },
      authToken,
    )
  }

  /** Stores a refresh token under its storage key. In the same transaction:
   *  - marks the token's client as signed in, so the client sweep never
   *    deletes it;
   *  - purges expired rows. A row is only read when its own token is
   *    presented, so rows left by dormant clients — or made unreachable by
   *    rotating MCP_AUTH_TOKEN — would otherwise stay forever. */
  const saveRefreshToken = db.transaction(
    ({ token, clientId, scopes }: { token: string; clientId: string; scopes: string[] }): void => {
      const now = DateTime.now()
      deleteExpiredRefreshTokensStmt.run(now.toUnixInteger())
      deleteExpiredConsumedTokensStmt.run(now.toUnixInteger())
      insertRefreshTokenStmt.run({
        storageKey: refreshTokenStorageKey(token),
        clientId,
        scopes: scopes.join(" "),
        expiresAt: now.plus({ seconds: REFRESH_TOKEN_TTL_S }).toUnixInteger(),
      })
      store.markSignedIn(clientId)
    },
  )

  /** Deletes a live refresh row and records its key as consumed in one
   *  transaction — a crash between the two would silently drop reuse
   *  detection for this token. */
  const consumeLiveRefreshRow = db.transaction(
    ({
      storageKey,
      clientId,
      expiresAt,
    }: {
      storageKey: string
      clientId: string
      expiresAt: number
    }): void => {
      deleteRefreshTokenStmt.run(storageKey)
      insertConsumedRefreshTokenStmt.run({ storageKey, clientId, expiresAt })
    },
  )

  type ConsumeRefreshTokenResult =
    | { status: "consumed"; scopes: string[]; storageKey: string }
    | { status: "reuse"; ownerClientId: string }
    | { status: "not_found" }

  /** Refresh token rotation with sliding expiry.
   *  - Single-use: consumed on read, rejected past expires_at.
   *  - Sliding: each refresh resets expires_at to REFRESH_TOKEN_TTL_S from now.
   *  - Isolated: a different auth token derives a different key.
   *  - Reuse: a consumed, unexpired key presented again reports "reuse" —
   *    the caller revokes the grant. */
  const consumeRefreshToken = ({
    token,
    clientId,
  }: {
    token: string
    clientId: string
  }): ConsumeRefreshTokenResult => {
    const storageKey = refreshTokenStorageKey(token)
    const nowSeconds = DateTime.now().toUnixInteger()

    const row = selectRefreshTokenStmt.get(storageKey, clientId)

    if (row) {
      if (row.expires_at < nowSeconds) {
        // An expired token was never presentable again, so its deletion
        // needs no consumed record — a later replay is a plain miss.
        deleteRefreshTokenStmt.run(storageKey)
        return { status: "not_found" }
      }
      consumeLiveRefreshRow({
        storageKey,
        clientId,
        expiresAt: row.expires_at,
      })
      return {
        status: "consumed",
        scopes: row.scopes.split(" "),
        storageKey,
      }
    }

    // Keyed on the token alone, unlike the live lookup: a consumed token
    // presented again means the RECORDED owner's grant is compromised no
    // matter which registration presents it. A live token under the wrong
    // client stays a plain miss — clients re-register routinely, and
    // revoking on a confused client would be trigger-happy.
    const consumedRow = selectConsumedRefreshTokenStmt.get(storageKey, nowSeconds)

    if (consumedRow) {
      return { status: "reuse", ownerClientId: consumedRow.client_id }
    }
    return { status: "not_found" }
  }

  const isRevoked = (token: string): boolean => !!selectRevokedTokenStmt.get(token)

  // Methods below implement OAuthServerProvider from the MCP SDK.
  // They appear unused locally but are called by mcpAuthRouter() in
  // oauth-routes.ts and requireBearerAuth() in mcp-core/mcp-router.ts.
  const provider: OAuthServerProvider = {
    get clientsStore(): OAuthRegisteredClientsStore {
      return store
    },

    /** A request that names no scope is granted DEFAULT_SCOPE; named scopes
     *  are granted as requested. The default is applied here, before the
     *  request is stored, so the consent page, the code exchange, and every
     *  later refresh read the same value. */
    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response,
    ): Promise<void> {
      // Thrown before anything is sent, so the SDK's handler can still
      // redirect the client with error=invalid_target.
      assertResourceIsThisServer(params.resource, client.client_id)
      const requestId = randomUUID()
      // The SDK splits `scope=` into [""], so blank entries count as none.
      const requestedScopes = (params.scopes ?? []).filter((scope) => scope !== "")
      const scopes = requestedScopes.length > 0 ? requestedScopes : [DEFAULT_SCOPE]
      pendingRequests.set(requestId, {
        client,
        params: { ...params, scopes },
        createdAt: DateTime.now(),
      })

      oauthLogger.info("oauth_authorize_started", {
        clientId: client.client_id,
        requestId,
        scopes,
      })
      res.type("html").send(
        renderConsentPage({
          clientName: client.client_name ?? client.client_id,
          clientId: client.client_id,
          scopes,
          requestId,
        }),
      )
    },

    /** The SDK checks the PKCE verifier against this challenge, then calls
     *  exchangeAuthorizationCode, which checks the code's client. */
    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const stored = authCodes.get(authorizationCode)

      if (!stored || stored.expiresAt < DateTime.now()) {
        oauthLogger.warn("oauth_challenge_failed", {
          reason: "expired_or_invalid",
        })
        throw new InvalidGrantError(INVALID_AUTH_CODE_MESSAGE)
      }
      return stored.params.codeChallenge
    },

    /** RFC 6749 §4.1.3: the code must have been issued to the authenticated
     *  client. https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3
     *  - `code_verifier` is not checked here, because the SDK has already
     *    checked it against challengeForAuthorizationCode's challenge.
     *  - `redirect_uri` is not compared because OAuth 2.1 removed it from the
     *    token request. PKCE already stops an authorization code injected by
     *    an attacker, and the SDK's /authorize accepts only S256 challenges.
     *    https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13#section-10.2 */
    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      _redirectUri?: string,
      resource?: URL,
    ): Promise<OAuthTokens> {
      // Checked before the code is consumed: a wrong resource is a client
      // configuration error, not a replay, so the code stays redeemable.
      assertResourceIsThisServer(resource, client.client_id)
      const stored = authCodes.get(authorizationCode)

      if (!stored || stored.expiresAt < DateTime.now()) {
        oauthLogger.warn("oauth_code_exchange_failed", {
          reason: "expired_or_invalid",
        })
        throw new InvalidGrantError(INVALID_AUTH_CODE_MESSAGE)
      }

      // Also checked before the code is consumed, so a code presented by
      // another client stays redeemable by the client it was issued to.
      if (stored.clientId !== client.client_id) {
        oauthLogger.warn("oauth_code_exchange_failed", {
          reason: "issued_to_another_client",
          clientId: stored.clientId,
          presenterClientId: client.client_id,
        })
        throw new InvalidGrantError(INVALID_AUTH_CODE_MESSAGE)
      }
      authCodes.delete(authorizationCode)

      const { scopes } = stored.params
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
      resource?: URL,
    ): Promise<OAuthTokens> {
      const clientId = client.client_id
      // Checked before the refresh token is consumed, for the same reason
      // as the code exchange: a wrong resource must not consume the token.
      assertResourceIsThisServer(resource, clientId)
      const consumed = consumeRefreshToken({ token: refreshToken, clientId })

      if (consumed.status === "reuse") {
        // OAuth 2.1 rotation replay: the server cannot tell which presenter
        // is the attacker, so the whole grant dies — the owner re-consents
        // once. The error matches the plain-miss message on purpose: a
        // distinct one would tell an attacker the replay was noticed.
        purgeExpiredRevocations()
        revokeClientGrant({
          ownerClientId: consumed.ownerClientId,
          revokedAt: DateTime.now().toUnixInteger(),
        })
        oauthLogger.warn("oauth_refresh_token_reuse", {
          clientId: consumed.ownerClientId,
          ...(clientId !== consumed.ownerClientId ? { presenterClientId: clientId } : {}),
        })
        throw new InvalidGrantError("Refresh token expired or invalid")
      }
      if (consumed.status === "not_found") {
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
      const grantedScopes = requestedScopes.length > 0 ? requestedScopes : consumed.scopes
      const requestedScopeWidens = grantedScopes.some((scope) => !consumed.scopes.includes(scope))

      if (requestedScopeWidens) {
        // A widening request consumes the token (misbehaving client). Delete
        // the consumed record so a retry is a plain miss, not a reuse signal.
        deleteConsumedRefreshTokenStmt.run(consumed.storageKey)
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

    /** Checks in order: static token (fast path for CLI) → per-token
     *  revocation → JWT → the client's grant-revocation cutoff. */
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
          scopes: [DEFAULT_SCOPE],
          expiresAt: DateTime.now().plus({ years: 10 }).toUnixInteger(),
        }
      }

      if (isRevoked(token)) {
        oauthLogger.warn("oauth_token_rejected", { reason: "revoked" })
        throw new InvalidTokenError("Token has been revoked")
      }

      const payload = verifyAccessJwt(token)

      if (payload) {
        const revokedClient = selectRevokedClientStmt.get(payload.sub)

        // Rejects a token minted strictly before the revocation:
        // - without iat the token cannot be proven newer, so it counts as
        //   minted at 0 and is rejected;
        // - a token minted in the revocation's own second passes, so a client
        //   that signs in again within that second keeps working. An attacker
        //   who refreshed in that same second keeps one access token until it
        //   expires; their refresh tokens are already deleted.
        if (revokedClient && (payload.iat ?? 0) < revokedClient.revoked_at) {
          oauthLogger.warn("oauth_token_rejected", {
            reason: "client_revoked",
            clientId: payload.sub,
          })
          throw new InvalidTokenError("Token has been revoked")
        }
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
      const isValidAccessToken = verifyAccessJwt(request.token) !== null

      if (isValidAccessToken) {
        purgeExpiredRevocations()
        insertRevokedTokenStmt.run(request.token, DateTime.now().toUnixInteger())
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
    requestId: string,
    reqLogger: Logger,
  ): PendingAuthRequest | undefined => {
    const pending = pendingRequests.get(requestId)

    if (!pending) return undefined
    if (pending.createdAt.plus({ seconds: PENDING_REQUEST_TTL_S }) < DateTime.now()) {
      pendingRequests.delete(requestId)
      reqLogger.info("oauth_request_expired")
      return undefined
    }
    return pending
  }

  const approveRequest = (requestId: string, reqLogger: Logger): string => {
    const pending = getPendingRequest(requestId, reqLogger)

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
      params: pending.params,
      expiresAt: DateTime.now().plus({ seconds: AUTH_CODE_TTL_S }),
    })
    reqLogger.info("oauth_consent_approved")
    return code
  }

  const deletePendingRequest = (requestId: string): void => {
    pendingRequests.delete(requestId)
  }

  return { provider, getPendingRequest, approveRequest, deletePendingRequest }
}

/** MCP session routes — transport lifecycle, session creation, request routing. */

import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { ipKeyGenerator, rateLimit } from "express-rate-limit"
import { randomUUID } from "node:crypto"
import { DateTime, Duration } from "luxon"
import type { PdfExtractor } from "../vault-operations/pdf-extractor.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js"
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import { computeEnabledToolNames, registerTools } from "./tool-definitions.js"
import { registerPrompts } from "./prompt-definitions.js"
import { TOOL_REGISTRY } from "./tool-registry.js"
import type { ToolName } from "./tool-registry.js"
import { createToolAvailability } from "./tool-availability.js"
import { logger } from "../../logger.js"
import { describeErrorForLog } from "../../utils/describe-error.js"
import { extractClientIp, headerAsString, mcpResourceUrl } from "../../auth.js"

type McpRouterOptions = {
  vaultPath: string
  search: SearchIndex
  pdfExtractor: PdfExtractor
  provider: OAuthServerProvider
  config: VaultConfig
  serverUrl: URL
  /** Whether /mcp rate-limits failed sign-in attempts. server.ts turns it
   *  on only for an MCP_AUTH_TOKEN short enough to guess. */
  failedAuthLimiterEnabled: boolean
}

// How many 401 answers a minute one client IP (an IPv6 client by its /56)
// may collect before /mcp answers 429, when the limiter is on. A valid
// client produces a 401 on its first request, which carries no token, when
// its six-hour access token expires, and once more after a revocation or a
// token rotation, so thirty a minute is far above any honest rate. The OAuth endpoints allow five because a sign-in
// touches each of them at most twice a minute.
const MCP_FAILED_AUTH_LIMIT = 30
const MCP_FAILED_AUTH_WINDOW_MS = 60 * 1000

/**
 * Server icon for MCP clients (spec 2025-11-25, SEP-973). Clients that
 * support serverInfo.icons render this beside the connection instead of a
 * generic or domain-derived icon. Served from the repo so it stays valid
 * regardless of the deployment domain.
 */
const SERVER_ICONS = [
  {
    src: "https://raw.githubusercontent.com/aliasunder/vault-cortex/main/assets/icon-400.png",
    mimeType: "image/png",
    sizes: ["400x400"],
  },
]

// Large note writes need room; this parser is reachable only with a valid token.
const MCP_JSON_BODY_LIMIT = "5mb"

const SERVER_WEBSITE_URL = "https://github.com/aliasunder/vault-cortex"

// A conversation left open overnight keeps its session, unless the session
// limit below closes it first.
const MCP_SESSION_IDLE_TIMEOUT = Duration.fromObject({ hours: 24 })

// Each session holds its own server instance, about 0.9 MB, so 300 sessions
// stay near 270 MB, within the 2 GB tiers the hosted deploy guides recommend.
const MAX_MCP_SESSIONS = 300

// One admission can close many sessions; the log line lists the first IDs
// only, because logger.ts caps each string but keeps every array element.
const MAX_LOGGED_REMOVED_SESSION_IDS = 20

type SessionRemovalReason = "idle" | "capacity"

/** One live MCP session. The record is mutated in place, because onclose
 *  reads the removal reason set just before close() and each request updates
 *  its start time. */
type McpSession = {
  transport: StreamableHTTPServerTransport
  lastRequestStartedAt: DateTime
  removalReason: SessionRemovalReason | undefined
}

type SessionRemoval = { sessionId: string; session: McpSession; reason: SessionRemovalReason }

const hasIdledOut = (session: Readonly<McpSession>, now: DateTime): boolean => {
  return session.lastRequestStartedAt.plus(MCP_SESSION_IDLE_TIMEOUT) < now
}

/** Metadata names only served tools; memory and search framing follow config. */
export const buildServerMetadata = (
  config: VaultConfig,
  enabledToolNames: ReadonlySet<ToolName>,
): { instructions: string; description: string } => {
  const { isToolEnabled, whenToolEnabledText } = createToolAvailability(enabledToolNames)

  const searchDescription = config.embeddingEnabled ? "hybrid search" : "full-text search"
  // Keyed on the enabled set, not config.readOnlyMode — the lint rule
  // enforces this; see tool-availability.ts.
  const servesWriteTools = TOOL_REGISTRY.some(
    (entry) => enabledToolNames.has(entry.name) && !entry.annotations.readOnlyHint,
  )
  const accessDescription = servesWriteTools ? "Read, write, and search" : "Read and search"
  const markdownClause = servesWriteTools
    ? "Vault content is Obsidian Flavored Markdown. Write tools pass content through without escaping — be intentional about Obsidian syntax (#, [[, %%, etc.) in inputs."
    : "Vault content is Obsidian Flavored Markdown. No tools that modify the vault are available."

  // Build instruction sentences from separator-free fragments so any
  // combination (including all-disabled) produces clean prose. Each list of
  // enabled tools is joined with "and", because the tools are complementary
  // entry points, not alternatives.
  const fileToolsFragment = whenToolEnabledText(
    "vault_read_file",
    "vault_read_file for images, canvases, and other non-markdown files",
  )
  const namedDiscoveryTools = (["vault_search", "vault_read_note"] as const).filter(isToolEnabled)

  const sentences: string[] = []

  if (namedDiscoveryTools.length > 0) {
    const suffix = fileToolsFragment ? `; ${fileToolsFragment}` : ""
    sentences.push(`Use ${namedDiscoveryTools.join(" and ")} to find and read notes${suffix}.`)
  } else if (fileToolsFragment) {
    sentences.push(`Use ${fileToolsFragment}.`)
  }
  if (isToolEnabled("vault_get_memory")) {
    sentences.push(
      `Use vault_get_memory to retrieve user preferences and context from ${config.memoryDir}/ files.`,
    )
  }
  const namedWriteTools = (["vault_write_note", "vault_update_memory"] as const).filter(
    isToolEnabled,
  )

  if (namedWriteTools.length > 0) {
    sentences.push(`Use ${namedWriteTools.join(" and ")} for writes.`)
  }
  const instructionBody = sentences.length > 0 ? ` ${sentences.join(" ")}` : ""
  const instructions = `${accessDescription} an Obsidian vault.${instructionBody}

${markdownClause}`
  const description = config.memoryEnabled
    ? `${accessDescription} an Obsidian vault. Provides ${searchDescription}, tag queries, and a structured memory layer (${config.memoryDir}/) for personalization across conversations.`
    : `${accessDescription} an Obsidian vault. Provides ${searchDescription}, tag queries, and property-based filtering.`
  return { instructions, description }
}

export const createMcpRouter = ({
  vaultPath,
  search,
  pdfExtractor,
  provider,
  config,
  serverUrl,
  failedAuthLimiterEnabled,
}: McpRouterOptions): Router => {
  const router = Router()
  // MCP spec: a 401 MUST carry WWW-Authenticate with a resource_metadata
  // parameter so clients can start discovery straight from the rejection —
  // pointed at the RFC 9728 path-suffixed URL for the /mcp resource.
  const bearerAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl(serverUrl)),
  })
  // Insertion order is recency order: admitSession inserts a new session last
  // and touchSession moves a routed one to the end, so the first entry is the
  // session whose last request started earliest.
  const sessions = new Map<string, McpSession>()

  /** Takes the session out of the map, then closes it. */
  const removeSession = ({ sessionId, session, reason }: SessionRemoval): void => {
    sessions.delete(sessionId)
    session.removalReason = reason
    // Not awaited, so admitSession stays synchronous: an await here would let
    // another initialize admit its session before admitSession's own insert,
    // and the map could pass MAX_MCP_SESSIONS. close() ends the session's open
    // streams and runs onclose before it returns.
    session.transport.close().catch((closeError: unknown) => {
      logger.warn("mcp_session_close_failed", { sessionId, ...describeErrorForLog(closeError) })
    })
  }

  const logRemovedSessions = (removedSessions: ReadonlyArray<SessionRemoval>): void => {
    if (removedSessions.length === 0) return

    const countRemovedFor = (reason: SessionRemovalReason): number => {
      return removedSessions.filter((removed) => removed.reason === reason).length
    }
    logger.info("mcp_sessions_removed", {
      idleCount: countRemovedFor("idle"),
      capacityCount: countRemovedFor("capacity"),
      sessionIds: removedSessions
        .slice(0, MAX_LOGGED_REMOVED_SESSION_IDS)
        .map((removed) => removed.sessionId),
    })
  }

  /** The only place a new session enters the map. Synchronous, so each
   *  admission runs to completion before another can start, and the map
   *  never holds more than MAX_MCP_SESSIONS. */
  const admitSession = (sessionId: string, session: McpSession): void => {
    const now = DateTime.now()

    // Every entry is checked, never stopping at the first active one: a wall
    // clock set backwards can leave an idle session behind an active one in
    // the map's order.
    const idleRemovals = [...sessions]
      .filter(([, candidate]) => hasIdledOut(candidate, now))
      .map(([idleSessionId, idleSession]): SessionRemoval => {
        return { sessionId: idleSessionId, session: idleSession, reason: "idle" }
      })
    for (const removal of idleRemovals) removeSession(removal)

    // The first entries are the least recently used, so they make room for
    // the new session.
    const overCapacityCount = Math.max(sessions.size - MAX_MCP_SESSIONS + 1, 0)
    const capacityRemovals = [...sessions]
      .slice(0, overCapacityCount)
      .map(([leastRecentSessionId, leastRecentSession]): SessionRemoval => {
        return { sessionId: leastRecentSessionId, session: leastRecentSession, reason: "capacity" }
      })
    for (const removal of capacityRemovals) removeSession(removal)

    sessions.set(sessionId, session)
    logRemovedSessions([...idleRemovals, ...capacityRemovals])
  }

  /** Marks a request's start: the session becomes the most recently used. */
  const touchSession = (sessionId: string, session: McpSession): void => {
    session.lastRequestStartedAt = DateTime.now()
    sessions.delete(sessionId)
    sessions.set(sessionId, session)
  }

  // The MCP Streamable HTTP spec requires servers to validate Origin against
  // DNS rebinding, where a page on another site points its own hostname at
  // a local install and reads the answers. Bearer auth stops such a page
  // unless it has the token; this check stops it either way. MCP clients
  // send no Origin, so only the server's own origin, PUBLIC_URL's, is
  // admitted.
  const originCheck = (req: Request, res: Response, next: NextFunction): void => {
    const origin = headerAsString(req.headers.origin)

    if (!origin || origin === serverUrl.origin) {
      next()
      return
    }
    logger.warn("mcp_origin_rejected", {
      clientIp: extractClientIp(req, config.trustForwardedHops),
      origin,
    })
    res.status(403).json({ error: "origin not allowed" })
  }

  // Counts only 401 answers: a valid client's 404 (unknown session), 400 (no
  // session) and 405 (GET) never count.
  // - The library counts every request when it arrives and takes it back
  //   when its response finishes with any status but 401. A response the
  //   client abandons never finishes, so its request counts until the
  //   window resets each minute. A client IP with MCP_FAILED_AUTH_LIMIT
  //   unfinished requests is therefore refused its next one too.
  // - Refusing before the token is checked is what bounds guessing, so a
  //   full bucket refuses a valid token from the same client IP for the
  //   rest of the window; see server.ts for why the limiter is on at all.
  const failedAuthLimiter = rateLimit({
    windowMs: MCP_FAILED_AUTH_WINDOW_MS,
    max: MCP_FAILED_AUTH_LIMIT,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 401,
    keyGenerator: (req: Request) => {
      return ipKeyGenerator(extractClientIp(req, config.trustForwardedHops))
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      logger.warn("mcp_auth_rate_limited", {
        clientIp: extractClientIp(req, config.trustForwardedHops),
      })
      res
        .status(429)
        .set("Cache-Control", "no-store")
        .json({ error: "too many failed authentication attempts" })
    },
  })
  const guards = failedAuthLimiterEnabled ? [originCheck, failedAuthLimiter] : [originCheck]

  const parseMcpJson = express.json({ limit: MCP_JSON_BODY_LIMIT })

  router.post("/mcp", ...guards, bearerAuth, parseMcpJson, async (req: Request, res: Response) => {
    const sessionId = headerAsString(req.headers["mcp-session-id"])
    const clientIp = extractClientIp(req, config.trustForwardedHops)
    logger.info("mcp_request", { sessionId, clientIp, method: "POST" })

    const existingSession = sessionId ? sessions.get(sessionId) : undefined

    if (sessionId && existingSession) {
      // An expired session gets the same 404 an unknown session gets, so its
      // client starts a new session.
      if (hasIdledOut(existingSession, DateTime.now())) {
        const removal: SessionRemoval = { sessionId, session: existingSession, reason: "idle" }
        removeSession(removal)
        logRemovedSessions([removal])
        logger.warn("mcp_response", {
          sessionId,
          clientIp,
          status: 404,
          outcome: "session expired",
        })
        res.status(404).json({ error: "session not found" })
        return
      }

      touchSession(sessionId, existingSession)
      logger.info("mcp_response", {
        sessionId,
        clientIp,
        status: 200,
        outcome: "routed to existing session",
      })
      await existingSession.transport.handleRequest(req, res, req.body)
      return
    }

    // A session ID the server does not hold: the session closed or the
    // server restarted.
    if (sessionId) {
      logger.warn("mcp_response", {
        sessionId,
        clientIp,
        status: 404,
        outcome: "session not found",
      })
      res.status(404).json({ error: "session not found" })
      return
    }

    // No session ID: only an initialize request may start a session.
    const body = req.body

    if (!isInitializeRequest(body)) {
      logger.warn("mcp_response", {
        clientIp,
        status: 400,
        outcome: "no session, non-initialize request",
      })
      res.status(400).json({ error: "no session" })
      return
    }
    // onsessioninitialized reads `session`, declared below because it holds
    // this transport. The SDK calls the callback only inside handleRequest,
    // once it has assigned the session ID and before it dispatches the
    // initialize, and never for a rejected initialize.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => admitSession(newSessionId, session),
    })
    const session: McpSession = {
      transport,
      lastRequestStartedAt: DateTime.now(),
      removalReason: undefined,
    }
    transport.onclose = () => {
      // Only an admitted session, which has its ID, is ever closed; the check
      // narrows the type.
      if (!transport.sessionId) return

      sessions.delete(transport.sessionId)
      // A session the server removed is logged by mcp_sessions_removed, so
      // session_closed counts only a client DELETE.
      if (session.removalReason) return

      logger.info("session_closed", {
        sessionId: transport.sessionId,
      })
    }
    const { instructions, description } = buildServerMetadata(
      config,
      computeEnabledToolNames(config),
    )
    const server = new McpServer(
      {
        name: "vault-cortex",
        title: "Vault Cortex",
        version: "1.0.0",
        description,
        icons: SERVER_ICONS,
        websiteUrl: SERVER_WEBSITE_URL,
      },
      { instructions },
    )

    const sessionLogger = logger.child({
      // Lazy: the transport generates its session id while handling the
      // initialize request — after this child is created. Resolved per-emit.
      sessionId: () => transport.sessionId,
      clientIp,
    })
    registerTools({
      server,
      vaultPath,
      search,
      pdfExtractor,
      logger: sessionLogger,
      config,
    })
    registerPrompts({
      server,
      vaultPath,
      search,
      logger: sessionLogger,
      config,
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, body)
    if (!transport.sessionId) {
      // The transport rejected the initialize request before generating a
      // session id (e.g. missing Accept header → 406) — no session exists,
      // so don't log "session created" with a hardcoded 200.
      logger.warn("mcp_response", {
        clientIp,
        status: res.statusCode,
        outcome: "initialize rejected, no session created",
      })
      return
    }
    // Another initialize's admission can close this session for capacity
    // while the SDK awaits this one's initialize; its client then gets 404 on
    // its next request.
    if (sessions.get(transport.sessionId) !== session) {
      logger.warn("mcp_response", {
        sessionId: transport.sessionId,
        clientIp,
        status: res.statusCode,
        outcome: "session removed before its initialize finished",
      })
      return
    }
    logger.info("mcp_response", {
      sessionId: transport.sessionId,
      clientIp,
      status: 200,
      outcome: "session created",
    })
  })

  // The Streamable HTTP spec lets a client open a standalone SSE stream via
  // GET for server-initiated messages — and explicitly allows servers that
  // don't offer one to reject the request with 405. vault-cortex never sends
  // server-initiated messages, so a held stream would only ever sit idle
  // until an upstream proxy timeout kills it (surfacing as gateway 5xx).
  router.get("/mcp", ...guards, bearerAuth, (req: Request, res: Response) => {
    const sessionId = headerAsString(req.headers["mcp-session-id"])
    const clientIp = extractClientIp(req, config.trustForwardedHops)
    logger.info("mcp_request", { sessionId, clientIp, method: "GET" })
    logger.info("mcp_response", {
      sessionId,
      clientIp,
      status: 405,
      outcome: "standalone SSE stream not offered",
    })
    res.status(405).set("Allow", "POST, DELETE").json({
      error: "method not allowed: this server does not offer a standalone SSE stream",
    })
  })

  router.delete("/mcp", ...guards, bearerAuth, async (req: Request, res: Response) => {
    const sessionId = headerAsString(req.headers["mcp-session-id"])
    const clientIp = extractClientIp(req, config.trustForwardedHops)
    logger.info("mcp_request", { sessionId, clientIp, method: "DELETE" })
    const session = sessionId ? sessions.get(sessionId) : undefined

    if (!sessionId || !session) {
      logger.warn("mcp_response", {
        sessionId,
        clientIp,
        status: 404,
        outcome: "session not found",
      })
      res.status(404).json({ error: "session not found" })
      return
    }
    // Taken out of the map first, so no request routes to a closing
    // transport. A DELETE answers 200 whatever the session's idle time, so a
    // client's clean shutdown after a long idle succeeds.
    sessions.delete(sessionId)
    await session.transport.close()
    logger.info("mcp_response", {
      sessionId,
      clientIp,
      status: 200,
      outcome: "session deleted",
    })
    res.status(200).json({ ok: true })
  })

  return router
}

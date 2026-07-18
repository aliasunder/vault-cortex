/** MCP session routes — transport lifecycle, session creation, request routing. */

import { Router } from "express"
import type { Request, Response } from "express"
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { SearchIndex } from "../search/search-index.js"
import type { VaultConfig } from "../config.js"
import { registerTools } from "./tool-definitions.js"
import { registerPrompts } from "./prompt-definitions.js"
import { logger } from "../../logger.js"
import { headerAsString } from "../../auth.js"

type McpRouterOptions = {
  vaultPath: string
  search: SearchIndex
  provider: OAuthServerProvider
  config: VaultConfig
}

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

const SERVER_WEBSITE_URL = "https://github.com/aliasunder/vault-cortex"

export const createMcpRouter = ({
  vaultPath,
  search,
  provider,
  config,
}: McpRouterOptions): Router => {
  const router = Router()
  const bearerAuth = requireBearerAuth({ verifier: provider })
  const transports = new Map<string, StreamableHTTPServerTransport>()

  router.post("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = headerAsString(req.headers["mcp-session-id"])
    const clientIp = req.ip
    logger.info("mcp_request", { sessionId, clientIp, method: "POST" })

    const existingTransport = sessionId ? transports.get(sessionId) : undefined
    if (existingTransport) {
      logger.info("mcp_response", {
        sessionId,
        clientIp,
        status: 200,
        outcome: "routed to existing session",
      })
      await existingTransport.handleRequest(req, res, req.body)
      return
    }

    if (!sessionId) {
      const body = req.body
      if (isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        })
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId)
            logger.info("session_closed", {
              sessionId: transport.sessionId,
            })
          }
        }
        const searchDescription = config.embeddingEnabled
          ? "hybrid search"
          : "full-text search"
        const server = new McpServer(
          {
            name: "vault-cortex",
            title: "Vault Cortex",
            version: "1.0.0",
            description: config.memoryEnabled
              ? `Read, write, and search an Obsidian vault. Provides ${searchDescription}, tag queries, and a structured memory layer (${config.memoryDir}/) for personalization across conversations.`
              : `Read, write, and search an Obsidian vault. Provides ${searchDescription}, tag queries, and property-based filtering.`,
            icons: SERVER_ICONS,
            websiteUrl: SERVER_WEBSITE_URL,
          },
          {
            instructions: config.memoryEnabled
              ? `Read, write, and search an Obsidian vault. Use vault_search and vault_read_note to find and read notes; vault_read_asset for images, canvases, and other non-markdown files. Use vault_get_memory to retrieve user preferences and context from ${config.memoryDir}/ files. Use vault_write_note and vault_update_memory for writes.

Vault content is Obsidian Flavored Markdown. Write tools pass content through without escaping — be intentional about Obsidian syntax (#, [[, %%, etc.) in inputs.`
              : `Read, write, and search an Obsidian vault. Use vault_search and vault_read_note to find and read notes; vault_read_asset for images, canvases, and other non-markdown files. Use vault_write_note for writes.

Vault content is Obsidian Flavored Markdown. Write tools pass content through without escaping — be intentional about Obsidian syntax (#, [[, %%, etc.) in inputs.`,
          },
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

        // @ts-expect-error — SDK type bug: StreamableHTTPServerTransport
        // declares onclose as optional, but Transport requires it. onclose
        // is assigned above; remove this when the SDK fixes the type.
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
        transports.set(transport.sessionId, transport)
        logger.info("mcp_response", {
          sessionId: transport.sessionId,
          clientIp,
          status: 200,
          outcome: "session created",
        })
        return
      }
      logger.warn("mcp_response", {
        clientIp,
        status: 400,
        outcome: "no session, non-initialize request",
      })
      res.status(400).json({ error: "no session" })
      return
    }

    logger.warn("mcp_response", {
      sessionId,
      clientIp,
      status: 404,
      outcome: "session not found",
    })
    res.status(404).json({ error: "session not found" })
  })

  // The Streamable HTTP spec lets a client open a standalone SSE stream via
  // GET for server-initiated messages — and explicitly allows servers that
  // don't offer one to reject the request with 405. vault-cortex never sends
  // server-initiated messages, so a held stream would only ever sit idle
  // until an upstream proxy timeout kills it (surfacing as gateway 5xx).
  router.get("/mcp", bearerAuth, (req: Request, res: Response) => {
    const sessionId = headerAsString(req.headers["mcp-session-id"])
    const clientIp = req.ip
    logger.info("mcp_request", { sessionId, clientIp, method: "GET" })
    logger.info("mcp_response", {
      sessionId,
      clientIp,
      status: 405,
      outcome: "standalone SSE stream not offered",
    })
    res.status(405).set("Allow", "POST, DELETE").json({
      error:
        "method not allowed: this server does not offer a standalone SSE stream",
    })
  })

  router.delete("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = headerAsString(req.headers["mcp-session-id"])
    const clientIp = req.ip
    logger.info("mcp_request", { sessionId, clientIp, method: "DELETE" })
    const transport = sessionId ? transports.get(sessionId) : undefined
    if (!sessionId || !transport) {
      logger.warn("mcp_response", {
        sessionId,
        clientIp,
        status: 404,
        outcome: "session not found",
      })
      res.status(404).json({ error: "session not found" })
      return
    }
    await transport.close()
    transports.delete(sessionId)
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

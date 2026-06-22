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

export type McpRouterOptions = {
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
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    const clientIp = req.ip
    logger.info("mcp_request", { sessionId, clientIp, method: "POST" })

    if (sessionId && transports.has(sessionId)) {
      logger.info("mcp_response", {
        sessionId,
        clientIp,
        status: 200,
        outcome: "routed to existing session",
      })
      await transports.get(sessionId)!.handleRequest(req, res, req.body)
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
        const server = new McpServer(
          {
            name: "vault-cortex",
            title: "Vault Cortex",
            version: "1.0.0",
            description: `Read, write, and search an Obsidian vault. Provides full-text search, tag queries, and a structured memory layer (${config.memoryDir}/) for personalization across conversations.`,
            icons: SERVER_ICONS,
            websiteUrl: SERVER_WEBSITE_URL,
          },
          {
            instructions: `Read, write, and search an Obsidian vault. Use vault_search and vault_read_note to find and read notes. Use vault_get_memory to retrieve user preferences and context from ${config.memoryDir}/ files. Use vault_write_note and vault_update_memory for writes.

Vault content is Obsidian Flavored Markdown. Write tools pass content through without escaping — be intentional about Obsidian syntax (#, [[, %%, etc.) in inputs.`,
          },
        )

        const sessionLogger = logger.child({
          sessionId: transport.sessionId,
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

        await server.connect(transport)
        await transport.handleRequest(req, res, body)
        if (transport.sessionId) {
          transports.set(transport.sessionId, transport)
        }
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

  router.get("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    const clientIp = req.ip
    logger.info("mcp_request", { sessionId, clientIp, method: "GET" })
    if (!sessionId || !transports.has(sessionId)) {
      logger.warn("mcp_response", {
        sessionId,
        clientIp,
        status: 404,
        outcome: "session not found",
      })
      res.status(404).json({ error: "session not found" })
      return
    }
    await transports.get(sessionId)!.handleRequest(req, res)
  })

  router.delete("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    const clientIp = req.ip
    logger.info("mcp_request", { sessionId, clientIp, method: "DELETE" })
    if (!sessionId || !transports.has(sessionId)) {
      logger.warn("mcp_response", {
        sessionId,
        clientIp,
        status: 404,
        outcome: "session not found",
      })
      res.status(404).json({ error: "session not found" })
      return
    }
    const transport = transports.get(sessionId)!
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

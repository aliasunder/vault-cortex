/** MCP server entry point — Express + StreamableHTTPServerTransport. */

import express from "express"
import type { Request, Response, NextFunction } from "express"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
import { createSearchIndex } from "./search-index.js"
import { registerTools } from "./tool-definitions.js"
import { startFileWatcher } from "./file-watcher.js"
import { createOAuthProvider } from "./oauth-provider.js"
import { renderConsentPage } from "./consent-page.js"
import { safeEqual } from "../auth.js"
import { logger } from "../logger.js"

/** Catch-all error handler for unhandled errors from async route handlers. */
const createErrorMiddleware =
  () =>
  (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    logger.error("unhandled_error", {
      sessionId,
      clientIp: req.ip,
      method: req.method,
      path: req.path,
      error: err.message,
    })
    if (!res.headersSent) {
      res.status(500).json({ error: "internal server error" })
    }
  }

const startServer = async (): Promise<void> => {
  const authToken = process.env.MCP_AUTH_TOKEN
  if (!authToken) {
    logger.error("missing required env", { var: "MCP_AUTH_TOKEN" })
    throw new Error("MCP_AUTH_TOKEN environment variable is required")
  }

  const vaultPath = process.env.VAULT_PATH
  if (!vaultPath) {
    logger.error("missing required env", { var: "VAULT_PATH" })
    throw new Error("VAULT_PATH environment variable is required")
  }

  const publicUrl = process.env.PUBLIC_URL
  if (!publicUrl) {
    logger.error("missing required env", { var: "PUBLIC_URL" })
    throw new Error("PUBLIC_URL environment variable is required")
  }

  const dataDir = process.env.INDEX_DB_PATH
    ? process.env.INDEX_DB_PATH.replace(/\/[^/]+$/, "")
    : "/data"
  const searchDbPath = process.env.INDEX_DB_PATH ?? `${dataDir}/search.db`
  const oauthDbPath = `${dataDir}/oauth.db`
  const port = parseInt(process.env.PORT ?? "8000", 10)
  const host = process.env.HOST ?? "0.0.0.0"

  const search = createSearchIndex(searchDbPath)
  const count = await search.rebuildFromVault(vaultPath)
  logger.info("initial index built", { count })

  startFileWatcher(vaultPath, search)

  const serverUrl = new URL(publicUrl)
  const { provider, getPendingRequest, approveRequest, deletePendingRequest } =
    createOAuthProvider({ authToken, serverUrl, dbPath: oauthDbPath })

  const app = express()
  app.set("trust proxy", true)
  app.use(express.json())

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  // OAuth routes (unauthenticated) — /.well-known/*, /authorize, /token, /register, /revoke
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: serverUrl,
      serviceDocumentationUrl: new URL(
        "https://github.com/aliasunder/vault-cortex",
      ),
      scopesSupported: ["vault"],
    }),
  )

  // Consent form submission (unauthenticated — part of authorize flow)
  app.post(
    "/oauth/decide",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const { request_id, token, action } = req.body as Record<string, string>
      const pending = getPendingRequest(request_id)

      if (!pending) {
        res.status(400).send("Authorization request expired or invalid.")
        return
      }

      if (action !== "approve") {
        deletePendingRequest(request_id)
        const redirectUrl = new URL(pending.params.redirectUri)
        redirectUrl.searchParams.set("error", "access_denied")
        if (pending.params.state)
          redirectUrl.searchParams.set("state", pending.params.state)
        res.redirect(redirectUrl.toString())
        return
      }

      if (!token || !safeEqual(token, authToken)) {
        res.type("html").send(
          renderConsentPage({
            clientName: pending.client.client_name ?? pending.client.client_id,
            clientId: pending.client.client_id,
            scopes: pending.params.scopes ?? [],
            requestId: request_id,
            error: "Invalid token. Please try again.",
          }),
        )
        return
      }

      const code = approveRequest(request_id)
      const redirectUrl = new URL(pending.params.redirectUri)
      redirectUrl.searchParams.set("code", code)
      if (pending.params.state)
        redirectUrl.searchParams.set("state", pending.params.state)
      res.redirect(redirectUrl.toString())
    },
  )

  // MCP routes — protected by OAuth bearer auth
  const bearerAuth = requireBearerAuth({ verifier: provider })

  const transports = new Map<string, StreamableHTTPServerTransport>()

  app.post("/mcp", bearerAuth, async (req: Request, res: Response) => {
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
        const server = new McpServer({
          name: "vault-cortex",
          version: "1.0.0",
        })

        const sessionLogger = logger.child({
          sessionId: transport.sessionId,
          clientIp,
        })
        registerTools({ server, vaultPath, search, logger: sessionLogger })

        await server.connect(transport)
        if (transport.sessionId) {
          transports.set(transport.sessionId, transport)
        }
        logger.info("mcp_response", {
          sessionId: transport.sessionId,
          clientIp,
          status: 200,
          outcome: "session created",
        })
        await transport.handleRequest(req, res, body)
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

  app.get("/mcp", bearerAuth, async (req: Request, res: Response) => {
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

  app.delete("/mcp", bearerAuth, async (req: Request, res: Response) => {
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

  app.use(createErrorMiddleware())

  app.listen(port, host, () => {
    logger.info("server started", { host, port })
  })

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down")
    process.exit(0)
  })
}

// Node ESM has no `require.main` — compare argv[1] to this module's path
// to avoid running the server when imported by tests
const isEntryPoint =
  resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  startServer().catch((err) => {
    logger.error("failed to start server", {
      error: err instanceof Error ? err.message : String(err),
    })
    process.exit(1)
  })
}

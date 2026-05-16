/** MCP server entry point — config, mount routes, listen. */

import express from "express"
import type { Request, Response, NextFunction } from "express"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createSearchIndex } from "./search/search-index.js"
import { createMemoryStore } from "./vault-operations/memory-store.js"
import { startFileWatcher } from "./search/file-watcher.js"
import { createOAuthProvider } from "./auth/oauth-provider.js"
import { createOAuthRoutes } from "./auth/oauth-routes.js"
import { createMcpRouter } from "./mcp-router.js"
import { loadConfig } from "./config.js"
import { logger } from "../logger.js"
import env from "env-var"

export const createErrorMiddleware =
  () =>
  (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    logger.error("unhandled_error", {
      sessionId: req.headers["mcp-session-id"] as string | undefined,
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
  const config = loadConfig()
  const authToken = env.get("MCP_AUTH_TOKEN").required().asString()
  const vaultPath = env.get("VAULT_PATH").required().asString()
  const publicUrl = env.get("PUBLIC_URL").required().asString()

  const indexDbPath = env.get("INDEX_DB_PATH").asString()
  const dataDir = indexDbPath ? indexDbPath.replace(/\/[^/]+$/, "") : "/data"
  const searchDbPath = indexDbPath ?? `${dataDir}/search.db`
  const oauthDbPath = `${dataDir}/oauth.db`
  const port = env.get("PORT").default("8000").asPortNumber()
  const host = env.get("HOST").default("0.0.0.0").asString()

  const search = createSearchIndex(searchDbPath)
  const count = await search.rebuildFromVault(vaultPath)
  logger.info("initial index built", { count })

  const memoryStore = createMemoryStore({ memoryDir: config.memoryDir })
  await memoryStore.bootstrapMemoryDir({ vaultPath }, logger)

  await startFileWatcher(vaultPath, search)

  const serverUrl = new URL(publicUrl)
  const oauthProvider = createOAuthProvider({
    authToken,
    serverUrl,
    dbPath: oauthDbPath,
  })

  const app = express()
  // Trust exactly one proxy hop (API Gateway). `true` would trust the entire
  // X-Forwarded-For chain, letting clients spoof req.ip via injected headers.
  app.set("trust proxy", 1)
  app.use(express.json())

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  app.use(
    createOAuthRoutes({
      authToken,
      serverUrl,
      oauthProvider,
      serviceDocumentationUrl: config.serviceDocumentationUrl,
    }),
  )
  app.use(
    createMcpRouter({
      vaultPath,
      search,
      provider: oauthProvider.provider,
      config,
    }),
  )

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

/** MCP server entry point — config, mount routes, listen. */

import express from "express"
import type { Request, Response, NextFunction } from "express"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createSearchIndex } from "./search-index.js"
import { startFileWatcher } from "./file-watcher.js"
import { createOAuthProvider } from "./oauth-provider.js"
import { createOAuthRoutes } from "./oauth-routes.js"
import { createMcpRouter } from "./mcp-router.js"
import { logger } from "../logger.js"

const createErrorMiddleware =
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

const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    logger.error("missing required env", { var: name })
    throw new Error(`${name} environment variable is required`)
  }
  return value
}

const startServer = async (): Promise<void> => {
  const authToken = requireEnv("MCP_AUTH_TOKEN")
  const vaultPath = requireEnv("VAULT_PATH")
  const publicUrl = requireEnv("PUBLIC_URL")

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

  app.use(createOAuthRoutes({ authToken, serverUrl, oauthProvider }))
  app.use(
    createMcpRouter({
      vaultPath,
      search,
      provider: oauthProvider.provider,
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

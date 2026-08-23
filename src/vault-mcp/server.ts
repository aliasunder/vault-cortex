/** MCP server entry point — config, mount routes, listen. */

import express from "express"
import type { Request, Response, NextFunction } from "express"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createSearchIndex } from "./search/search-index.js"
import { createEmbedder } from "./search/embedder.js"
import { createReranker } from "./search/reranker.js"
import { createMemoryStore } from "./vault-operations/memory-store.js"
import { startFileWatcher } from "./search/file-watcher.js"
import { createOAuthProvider } from "./oauth/oauth-provider.js"
import { createOAuthRoutes } from "./oauth/oauth-routes.js"
import { createMcpRouter } from "./mcp-core/mcp-router.js"
import { loadConfig } from "./config.js"
import type { VaultConfig } from "./config.js"
import { logger } from "../logger.js"
import { extractClientIp, headerAsString } from "../auth.js"
import { describeError } from "../utils/describe-error.js"
import env from "env-var"

/** Error middleware — logs the failure with request context, answers 500.
 *  The client IP is derived under the same Forwarded hop count as
 *  everywhere else, so a client-supplied Forwarded header can't write a
 *  false IP into the error log. */
export const createErrorMiddleware =
  (trustForwardedHops: number) =>
  (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    logger.error("unhandled_error", {
      sessionId: headerAsString(req.headers["mcp-session-id"]),
      clientIp: extractClientIp(req, trustForwardedHops),
      method: req.method,
      path: req.path,
      error: `[${err.name}]: ${err.message}`,
      stack: err.stack,
    })
    if (!res.headersSent) {
      res.status(500).json({ error: "internal server error" })
    }
  }

/**
 * SIGTERM handler that drains in-flight requests before exiting, so a write
 * can't be interrupted mid-flight. `close()` stops accepting new connections
 * and waits for active requests to finish; the fallback forces exit if a
 * connection hangs the drain longer than `forceExitMs`.
 */
export const createShutdownHandler =
  (
    httpServer: { close: (callback: () => void) => void },
    forceExitMs = 10_000,
  ): (() => void) =>
  (): void => {
    logger.info("SIGTERM received, draining")
    httpServer.close(() => {
      logger.info("drained, exiting")
      process.exit(0)
    })
    setTimeout(() => {
      logger.warn("drain timed out, forcing exit")
      process.exit(1)
    }, forceExitMs).unref()
  }

/**
 * Runs the memory template bootstrap unless config forbids it — memory
 * disabled, or read-only mode (a read-only server never writes to the vault,
 * and this is the one server-initiated vault write).
 */
export const bootstrapMemoryIfEnabled = async (
  config: VaultConfig,
  vaultPath: string,
): Promise<void> => {
  if (!config.memoryEnabled || config.readOnlyMode) return
  const memoryStore = createMemoryStore({ memoryDir: config.memoryDir })
  await memoryStore.bootstrapMemoryDir({ vaultPath }, logger)
}

const startServer = async (): Promise<void> => {
  const config = loadConfig()
  // Trim so a stray trailing space or newline on MCP_AUTH_TOKEN in .env
  // can't silently break every auth attempt — a valid token has no
  // surrounding whitespace.
  const authToken = env.get("MCP_AUTH_TOKEN").required().asString().trim()
  const vaultPath = env.get("VAULT_PATH").required().asString()
  const publicUrl = env.get("PUBLIC_URL").required().asString()

  const indexDbPath = env.get("INDEX_DB_PATH").asString()
  const dataDir = indexDbPath ? indexDbPath.replace(/\/[^/]+$/, "") : "/data"
  const searchDbPath = indexDbPath ?? `${dataDir}/search.db`
  const oauthDbPath = `${dataDir}/oauth.db`
  const port = env.get("PORT").default("8000").asPortNumber()
  const host = env.get("HOST").default("0.0.0.0").asString()

  logger.info("config loaded", {
    memoryEnabled: config.memoryEnabled,
    fileToolsEnabled: config.fileToolsEnabled,
    readOnlyMode: config.readOnlyMode,
    disabledTools:
      config.disabledTools.size > 0 ? [...config.disabledTools] : "none",
    memoryDir: config.memoryDir,
    embeddingEnabled: config.embeddingEnabled,
    rerankMode: config.rerankMode,
    windowsBindMount: config.windowsBindMount,
    trustProxyHops: config.trustProxyHops,
    trustForwardedHops: config.trustForwardedHops,
  })

  const embedder = config.embeddingEnabled ? createEmbedder(logger) : undefined
  const reranker =
    config.embeddingEnabled && config.rerankMode === "blended"
      ? createReranker(logger)
      : undefined
  const search = createSearchIndex(searchDbPath, embedder, reranker, {
    memoryDir: config.memoryEnabled ? config.memoryDir : undefined,
    fileToolsEnabled: config.fileToolsEnabled,
  })
  const { count } = await search.rebuildFromVault({ vaultPath }, logger)
  logger.info("initial index built", { count })

  await bootstrapMemoryIfEnabled(config, vaultPath)
  await startFileWatcher(vaultPath, search, {
    usePolling: config.windowsBindMount,
  })

  const serverUrl = new URL(publicUrl)
  const oauthProvider = createOAuthProvider({
    authToken,
    dbPath: oauthDbPath,
    logger,
  })

  const app = express()
  // Proxy trust is deployment-explicit: TRUST_PROXY_HOPS grants one
  // X-Forwarded-For hop per proxy the deployment controls. With the
  // default 0, req.ip — the OAuth rate limiter's fallback bucket key —
  // is the socket peer, and an injected header can't shift it. Never
  // widen this to Express's blanket `true`: trusting the whole chain
  // lets any client claim any IP via appended headers.
  app.set("trust proxy", config.trustProxyHops)
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
      trustForwardedHops: config.trustForwardedHops,
      logger,
    }),
  )
  app.use(
    createMcpRouter({
      vaultPath,
      search,
      serverUrl,
      provider: oauthProvider.provider,
      config,
    }),
  )

  app.use(createErrorMiddleware(config.trustForwardedHops))

  // Express 5 reports a bind failure (EADDRINUSE, EACCES) through the
  // callback's error argument instead of throwing, so an unchecked callback
  // would log "server started" and leave a process that serves nothing.
  const httpServer = app.listen(port, host, (listenError?: Error) => {
    if (listenError) {
      logger.error("server failed to listen", {
        host,
        port,
        error: describeError(listenError),
      })
      process.exit(1)
    }
    logger.info("server started", { host, port })
  })

  process.on("SIGTERM", createShutdownHandler(httpServer))
}

// Node ESM has no `require.main` — compare argv[1] to this module's path
// to avoid running the server when imported by tests
const isEntryPoint =
  resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  startServer().catch((err) => {
    logger.error("failed to start server", {
      error: describeError(err),
    })
    process.exit(1)
  })
}

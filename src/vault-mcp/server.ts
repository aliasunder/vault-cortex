/** MCP server entry point — config, mount routes, listen. */

import express, { type Request, type Response } from "express"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createSearchIndex } from "./search/search-index.js"
import {
  BODY_TAG_PARSE_TIMEOUT_MS,
  createBodyTagParser,
  type BodyTagParser,
} from "./search/body-tag-parser.js"
import { createSearchModels } from "./search/search-models.js"
import { createMemoryStore } from "./vault-operations/memory-store.js"
import { createPdfExtractor, type PdfExtractor } from "./vault-operations/pdf-extractor.js"
import { readTaskFormatConfig } from "./vault-operations/task-format-config.js"
import { trashSweeper } from "./vault-operations/trash-sweeper.js"
import { watchVaultAndBuildIndex } from "./search/file-watcher.js"
import { createOAuthProvider } from "./oauth/oauth-provider.js"
import { createOAuthRoutes } from "./oauth/oauth-routes.js"
import { createMcpRouter } from "./mcp-core/mcp-router.js"
import { renderSetupPage } from "./setup/setup-page.js"
import { loadConfig, type VaultConfig } from "./config.js"
import { logger } from "../logger.js"
import { createErrorMiddleware } from "../http-error-middleware.js"
import { describeError } from "../utils/describe-error.js"
import { urlHasCredentials } from "../utils/url-has-credentials.js"
import { securityHeaders } from "../utils/security-headers.js"
import env from "env-var"

/**
 * SIGTERM handler that drains in-flight requests before exiting, so a write
 * can't be interrupted mid-flight.
 * - The body-tag parser refuses new parses before requests drain; worker
 *   termination continues in the background.
 * - `httpServer.close()` stops accepting new connections and waits for active
 *   requests to finish.
 * - The fallback forces exit if a connection hangs the drain longer than
 *   `forceExitMs`.
 */
export const createShutdownHandler =
  ({
    httpServer,
    bodyTagParser,
    pdfExtractor,
    forceExitMs = 10_000,
  }: {
    httpServer: { close: (callback: () => void) => void }
    bodyTagParser: Pick<BodyTagParser, "close">
    pdfExtractor: Pick<PdfExtractor, "close">
    forceExitMs?: number
  }): (() => void) =>
  (): void => {
    logger.info("SIGTERM received, draining")

    // Close extraction before draining HTTP so active reads get a defined error immediately.
    const extractionClosed = pdfExtractor.close()
    const parserClosed = bodyTagParser.close()
    const drained = new Promise<void>((resolveDrain) => httpServer.close(resolveDrain))
    const finishShutdown = async (): Promise<void> => {
      try {
        const cleanupResults = await Promise.allSettled([extractionClosed, parserClosed, drained])
        const failedCleanup = cleanupResults.find((result) => result.status === "rejected")

        if (failedCleanup) throw failedCleanup.reason
        logger.info("drained, exiting")
        process.exit(0)
      } catch (error) {
        logger.warn("shutdown cleanup failed", { error: describeError(error) })
        process.exit(1)
      }
    }
    void finishShutdown()
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

type DataPaths = { searchDbPath: string; oauthDbPath: string; modelCacheDir: string }

/** Where the server keeps its state: beside INDEX_DB_PATH, or in /data when it is unset. */
export const resolveDataPaths = (indexDbPathSetting: string | undefined): DataPaths => {
  // An empty INDEX_DB_PATH counts as unset, as it does in the :remote init scripts.
  const indexDbPath = indexDbPathSetting || undefined
  // /data is the Docker volume where the container persists its databases, models and logs
  const dataDir = indexDbPath ? dirname(indexDbPath) : "/data"

  return {
    searchDbPath: indexDbPath ?? `${dataDir}/search.db`,
    oauthDbPath: `${dataDir}/oauth.db`,
    // transformers.js's default model folder, under /app, is lost whenever the container is
    // re-created, and a server run with a PUID other than 1000 can't write it.
    modelCacheDir: `${dataDir}/models`,
  }
}

/** Matches `*`, `?`, or `[`, which the `:remote` init scripts' `find -path` reads as wildcards. */
const GLOB_CHARS = /[*?[]/

const startServer = async (): Promise<void> => {
  const config = loadConfig()
  // Trim so a stray trailing space or newline on MCP_AUTH_TOKEN in .env
  // can't silently break every auth attempt — a valid token has no
  // surrounding whitespace.
  const authToken = env.get("MCP_AUTH_TOKEN").required().asString().trim()
  const vaultPath = env.get("VAULT_PATH").required().asString()

  if (GLOB_CHARS.test(vaultPath)) {
    throw new Error("VAULT_PATH must not contain glob characters (*, ?, [)")
  }

  const publicUrl = env.get("PUBLIC_URL").required().asString()
  const serverUrl = new URL(publicUrl)

  if (serverUrl.protocol !== "http:" && serverUrl.protocol !== "https:") {
    throw new Error(
      "PUBLIC_URL must be an http:// or https:// URL (e.g. https://vault.example.com)",
    )
  }

  // Credentials in the URL would be minted into every token's `iss`
  // claim and served by the discovery documents — refuse to start.
  if (urlHasCredentials(serverUrl)) {
    throw new Error("PUBLIC_URL must not contain credentials (user:password@)")
  }

  // A bare trailing ? or # parses to an empty search or hash, so check the raw string.
  if (publicUrl.includes("?") || publicUrl.includes("#")) {
    throw new Error("PUBLIC_URL must be a bare origin — no query string or fragment")
  }

  if (serverUrl.pathname.replace(/\/+$/, "") !== "") {
    throw new Error(
      "PUBLIC_URL must be a bare origin — path prefixes are not supported (e.g. https://vault.example.com)",
    )
  }

  const { searchDbPath, oauthDbPath, modelCacheDir } = resolveDataPaths(
    env.get("INDEX_DB_PATH").asString(),
  )
  const port = env.get("PORT").default("8000").asPortNumber()
  const host = env.get("HOST").default("0.0.0.0").asString()

  logger.info("config loaded", {
    memoryEnabled: config.memoryEnabled,
    fileToolsEnabled: config.fileToolsEnabled,
    readOnlyMode: config.readOnlyMode,
    disabledTools: config.disabledTools.size > 0 ? [...config.disabledTools] : "none",
    memoryDir: config.memoryDir,
    embeddingEnabled: config.embeddingEnabled,
    rerankMode: config.rerankMode,
    windowsBindMount: config.windowsBindMount,
    trustProxyHops: config.trustProxyHops,
    trustForwardedHops: config.trustForwardedHops,
    trashRetentionDays: config.trashRetentionDays ?? "none",
  })

  const { embedder, reranker } = await createSearchModels(
    { embeddingEnabled: config.embeddingEnabled, rerankMode: config.rerankMode, modelCacheDir },
    logger,
  )

  // The status registry is captured at boot so listings and writes classify
  // with one map; format and date toggles are read live per task write.
  const { statusRegistry } = await readTaskFormatConfig(vaultPath, logger)
  const search = createSearchIndex(searchDbPath, embedder, reranker, {
    memoryDir: config.memoryEnabled ? config.memoryDir : undefined,
    fileToolsEnabled: config.fileToolsEnabled,
    statusRegistry,
  })

  // Before the watcher starts, so its template writes are not held and re-read.
  await bootstrapMemoryIfEnabled(config, vaultPath)

  // Lives until SIGTERM, when the shutdown handler closes it
  const bodyTagParser = createBodyTagParser({ timeoutMs: BODY_TAG_PARSE_TIMEOUT_MS })
  const pdfExtractor = createPdfExtractor({ vaultPath, maxFileBytes: config.maxFileBytes })
  // The signal handler must exist before startup reconciliation can queue extraction.
  const lifecycle: { httpServer?: { close: (callback: () => void) => void } } = {}
  process.once(
    "SIGTERM",
    createShutdownHandler({
      httpServer: {
        close: (callback) => {
          if (lifecycle.httpServer) lifecycle.httpServer.close(callback)
          else callback()
        },
      },
      bodyTagParser,
      pdfExtractor,
    }),
  )

  try {
    // Startup takes only the note count and leaves the rebuild's embedding and
    // body-tag passes running, so the server takes requests while they run;
    // rebuildFromVault logs either pass's failure itself.
    const { count, startPdfPass } = await watchVaultAndBuildIndex(
      {
        vaultPath,
        search,
        bodyTagParser,
        pdfExtractor,
        maxFileBytes: config.maxFileBytes,
        watcherOptions: { usePolling: config.windowsBindMount },
      },
      logger,
    )
    logger.info("initial index built", { notesIndexedByRebuild: count })

    const oauthProvider = createOAuthProvider({
      authToken,
      dbPath: oauthDbPath,
      serverUrl,
      logger,
    })

    const app = express()
    // First, so a response that later middleware ends early, such as an error
    // or a redirect, carries the headers too.
    app.use(securityHeaders)
    app.disable("x-powered-by")
    // Proxy trust is deployment-explicit: TRUST_PROXY_HOPS grants one
    // X-Forwarded-For hop per proxy the deployment controls. With the
    // default 0, req.ip — the OAuth rate limiter's fallback bucket key —
    // is the socket peer, and an injected header can't shift it. Never
    // widen this to Express's blanket `true`: trusting the whole chain
    // lets any client claim any IP via appended headers.
    app.set("trust proxy", config.trustProxyHops)

    app.get("/healthz", (_req: Request, res: Response) => {
      res.json({ ok: true })
    })

    // The :remote image serves the Sync sign-in page here while it has no
    // token (setup/setup-server.ts); once configured, the same address says so
    // instead of 404ing on a link from that flow or a guide.
    app.get("/setup", (_req: Request, res: Response) => {
      // Not cached, so the address shows setup mode's page again if the
      // container returns to setup mode.
      res
        .set("Cache-Control", "no-store")
        .type("html")
        .send(renderSetupPage({ kind: "configured" }))
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
        pdfExtractor,
        serverUrl,
        provider: oauthProvider.provider,
        config,
      }),
    )

    app.use(createErrorMiddleware({ trustForwardedHops: config.trustForwardedHops }))

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
        void pdfExtractor.close().finally(() => process.exit(1))
        return
      }
      logger.info("server started", { host, port })
      // This is the shared boundary for rebuild and held/live watcher PDF work.
      void startPdfPass()
    })
    lifecycle.httpServer = httpServer

    // Started after listen so a large trash backlog (unlinks at bind-mount
    // latency) can never stall /healthz past container health-check budgets.
    // Sync deploys never trash (their deletes skip .trash/ and remove the note
    // for good) and a read-only server never modifies the vault, so neither runs.
    const trashBookkeepingEnabled = !config.readOnlyMode && !config.obsidianSyncEnabled

    // Orphan purge: drops rows whose .trash/ entry is gone — runs once at
    // boot regardless of TRASH_RETENTION_DAYS.
    if (trashBookkeepingEnabled) {
      try {
        await trashSweeper.purgeOrphanedTrashEntries({ vaultPath, trashEntryStore: search }, logger)
      } catch (error) {
        logger.error("orphaned trash entry purge failed", {
          error: describeError(error),
        })
      }
    }

    // Retention sweep: unlinks expired files on a daily schedule.
    const { trashRetentionDays } = config

    if (trashBookkeepingEnabled && trashRetentionDays !== null) {
      trashSweeper.startTrashSweepSchedule(
        {
          vaultPath,
          retentionDays: trashRetentionDays,
          trashEntryStore: search,
        },
        logger,
      )
    }
  } catch (error) {
    await Promise.all([pdfExtractor.close(), bodyTagParser.close()])
    throw error
  }
}

// Node ESM has no `require.main` — compare argv[1] to this module's path
// to avoid running the server when imported by tests
const isEntryPoint = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  startServer().catch((err) => {
    logger.error("failed to start server", {
      error: describeError(err),
    })
    process.exit(1)
  })
}

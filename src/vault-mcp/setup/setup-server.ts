/** Setup-mode entry point — what svc-vault-mcp runs instead of server.ts
 *  while the container has no Obsidian Sync token. Serves /setup and
 *  /healthz only; every other path answers 503 with the setup URL. No
 *  index, no watcher, no OAuth: the page must be up seconds after the
 *  deploy, not after a vault download. */

import express from "express"
import type { NextFunction, Request, Response } from "express"
import { join } from "node:path"
import env from "env-var"
import { loadConfig } from "../config.js"
import { logger } from "../../logger.js"
import { describeError } from "../../utils/describe-error.js"
import { createSetupRoutes } from "./setup-routes.js"

const startSetupServer = (): void => {
  // Validates the rest of the deployment's settings too, so a typo in an
  // optional variable surfaces here rather than after the user's sign-in.
  const config = loadConfig()
  const authToken = env.get("MCP_AUTH_TOKEN").required().asString().trim()
  const port = env.get("PORT").default("8000").asPortNumber()
  const host = env.get("HOST").default("0.0.0.0").asString()
  // Optional here — a template deploy derives it, a plain `docker run` may
  // not have set it yet — where server.ts requires it.
  const publicUrl = URL.parse(env.get("PUBLIC_URL").default("").asString())
  // The Sync client's credential file. obsidian-headless resolves its config
  // home the same way: XDG_CONFIG_HOME, else $HOME/.config.
  const configHome =
    env.get("XDG_CONFIG_HOME").asString() ||
    join(env.get("HOME").required().asString(), ".config")
  const tokenFilePath = join(configHome, "obsidian-headless", "auth_token")
  // Override exists for the boot tests, which point it at a stub inside the
  // container; the production value is the default.
  const obsidianApiBaseUrl = env
    .get("OBSIDIAN_API_URL")
    .default("https://api.obsidian.md")
    .asUrlString()
  const vaultName = env.get("VAULT_NAME").default("").asString().trim()
  const vaultPasswordSet = Boolean(env.get("VAULT_PASSWORD").asString())
  const savedLoginRejected =
    env.get("SETUP_REASON").default("").asString() === "login-failed"

  const setupUrl = publicUrl ? new URL("/setup", publicUrl).href : "/setup"

  const app = express()
  app.set("trust proxy", config.trustProxyHops)

  // Healthy on purpose: the platform's health check must pass for the
  // setup page to be reachable at all. `mode` tells the completion page's
  // poll — and any curious client — that this is not the full server yet.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, mode: "setup" })
  })

  app.use(
    createSetupRoutes({
      authToken,
      publicUrl: publicUrl ?? undefined,
      vaultName: vaultName || undefined,
      vaultPasswordSet,
      tokenFilePath,
      obsidianApiBaseUrl,
      savedLoginRejected,
      trustForwardedHops: config.trustForwardedHops,
      onSetupComplete: () => {
        logger.info("setup server exiting for restart")
        process.exit(0)
      },
      logger,
    }),
  )

  app.use((_req: Request, res: Response) => {
    res.status(503).json({ error: "setup required", setup_url: setupUrl })
  })

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error("unhandled_error", {
      method: req.method,
      path: req.path,
      error: describeError(err),
      stack: err.stack,
    })
    if (!res.headersSent)
      res.status(500).json({ error: "internal server error" })
  })

  app.listen(port, host, (listenError?: Error) => {
    if (listenError) {
      logger.error("setup server failed to listen", {
        host,
        port,
        error: describeError(listenError),
      })
      process.exit(1)
    }
    logger.info("setup server started", { host, port, setupUrl })
  })
}

startSetupServer()

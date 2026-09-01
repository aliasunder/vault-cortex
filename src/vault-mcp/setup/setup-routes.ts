/** The /setup routes: sign the server in to Obsidian Sync from the browser
 *  and write the token where the Sync client reads it. Served only while
 *  the container has no working token (setup mode). */

import express, { Router } from "express"
import type { NextFunction, Request, Response } from "express"
import { rateLimit } from "express-rate-limit"
import { randomUUID } from "node:crypto"
import { DateTime } from "luxon"
import { extractClientIp, safeEqual } from "../../auth.js"
import type { Logger } from "../../logger.js"
import {
  ObsidianApiError,
  describeApiFailure,
  isMfaCodeError,
  isMfaRequiredError,
  obsidianApi,
} from "./obsidian-api.js"
import type {
  RemoteVault,
  SignInResult,
  VaultKeyStatus,
} from "./obsidian-api.js"
import { deriveVaultKeyHash } from "./vault-key.js"
import { renderSetupPage } from "./setup-page.js"
import type { PreflightProblem } from "./setup-page.js"
import { syncTokenStore } from "./sync-token-store.js"

type SetupRoutesOptions = {
  authToken: string
  /** Where MCP clients connect once the server is up; undefined when
   *  PUBLIC_URL is not set (a plain `docker run` without it). */
  publicUrl: URL | undefined
  vaultName: string | undefined
  /** The vault's end-to-end encryption password; undefined when unset. */
  vaultPassword: string | undefined
  /** The Sync client's credential file, `<config home>/obsidian-headless/auth_token`. */
  tokenFilePath: string
  obsidianApiBaseUrl: string
  /** Set when the boot chain rejected a token already on the volume. */
  savedLoginRejected: boolean
  trustForwardedHops: number
  /** Runs once the completion page has been delivered — the wiring exits
   *  the process so the container can restart into a normal boot. */
  onSetupComplete: () => void
  logger: Logger
}

/** How long a sign-in that is waiting for its 2FA code stays valid. */
const PENDING_SIGN_IN_TTL_MINUTES = 5

type PendingSignIn = {
  email: string
  password: string
  expiresAt: DateTime
}

/** A body field, or "" when absent or not a string. */
const formField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name]
  return typeof value === "string" ? value : ""
}

export const createSetupRoutes = ({
  authToken,
  publicUrl,
  vaultName,
  vaultPassword,
  tokenFilePath,
  obsidianApiBaseUrl,
  savedLoginRejected,
  trustForwardedHops,
  onSetupComplete,
  logger,
}: SetupRoutesOptions): Router => {
  const routeLogger = logger.child({ component: "setup-routes" })
  const router = Router()

  // Email + password of a sign-in that still needs its 2FA code, keyed by
  // the id the code form posts back. Kept in memory only, single use, and
  // dropped after the TTL — never rendered into the page.
  const pendingSignIns = new Map<string, PendingSignIn>()

  const storePendingSignIn = ({
    email,
    password,
    inheritedExpiresAt,
  }: {
    email: string
    password: string
    inheritedExpiresAt?: DateTime
  }): string => {
    const requestId = randomUUID()
    const expiresAt =
      inheritedExpiresAt ??
      DateTime.now().plus({ minutes: PENDING_SIGN_IN_TTL_MINUTES })
    const remainingMs = expiresAt.diff(DateTime.now()).toMillis()
    // The inherited expiry already passed — don't store credentials at all.
    if (remainingMs <= 0) return requestId
    pendingSignIns.set(requestId, { email, password, expiresAt })
    // Drop the credentials at the expiry even when no further request arrives;
    // `expiresAt` stays the check for a code that comes in late. unref so an
    // abandoned sign-in cannot hold the process open.
    setTimeout(() => pendingSignIns.delete(requestId), remainingMs).unref()
    return requestId
  }

  const takePendingSignIn = (requestId: string): PendingSignIn | undefined => {
    const pending = pendingSignIns.get(requestId)
    pendingSignIns.delete(requestId)
    if (!pending || pending.expiresAt <= DateTime.now()) return undefined
    return pending
  }

  // 5/min per client IP, the same budget as the OAuth endpoints. The miss
  // path calls Obsidian's API, so an unlimited endpoint would relay password
  // guesses from this server's address.
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    keyGenerator: (req: Request) => extractClientIp(req, trustForwardedHops),
    handler: (
      req: Request,
      res: Response,
      _next: NextFunction,
      options: { statusCode: number; message: unknown },
    ) => {
      routeLogger.warn("setup_rate_limited", {
        clientIp: extractClientIp(req, trustForwardedHops),
      })
      res.status(options.statusCode).send(options.message)
    },
  })

  // Express keeps the brackets on an IPv6 host, so `[::1]` is the loopback
  // form a browser sends.
  const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"])

  const isInsecureTransport = (req: Request): boolean => {
    if (req.secure) return false
    return !LOOPBACK_HOSTNAMES.has(req.hostname)
  }

  const sendSignInPage = (
    req: Request,
    res: Response,
    { status = 200, error }: { status?: number; error?: string } = {},
  ): void => {
    res
      .status(status)
      .type("html")
      .send(
        renderSetupPage({
          kind: "sign-in",
          error,
          savedLoginRejected,
          insecureTransport: isInsecureTransport(req),
        }),
      )
  }

  // The listing is advisory: if it cannot be fetched the token is still
  // valid, so sign-in proceeds and the boot chain reports any problem.
  const listAccountVaults = async (
    token: string,
    requestLogger: Logger,
  ): Promise<RemoteVault[] | undefined> => {
    try {
      return await obsidianApi.listVaults({
        apiBaseUrl: obsidianApiBaseUrl,
        token,
      })
    } catch (error) {
      requestLogger.warn("setup_vault_check_skipped", {
        error: describeApiFailure(error),
      })
      return undefined
    }
  }

  /** The check `ob sync-setup` would fail on next boot with a wrong
   *  VAULT_PASSWORD. A key this server cannot derive blocks too — the next
   *  boot cannot derive it either. Only a check that cannot reach Obsidian
   *  is advisory, like the listing. */
  const checkVaultKey = async (
    {
      token,
      password,
      key,
      encryptedVaultName,
    }: {
      token: string
      password: string
      key: VaultKeyStatus
      encryptedVaultName: string
    },
    requestLogger: Logger,
  ): Promise<PreflightProblem | undefined> => {
    if (key.kind === "unsupported-version") {
      return {
        kind: "vault-key-underivable",
        vaultName: encryptedVaultName,
        encryptionVersion: key.encryptionVersion,
      }
    }
    if (key.kind === "incomplete-listing") {
      return {
        kind: "vault-key-underivable",
        vaultName: encryptedVaultName,
        encryptionVersion: undefined,
      }
    }
    const keyMaterial = key.material
    const keyHash = await deriveVaultKeyHash({
      password,
      salt: keyMaterial.salt,
      encryptionVersion: keyMaterial.encryptionVersion,
    })
    try {
      await obsidianApi.validateVaultKey({
        apiBaseUrl: obsidianApiBaseUrl,
        token,
        keyMaterial,
        keyHash,
      })
      return undefined
    } catch (error) {
      if (error instanceof ObsidianApiError) {
        return {
          kind: "vault-access-rejected",
          vaultName: encryptedVaultName,
          apiMessage: error.message,
        }
      }
      requestLogger.warn("setup_vault_key_check_skipped", {
        reason: describeApiFailure(error),
      })
      return undefined
    }
  }

  /** The deployment settings the next boot would fail on — checked before
   *  the token is written, so the user fixes them from this page instead
   *  of from a crash-looping container's logs. */
  const checkVaultSettings = async (
    token: string,
    requestLogger: Logger,
  ): Promise<PreflightProblem | undefined> => {
    if (!vaultName) return { kind: "vault-name-unset" }
    const vaults = await listAccountVaults(token, requestLogger)
    if (!vaults) return undefined
    const matches = vaults.filter((vault) => vault.name === vaultName)
    if (matches.length === 0) {
      return {
        kind: "vault-not-found",
        vaultName,
        vaultNames: vaults.map((vault) => vault.name),
      }
    }
    if (matches.length > 1) return { kind: "vault-name-ambiguous", vaultName }
    const [vault] = matches
    if (!vault?.encrypted) return undefined
    if (!vaultPassword) return { kind: "password-missing", vaultName }
    return checkVaultKey(
      {
        token,
        password: vaultPassword,
        key: vault.key,
        encryptedVaultName: vaultName,
      },
      requestLogger,
    )
  }

  const completeSetup = async (
    { token, accountEmail }: SignInResult,
    res: Response,
    requestLogger: Logger,
  ): Promise<void> => {
    const problem = await checkVaultSettings(token, requestLogger)
    if (problem) {
      requestLogger.warn("setup_blocked", { problem: problem.kind })
      res
        .type("html")
        .send(renderSetupPage({ kind: "blocked", accountEmail, problem }))
      return
    }
    await syncTokenStore.writeSyncToken({ tokenFilePath, token }, requestLogger)
    requestLogger.info("setup_complete")
    // The process exits only after the page has left, so the browser has
    // the polling script before the server goes away. The token is on
    // disk now, so the restart must also follow a browser that has gone:
    // `close` fires after the page is delivered and on a dropped
    // connection — possibly already, while the token was being written.
    if (res.destroyed) {
      onSetupComplete()
      return
    }
    res.once("close", onSetupComplete)
    res.type("html").send(
      renderSetupPage({
        kind: "complete",
        accountEmail,
        mcpUrl: publicUrl ? new URL("/mcp", publicUrl).href : undefined,
      }),
    )
  }

  const handleSignInForm = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    requestLogger: Logger,
  ): Promise<void> => {
    // Whitespace-tolerant like the consent page: a token copied from a
    // dashboard or terminal can pick up a wrapped newline.
    const submittedToken = formField(body, "token").replace(/\s+/g, "")
    if (!submittedToken || !safeEqual(submittedToken, authToken)) {
      requestLogger.warn("setup_bad_token")
      sendSignInPage(req, res, {
        status: 401,
        error:
          "That MCP token does not match this server. Check the MCP_AUTH_TOKEN value in your deployment's settings.",
      })
      return
    }
    const email = formField(body, "email").trim()
    const password = formField(body, "password")
    if (!email || !password) {
      sendSignInPage(req, res, {
        status: 400,
        error: "Enter your Obsidian account email and password.",
      })
      return
    }
    // The try/catch covers the API call only — a filesystem error from
    // completeSetup must not be formatted as an API failure.
    let result: SignInResult
    try {
      result = await obsidianApi.signIn({
        apiBaseUrl: obsidianApiBaseUrl,
        email,
        password,
        mfa: "",
      })
    } catch (error) {
      if (isMfaRequiredError(error)) {
        const requestId = storePendingSignIn({ email, password })
        res.type("html").send(renderSetupPage({ kind: "mfa", requestId }))
        return
      }
      requestLogger.warn("setup_signin_failed", {
        error: describeApiFailure(error),
      })
      sendSignInPage(req, res, { error: describeApiFailure(error) })
      return
    }
    await completeSetup(result, res, requestLogger)
  }

  const handleMfaForm = async (
    req: Request,
    res: Response,
    body: Record<string, unknown>,
    requestLogger: Logger,
  ): Promise<void> => {
    const pending = takePendingSignIn(formField(body, "request_id"))
    if (!pending) {
      sendSignInPage(req, res, {
        error: "That sign-in expired — start again.",
      })
      return
    }
    const mfa = formField(body, "mfa").trim()
    // Scoped to the API call — same reason as handleSignInForm.
    let result: SignInResult
    try {
      result = await obsidianApi.signIn({
        apiBaseUrl: obsidianApiBaseUrl,
        email: pending.email,
        password: pending.password,
        mfa,
      })
    } catch (error) {
      requestLogger.warn("setup_signin_failed", {
        error: describeApiFailure(error),
        mfaAttempt: true,
      })
      // A wrong or missing code keeps the sign-in alive for another try;
      // anything else (a timeout, a rejected password) starts over.
      if (isMfaCodeError(error)) {
        const requestId = storePendingSignIn({
          email: pending.email,
          password: pending.password,
          inheritedExpiresAt: pending.expiresAt,
        })
        res.type("html").send(
          renderSetupPage({
            kind: "mfa",
            requestId,
            error: describeApiFailure(error),
          }),
        )
        return
      }
      sendSignInPage(req, res, { error: describeApiFailure(error) })
      return
    }
    await completeSetup(result, res, requestLogger)
  }

  router.get("/setup", (req: Request, res: Response) => {
    sendSignInPage(req, res)
  })

  router.post(
    "/setup",
    limiter,
    express.urlencoded({ extended: false }),
    async (req: Request, res: Response) => {
      const body: Record<string, unknown> = req.body
      const requestLogger = routeLogger.child({
        clientIp: extractClientIp(req, trustForwardedHops),
      })
      if (formField(body, "request_id")) {
        await handleMfaForm(req, res, body, requestLogger)
        return
      }
      await handleSignInForm(req, res, body, requestLogger)
    },
  )

  return router
}

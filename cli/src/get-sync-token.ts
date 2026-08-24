import { join, resolve } from "node:path"

import type { Prompts } from "./prompts.js"
import { patchEnvObsidianToken } from "./scaffold.js"
import { expandTilde } from "./vault.js"

export type GetSyncTokenFlags = {
  dir?: string
}

export type GetSyncTokenDeps = {
  prompts: Prompts
  fetchFn: typeof fetch
}

const OBSIDIAN_SIGNIN_URL = "https://api.obsidian.md/user/signin"
const SIGNIN_TIMEOUT_MS = 30_000

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

class ObsidianApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ObsidianApiError"
  }
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Calls the Obsidian Sync signin API. Returns the parsed JSON on success,
 * or throws on HTTP/network errors. The API returns { error: string } for
 * auth failures (200 with an error field), and non-200 for server errors.
 */
const callSigninApi = async (
  params: { email: string; password: string; mfa: string },
  fetchFn: typeof fetch,
): Promise<{ token: string; name: string; email: string }> => {
  const response = await fetchFn(OBSIDIAN_SIGNIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://obsidian.md",
    },
    body: JSON.stringify({
      email: params.email,
      password: params.password,
      mfa: params.mfa,
    }),
    signal: AbortSignal.timeout(SIGNIN_TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`HTTP Error ${response.status}`)

  const body = await response.json().catch(() => null)
  if (!isJsonObject(body))
    throw new Error("Unexpected response from Obsidian API (not JSON)")
  if (typeof body.error === "string") throw new ObsidianApiError(body.error)
  if (typeof body.token !== "string" || !body.token)
    throw new Error("Unexpected response from Obsidian API (no token)")

  return {
    token: body.token,
    name: typeof body.name === "string" ? body.name : "",
    email: typeof body.email === "string" ? body.email : "",
  }
}

/**
 * Warns the user about a signin failure with a message tailored to the
 * error type. Called by both the initial signin and MFA retry paths.
 */
const warnSigninError = (
  error: unknown,
  prompts: Prompts,
  isMfaRetry: boolean,
): void => {
  if (error instanceof Error && error.name === "TimeoutError") {
    prompts.warn(
      "Request timed out — check your internet connection and try again.",
    )
    return
  }

  const mfaHint =
    isMfaRetry &&
    error instanceof ObsidianApiError &&
    error.message.includes("2FA code")
      ? "\n  Check your 2FA code and try again."
      : ""

  prompts.warn(`Could not sign in: ${describeError(error)}${mfaHint}`)
}

/**
 * Signs in to the user's Obsidian account via the Sync API and returns
 * the auth token. Prompts for email, password, and MFA code (when 2FA
 * is enabled). Returns the token on success, undefined on any failure.
 */
export const captureObsidianToken = async (
  deps: GetSyncTokenDeps,
): Promise<string | undefined> => {
  const { prompts, fetchFn } = deps

  prompts.log(
    "Sign in to your Obsidian account to generate the token your server\n" +
      "needs to sync your vault.",
  )
  const email = await prompts.text("Obsidian account email:", {
    placeholder: "you@example.com",
  })
  const password = await prompts.password("Password:")

  const spinner = prompts.spinner()
  spinner.start("Signing in to Obsidian...")

  try {
    const result = await callSigninApi({ email, password, mfa: "" }, fetchFn)
    spinner.stop(`Signed in as ${result.name} (${result.email}).`)
    return result.token
  } catch (error) {
    // MFA required: the API returns an error containing "2FA code" — prompt
    // and retry. "2FA code is incorrect" is a wrong-code rejection, not a
    // prompt-for-code signal. Mirrors the obsidian-headless v0.0.14 logic.
    const needsMfa =
      error instanceof ObsidianApiError &&
      error.message.includes("2FA code") &&
      !error.message.includes("2FA code is incorrect")

    if (!needsMfa) {
      spinner.stop("Sign-in failed.")
      warnSigninError(error, prompts, false)
      return undefined
    }

    spinner.stop("Two-factor authentication required.")
    const mfaCode = await prompts.text("2FA code:")

    spinner.start("Verifying...")
    try {
      const result = await callSigninApi(
        { email, password, mfa: mfaCode },
        fetchFn,
      )
      spinner.stop(`Signed in as ${result.name} (${result.email}).`)
      return result.token
    } catch (retryError) {
      spinner.stop("Sign-in failed.")
      warnSigninError(retryError, prompts, true)
      return undefined
    }
  }
}

/**
 * Subcommand entry: generate an Obsidian Sync token via the Obsidian API.
 * Without --dir, prints the token to stdout.
 * With --dir, writes it directly to `<dir>/.env`.
 */
export const runGetSyncToken = async (
  flags: GetSyncTokenFlags,
  deps: GetSyncTokenDeps,
): Promise<number> => {
  const { prompts } = deps

  prompts.intro("vault-cortex get-sync-token")

  const token = await captureObsidianToken(deps)
  if (!token) {
    prompts.error("Could not capture the auth token.")
    return 1
  }

  const envFilePath = flags.dir
    ? join(resolve(expandTilde(flags.dir)), ".env")
    : undefined

  if (!envFilePath) {
    prompts.log("Your OBSIDIAN_AUTH_TOKEN:")
    prompts.print(`\n  ${token}\n`)
    prompts.outro("Done.")
    return 0
  }

  const patched = patchEnvObsidianToken(envFilePath, token)
  if (!patched) {
    prompts.error(
      `Could not patch ${envFilePath} — the file is missing or has no ` +
        "OBSIDIAN_AUTH_TOKEN line. Run init first.",
    )
    return 1
  }
  prompts.log(`Token written to ${envFilePath}`)
  prompts.outro("Done.")
  return 0
}

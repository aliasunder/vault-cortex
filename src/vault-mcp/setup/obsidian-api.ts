/** Obsidian's account API, called the way the obsidian-headless CLI calls
 *  it: sign in (the `ob login` request) and list the account's vaults (the
 *  `ob sync-setup` lookup). The pinned CLI in obsidian-headless/ is the
 *  contract — re-verify both calls on every bump (AGENTS.md → Upgrading
 *  obsidian-headless). The npm CLI's get-sync-token command
 *  (cli/src/get-sync-token.ts) carries its own copy of the sign-in call; the
 *  two packages share no code. */

const REQUEST_TIMEOUT_MS = 30_000

/** Encryption scheme version the pinned Sync client supports — sent with
 *  the vault listing so each vault comes back with the key material that
 *  client understands. */
const SUPPORTED_ENCRYPTION_VERSION = 3

/** An error the API returned in its response body (HTTP 200 with an
 *  `error` field): a rejected password, a missing or wrong 2FA code. */
export class ObsidianApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ObsidianApiError"
  }
}

/** The API's answers about the code itself all start "2FA code …" — a
 *  first sign-in without one, or a wrong one. The email and password were
 *  accepted, so the sign-in is worth another code. The wording is the
 *  API's contract, read from the pinned CLI. */
export const isMfaCodeError = (error: unknown): error is ObsidianApiError =>
  error instanceof ObsidianApiError && error.message.includes("2FA code")

/** "2FA code is incorrect" is a wrong code, not a request for one. */
export const isMfaRequiredError = (error: unknown): boolean =>
  isMfaCodeError(error) && !error.message.includes("2FA code is incorrect")

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const postJson = async ({
  apiBaseUrl,
  path,
  body,
  headers = {},
}: {
  apiBaseUrl: string
  path: string
  body: Record<string, unknown>
  headers?: Record<string, string>
}): Promise<Record<string, unknown>> => {
  const response = await fetch(new URL(path, apiBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Obsidian API answered HTTP ${response.status}`)
  }
  const parsed: unknown = await response.json()
  if (!isJsonObject(parsed)) {
    throw new Error("Obsidian API response is not a JSON object")
  }
  if (typeof parsed.error === "string") throw new ObsidianApiError(parsed.error)
  return parsed
}

export type SignInResult = {
  /** The OBSIDIAN_AUTH_TOKEN value. */
  token: string
  /** The account's display name, or the email when the API sends none. */
  accountName: string
}

const signIn = async ({
  apiBaseUrl,
  email,
  password,
  mfa,
}: {
  apiBaseUrl: string
  email: string
  password: string
  /** Empty on the first attempt; the API then says whether a code is needed. */
  mfa: string
}): Promise<SignInResult> => {
  const body = await postJson({
    apiBaseUrl,
    path: "/user/signin",
    body: { email, password, mfa },
    // The API rejects the sign-in without this origin.
    headers: { Origin: "https://obsidian.md" },
  })
  if (typeof body.token !== "string" || !body.token) {
    throw new Error("Obsidian API sign-in response carries no token")
  }
  const accountName = typeof body.name === "string" ? body.name : email
  return { token: body.token, accountName }
}

type RemoteVault = {
  name: string
  /** End-to-end encrypted: the listing carries no `password` for the vault,
   *  so `ob sync-setup` needs VAULT_PASSWORD. */
  encrypted: boolean
}

const remoteVaultsOf = (entries: unknown): RemoteVault[] => {
  if (!Array.isArray(entries)) return []
  return entries.filter(isJsonObject).flatMap((entry) => {
    if (typeof entry.name !== "string") return []
    return [{ name: entry.name, encrypted: typeof entry.password !== "string" }]
  })
}

/** Every vault the token can sync — the account's own and those shared
 *  with it, the same set `ob sync-setup` searches by name. */
const listVaults = async ({
  apiBaseUrl,
  token,
}: {
  apiBaseUrl: string
  token: string
}): Promise<RemoteVault[]> => {
  const body = await postJson({
    apiBaseUrl,
    path: "/vault/list",
    body: { token, supported_encryption_version: SUPPORTED_ENCRYPTION_VERSION },
  })
  return [...remoteVaultsOf(body.vaults), ...remoteVaultsOf(body.shared)]
}

/** Message for a failed call, safe to show the user: the API's own error
 *  text when it answered, otherwise a generic reachability line — no URLs
 *  or stack detail. */
export const describeApiFailure = (error: unknown): string => {
  if (error instanceof ObsidianApiError) return error.message
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Obsidian's servers did not answer in time — try again."
  }
  // The bare message, not describeError's "[Name]: message" log form —
  // this string is shown on the page.
  const reason = error instanceof Error ? error.message : String(error)
  return `Could not reach Obsidian's servers (${reason}).`
}

export const obsidianApi = { signIn, listVaults }

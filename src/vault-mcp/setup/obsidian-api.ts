/** Obsidian's account API, called the way the obsidian-headless CLI calls
 *  it: sign in (the `ob login` request), list the account's vaults, and
 *  check a vault key (the two `ob sync-setup` calls). The pinned CLI in
 *  obsidian-headless/ is the contract — re-verify every call on every bump
 *  (AGENTS.md → Upgrading obsidian-headless). The npm CLI's get-sync-token
 *  command (cli/src/get-sync-token.ts) carries its own copy of the sign-in
 *  call; the two packages share no code. */

import {
  NEWEST_SUPPORTED_ENCRYPTION_VERSION,
  isSupportedEncryptionVersion,
} from "./vault-key.js"
import type { SupportedEncryptionVersion } from "./vault-key.js"

const REQUEST_TIMEOUT_MS = 30_000

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
  /** The email the user signed in with — shown back on the page. */
  accountEmail: string
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
  return { token: body.token, accountEmail: email }
}

/** What `ob sync-setup` needs from the listing to check a vault password:
 *  the salt the key is derived from, and the vault id, host, and scheme
 *  version the access check is sent with. */
type VaultKeyMaterial = {
  vaultId: string
  salt: string
  host: string
  encryptionVersion: SupportedEncryptionVersion
}

/** Whether this server can derive the vault's key at all — `ob sync-setup`
 *  fails the same way on the next boot when it cannot. */
export type VaultKeyStatus =
  | { kind: "derivable"; material: VaultKeyMaterial }
  /** The vault uses an encryption scheme newer than the pinned Sync client. */
  | { kind: "unsupported-version"; encryptionVersion: number | undefined }
  /** The listing entry lacks a field the check needs. */
  | { kind: "incomplete-listing" }

export type RemoteVault =
  | { name: string; encrypted: false }
  /** End-to-end encrypted: `ob sync-setup` needs VAULT_PASSWORD. */
  | { name: string; encrypted: true; key: VaultKeyStatus }

const keyStatusOf = (entry: Record<string, unknown>): VaultKeyStatus => {
  const { id, salt, host, encryption_version } = entry
  if (typeof id !== "string" || typeof salt !== "string") {
    return { kind: "incomplete-listing" }
  }
  if (typeof host !== "string") return { kind: "incomplete-listing" }
  if (!isSupportedEncryptionVersion(encryption_version)) {
    return {
      kind: "unsupported-version",
      encryptionVersion:
        typeof encryption_version === "number" ? encryption_version : undefined,
    }
  }
  return {
    kind: "derivable",
    material: {
      vaultId: id,
      salt,
      host,
      encryptionVersion: encryption_version,
    },
  }
}

const remoteVaultsOf = (entries: unknown): RemoteVault[] => {
  if (!Array.isArray(entries)) return []
  return entries.filter(isJsonObject).flatMap((entry): RemoteVault[] => {
    if (typeof entry.name !== "string") return []
    // Same test as `ob sync-setup`: the API sends `password: ""` (not an
    // absent field) for an end-to-end encrypted vault.
    if (entry.password) return [{ name: entry.name, encrypted: false }]
    return [{ name: entry.name, encrypted: true, key: keyStatusOf(entry) }]
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
    // Sent so each vault comes back with the key material this client
    // understands.
    body: {
      token,
      supported_encryption_version: NEWEST_SUPPORTED_ENCRYPTION_VERSION,
    },
  })
  return [...remoteVaultsOf(body.vaults), ...remoteVaultsOf(body.shared)]
}

/** The check `ob sync-setup` makes before it configures a vault: Obsidian
 *  compares the key hash with the vault's. Rejection arrives as an
 *  ObsidianApiError carrying the API's text; the hash is a verifier for
 *  the vault password and is never logged. */
const validateVaultKey = async ({
  apiBaseUrl,
  token,
  keyMaterial,
  keyHash,
}: {
  apiBaseUrl: string
  token: string
  keyMaterial: VaultKeyMaterial
  keyHash: string
}): Promise<void> => {
  await postJson({
    apiBaseUrl,
    path: "/vault/access",
    body: {
      token,
      vault_uid: keyMaterial.vaultId,
      keyhash: keyHash,
      host: keyMaterial.host,
      encryption_version: keyMaterial.encryptionVersion,
    },
  })
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

export const obsidianApi = { signIn, listVaults, validateVaultKey }

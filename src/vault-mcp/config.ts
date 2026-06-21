/** Centralized config — reads env vars once, validates, exports typed config. */

import { z } from "zod"
import envVar from "env-var"

// ── Validation ─────────────────────────────────────────────────

/** Validates a vault folder name: non-empty, no traversal, no absolute paths.
 *  Trims whitespace and strips trailing slashes for consistency. */
const vaultFolderName = z
  .string()
  .min(1, "folder name cannot be empty")
  // Strip leading/trailing whitespace and any trailing path separators
  .transform((value) => value.trim().replace(/\/+$/, ""))
  .pipe(
    z
      .string()
      .refine((value) => value.length > 0, "folder name cannot be blank")
      .refine(
        (value) => !value.includes(".."),
        "path traversal (..) not allowed",
      )
      .refine((value) => !value.startsWith("/"), "absolute paths not allowed"),
  )

/** Splits a comma-separated string into an array of folder names.
 *  Trims each entry; empty entries (from trailing commas) are filtered out. */
const splitCommaSeparatedFolders = (raw: string): string[] =>
  raw.split(",").reduce<string[]>((acc, entry) => {
    const trimmed = entry.trim()
    if (trimmed.length > 0) acc.push(trimmed)
    return acc
  }, [])

// ── Config type ────────────────────────────────────────────────

export type VaultConfig = Readonly<{
  memoryDir: string
  protectedPaths: readonly string[]
  orphanExcludeFolders: readonly string[]
  serviceDocumentationUrl: string
  /** "Windows mode": the vault is bind-mounted from a Windows drive into Docker
   *  Desktop, so it crosses the Docker Desktop ↔ WSL2 bridge. Enables filesystem
   *  polling for the watcher (inotify doesn't cross the bridge) and a
   *  rename-based exclusive write for moves (hard links aren't supported there).
   *  Set via WINDOWS_MODE; safe to leave on for any Windows setup. */
  windowsBindMount: boolean
}>

// ── Loader ─────────────────────────────────────────────────────

/** Loads and validates config from env vars. Pass a custom env record
 *  for testing — defaults to process.env when omitted. */
export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
): VaultConfig => {
  const memoryDirRaw = env.MEMORY_DIR?.trim()
  const memoryDir = memoryDirRaw
    ? vaultFolderName.parse(memoryDirRaw)
    : "About Me"

  const protectedPathsRaw = env.PROTECTED_PATHS?.trim()
  const protectedPaths = protectedPathsRaw
    ? splitCommaSeparatedFolders(protectedPathsRaw).map((folder) =>
        vaultFolderName.parse(folder),
      )
    : [memoryDir, "Daily Notes"]

  const orphanExcludeFolders = env.ORPHAN_EXCLUDE_FOLDERS?.trim()
    ? splitCommaSeparatedFolders(env.ORPHAN_EXCLUDE_FOLDERS.trim()).map(
        (folder) => vaultFolderName.parse(folder),
      )
    : ["Daily Notes", "Templates", memoryDir]

  const serviceDocumentationUrl = env.SERVICE_DOCUMENTATION_URL?.trim()
    ? z.string().url().parse(env.SERVICE_DOCUMENTATION_URL.trim())
    : "https://github.com/aliasunder/vault-cortex"

  // env-var's .asBool() parses true/false/1/0 and fails fast on anything else.
  const windowsBindMount = envVar
    .from(env)
    .get("WINDOWS_MODE")
    .default("false")
    .asBool()

  return Object.freeze({
    memoryDir,
    protectedPaths,
    orphanExcludeFolders,
    serviceDocumentationUrl,
    windowsBindMount,
  })
}

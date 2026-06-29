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
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

// ── Config type ────────────────────────────────────────────────

export type VaultConfig = Readonly<{
  /** When false, the memory layer is fully disabled — bootstrap is skipped,
   *  memory tools are hidden, and server metadata omits memory references. */
  memoryEnabled: boolean
  memoryDir: string
  protectedPaths: readonly string[]
  orphanExcludeFolders: readonly string[]
  serviceDocumentationUrl: string
  /** When true, the embedding pipeline is active — notes are chunked, embedded
   *  via a local ONNX model (bge-small-en-v1.5), and stored in sqlite-vec for
   *  vector search. When false, no model is loaded, no vector tables are created,
   *  and search uses FTS5 only. */
  embeddingEnabled: boolean
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
  const memoryEnabled = envVar
    .from(env)
    .get("MEMORY_ENABLED")
    .default("true")
    .asBool()

  const embeddingEnabled = envVar
    .from(env)
    .get("EMBEDDING_ENABLED")
    .default("true")
    .asBool()

  const windowsBindMount = envVar
    .from(env)
    .get("WINDOWS_MODE")
    .default("false")
    .asBool()

  return Object.freeze({
    memoryEnabled,
    memoryDir,
    protectedPaths,
    orphanExcludeFolders,
    serviceDocumentationUrl,
    embeddingEnabled,
    windowsBindMount,
  })
}

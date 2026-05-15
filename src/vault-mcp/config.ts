/** Centralized config — reads env vars once, validates, exports typed config. */

import { z } from "zod"

// ── Validation ─────────────────────────────────────────────────

/** Validates a vault folder name: non-empty, no traversal, no absolute paths.
 *  Trims whitespace and strips trailing slashes for consistency. */
const vaultFolderName = z
  .string()
  .min(1, "folder name cannot be empty")
  .transform((s) => s.trim().replace(/\/+$/, ""))
  .pipe(
    z
      .string()
      .refine((s) => s.length > 0, "folder name cannot be blank")
      .refine((s) => !s.includes(".."), "path traversal (..) not allowed")
      .refine((s) => !s.startsWith("/"), "absolute paths not allowed"),
  )

/** Splits a comma-separated string into an array of validated folder names.
 *  Empty entries (from trailing commas) are filtered out. */
const parseCommaSeparated = (raw: string): string[] =>
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
    ? parseCommaSeparated(protectedPathsRaw).map((folder) =>
        vaultFolderName.parse(folder),
      )
    : [memoryDir, "Daily Notes"]

  const orphanExcludeFoldersRaw = env.ORPHAN_EXCLUDE_FOLDERS?.trim()
  const orphanExcludeFolders = orphanExcludeFoldersRaw
    ? parseCommaSeparated(orphanExcludeFoldersRaw).map((folder) =>
        vaultFolderName.parse(folder),
      )
    : ["Daily Notes", "Templates", memoryDir]

  const serviceDocUrlRaw = env.SERVICE_DOCUMENTATION_URL?.trim()
  const serviceDocumentationUrl = serviceDocUrlRaw
    ? z.string().url().parse(serviceDocUrlRaw)
    : "https://github.com/aliasunder/vault-cortex"

  return Object.freeze({
    memoryDir,
    protectedPaths,
    orphanExcludeFolders,
    serviceDocumentationUrl,
  })
}

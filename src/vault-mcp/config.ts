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
  /** When false, file tools (vault_read_file, vault_list_files) are hidden —
   *  tool registration is skipped and server metadata omits file tool
   *  references. File config vars are still parsed when disabled. */
  fileToolsEnabled: boolean
  memoryDir: string
  protectedPaths: readonly string[]
  orphanExcludeFolders: readonly string[]
  serviceDocumentationUrl: string
  /** When true, the embedding pipeline is active — notes are chunked, embedded
   *  via a local ONNX model (bge-small-en-v1.5), and stored in sqlite-vec for
   *  vector search. When false, no model is loaded, no vector tables are created,
   *  and search uses FTS5 only. */
  embeddingEnabled: boolean
  /** Controls cross-encoder reranking after RRF fusion in hybrid search.
   *  "blended" applies position-aware score blending (~200ms added latency).
   *  "none" skips reranking entirely — no model download, RRF-only ordering.
   *  Only takes effect when embeddingEnabled is true. */
  rerankMode: "none" | "blended"
  /** "Windows mode": the vault is bind-mounted from a Windows drive into Docker
   *  Desktop, so it crosses the Docker Desktop ↔ WSL2 bridge. Enables filesystem
   *  polling for the watcher (inotify doesn't cross the bridge) and a
   *  rename-based exclusive write for moves (hard links aren't supported there).
   *  Set via WINDOWS_MODE; safe to leave on for any Windows setup. */
  windowsBindMount: boolean
  /** Per-read byte cap for vault_read_file — files larger than this are
   *  rejected before reading (memory guard). Set via MAX_FILE_BYTES. */
  maxFileBytes: number
  /** Byte budget for image output after downscale/recompress, in binary bytes
   *  BEFORE base64 encoding. The default fits Claude Code's MCP output token
   *  cap (base64 expands ~4/3, then tokenizes at roughly 3 chars/token).
   *  Set via MAX_IMAGE_OUTPUT_BYTES; raise for clients with looser caps. */
  maxImageOutputBytes: number
  /** Maximum number of PDF pages to render as images when raw: true is set on
   *  vault_read_file. The per-page byte budget is maxImageOutputBytes divided
   *  evenly across the rendered pages. Set via MAX_PDF_RENDER_PAGES. */
  maxPdfRenderPages: number
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

  const fileToolsEnabled = envVar
    .from(env)
    .get("FILE_TOOLS_ENABLED")
    .default("true")
    .asBool()

  const embeddingEnabled = envVar
    .from(env)
    .get("EMBEDDING_ENABLED")
    .default("true")
    .asBool()

  const rerankMode = z
    .enum(["none", "blended"])
    .parse(envVar.from(env).get("RERANK_MODE").default("blended").asString())

  const windowsBindMount = envVar
    .from(env)
    .get("WINDOWS_MODE")
    .default("false")
    .asBool()

  // env-var's asIntPositive admits 0, but a zero byte cap would make every
  // file read fail at runtime — reject it at startup instead.
  const requireNonZero = (name: string, value: number): number => {
    if (value === 0) {
      throw new Error(`env-var: "${name}" must be greater than 0`)
    }
    return value
  }

  // 50 MiB — matches the most permissive prior art for MCP file reads.
  const maxFileBytes = requireNonZero(
    "MAX_FILE_BYTES",
    envVar.from(env).get("MAX_FILE_BYTES").default("52428800").asIntPositive(),
  )

  // 48 KiB binary ≈ 64 KiB base64 ≈ ~21k tokens — under Claude Code's 25k-token
  // MCP output cap with headroom for the metadata text block.
  const maxImageOutputBytes = requireNonZero(
    "MAX_IMAGE_OUTPUT_BYTES",
    envVar
      .from(env)
      .get("MAX_IMAGE_OUTPUT_BYTES")
      .default("49152")
      .asIntPositive(),
  )

  const maxPdfRenderPages = requireNonZero(
    "MAX_PDF_RENDER_PAGES",
    envVar.from(env).get("MAX_PDF_RENDER_PAGES").default("5").asIntPositive(),
  )

  return Object.freeze({
    memoryEnabled,
    fileToolsEnabled,
    memoryDir,
    protectedPaths,
    orphanExcludeFolders,
    serviceDocumentationUrl,
    embeddingEnabled,
    rerankMode,
    windowsBindMount,
    maxFileBytes,
    maxImageOutputBytes,
    maxPdfRenderPages,
  })
}

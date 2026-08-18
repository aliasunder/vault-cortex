/** Centralized config — reads env vars once, validates, exports typed config. */

import { z } from "zod"
import envVar from "env-var"
import { DateTime } from "luxon"
import {
  momentToLuxonFormat,
  findUnsupportedTokens,
} from "./obsidian-markdown/moment-format.js"
import { logger } from "../logger.js"
import { isToolName } from "./mcp-core/tool-registry.js"
import type { ToolName } from "./mcp-core/tool-registry.js"

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

/** Splits a comma-separated env value into its entries.
 *  Trims each entry; empty entries (from trailing commas) are filtered out. */
const splitCommaSeparatedValues = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

/** Validates a DAILY_NOTES_FORMAT value by probe-rendering a fixed date.
 *  Structural checks only — structurally unsafe results (traversal,
 *  separators, empty) are rejected. Warns when the format contains
 *  unsupported tokens. Returns the raw moment string unchanged. */
const validateDailyNotesFormat = (momentFormat: string): string => {
  const renderedProbe = DateTime.fromISO("2026-01-31").toFormat(
    momentToLuxonFormat(momentFormat),
  )
  if (renderedProbe.trim().length === 0) {
    throw new Error(
      `env-var: "DAILY_NOTES_FORMAT" renders to an empty filename`,
    )
  }
  if (momentFormat.includes("..") || renderedProbe.includes("..")) {
    throw new Error(
      `env-var: "DAILY_NOTES_FORMAT" must not contain path traversal (..)`,
    )
  }
  if (momentFormat.startsWith("/") || renderedProbe.startsWith("/")) {
    throw new Error(
      `env-var: "DAILY_NOTES_FORMAT" must not start with a path separator`,
    )
  }
  if (momentFormat.endsWith("/") || renderedProbe.endsWith("/")) {
    throw new Error(
      `env-var: "DAILY_NOTES_FORMAT" must not end with a path separator`,
    )
  }
  const unsupportedTokens = findUnsupportedTokens(momentFormat)
  if (unsupportedTokens.length > 0) {
    logger.warn(
      `DAILY_NOTES_FORMAT contains unsupported token(s): ${unsupportedTokens.join(", ")} — daily note lookups will fail; vault_get_daily_note will return an error until the format is changed`,
    )
  }
  return momentFormat
}

// ── Config type ────────────────────────────────────────────────

export type VaultConfig = Readonly<{
  /** When false, the memory layer is fully disabled — bootstrap is skipped,
   *  memory tools are hidden, and server metadata omits memory references. */
  memoryEnabled: boolean
  /** When false, file tools (vault_read_file, vault_list_files) are hidden —
   *  tool registration is skipped and server metadata omits file tool
   *  references. File config vars are still parsed when disabled. */
  fileToolsEnabled: boolean
  /** When true, the server is read-only: every tool that writes to the vault
   *  is hidden, the memory-review prompt is unregistered, memory bootstrap is
   *  skipped, and server metadata omits write references. Search-index and
   *  OAuth SQLite writes are unaffected — infrastructure, not vault writes.
   *  Set via READONLY_MODE. */
  readOnlyMode: boolean
  /** Individual tools hidden from registration — the per-tool escape hatch.
   *  Purely subtractive: it cannot re-enable a tool MEMORY_ENABLED,
   *  FILE_TOOLS_ENABLED, or READONLY_MODE already hides, and it has no
   *  effect on indexing, memory bootstrap, or the file watcher. Set via
   *  DISABLED_TOOLS (comma-separated tool names; unknown names fail the
   *  boot). */
  disabledTools: ReadonlySet<ToolName>
  memoryDir: string
  /** Sets the daily notes folder, taking precedence over
   *  .obsidian/daily-notes.json.
   *  Per-field precedence: env setting → daily-notes.json → fallback
   *  ("Daily Notes"). Set via DAILY_NOTES_FOLDER. */
  dailyNotesFolder?: string | undefined
  /** Sets the daily notes filename format (moment tokens, matching
   *  Obsidian's setting), taking precedence over .obsidian/daily-notes.json.
   *  Per-field precedence: env setting → daily-notes.json → fallback
   *  ("YYYY-MM-DD"). Set via DAILY_NOTES_FORMAT. */
  dailyNotesFormat?: string | undefined
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

  const dailyNotesFolderRaw = env.DAILY_NOTES_FOLDER?.trim()
  const dailyNotesFolder = dailyNotesFolderRaw
    ? vaultFolderName.parse(dailyNotesFolderRaw)
    : undefined

  const dailyNotesFormatRaw = env.DAILY_NOTES_FORMAT?.trim()
  const dailyNotesFormat = dailyNotesFormatRaw
    ? validateDailyNotesFormat(dailyNotesFormatRaw)
    : undefined

  // Smart defaults track the env-configured daily notes folder (the
  // vault's daily-notes.json can't cascade here — config load is
  // synchronous env parsing; the file is read lazily at call time).
  const dailyNotesFolderOrDefault = dailyNotesFolder ?? "Daily Notes"

  const protectedPathsRaw = env.PROTECTED_PATHS?.trim()
  const protectedPaths = protectedPathsRaw
    ? splitCommaSeparatedValues(protectedPathsRaw).map((folder) =>
        vaultFolderName.parse(folder),
      )
    : [memoryDir, dailyNotesFolderOrDefault]

  const orphanExcludeFolders = env.ORPHAN_EXCLUDE_FOLDERS?.trim()
    ? splitCommaSeparatedValues(env.ORPHAN_EXCLUDE_FOLDERS.trim()).map(
        (folder) => vaultFolderName.parse(folder),
      )
    : [dailyNotesFolderOrDefault, "Templates", memoryDir]

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

  const readOnlyMode = envVar
    .from(env)
    .get("READONLY_MODE")
    .default("false")
    .asBool()

  // Unknown names are rejected at boot: a typo that silently disabled
  // nothing would leave the operator believing a tool is off when it isn't.
  const disabledToolsRaw = env.DISABLED_TOOLS?.trim()
  const disabledToolEntries = disabledToolsRaw
    ? splitCommaSeparatedValues(disabledToolsRaw)
    : []
  const disabledTools: ReadonlySet<ToolName> = new Set(
    disabledToolEntries.map((toolName) => {
      if (!isToolName(toolName)) {
        throw new Error(
          `env-var: "DISABLED_TOOLS" contains an unknown tool name: "${toolName}"`,
        )
      }
      return toolName
    }),
  )

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
    readOnlyMode,
    disabledTools,
    memoryDir,
    dailyNotesFolder,
    dailyNotesFormat,
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

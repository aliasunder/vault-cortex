import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

export type Mode = "local" | "remote"

export type FileToWrite = {
  /** Filename inside the target directory (e.g. ".env"). */
  name: string
  content: string
  /** Unix permission bits for files holding secrets (e.g. 0o600 for .env). */
  mode?: number
}

export type FileWriteResult = {
  name: string
  status: "created" | "unchanged" | "overwritten" | "kept"
}

/** Default host port — matches the container's internal port. */
export const DEFAULT_PORT = 8000

/** Matches an active (uncommented) PORT line, with optional surrounding quotes. */
const ENV_PORT_LINE = /^PORT=["']?(\d+)["']?\s*$/m

/** Matches an active (uncommented) VAULT_PATH line in a .env file. */
const ENV_VAULT_PATH_LINE = /^VAULT_PATH=(.+)\s*$/m

/** Matches an active (uncommented) PUBLIC_URL line. */
const ENV_PUBLIC_URL_LINE = /^PUBLIC_URL=/m

/** Matches an active (uncommented) PUBLIC_URL line, capturing a non-empty value. */
const ENV_PUBLIC_URL_VALUE_LINE = /^PUBLIC_URL=(.+)\s*$/m

/** Matches an active (uncommented) OBSIDIAN_AUTH_TOKEN line. */
const OBSIDIAN_AUTH_TOKEN_LINE = /^OBSIDIAN_AUTH_TOKEN=/m

/** Matches an env line whose value is wrapped in matching quotes. */
const QUOTED_ENV_VALUE = /^([A-Za-z_][A-Za-z0-9_]*=)(["'])(.*)\2(\s*)$/gm

/**
 * Strips matching surrounding quotes from a value — `"foo"` → `foo`,
 * `'bar'` → `bar`, `unquoted` → `unquoted`. Only strips when the
 * opening and closing quote characters match.
 */
const stripSurroundingQuotes = (value: string): string => {
  const quoteMatch = /^(["'])(.*)\1$/.exec(value)
  return quoteMatch ? quoteMatch[2] : value
}

export const buildFilesToWrite = (envContent: string): FileToWrite[] => [
  // .env holds the bearer token (and possibly a vault password) — owner-only.
  { name: ".env", content: envContent, mode: 0o600 },
]

/**
 * Reads the host port from the .env that is actually on disk — which may be
 * a pre-existing file this run chose to keep, with a PORT override the
 * generated default doesn't have. Falls back to DEFAULT_PORT when the file
 * or an uncommented PORT line is absent.
 */
export const readEnvPort = (envFilePath: string): number => {
  if (!existsSync(envFilePath)) return DEFAULT_PORT
  const match = ENV_PORT_LINE.exec(readFileSync(envFilePath, "utf8"))
  return match ? Number(match[1]) : DEFAULT_PORT
}

/**
 * Reads the host vault path from a .env file. Returns undefined when the
 * file is missing or has no uncommented VAULT_PATH line.
 */
export const readEnvVaultPath = (envFilePath: string): string | undefined => {
  if (!existsSync(envFilePath)) return undefined
  const match = ENV_VAULT_PATH_LINE.exec(readFileSync(envFilePath, "utf8"))
  const rawValue = match?.[1].trim()
  return rawValue ? stripSurroundingQuotes(rawValue) : undefined
}

/**
 * Returns true when the .env file has an active (uncommented) PUBLIC_URL line.
 * It's the FALSE result that carries the signal: the old compose-based CLI's
 * generated .env never held a PUBLIC_URL line (the compose file's environment
 * defaults supplied it), so a local .env without one predates the docker-run
 * migration — callers use the negation to ask the user to add the line
 * instead of starting a server missing a required variable.
 */
export const hasEnvPublicUrl = (envFilePath: string): boolean => {
  if (!existsSync(envFilePath)) return false
  return ENV_PUBLIC_URL_LINE.test(readFileSync(envFilePath, "utf8"))
}

/**
 * Reads the public URL value from a .env file. Returns undefined when the
 * file is missing or has no uncommented, non-empty PUBLIC_URL line —
 * deliberately stricter than hasEnvPublicUrl, whose job is old-compose
 * detection and so matches an empty `PUBLIC_URL=` line too.
 */
export const readEnvPublicUrl = (envFilePath: string): string | undefined => {
  if (!existsSync(envFilePath)) return undefined
  const match = ENV_PUBLIC_URL_VALUE_LINE.exec(
    readFileSync(envFilePath, "utf8"),
  )
  // A whitespace-only line matches the regex and trims to "" — normalize to
  // undefined so the non-empty contract holds ("" is never a legitimate URL).
  const rawValue = match?.[1].trim()
  const unquotedValue = rawValue ? stripSurroundingQuotes(rawValue) : undefined
  // Strip trailing slashes (mirroring askPublicUrl's prompt-side
  // normalization): consumers append paths to this base, and a hand-edited
  // `https://host/` would otherwise print broken `//mcp` connect URLs.
  const normalizedPublicUrl = unquotedValue?.replace(/\/+$/, "")
  return normalizedPublicUrl || undefined
}

/**
 * Detects the deployment mode from a .env file. Remote mode requires
 * OBSIDIAN_AUTH_TOKEN (absent from local). Returns undefined when the
 * .env file does not exist.
 */
export const detectMode = (envFilePath: string): Mode | undefined => {
  if (!existsSync(envFilePath)) return undefined
  const content = readFileSync(envFilePath, "utf8")
  return OBSIDIAN_AUTH_TOKEN_LINE.test(content) ? "remote" : "local"
}

/**
 * Patches the OBSIDIAN_AUTH_TOKEN value in an existing .env file.
 * Returns true when the patch succeeded, false when the file is missing
 * or has no active OBSIDIAN_AUTH_TOKEN line (e.g. a local-mode .env).
 */
export const patchEnvObsidianToken = (
  envFilePath: string,
  token: string,
): boolean => {
  if (!existsSync(envFilePath)) return false
  const content = readFileSync(envFilePath, "utf8")
  /** Matches the full OBSIDIAN_AUTH_TOKEN line for replacement. */
  const fullTokenLine = /^OBSIDIAN_AUTH_TOKEN=.*$/m
  if (!fullTokenLine.test(content)) return false
  // Function replacement avoids $ pattern interpretation ($&, $', etc.)
  // that String.prototype.replace applies to string replacements.
  const patched = content.replace(
    fullTokenLine,
    () => `OBSIDIAN_AUTH_TOKEN=${token}`,
  )
  writeFileSync(envFilePath, patched)
  return true
}

/**
 * Strips surrounding quotes from env values in the file. `docker run
 * --env-file` passes quotes literally (`VAULT_NAME="My Vault"` becomes
 * the value `"My Vault"` with embedded quotes), while Compose strips
 * them. Removing quotes makes the file work correctly for both paths.
 * Returns true when the file was modified.
 */
export const stripEnvQuotedValues = (envFilePath: string): boolean => {
  if (!existsSync(envFilePath)) return false
  const content = readFileSync(envFilePath, "utf8")
  // Reset lastIndex — the /g flag makes the regex stateful.
  QUOTED_ENV_VALUE.lastIndex = 0
  const sanitized = content.replace(QUOTED_ENV_VALUE, "$1$3$4")
  if (sanitized === content) return false
  writeFileSync(envFilePath, sanitized)
  return true
}

/**
 * Writes the files into targetDir (created if missing). Existing files
 * are never overwritten silently: identical content is skipped, and differing
 * content defers to the resolveConflict callback (interactive prompt, or a
 * constant `false` in non-interactive mode).
 */
export const writeFiles = async (
  params: { targetDir: string; files: FileToWrite[] },
  resolveConflict: (name: string) => Promise<boolean>,
): Promise<FileWriteResult[]> => {
  const { targetDir, files } = params
  mkdirSync(targetDir, { recursive: true })

  const results: FileWriteResult[] = []
  for (const file of files) {
    const filePath = join(targetDir, file.name)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, file.content, { mode: file.mode })
      results.push({ name: file.name, status: "created" })
      continue
    }
    if (readFileSync(filePath, "utf8") === file.content) {
      results.push({ name: file.name, status: "unchanged" })
      continue
    }
    const overwrite = await resolveConflict(file.name)
    if (!overwrite) {
      results.push({ name: file.name, status: "kept" })
      continue
    }
    // writeFileSync's mode only applies on creation — tighten explicitly
    // when replacing an existing file.
    writeFileSync(filePath, file.content)
    if (file.mode !== undefined) chmodSync(filePath, file.mode)
    results.push({ name: file.name, status: "overwritten" })
  }
  return results
}

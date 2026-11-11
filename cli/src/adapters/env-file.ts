import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type FileToWrite = {
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

/** Matches an active (uncommented) OBSIDIAN_AUTH_TOKEN line. */
const OBSIDIAN_AUTH_TOKEN_LINE = /^OBSIDIAN_AUTH_TOKEN=/m

/** Matches every full OBSIDIAN_AUTH_TOKEN line for replacement. */
const EVERY_OBSIDIAN_AUTH_TOKEN_LINE = /^OBSIDIAN_AUTH_TOKEN=.*$/gm

/** Matches an env line whose value is wrapped in matching quotes. */
const QUOTED_ENV_VALUE = /^([A-Za-z_][A-Za-z0-9_]*=)(["'])(.*)\2(\s*)$/gm

/** The file's text, or undefined when it does not exist. */
const read = (envFilePath: string): string | undefined => {
  if (!existsSync(envFilePath)) return undefined
  return readFileSync(envFilePath, "utf8")
}

const buildFilesToWrite = (envContent: string): FileToWrite[] => [
  // .env holds the bearer token (and possibly a vault password) — owner-only.
  { name: ".env", content: envContent, mode: 0o600 },
]

/**
 * Patches every active OBSIDIAN_AUTH_TOKEN line in an existing .env, since
 * `docker run --env-file` lets the last duplicate win. Returns false when the
 * file is missing or has no active line (e.g. a local-mode .env).
 */
const patchObsidianToken = (envFilePath: string, token: string): boolean => {
  const content = read(envFilePath)

  if (!content || !OBSIDIAN_AUTH_TOKEN_LINE.test(content)) return false
  // Function replacement avoids $ pattern interpretation ($&, $', etc.)
  // that String.prototype.replace applies to string replacements.
  const patched = content.replace(
    EVERY_OBSIDIAN_AUTH_TOKEN_LINE,
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
const stripQuotedValues = (envFilePath: string): boolean => {
  const content = read(envFilePath)

  if (!content) return false
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
const writeFiles = async (
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

/** Reads and writes a deployment's .env file; parseEnvValues in env-values.ts parses what read returns. */
export const envFile = {
  read,
  buildFilesToWrite,
  patchObsidianToken,
  stripQuotedValues,
  writeFiles,
}

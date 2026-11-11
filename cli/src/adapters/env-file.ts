import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type EnvWriteStatus = "created" | "unchanged" | "overwritten" | "kept"

/** .env holds the bearer token (and possibly a vault password), so only its owner may read it. */
const ENV_FILE_MODE = 0o600

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

/** Replaces an existing .env's text; the file keeps its permissions. */
const replace = (envFilePath: string, envContent: string): void => {
  writeFileSync(envFilePath, envContent)
}

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
 * Writes .env into targetDir (created if missing), readable by its owner
 * only. An existing .env is never overwritten silently: identical content is
 * skipped, and differing content defers to the resolveConflict callback
 * (interactive prompt, or a constant `false` in non-interactive mode).
 */
const write = async (
  params: { targetDir: string; envContent: string },
  resolveConflict: () => Promise<boolean>,
): Promise<EnvWriteStatus> => {
  const { targetDir, envContent } = params
  mkdirSync(targetDir, { recursive: true })
  const envFilePath = join(targetDir, ".env")

  if (!existsSync(envFilePath)) {
    writeFileSync(envFilePath, envContent, { mode: ENV_FILE_MODE })
    return "created"
  }
  if (readFileSync(envFilePath, "utf8") === envContent) return "unchanged"
  const overwrite = await resolveConflict()

  if (!overwrite) return "kept"
  // writeFileSync's mode only applies on creation — tighten explicitly
  // when replacing an existing file.
  writeFileSync(envFilePath, envContent)
  chmodSync(envFilePath, ENV_FILE_MODE)
  return "overwritten"
}

/** Reads and writes a deployment's .env file; parseEnvValues in env-values.ts parses what read returns. */
export const envFile = {
  read,
  replace,
  patchObsidianToken,
  stripQuotedValues,
  write,
}

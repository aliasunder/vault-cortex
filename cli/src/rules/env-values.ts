import type { Mode } from "../adapters/docker.js"
import { DEFAULT_PORT, describeInvalidEnvPort, isValidPort } from "./ports.js"

/**
 * The value of each variable's last active (uncommented) line in a .env
 * file, trimmed but still quoted. The last line wins because
 * `docker run --env-file` lets the last duplicate win, even an empty one.
 */
export type EnvValues = ReadonlyMap<string, string>

/** Matches every active (uncommented) assignment line, capturing the name and the raw value. */
const ENV_ASSIGNMENT_LINES = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm

/** Matches a value wrapped in one pair of matching quotes, capturing the inside. */
const SURROUNDING_QUOTES = /^(["'])(.*)\1$/

/**
 * Used when .env sets no INSTANCE_NAME: the container name and volume prefix
 * every install had before the setting existed, so those installs keep their data.
 */
export const DEFAULT_INSTANCE_NAME = "vault-cortex"

/**
 * Compose's project-name rule plus Docker's two-character minimum for container
 * names, so the container, the Compose project and the volume prefix are one string.
 */
const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]+$/

export const parseEnvValues = (envContent: string): EnvValues => {
  const assignments = [...envContent.matchAll(ENV_ASSIGNMENT_LINES)]
  // A later duplicate replaces an earlier one in the Map, so the last line wins.
  return new Map(assignments.map(([, name, rawValue]) => [name, rawValue.trim()]))
}

/**
 * Strips matching surrounding quotes from a value — `"foo"` → `foo`,
 * `'bar'` → `bar`, `unquoted` → `unquoted`. Only strips when the
 * opening and closing quote characters match.
 */
const stripSurroundingQuotes = (value: string): string => {
  const quoteMatch = SURROUNDING_QUOTES.exec(value)
  return quoteMatch ? quoteMatch[2] : value
}

/**
 * A variable's value without one pair of surrounding quotes, as
 * envFile.stripQuotedValues leaves it before docker run. A commented-out or
 * missing line returns undefined, which means the server uses its built-in
 * default; an empty line returns "".
 */
export const readEnvValue = (envValues: EnvValues, name: string): string | undefined => {
  const rawValue = envValues.get(name)
  return rawValue && stripSurroundingQuotes(rawValue)
}

export type PortRead = { kind: "ok"; port: number } | { kind: "invalid"; message: string }

/**
 * Reads the host port:
 * - a missing line or empty value means DEFAULT_PORT;
 * - any other value that is not a port is reported, never corrected, because
 *   the CLI would map one port while PUBLIC_URL names another.
 */
export const readEnvPort = (envValues: EnvValues): PortRead => {
  const portValue = readEnvValue(envValues, "PORT")

  if (!portValue) return { kind: "ok", port: DEFAULT_PORT }
  if (!isValidPort(portValue)) {
    return { kind: "invalid", message: describeInvalidEnvPort(portValue) }
  }
  return { kind: "ok", port: Number(portValue) }
}

/** Returns why a candidate instance name is invalid, or undefined when it is valid. */
export const describeInvalidInstanceName = (candidateName: string): string | undefined => {
  if (INSTANCE_NAME_PATTERN.test(candidateName)) return undefined
  return `"${candidateName}" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit.`
}

export type InstanceNameRead =
  { kind: "ok"; instanceName: string } | { kind: "invalid"; message: string }

/**
 * Reads INSTANCE_NAME:
 * - a missing line or empty value means DEFAULT_INSTANCE_NAME;
 * - an invalid value is reported, never corrected, because the name decides
 *   which volumes hold the install's data.
 */
export const readEnvInstanceName = (envValues: EnvValues): InstanceNameRead => {
  const instanceName = readEnvValue(envValues, "INSTANCE_NAME")

  if (!instanceName) return { kind: "ok", instanceName: DEFAULT_INSTANCE_NAME }
  const invalidReason = describeInvalidInstanceName(instanceName)

  if (invalidReason) return { kind: "invalid", message: `INSTANCE_NAME ${invalidReason}` }
  return { kind: "ok", instanceName }
}

/** Reads the host vault path; undefined when the line is missing or empty. */
export const readEnvVaultPath = (envValues: EnvValues): string | undefined => {
  return readEnvValue(envValues, "VAULT_PATH") || undefined
}

/**
 * Reads the public URL. Returns undefined when the line is missing or empty,
 * which is how start spots a .env the server would refuse (including one
 * from the old compose-based CLI, which never wrote the line).
 */
export const readEnvPublicUrl = (envValues: EnvValues): string | undefined => {
  // A whitespace-only value, quoted or not, counts as empty, as it does in
  // the server's check of the required variable.
  const unquotedValue = readEnvValue(envValues, "PUBLIC_URL")?.trim()
  // Strip trailing slashes (mirroring askPublicUrl's prompt-side
  // normalization): consumers append paths to this base, and a hand-edited
  // `https://host/` would otherwise print broken `//mcp` connect URLs.
  const normalizedPublicUrl = unquotedValue?.replace(/\/+$/, "")
  return normalizedPublicUrl || undefined
}

/** Remote mode requires an OBSIDIAN_AUTH_TOKEN line, even an empty one; local has none. */
export const detectMode = (envValues: EnvValues): Mode => {
  return envValues.has("OBSIDIAN_AUTH_TOKEN") ? "remote" : "local"
}

/**
 * Reads the OBSIDIAN_AUTH_TOKEN value. Returns undefined when the line is
 * missing or the value is empty — `OBSIDIAN_AUTH_TOKEN=""` included, since
 * the CLI strips quotes before docker run. Quotes stay in a returned value,
 * because init writes it back into the regenerated .env.
 */
export const readEnvObsidianToken = (envValues: EnvValues): string | undefined => {
  const rawValue = envValues.get("OBSIDIAN_AUTH_TOKEN")
  const unquotedValue = rawValue ? stripSurroundingQuotes(rawValue).trim() : ""

  return unquotedValue ? rawValue : undefined
}

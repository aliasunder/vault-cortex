import { parseEnvValues, readEnvValue } from "./env-values.js"
import { DEFAULT_PORT, isValidPort } from "./ports.js"

/** The .env values that tell one install on a machine apart from another. */
export type InstanceIdentity = {
  /**
   * Read from the folder's existing .env, without surrounding quotes, when
   * init runs again over it.
   */
  carried: Record<string, string>
  /**
   * Chosen in this run, by flag or prompt. A `http://localhost:<port>`
   * PUBLIC_URL follows a chosen PORT.
   */
  chosen: Record<string, string>
}

/** Matches the full active (uncommented) assignment line for a var. */
const activeLinePattern = (name: string): RegExp => new RegExp(`^${name}=.*$`, "m")

/** Matches the full commented-out assignment line (`# VAR=...`) for a var. */
const commentedLinePattern = (name: string): RegExp => new RegExp(`^# ${name}=.*$`, "m")

/**
 * Applies chosen values to .env content as a pure text transform: every
 * active line for the var is replaced (docker --env-file gives the last
 * duplicate precedence, so a single-line replace could leave a stale
 * duplicate winning), a commented-out line is uncommented and replaced, and
 * a var with no line at all (a .env predating the setting) is appended —
 * the chosen value must land in the file, never be silently dropped.
 */
export const applyOptionalSettings = (
  envContent: string,
  overrides: Record<string, string>,
): string =>
  Object.entries(overrides).reduce((content, [name, value]) => {
    // Fresh RegExp per use (the /g flag makes instances stateful via
    // lastIndex); function replacements avoid $-pattern interpretation in
    // values, same as envFile.patchObsidianToken.
    const everyActiveLine = new RegExp(`^${name}=.*$`, "gm")

    if (activeLinePattern(name).test(content)) {
      return content.replace(everyActiveLine, () => `${name}=${value}`)
    }
    if (commentedLinePattern(name).test(content)) {
      return content.replace(commentedLinePattern(name), () => `${name}=${value}`)
    }
    return `${content.trimEnd()}\n\n${name}=${value}\n`
  }, envContent)

/**
 * A PORT override moves the server, and the local quickstart derives
 * PUBLIC_URL (the OAuth issuer) from that port. When the current PUBLIC_URL
 * is exactly the derived http://localhost:<current port> form, it follows
 * the new port — otherwise the advertised OAuth discovery endpoints would
 * point at a port nothing listens on. A custom PUBLIC_URL (reverse proxy,
 * remote domain) is the user's own and is never touched.
 */
export const withPublicUrlOverride = (params: {
  overrides: Record<string, string>
  envContent: string
}): Record<string, string> => {
  const { overrides, envContent } = params
  const newPort = overrides.PORT

  if (!newPort) return overrides
  const envValues = parseEnvValues(envContent)
  // An empty PORT= line leaves the default port in effect, as readEnvPort reads it.
  const currentPort = readEnvValue(envValues, "PORT") || String(DEFAULT_PORT)
  const currentPublicUrl = readEnvValue(envValues, "PUBLIC_URL")
  // A generated .env starts with PUBLIC_URL=http://localhost:8000, the default
  // port. When PORT was edited into a value that isn't a port, such as
  // PORT=abc, a URL that still names the default port follows the new port too.
  const followedPorts = isValidPort(currentPort)
    ? [currentPort]
    : [currentPort, String(DEFAULT_PORT)]
  const publicUrlFollowsPort = followedPorts.some(
    (followedPort) => currentPublicUrl === `http://localhost:${followedPort}`,
  )

  if (!publicUrlFollowsPort) return overrides
  return { ...overrides, PUBLIC_URL: `http://localhost:${newPort}` }
}

/**
 * Warns about a picked PORT change that left PUBLIC_URL as it was:
 * withPublicUrlOverride never rewrites a custom URL, so it may still name
 * the old port. Returns undefined when there is nothing to warn about.
 */
export const describeStrandedPublicUrl = (params: {
  envContent: string
  pickedOverrides: Record<string, string>
  appliedOverrides: Record<string, string>
}): string | undefined => {
  const { envContent, pickedOverrides, appliedOverrides } = params
  const envValues = parseEnvValues(envContent)
  const currentPublicUrl = readEnvValue(envValues, "PUBLIC_URL")

  // Picking PORT and accepting its pre-filled current value changes nothing.
  const currentPort = readEnvValue(envValues, "PORT") || String(DEFAULT_PORT)
  const portChanged = Boolean(pickedOverrides.PORT) && pickedOverrides.PORT !== currentPort

  if (!portChanged || appliedOverrides.PUBLIC_URL || !currentPublicUrl) return undefined
  // A localhost URL that already names the new port still reaches the server.
  const publicUrlNamesNewPort = currentPublicUrl === `http://localhost:${pickedOverrides.PORT}`

  if (publicUrlNamesNewPort) return undefined
  return `PORT changed — make sure PUBLIC_URL (${currentPublicUrl}) still reaches the server.`
}

/**
 * Writes the identity into freshly generated .env content, before the
 * optional-settings chooser reads it, so the chooser shows the identity's port
 * as current. A `http://localhost:<port>` PUBLIC_URL follows a carried or a
 * chosen port; a carried PUBLIC_URL is the user's own and lands verbatim.
 */
export const applyInstanceIdentity = (envContent: string, identity: InstanceIdentity): string => {
  const carriedSettings = identity.carried.PUBLIC_URL
    ? identity.carried
    : withPublicUrlOverride({ overrides: identity.carried, envContent })
  const withCarried = applyOptionalSettings(envContent, carriedSettings)
  const chosenSettings = withPublicUrlOverride({
    overrides: identity.chosen,
    envContent: withCarried,
  })
  return applyOptionalSettings(withCarried, chosenSettings)
}

/**
 * Warns when --port changes a re-run's port but its carried PUBLIC_URL stays:
 * applyInstanceIdentity moves only a `http://localhost:<port>` URL, never a
 * custom one. Returns undefined when there is nothing to warn about.
 */
export const describeStrandedCarriedPublicUrl = (
  envContent: string,
  identity: InstanceIdentity,
): string | undefined => {
  if (!identity.carried.PUBLIC_URL) return undefined
  const withCarried = applyOptionalSettings(envContent, identity.carried)

  return describeStrandedPublicUrl({
    envContent: withCarried,
    pickedOverrides: identity.chosen,
    appliedOverrides: withPublicUrlOverride({
      overrides: identity.chosen,
      envContent: withCarried,
    }),
  })
}

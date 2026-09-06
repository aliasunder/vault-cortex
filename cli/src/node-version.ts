/** Matches the first dotted version number in an engines range like ">=22.12.0". */
const VERSION_IN_RANGE = /(\d+)\.(\d+)(?:\.(\d+))?/

/**
 * Extracts the minimum version from a simple engines range (">=22.12.0").
 * The CLI only ever declares a floor, so the first version in the string
 * is the minimum.
 */
export const minimumNodeVersion = (enginesRange: string): string => {
  const match = VERSION_IN_RANGE.exec(enginesRange)
  if (!match) throw new Error(`Cannot parse engines range: ${enginesRange}`)
  const [, major, minor, patch] = match
  return `${major}.${minor}.${patch ?? "0"}`
}

/**
 * The refusal printed when the running Node is below the engines floor.
 * Lives in this zero-import module so bin.ts can build it before any
 * dependency-laden import runs on an unsupported runtime.
 */
export const nodeVersionRefusalMessage = ({
  minimum,
  current,
}: {
  minimum: string
  current: string
}): string => {
  return (
    `vault-cortex requires Node.js >= ${minimum} (you have ${current}).\n` +
    `Upgrade at https://nodejs.org — or use a no-Node manual setup:\n` +
    `  local:  https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/README.md\n` +
    `  remote: https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md`
  )
}

/**
 * Numeric major.minor.patch comparison: is current >= minimum?
 * The most significant differing segment decides; equal versions satisfy.
 */
export const satisfiesMinimum = (current: string, minimum: string): boolean => {
  const [currentMajor = 0, currentMinor = 0, currentPatch = 0] = current
    .split(".")
    .map(Number)
  const [minimumMajor = 0, minimumMinor = 0, minimumPatch = 0] = minimum
    .split(".")
    .map(Number)

  if (currentMajor !== minimumMajor) return currentMajor > minimumMajor
  if (currentMinor !== minimumMinor) return currentMinor > minimumMinor
  return currentPatch >= minimumPatch
}

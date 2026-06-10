/** Matches the first dotted version number in an engines range like ">=20.12.0". */
const VERSION_IN_RANGE = /(\d+)\.(\d+)(?:\.(\d+))?/

/**
 * Extracts the minimum version from a simple engines range (">=20.12.0").
 * The CLI only ever declares a floor, so the first version in the string
 * is the minimum.
 */
export const minimumNodeVersion = (enginesRange: string): string => {
  const match = VERSION_IN_RANGE.exec(enginesRange)
  if (match === null)
    throw new Error(`Cannot parse engines range: ${enginesRange}`)
  const [, major, minor, patch] = match
  return `${major}.${minor}.${patch ?? "0"}`
}

/** Numeric major.minor.patch comparison: is current >= minimum? */
export const satisfiesMinimum = (current: string, minimum: string): boolean => {
  const currentParts = current.split(".").map(Number)
  const minimumParts = minimum.split(".").map(Number)
  for (const index of [0, 1, 2]) {
    const currentPart = currentParts[index] ?? 0
    const minimumPart = minimumParts[index] ?? 0
    if (currentPart > minimumPart) return true
    if (currentPart < minimumPart) return false
  }
  return true
}

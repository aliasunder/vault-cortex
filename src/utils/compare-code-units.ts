/** Code-unit string comparison for deterministic tie-breaks —
 *  localeCompare would order the same strings differently across
 *  deployments depending on the runtime's locale and ICU data. */
export const compareByCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1

  return Number(left > right)
}

import { DateTime } from "luxon"

/** Rounds fractional filesystem mtimes before formatting and rejects invalid values. */
export const mtimeToIso = (mtimeMs: number): string => {
  const iso = DateTime.fromMillis(Math.round(mtimeMs)).toISO()
  if (iso === null) throw new Error(`invalid mtime: ${mtimeMs}`)
  return iso
}

import { DateTime } from "luxon"

/** Rounds fractional filesystem mtimes before formatting and rejects invalid values. */
export const mtimeToIso = (mtime: number): string => {
  const iso = DateTime.fromMillis(Math.round(mtime)).toISO()
  if (iso === null) throw new Error(`invalid mtime: ${mtime}`)
  return iso
}

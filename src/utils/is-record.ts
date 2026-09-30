/** True for a plain object (not null, not an array), so parsed JSON can be
 *  read by key. */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

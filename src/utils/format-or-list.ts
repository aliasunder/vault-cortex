/** Formats items as a prose alternatives list — "A", "A or B", "A, B, or C".
 *  Used wherever generated text offers a caller several interchangeable
 *  options and the option set is computed rather than literal. An empty list
 *  formats as "", so callers that can produce one must handle that case —
 *  a sentence built around an empty list reads as a truncated fragment. */
export const formatOrList = (items: readonly string[]): string => {
  if (items.length <= 2) return items.join(" or ")
  const allButLast = items.slice(0, -1).join(", ")
  const last = items.slice(-1).join("")
  return `${allButLast}, or ${last}`
}

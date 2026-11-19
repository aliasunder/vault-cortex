// ── Note aliases, the alternative names Obsidian finds a note by ───────────

/** Matches the `aliases` property key in any letter case. */
const ALIASES_KEY_RE = /^aliases$/i

/** The first key spelled `aliases` in any letter case, or undefined. */
export const findAliasesKey = (frontmatter: Record<string, unknown>): string | undefined => {
  return Object.keys(frontmatter).find((key) => ALIASES_KEY_RE.test(key))
}

/** The text entries of an aliases value, trimmed, with empty entries dropped:
 *  a text value is one entry, a list keeps its text elements, and any other
 *  value has none. */
const aliasEntriesFromValue = (value: unknown): string[] => {
  if (typeof value === "string") return [value.trim()].filter(Boolean)
  if (!Array.isArray(value)) return []

  return value
    .filter((element) => typeof element === "string")
    .map((element) => element.trim())
    .filter(Boolean)
}

/** A note's aliases in document order, read from the first key spelled
 *  `aliases` in any letter case. */
export const parseFrontmatterAliases = (frontmatter: Record<string, unknown>): string[] => {
  const aliasesKey = findAliasesKey(frontmatter)
  return aliasesKey ? aliasEntriesFromValue(frontmatter[aliasesKey]) : []
}

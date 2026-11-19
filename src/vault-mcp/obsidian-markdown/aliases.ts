// ── Note aliases, the alternative names Obsidian finds a note by ───────────

/** The first key spelled `aliases` in any letter case, or undefined. A later
 *  key with another spelling stays an ordinary property. */
export const findAliasesKey = (frontmatter: Record<string, unknown>): string | undefined => {
  return Object.keys(frontmatter).find((key) => key.toLowerCase() === "aliases")
}

/** The text entries of an aliases value, trimmed, with empty entries dropped:
 *  a text value is one entry, a list keeps its text elements, and any other
 *  value has none. */
const aliasEntriesFromValue = (value: unknown): string[] => {
  const elements: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value]

  return elements
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

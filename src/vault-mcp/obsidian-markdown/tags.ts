// ── Frontmatter tags, read the way Obsidian's Tags view reads them ──────────

/**
 * Matches a tag name Obsidian's Tags view accepts: no whitespace, no
 * character from the General Punctuation (U+2000–U+206F) or Supplemental
 * Punctuation (U+2E00–U+2E7F) blocks, and none of the listed ASCII
 * punctuation, so `_`, `-`, `/`, letters, digits, emoji and other Unicode
 * pass. A copy of the class Obsidian 1.14.4 tests every tag against (its
 * `getTags` and property editor), without the leading `#`.
 */
const TAG_NAME_RE = /^[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+$/

/** Matches a name made of ASCII digits only, which Obsidian refuses as a tag
 *  (`#1984` is not a tag, `#y1984` is), with the same `\d` Obsidian uses. */
const DIGITS_ONLY_RE = /^\d+$/

/** Matches the `tags` property key in any letter case, as Obsidian looks it up. */
const TAGS_KEY_RE = /^tags$/i

/** True for a property key Obsidian reads tags from: `tags` in any letter case. */
export const isTagsKey = (key: string): boolean => TAGS_KEY_RE.test(key)

/** True for a name that Obsidian's Tags view would list as a tag. */
export const isObsidianTagName = (name: string): boolean =>
  TAG_NAME_RE.test(name) && !DIGITS_ONLY_RE.test(name)

/** The raw value under the first key spelled `tags` in any letter case, the
 *  only key Obsidian reads: a later `Tags` key is ignored even if the first
 *  one is empty. */
const findTagsValue = (frontmatter: Record<string, unknown>): unknown => {
  const tagsKey = Object.keys(frontmatter).find(isTagsKey)
  return tagsKey ? frontmatter[tagsKey] : undefined
}

/** The text entries of a `tags` value, each trimmed: a text value is one
 *  entry, a list keeps its text elements, and any other value has none. An
 *  entry that trims to "" stays here and fails `isObsidianTagName` later. */
const textEntriesOf = (value: unknown): string[] => {
  if (typeof value === "string") return [value.trim()]
  if (Array.isArray(value)) {
    return value.filter((element) => typeof element === "string").map((element) => element.trim())
  }
  return []
}

/** The tag name an entry carries: one leading `#` and one trailing `/`
 *  removed, as Obsidian removes them before testing the name. */
const tagNameOf = (entry: string): string => {
  const withoutHash = entry.startsWith("#") ? entry.slice(1) : entry
  return withoutHash.endsWith("/") ? withoutHash.slice(0, -1) : withoutHash
}

/**
 * The tags Obsidian's Tags view shows for a note's properties, as bare names
 * in document order. A repeated tag is kept once per occurrence, because
 * `listAllTags` picks the spelling it shows by occurrence count. Reproduces
 * Obsidian 1.14.4's `parseFrontMatterTags` followed by `getTags`'s name test:
 * - the first key spelled `tags` in any letter case is read;
 * - a text value is one entry and a list keeps its text elements, trimmed;
 * - one leading `#` and one trailing `/` are removed;
 * - a name is kept only if `isObsidianTagName` accepts it.
 */
export const parseFrontmatterTags = (frontmatter: Record<string, unknown>): string[] =>
  textEntriesOf(findTagsValue(frontmatter)).map(tagNameOf).filter(isObsidianTagName)

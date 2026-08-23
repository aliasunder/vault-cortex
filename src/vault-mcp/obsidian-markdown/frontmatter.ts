import matter from "gray-matter"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

/**
 * gray-matter engine override: js-yaml's default YAML 1.1 schema parses
 * timestamp-shaped scalars into JS Dates, which stringify back as UTC-Z
 * — silently rewriting datetime properties like `created` to a different
 * representation of the same instant. The `yaml` package (YAML 1.2 core
 * schema) has no timestamp type, so datetimes parse as plain strings and
 * dump back unquoted — frontmatter values round-trip verbatim.
 *
 * `lineWidth: 0` disables the dumper's 80-column folding of long values.
 * `nullStr: ""` dumps null values as empty properties (`due:`), matching
 * how Obsidian writes them, instead of a literal `due: null`.
 */
const MATTER_OPTIONS = {
  engines: {
    yaml: {
      parse: (input: string): Record<string, unknown> => {
        // YAML.parse returns null for empty/comment-only input; gray-matter
        // expects an object for `data`
        const parsed: unknown = parseYaml(input)
        const isPlainObject =
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        if (!isPlainObject) return {}
        // parseYaml returns a plain object for valid YAML mappings;
        // round-trip through entries to satisfy Record<string, unknown>
        return Object.fromEntries(Object.entries(parsed))
      },
      stringify: (data: object): string =>
        stringifyYaml(data, { lineWidth: 0, nullStr: "" }),
    },
  },
}

/**
 * Frontmatter and body of a parsed note. This is `parseNote`'s whole
 * contract — the underlying gray-matter result carries extra fields
 * (excerpt, language, orig) that no caller may rely on.
 */
export type ParsedNote = {
  data: Record<string, unknown>
  content: string
}

/**
 * Matches a frontmatter opener: `---` alone on the first line (optional
 * BOM, trailing spaces/tabs, CRLF, or a whole-file `---`). Obsidian
 * starts a properties block only on this form; gray-matter alone is
 * wider — it reads `--- <text>` as a named parser-engine and throws on
 * unregistered names (Multi Column Markdown's
 * `--- start-multi-column: <name>` syntax, issue #485).
 */
const FRONTMATTER_OPENER = /^\uFEFF?---[ \t]*(\r?\n|$)/

/**
 * Matches a frontmatter closer after the opener line: any later line
 * starting with `---`. Loose on purpose — Obsidian's metadata cache
 * accepts closers like `----` or `---,` (its properties panel merely
 * skips rendering such a block), and gray-matter closes on the same
 * prefix, so the two parsers agree.
 */
const FRONTMATTER_CLOSER = /\n---/

/**
 * Parses a note into frontmatter `data` + `content`, with the
 * string-preserving YAML engine applied.
 *
 * A properties block exists only when the first line is a bare `---`
 * AND a later line starts with `---` — the rule Obsidian's metadata
 * cache follows. Anything else (a `--- <text>` first line, an opener
 * with no closer) is body text, returned untouched apart from a
 * leading BOM being stripped (gray-matter's own normalization, applied
 * on both paths). Invalid YAML inside a real block still throws —
 * write paths must reject loudly rather than silently stack a second
 * properties block above a broken one.
 *
 * Always use this instead of calling gray-matter directly — a bare
 * `matter()` call reverts to the js-yaml engine and reintroduces the
 * UTC-Z datetime bug.
 */
export const parseNote = (content: string): ParsedNote => {
  const hasFrontmatterFences =
    FRONTMATTER_OPENER.test(content) && FRONTMATTER_CLOSER.test(content)
  if (hasFrontmatterFences) {
    // Rebuilt as a literal so the runtime value carries exactly the
    // declared fields — gray-matter's result has extra enumerable keys
    // (excerpt, isEmpty) that would otherwise leak through spreads
    const parsed = matter(content, MATTER_OPTIONS)
    return { data: parsed.data, content: parsed.content }
  }
  const contentWithoutBom = content.startsWith("\uFEFF")
    ? content.slice(1)
    : content
  return { data: {}, content: contentWithoutBom }
}

/**
 * Serializes a body + frontmatter object back into a note string, with
 * the string-preserving YAML engine applied.
 *
 * The body is wrapped in `{ content: body }` because `matter.stringify`
 * given a plain string re-parses it as a whole note first: a body
 * opening with plugin syntax (`--- start-multi-column: …`) would hit
 * the unregistered-engine throw, and a body opening with a `---`
 * horizontal rule would be consumed as an unclosed frontmatter fence
 * and dropped entirely. The object form uses the body verbatim.
 *
 * Always use this instead of calling `matter.stringify` directly — a
 * bare call reverts to the js-yaml engine and reintroduces the UTC-Z
 * datetime bug.
 */
export const stringifyNote = (body: string, data: object): string =>
  matter.stringify({ content: body }, data, MATTER_OPTIONS)

/**
 * Merges `updates` into `existing` frontmatter. A key explicitly set to
 * null in `updates` is removed. Nulls already present in `existing`
 * (e.g. Obsidian empty properties like `due:`) are preserved — only the
 * caller's nulls are deletions.
 */
export const mergeFrontmatter = (
  existing: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> => {
  // Keys the caller explicitly nulled are deletions, not values
  const deletedKeys = new Set(
    Object.entries(updates)
      .filter(([, updateValue]) => updateValue === null)
      .map(([updateKey]) => updateKey),
  )
  return Object.fromEntries(
    Object.entries({ ...existing, ...updates }).filter(
      ([mergedKey]) => !deletedKeys.has(mergedKey),
    ),
  )
}

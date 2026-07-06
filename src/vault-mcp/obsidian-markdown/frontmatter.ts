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
 * Parses a note into frontmatter `data` + `content`, with the
 * string-preserving YAML engine applied.
 *
 * Always use this instead of calling gray-matter directly — a bare
 * `matter()` call reverts to the js-yaml engine and reintroduces the
 * UTC-Z datetime bug.
 */
export const parseNote = (content: string): matter.GrayMatterFile<string> =>
  matter(content, MATTER_OPTIONS)

/**
 * Serializes a body + frontmatter object back into a note string, with
 * the string-preserving YAML engine applied.
 *
 * Always use this instead of calling `matter.stringify` directly — a
 * bare call reverts to the js-yaml engine and reintroduces the UTC-Z
 * datetime bug.
 */
export const stringifyNote = (body: string, data: object): string =>
  matter.stringify(body, data, MATTER_OPTIONS)

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

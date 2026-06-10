import matter from "gray-matter"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

/**
 * gray-matter engine override: js-yaml's default YAML 1.1 schema parses
 * timestamp-shaped scalars into JS Dates, which stringify back as UTC-Z
 * and destroy the vault's local-offset ISO 8601 convention. The `yaml`
 * package (YAML 1.2 core schema) has no timestamp type, so datetimes
 * parse as plain strings and dump back unquoted — frontmatter values
 * round-trip verbatim.
 *
 * `lineWidth: 0` disables the dumper's 80-column folding of long values.
 */
const MATTER_OPTIONS = {
  engines: {
    yaml: {
      parse: (input: string): Record<string, unknown> => {
        // YAML.parse returns null for empty/comment-only input; gray-matter
        // expects an object for `data`
        const parsed: unknown = parseYaml(input)
        return (parsed ?? {}) as Record<string, unknown>
      },
      stringify: (data: object): string =>
        stringifyYaml(data, { lineWidth: 0 }),
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

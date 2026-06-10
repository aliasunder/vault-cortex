import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

/**
 * Shared gray-matter options that swap the YAML engine from js-yaml to
 * the `yaml` package.
 *
 * gray-matter's default engine (js-yaml, YAML 1.1 schema) parses
 * timestamp-shaped scalars into JS Date objects, which `matter.stringify`
 * re-serializes via `toISOString()` — converting local-offset ISO 8601
 * values like `created: 2026-05-13T20:00:00-04:00` to UTC-Z
 * (`2026-05-14T00:00:00.000Z`). Same instant, wrong representation.
 *
 * The `yaml` package uses the YAML 1.2 core schema, which has no
 * timestamp type: datetimes parse as plain strings and dump back
 * unquoted, so frontmatter values round-trip verbatim. Every
 * `matter()` / `matter.stringify()` call that can rewrite a note must
 * pass these options.
 *
 * `lineWidth: 0` disables the dumper's 80-column folding of long values.
 */
export const MATTER_OPTIONS = {
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

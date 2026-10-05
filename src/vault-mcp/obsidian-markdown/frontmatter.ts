import matter from "gray-matter"
import { LineCounter, parseDocument, stringify as stringifyYaml, visit } from "yaml"
import type { Document } from "yaml"

/** A parsed note, with its properties in `data` and its body in `content`. */
export type ParsedNote = {
  data: Record<string, unknown>
  content: string
}

/** Which kind of properties block a read or write refused, so a caller can pick the remedy. */
type UnsupportedPropertiesBlockKind = "invalid-yaml" | "not-key-value" | "explicit-tag"

/**
 * A properties block the server cannot read, or cannot keep through a
 * rewrite. The default `name` is kept, so the error reaches clients as
 * `[Error]: …` like every other domain error.
 */
export class UnsupportedPropertiesBlockError extends Error {
  readonly kind: UnsupportedPropertiesBlockKind

  constructor(params: { message: string; kind: UnsupportedPropertiesBlockKind; cause?: unknown }) {
    super(params.message, { cause: params.cause })
    this.kind = params.kind
  }
}

/**
 * A write whose result would open with `---` lines the server cannot read
 * or keep as a properties block. Separate from UnsupportedPropertiesBlockError
 * because no block in the vault is broken: the write would turn body lines
 * into the opening block, so the repair steps for a broken block do not apply.
 */
export class UnkeepableOpeningBlockError extends Error {}

/**
 * Matches a frontmatter opener: `---` alone on the first line (optional
 * BOM, trailing spaces/tabs, CRLF, or a whole-file `---`). Obsidian
 * starts a properties block only on this form; gray-matter alone is
 * wider — it reads `--- <text>` as a named parser-engine and throws on
 * unregistered names (Multi Column Markdown's
 * `--- start-multi-column: <name>` syntax).
 */
const FRONTMATTER_OPENER = /^\uFEFF?---[ \t]*(\r?\n|$)/

/**
 * Matches a frontmatter closer, which is a line after the first that starts
 * with `---`. It is tested against the whole note, and the leading `\n`
 * keeps it off the opener on the first line. Loose on purpose — Obsidian's
 * metadata cache accepts closers like `----` or `---,` (its properties panel
 * merely skips rendering such a block), and gray-matter closes on the same
 * prefix, so the two parsers agree.
 */
const FRONTMATTER_CLOSER = /\n---/

/**
 * Lets gray-matter split a note without reading its YAML. The engine
 * returns `{}` without parsing, so a block that would not parse still
 * splits, at the same boundaries gray-matter finds in any note.
 */
const SPLIT_ONLY_OPTIONS = {
  engines: { yaml: { parse: (): Record<string, unknown> => ({}) } },
}

/**
 * Splits a note into its raw properties block and the body after it,
 * without parsing the YAML. A properties block exists only when the first
 * line is a bare `---` AND a later line starts with `---` — the rule
 * Obsidian's metadata cache follows. Otherwise `blockText` is null and the
 * body is the whole note. A leading BOM is stripped on both paths, as
 * gray-matter does.
 *
 * `tasks.findBodyStartLine` finds where the body starts by its own,
 * stricter rule: a first line and a later line that are exactly `---`.
 */
export const splitPropertiesBlock = (
  content: string,
): {
  /** The text between the `---` lines. It starts with the opener line's own
   *  newline, so its line numbers match the note's. */
  blockText: string | null
  body: string
} => {
  const hasFrontmatterFences = FRONTMATTER_OPENER.test(content) && FRONTMATTER_CLOSER.test(content)

  if (hasFrontmatterFences) {
    const file = matter(content, SPLIT_ONLY_OPTIONS)
    return { blockText: file.matter, body: file.content }
  }
  const contentWithoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content
  return { blockText: null, body: contentWithoutBom }
}

/**
 * The result of reading a properties block:
 * - `unreadable`: the parser cannot read the YAML.
 * - `unkeepable`: readable, but a rewrite would lose it (a list, a single value, an explicit tag).
 * - `keepable`: a rewrite keeps its keys and values.
 *
 * `data` holds the block's top-level properties, or `{}` when the block is
 * not a key-value mapping.
 */
type PropertiesBlockReading =
  | { status: "unreadable"; error: UnsupportedPropertiesBlockError }
  | { status: "unkeepable"; data: Record<string, unknown>; error: UnsupportedPropertiesBlockError }
  | { status: "keepable"; data: Record<string, unknown> }

const YAML_CORE_TAG_PREFIX = "tag:yaml.org,2002:"

/** Shows a resolved tag as YAML spells it, writing the core prefix as `!!` (`!!str`). */
const formatTagAsWritten = (tag: string): string => {
  if (tag.startsWith(YAML_CORE_TAG_PREFIX)) return `!!${tag.slice(YAML_CORE_TAG_PREFIX.length)}`
  return tag
}

/** The first tag written in the block's source, in document order. Implicit values carry no tag. */
const findFirstExplicitTag = (document: Document): string | null => {
  // visit() reports nodes through a callback, so the first tag is kept in a
  // local the callback assigns before it stops the walk
  let firstTag: string | null = null
  visit(document, {
    Node: (_key, node) => {
      if (!node.tag) return undefined

      firstTag = node.tag
      return visit.BREAK
    },
  })
  return firstTag
}

/** A YAML mapping's top-level entries as properties. Any other value (a
 *  list, a single value, null) holds no properties, so it becomes `{}`. */
const yamlValueToProperties = (value: unknown): Record<string, unknown> => {
  const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value)

  if (!isPlainObject) return {}
  // Rebuilding from entries types the mapping as Record<string, unknown> without a cast
  return Object.fromEntries(Object.entries(value))
}

const unreadableReading = (params: {
  message: string
  cause?: unknown
}): PropertiesBlockReading => ({
  status: "unreadable",
  error: new UnsupportedPropertiesBlockError({ ...params, kind: "invalid-yaml" }),
})

const unkeepableReading = (params: {
  value: unknown
  message: string
  kind: UnsupportedPropertiesBlockKind
}): PropertiesBlockReading => ({
  status: "unkeepable",
  data: yamlValueToProperties(params.value),
  error: new UnsupportedPropertiesBlockError({ message: params.message, kind: params.kind }),
})

/**
 * Runs toJS(), which throws on an alias it cannot expand: one naming an
 * anchor the block never sets (`title: *bold*` reads as an alias to an
 * anchor named `bold*`), or one past the parser's alias-count limit.
 */
const convertDocumentToValue = (
  document: Document,
):
  | { status: "converted"; value: unknown }
  | { status: "failed"; reading: PropertiesBlockReading } => {
  try {
    return { status: "converted", value: document.toJS() }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: "failed",
      reading: unreadableReading({
        message: `properties block is not valid YAML: ${reason}`,
        cause: error,
      }),
    }
  }
}

/**
 * Reads a raw properties block with the `yaml` package (YAML 1.2 core
 * schema). That schema reads no untagged value as a timestamp, so datetime
 * properties like `created` stay plain strings instead of becoming Dates
 * that would stringify back as UTC-Z.
 */
const readPropertiesBlock = (blockText: string): PropertiesBlockReading => {
  // Each call gets its own counter, because a shared one keeps counting
  // across parses and reports later errors on the wrong line. The block
  // text starts with the opener's own newline, so its lines are the note's.
  const lineCounter = new LineCounter()
  // prettyErrors would append its own position and a multi-line excerpt of
  // the block to each message; the message below states the position itself
  const document = parseDocument(blockText, { prettyErrors: false, lineCounter })
  const [firstError] = document.errors

  if (firstError) {
    const { line, col } = lineCounter.linePos(firstError.pos[0])
    return unreadableReading({
      message: `properties block is not valid YAML at line ${line}, column ${col}: ${firstError.message}`,
      cause: firstError,
    })
  }

  const conversion = convertDocumentToValue(document)

  if (conversion.status === "failed") return conversion.reading

  const { value } = conversion

  // The shape checks run before the tag check, so a tagged list or single
  // value reports not-key-value: it holds no properties to keep, and its
  // remedy (carry the text over to the body) fits better than the tag's
  if (Array.isArray(value)) {
    return unkeepableReading({
      value,
      kind: "not-key-value",
      message:
        "properties block holds a list, not key-value pairs, so rewriting the note would delete it",
    })
  }

  // A null value passes this check on purpose, because an empty block, or
  // one holding only `null` or `~`, has no properties: Obsidian reads it as
  // none, and a rewrite writes none
  if (typeof value !== "object") {
    return unkeepableReading({
      value,
      kind: "not-key-value",
      message:
        "properties block holds a single value, not key-value pairs (a --- line at the top and a later --- line make a properties block), so rewriting the note would delete it",
    })
  }

  const explicitTag = findFirstExplicitTag(document)

  // A tagged value comes back from a rewrite changed or empty (`!done`
  // loses its value, `!!timestamp` becomes an ISO string), so any tag the
  // source spells out makes the block one a rewrite cannot keep
  if (explicitTag) {
    return unkeepableReading({
      value,
      kind: "explicit-tag",
      message: `properties block uses the YAML tag ${formatTagAsWritten(explicitTag)}, which rewriting the note would drop`,
    })
  }
  return { status: "keepable", data: yamlValueToProperties(value) }
}

/**
 * Parses a note for reading: frontmatter `data` + body `content`.
 *
 * Only YAML the parser cannot read throws (`UnsupportedPropertiesBlockError`,
 * kind `invalid-yaml`). A list or a single value reads as no properties
 * (`{}`), and a tagged value reads as the parser resolves its tag. Writes
 * use `parseNoteForRewrite`, which also refuses the blocks a rewrite would lose.
 */
export const parseNote = (content: string): ParsedNote => {
  const { blockText, body } = splitPropertiesBlock(content)

  if (blockText === null) return { data: {}, content: body }

  const reading = readPropertiesBlock(blockText)

  // A read refuses only YAML the parser cannot read
  if (reading.status === "unreadable") throw reading.error
  return { data: reading.data, content: body }
}

/**
 * Parses a note that is about to be rewritten. Beyond `parseNote`'s
 * refusal of unreadable YAML, it throws `UnsupportedPropertiesBlockError`
 * for a block the rewrite would delete or change — a list, a single value,
 * or a value with an explicit tag — so a write never silently drops it.
 */
export const parseNoteForRewrite = (content: string): ParsedNote => {
  const { blockText, body } = splitPropertiesBlock(content)

  if (blockText === null) return { data: {}, content: body }

  const reading = readPropertiesBlock(blockText)

  // The one difference from parseNote: an unkeepable block is refused too
  if (reading.status !== "keepable") throw reading.error
  return { data: reading.data, content: body }
}

/**
 * Serializes properties as a frontmatter block, `""` when there are none.
 * It writes gray-matter's format, trimmed YAML between `---` lines.
 *
 * `lineWidth: 0` disables the dumper's 80-column folding of long values.
 * `nullStr: ""` dumps null values as empty properties (`due:`), matching
 * how Obsidian writes them, instead of a literal `due: null`.
 */
export const serializePropertiesBlock = (data: object): string => {
  const dumpedYaml = stringifyYaml(data, { lineWidth: 0, nullStr: "" }).trim()

  // The dumper writes `{}` for an object with no keys, and for one whose
  // values are all undefined (it drops those keys), so there is no block to write
  if (dumpedYaml === "{}") return ""
  return `---\n${dumpedYaml}\n---\n`
}

/**
 * Refuses a serialized note whose opening block the server could not read
 * or keep. With no properties to write, the body goes out verbatim, so a
 * body opening with `---` lines becomes the properties block; a block
 * dumped from properties reads back as a mapping and passes.
 */
const assertOpeningBlockIsKeepable = (serialized: string): void => {
  const { blockText } = splitPropertiesBlock(serialized)

  if (blockText === null) return

  const reading = readPropertiesBlock(blockText)

  if (reading.status === "keepable") return
  throw new UnkeepableOpeningBlockError(
    `the note would open with a properties block the server cannot keep: ${reading.error.message}`,
    { cause: reading.error },
  )
}

/**
 * Serializes a body + frontmatter object into a note string, ending with
 * a newline, and refuses a result whose opening properties block could
 * not be read or kept on the next write.
 */
export const stringifyNote = (body: string, data: object): string => {
  const bodyWithTrailingNewline = body.endsWith("\n") ? body : `${body}\n`
  const serialized = `${serializePropertiesBlock(data)}${bodyWithTrailingNewline}`

  assertOpeningBlockIsKeepable(serialized)
  return serialized
}

/**
 * Replaces a note's whole properties block with `properties` and keeps the
 * body's bytes exactly, adding no newline; only a leading BOM is dropped,
 * as on every split. The old block is never parsed, so a block the server
 * cannot read or keep can still be replaced. `{}` removes the block.
 */
export const replacePropertiesBlock = (content: string, properties: object): string => {
  const { body } = splitPropertiesBlock(content)
  const replaced = `${serializePropertiesBlock(properties)}${body}`

  assertOpeningBlockIsKeepable(replaced)
  return replaced
}

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

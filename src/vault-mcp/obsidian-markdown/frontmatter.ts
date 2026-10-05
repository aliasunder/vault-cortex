import matter from "gray-matter"
import { LineCounter, parseDocument, stringify as stringifyYaml, visit } from "yaml"
import type { Document } from "yaml"

/**
 * Frontmatter and body of a parsed note. This is `parseNote`'s whole
 * contract — the underlying gray-matter result carries extra fields
 * (excerpt, language, orig) that no caller may rely on.
 */
export type ParsedNote = {
  data: Record<string, unknown>
  content: string
}

/** Which kind of properties block a write refused, so a caller can pick the remedy. */
type UnreadablePropertiesKind = "invalid-yaml" | "not-key-value" | "explicit-tag"

/**
 * A properties block the server cannot read, or cannot keep through a
 * rewrite. The default `name` is kept, so the error reaches clients as
 * `[Error]: …` like every other domain error.
 */
export class UnreadablePropertiesError extends Error {
  readonly kind: UnreadablePropertiesKind

  constructor(params: { message: string; kind: UnreadablePropertiesKind; cause?: unknown }) {
    super(params.message, { cause: params.cause })
    this.kind = params.kind
  }
}

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
 * Matches a frontmatter closer after the opener line: any later line
 * starting with `---`. Loose on purpose — Obsidian's metadata cache
 * accepts closers like `----` or `---,` (its properties panel merely
 * skips rendering such a block), and gray-matter closes on the same
 * prefix, so the two parsers agree.
 */
const FRONTMATTER_CLOSER = /\n---/

/**
 * Lets gray-matter split a note without reading its YAML. The engine
 * returns `{}` without parsing, so a block that would not parse still
 * splits, and gray-matter's own split keeps the block text and body
 * byte-identical to how notes have always been read.
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
 */
export const splitPropertiesBlock = (
  content: string,
): { blockText: string | null; body: string } => {
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
 * - `keepable`: a rewrite keeps it.
 *
 * `data` is what reads have always returned for the block.
 */
type PropertiesBlockReading =
  | { status: "unreadable"; error: UnreadablePropertiesError }
  | { status: "unkeepable"; data: Record<string, unknown>; error: UnreadablePropertiesError }
  | { status: "keepable"; data: Record<string, unknown> }

const YAML_CORE_TAG_PREFIX = "tag:yaml.org,2002:"

/** Shows a resolved tag as YAML spells it, writing the core prefix as `!!` (`!!str`). */
const formatTagAsWritten = (tag: string): string => {
  if (tag.startsWith(YAML_CORE_TAG_PREFIX)) return `!!${tag.slice(YAML_CORE_TAG_PREFIX.length)}`
  return tag
}

/** The first tag written in the block's source, in document order. Implicit values carry no tag. */
const findFirstExplicitTag = (document: Document): string | null => {
  // visit() reports nodes through a callback, so the tags collect in a local list
  const explicitTags: string[] = []
  visit(document, {
    Node: (_key, node) => {
      if (node.tag) explicitTags.push(node.tag)
    },
  })
  return explicitTags[0] ?? null
}

/** Reads have always returned a plain object's own entries, and `{}` for anything else. */
const projectToProperties = (value: unknown): Record<string, unknown> => {
  const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value)

  if (!isPlainObject) return {}
  return Object.fromEntries(Object.entries(value))
}

const unreadableReading = (params: {
  message: string
  cause?: unknown
}): PropertiesBlockReading => ({
  status: "unreadable",
  error: new UnreadablePropertiesError({ ...params, kind: "invalid-yaml" }),
})

const unkeepableReading = (params: {
  value: unknown
  message: string
  kind: UnreadablePropertiesKind
}): PropertiesBlockReading => ({
  status: "unkeepable",
  data: projectToProperties(params.value),
  error: new UnreadablePropertiesError({ message: params.message, kind: params.kind }),
})

/** Runs toJS(), which throws on alias failures (`*bold*`, excessive alias counts). */
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
 * schema). It has no timestamp type, so datetime properties like
 * `created` stay plain strings instead of becoming Dates that would
 * stringify back as UTC-Z.
 */
const readPropertiesBlock = (blockText: string): PropertiesBlockReading => {
  // Each call gets its own counter, because a shared one keeps counting
  // across parses and reports later errors on the wrong line. The block
  // text starts with the opener's own newline, so its lines are the note's.
  const lineCounter = new LineCounter()
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

  if (Array.isArray(value)) {
    return unkeepableReading({
      value,
      kind: "not-key-value",
      message:
        "properties block holds a list, not key-value pairs, so rewriting the note would delete it",
    })
  }
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
  return { status: "keepable", data: projectToProperties(value) }
}

/**
 * Parses a note for reading: frontmatter `data` + body `content`.
 *
 * Only YAML the parser cannot read throws (`UnreadablePropertiesError`,
 * kind `invalid-yaml`); a list, a single value or an explicitly tagged
 * block reads as it always has. Writes use `parseNoteForRewrite`, which
 * also refuses the blocks a rewrite would lose.
 */
export const parseNote = (content: string): ParsedNote => {
  const { blockText, body } = splitPropertiesBlock(content)

  if (blockText === null) return { data: {}, content: body }

  const reading = readPropertiesBlock(blockText)

  if (reading.status === "unreadable") throw reading.error
  return { data: reading.data, content: body }
}

/**
 * Parses a note that is about to be rewritten. Beyond `parseNote`'s
 * refusal of unreadable YAML, it throws `UnreadablePropertiesError` for a
 * block the rewrite would delete or change — a list, a single value, or a
 * value with an explicit tag — so a write never silently drops it.
 */
export const parseNoteForRewrite = (content: string): ParsedNote => {
  const { blockText, body } = splitPropertiesBlock(content)

  if (blockText === null) return { data: {}, content: body }

  const reading = readPropertiesBlock(blockText)

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

  if (dumpedYaml === "{}") return ""
  return `---\n${dumpedYaml}\n---\n`
}

/**
 * Refuses a serialized note whose opening block the server could not read
 * or keep. With no properties to write, the body goes out verbatim, so a
 * body opening with `---` lines becomes the note's properties block.
 */
const assertOpeningBlockIsKeepable = (serialized: string): void => {
  const { blockText } = splitPropertiesBlock(serialized)

  if (blockText === null) return

  const reading = readPropertiesBlock(blockText)

  if (reading.status === "keepable") return
  // This is a plain Error rather than UnreadablePropertiesError because the
  // content being written is at fault, not a block already in the vault,
  // so the repair steps for a broken block do not apply
  throw new Error(
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

import matter from "gray-matter"
import { DateTime } from "luxon"
import { stringify as stringifyYaml } from "yaml"
import { describe, it, expect } from "vitest"
import {
  parseNote,
  parseNoteForRewrite,
  splitPropertiesBlock,
  serializePropertiesBlock,
  stringifyNote,
  mergeFrontmatter,
  UnkeepableOpeningBlockError,
  UnsupportedPropertiesBlockError,
} from "../frontmatter.js"

/** Written as a code point so no invisible literal hides in the source. */
const BOM = String.fromCharCode(0xfeff)

/**
 * Multi Column Markdown template — a `--- <text>` first line that
 * gray-matter alone reads as an unregistered parser-engine name and throws
 * on. Obsidian treats the file as plain text with no properties.
 */
const MULTI_COLUMN_NOTE = [
  "--- start-multi-column: ExampleRegion1",
  "```column-settings",
  "number of columns: 2",
  "largest column: left",
  "```",
  ">[!info] First Column",
  "",
  "Text displayed in column 1.",
  "",
  "--- end-column ---",
  "",
  ">[!example] Column 2",
  "",
  "Text displayed in column 2.",
  "",
  "--- end-multi-column",
  "",
].join("\n")

const SINGLE_VALUE_MESSAGE =
  "properties block holds a single value, not key-value pairs (a --- line at the top and a later --- line make a properties block), so rewriting the note would delete it"

const LIST_MESSAGE =
  "properties block holds a list, not key-value pairs, so rewriting the note would delete it"

const UNCLOSED_FLOW_MESSAGE =
  "properties block is not valid YAML at line 2, column 17: Flow sequence in block collection must be sufficiently indented and end with a ]"

/** Runs a call that must throw and returns what it threw. */
const catchThrown = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("expected the call to throw, but it returned")
}

/** The parts of a properties-block refusal callers rely on, or null when the throw is anything else. */
const describeRefusal = (thrown: unknown): { kind: string; message: string } | null => {
  if (!(thrown instanceof UnsupportedPropertiesBlockError)) return null
  return { kind: thrown.kind, message: thrown.message }
}

/** The parts of stringifyNote's output refusal, an UnkeepableOpeningBlockError whose cause is the block refusal. */
const describeOutputRefusal = (
  thrown: unknown,
): { message: string; causeIsBlockRefusal: boolean } | null => {
  if (!(thrown instanceof UnkeepableOpeningBlockError)) return null
  return {
    message: thrown.message,
    causeIsBlockRefusal: thrown.cause instanceof UnsupportedPropertiesBlockError,
  }
}

// ── parseNote ────────────────────────────────────────────────────

describe("parseNote", () => {
  it("returns the Multi Column template as body with no frontmatter", () => {
    expect(parseNote(MULTI_COLUMN_NOTE)).toEqual({
      data: {},
      content: MULTI_COLUMN_NOTE,
    })
  })

  it("treats a `--- text` first line as body, not a parser-engine name", () => {
    expect(parseNote("--- some text\nbody line\n")).toEqual({
      data: {},
      content: "--- some text\nbody line\n",
    })
  })

  it("treats a `----` first line as body", () => {
    expect(parseNote("----\nbody line\n")).toEqual({
      data: {},
      content: "----\nbody line\n",
    })
  })

  it("treats an opener with no closing dash line as body — Obsidian parses no properties from an unclosed fence", () => {
    const unclosedFence = "---\ntags:\n  - hello\n# Title\nsome text after, no closing dashes\n"
    expect(parseNote(unclosedFence)).toEqual({
      data: {},
      content: unclosedFence,
    })
  })

  it("parses a block closed by `----`, matching Obsidian's metadata cache", () => {
    // The fourth dash leaks into content — gray-matter and Obsidian's
    // cache both close on the `---` prefix
    expect(parseNote("---\ntags:\n  - hello\n----\n")).toEqual({
      data: { tags: ["hello"] },
      content: "-\n",
    })
  })

  it("parses a block closed by `---,`, matching Obsidian's metadata cache", () => {
    expect(parseNote("---\ntags:\n  - hello\n---,\n# Title\nsome text\n")).toEqual({
      data: { tags: ["hello"] },
      content: ",\n# Title\nsome text\n",
    })
  })

  it("parses an ordinary frontmatter block", () => {
    expect(parseNote("---\ntitle: x\n---\nbody\n")).toEqual({
      data: { title: "x" },
      content: "body\n",
    })
  })

  it("parses an opener with trailing whitespace", () => {
    expect(parseNote("---  \ntitle: x\n---\nbody\n")).toEqual({
      data: { title: "x" },
      content: "body\n",
    })
  })

  it("parses CRLF frontmatter", () => {
    // The \r inside the value is gray-matter's pre-existing CRLF
    // handling, pinned as-is — the opener gate must not reject the file
    expect(parseNote("---\r\ntitle: x\r\n---\r\nbody\r\n")).toEqual({
      data: { title: "x\r" },
      content: "body\r\n",
    })
  })

  it("strips a BOM before an ordinary frontmatter block", () => {
    expect(parseNote(BOM + "---\ntitle: x\n---\nbody\n")).toEqual({
      data: { title: "x" },
      content: "body\n",
    })
  })

  it("strips a BOM from a note with no frontmatter", () => {
    expect(parseNote(BOM + "plain body\n")).toEqual({
      data: {},
      content: "plain body\n",
    })
  })

  it("treats a whole-file `---` as body", () => {
    expect(parseNote("---")).toEqual({ data: {}, content: "---" })
  })

  it("returns empty data for an empty fence pair", () => {
    expect(parseNote("---\n---\n")).toEqual({ data: {}, content: "" })
  })

  it.each([
    {
      label: "an unclosed flow sequence",
      note: "---\ntitle: [unclosed\n---\nbody\n",
      message: UNCLOSED_FLOW_MESSAGE,
    },
    {
      label: "a duplicate key",
      note: "---\na: 1\na: 2\n---\nbody\n",
      message: "properties block is not valid YAML at line 3, column 1: Map keys must be unique",
    },
    {
      label: "tab indentation",
      note: "---\na:\n\tb: 1\n---\nbody\n",
      message:
        "properties block is not valid YAML at line 3, column 1: Tabs are not allowed as indentation",
    },
    {
      label: "a nested implicit key",
      note: "---\ntitle: a: b\n---\nbody\n",
      message:
        "properties block is not valid YAML at line 2, column 8: Nested mappings are not allowed in compact mappings",
    },
    {
      label: "an unbalanced quote",
      note: '---\ntitle: "abc\n---\nbody\n',
      message: 'properties block is not valid YAML at line 2, column 12: Missing closing "quote',
    },
    {
      label: "an alias with no anchor, which has no position",
      note: "---\nsummary: *bold*\n---\nbody\n",
      message:
        "properties block is not valid YAML: Unresolved alias (the anchor must be set before the alias): bold*",
    },
  ])("refuses $label with the server's own message", ({ note, message }) => {
    expect(describeRefusal(catchThrown(() => parseNote(note)))).toEqual({
      kind: "invalid-yaml",
      message,
    })
  })

  it("reports the same position when the same note is parsed again", () => {
    const note = "---\ntitle: [unclosed\n---\nbody\n"

    expect(describeRefusal(catchThrown(() => parseNote(note)))).toEqual({
      kind: "invalid-yaml",
      message: UNCLOSED_FLOW_MESSAGE,
    })
    expect(describeRefusal(catchThrown(() => parseNote(note)))).toEqual({
      kind: "invalid-yaml",
      message: UNCLOSED_FLOW_MESSAGE,
    })
  })

  it("reports the note's own line when the note starts with a BOM", () => {
    expect(
      describeRefusal(catchThrown(() => parseNote(BOM + "---\ntitle: [unclosed\n---\nbody\n"))),
    ).toEqual({ kind: "invalid-yaml", message: UNCLOSED_FLOW_MESSAGE })
  })

  it("reports the note's own line in a CRLF note", () => {
    expect(
      describeRefusal(catchThrown(() => parseNote("---\r\na: 1\r\na: 2\r\n---\r\nbody\r\n"))),
    ).toEqual({
      kind: "invalid-yaml",
      message: "properties block is not valid YAML at line 3, column 1: Map keys must be unique",
    })
  })

  it.each([
    { label: "a list block", note: "---\n- a\n- b\n---\nbody\n", data: {} },
    { label: "a false block", note: "---\nfalse\n---\nbody\n", data: {} },
    { label: "a zero block", note: "---\n0\n---\nbody\n", data: {} },
    { label: 'a "" block', note: '---\n""\n---\nbody\n', data: {} },
    { label: "a prose block", note: "---\nJust a paragraph.\n---\nbody\n", data: {} },
    { label: "a null block", note: "---\nnull\n---\nbody\n", data: {} },
    { label: "a ~ block", note: "---\n~\n---\nbody\n", data: {} },
    { label: "a comment-only block", note: "---\n# a comment\n---\nbody\n", data: {} },
    { label: "a custom tag", note: "---\nstatus: !done\n---\nbody\n", data: { status: "" } },
    {
      label: "a !!timestamp tag",
      note: "---\nq: !!timestamp 2024-01-01\n---\nbody\n",
      // The yaml library hands back a JS Date for this tag, so the expected value is one
      data: { q: DateTime.fromISO("2024-01-01", { zone: "utc" }).toJSDate() },
    },
  ])("reads $label as it always has", ({ note, data }) => {
    expect(parseNote(note)).toEqual({ data, content: "body\n" })
  })
})

// ── parseNoteForRewrite ──────────────────────────────────────────

describe("parseNoteForRewrite", () => {
  it.each([
    {
      label: "a list block",
      note: "---\n- a\n- b\n---\nbody\n",
      kind: "not-key-value",
      message: LIST_MESSAGE,
    },
    {
      label: "a false block",
      note: "---\nfalse\n---\nbody\n",
      kind: "not-key-value",
      message: SINGLE_VALUE_MESSAGE,
    },
    {
      label: "a zero block",
      note: "---\n0\n---\nbody\n",
      kind: "not-key-value",
      message: SINGLE_VALUE_MESSAGE,
    },
    {
      label: 'a "" block',
      note: '---\n""\n---\nbody\n',
      kind: "not-key-value",
      message: SINGLE_VALUE_MESSAGE,
    },
    {
      label: "a prose block between --- lines",
      note: "---\nJust a paragraph.\n---\nbody\n",
      kind: "not-key-value",
      message: SINGLE_VALUE_MESSAGE,
    },
    {
      label: "a custom tag",
      note: "---\nstatus: !done\n---\nbody\n",
      kind: "explicit-tag",
      message: "properties block uses the YAML tag !done, which rewriting the note would drop",
    },
    {
      label: "the bare ! tag",
      note: "---\na: ! 12\n---\nbody\n",
      kind: "explicit-tag",
      message: "properties block uses the YAML tag !, which rewriting the note would drop",
    },
    {
      label: "a !!str tag",
      note: "---\nn: !!str 123\n---\nbody\n",
      kind: "explicit-tag",
      message: "properties block uses the YAML tag !!str, which rewriting the note would drop",
    },
    {
      label: "a !!float tag",
      note: "---\nr: !!float 1\n---\nbody\n",
      kind: "explicit-tag",
      message: "properties block uses the YAML tag !!float, which rewriting the note would drop",
    },
    {
      label: "a !!timestamp tag",
      note: "---\nq: !!timestamp 2024-01-01\n---\nbody\n",
      kind: "explicit-tag",
      message:
        "properties block uses the YAML tag !!timestamp, which rewriting the note would drop",
    },
    {
      label: "a !!map tag on a list",
      note: "---\nm: !!map [one, two]\n---\nbody\n",
      kind: "explicit-tag",
      message: "properties block uses the YAML tag !!map, which rewriting the note would drop",
    },
    {
      label: "unreadable YAML",
      note: "---\ntitle: [unclosed\n---\nbody\n",
      kind: "invalid-yaml",
      message: UNCLOSED_FLOW_MESSAGE,
    },
  ])("refuses $label", ({ note, kind, message }) => {
    expect(describeRefusal(catchThrown(() => parseNoteForRewrite(note)))).toEqual({
      kind,
      message,
    })
  })

  it.each([
    { label: "a null block", note: "---\nnull\n---\nbody\n", data: {} },
    { label: "a ~ block", note: "---\n~\n---\nbody\n", data: {} },
    { label: "an empty block", note: "---\n---\nbody\n", data: {} },
    { label: "a comment-only block", note: "---\n# a comment\n---\nbody\n", data: {} },
    { label: "no block", note: "body\n", data: {} },
    {
      label: "a mapping of every implicit scalar type",
      note: "---\na: 1\nb: 2.5\nc: true\nd: null\ne: ~\nf: 2024-01-01\ng: text\nh: [x, y]\nj: {k: v}\n---\nbody\n",
      data: {
        a: 1,
        b: 2.5,
        c: true,
        d: null,
        e: null,
        f: "2024-01-01",
        g: "text",
        h: ["x", "y"],
        j: { k: "v" },
      },
    },
  ])("accepts $label", ({ note, data }) => {
    expect(parseNoteForRewrite(note)).toEqual({ data, content: "body\n" })
  })
})

// ── splitPropertiesBlock ─────────────────────────────────────────

describe("splitPropertiesBlock", () => {
  it.each([
    {
      label: "a --- closer",
      note: "---\ntitle: x\n---\nbody\n",
      blockText: "\ntitle: x",
      body: "body\n",
    },
    {
      label: "a ---- closer, whose last dash stays in the body",
      note: "---\ntitle: x\n----\nbody\n",
      blockText: "\ntitle: x",
      body: "-\nbody\n",
    },
    {
      label: "a ---, closer",
      note: "---\ntitle: x\n---,\nbody\n",
      blockText: "\ntitle: x",
      body: ",\nbody\n",
    },
    {
      label: "a closer with trailing spaces",
      note: "---\ntitle: x\n---   \nbody\n",
      blockText: "\ntitle: x",
      body: "   \nbody\n",
    },
    {
      label: "a ---text closer",
      note: "---\ntitle: x\n---text\nbody\n",
      blockText: "\ntitle: x",
      body: "text\nbody\n",
    },
    {
      label: "a Multi Column opener, which is no block",
      note: "--- start-multi-column: X\ntext\n--- end-multi-column\n",
      blockText: null,
      body: "--- start-multi-column: X\ntext\n--- end-multi-column\n",
    },
    {
      label: "a ---text first line, which is no block",
      note: "---text\ntitle: x\n---\nbody\n",
      blockText: null,
      body: "---text\ntitle: x\n---\nbody\n",
    },
    {
      label: "CRLF line endings",
      note: "---\r\ntitle: x\r\n---\r\nbody\r\n",
      blockText: "\r\ntitle: x\r",
      body: "body\r\n",
    },
    {
      label: "a BOM before a block",
      note: BOM + "---\ntitle: x\n---\nbody\n",
      blockText: "\ntitle: x",
      body: "body\n",
    },
    {
      label: "a BOM with no block",
      note: BOM + "plain body\n",
      blockText: null,
      body: "plain body\n",
    },
    {
      label: "a closer at the end of the file",
      note: "---\ntitle: x\n---",
      blockText: "\ntitle: x",
      body: "",
    },
    { label: "an empty block", note: "---\n---\nbody\n", blockText: "", body: "body\n" },
    { label: "an empty body", note: "---\ntitle: x\n---\n", blockText: "\ntitle: x", body: "" },
    {
      label: "a body with no trailing newline",
      note: "---\ntitle: x\n---\nbody",
      blockText: "\ntitle: x",
      body: "body",
    },
    {
      label: "an opener with no closer",
      note: "---\ntitle: x\nbody\n",
      blockText: null,
      body: "---\ntitle: x\nbody\n",
    },
  ])("splits $label without parsing the YAML", ({ note, blockText, body }) => {
    expect(splitPropertiesBlock(note)).toEqual({ blockText, body })
  })

  it("splits a block that would not parse", () => {
    expect(splitPropertiesBlock("---\ntitle: [unclosed\n---\nbody\n")).toEqual({
      blockText: "\ntitle: [unclosed",
      body: "body\n",
    })
  })
})

// ── serializePropertiesBlock ─────────────────────────────────────

describe("serializePropertiesBlock", () => {
  it.each([
    {
      label: "a mapping",
      data: { title: "x", tags: ["a", "b"] },
      block: "---\ntitle: x\ntags:\n  - a\n  - b\n---\n",
    },
    { label: "no properties", data: {}, block: "" },
    { label: "a null value as an empty property", data: { due: null }, block: "---\ndue:\n---\n" },
    {
      label: "a value ending in blank lines, trimmed like gray-matter",
      data: { note: "line\n\n" },
      block: "---\nnote: |+\n  line\n---\n",
    },
  ])("serializes $label", ({ data, block }) => {
    expect(serializePropertiesBlock(data)).toBe(block)
  })
})

// ── stringifyNote ────────────────────────────────────────────────

/**
 * gray-matter's stringify with the YAML options the server has always
 * used — the implementation stringifyNote replaced, kept here as an
 * independent check that every write's bytes are unchanged.
 */
const GRAY_MATTER_STRINGIFY_OPTIONS = {
  engines: {
    yaml: {
      parse: (): Record<string, unknown> => ({}),
      stringify: (data: object): string => stringifyYaml(data, { lineWidth: 0, nullStr: "" }),
    },
  },
}

describe("stringifyNote", () => {
  it("prepends a frontmatter block above a body that opens with plugin syntax", () => {
    const pluginBody = "--- start-multi-column: ExampleRegion1\ntext in column\n"
    expect(stringifyNote(pluginBody, { title: "x" })).toBe(
      "---\ntitle: x\n---\n--- start-multi-column: ExampleRegion1\ntext in column\n",
    )
  })

  it("preserves a body that opens with a horizontal rule", () => {
    // gray-matter's string form re-parses the body and consumes an
    // HR-leading body as an unclosed fence, erasing it — the object
    // form passed by stringifyNote must keep it verbatim
    expect(stringifyNote("---\nrest of body\n", { title: "x" })).toBe(
      "---\ntitle: x\n---\n---\nrest of body\n",
    )
  })

  it("wraps an ordinary body", () => {
    expect(stringifyNote("plain body\n", { title: "x" })).toBe("---\ntitle: x\n---\nplain body\n")
  })

  it("writes no frontmatter block for empty properties", () => {
    expect(stringifyNote("plain body\n", {})).toBe("plain body\n")
  })

  it("round-trips a plugin-syntax body through parseNote", () => {
    const pluginBody = "--- start-multi-column: ExampleRegion1\ntext in column\n"
    expect(parseNote(stringifyNote(pluginBody, { title: "x" }))).toEqual({
      data: { title: "x" },
      content: pluginBody,
    })
  })

  it.each([
    { label: "a null first", body: "body\n", data: { due: null, title: "x" } },
    { label: "a null last", body: "body\n", data: { title: "x", due: null } },
    { label: "a null alone", body: "body\n", data: { due: null } },
    { label: "nested values", body: "body\n", data: { meta: { a: [1, { b: "c" }] } } },
    { label: "a multi-line string", body: "body\n", data: { text: "one\ntwo\nthree" } },
    { label: "--- inside a string", body: "body\n", data: { text: "a\n---\nb" } },
    { label: "a value ending in blank lines", body: "body\n", data: { note: "line\n\n" } },
    { label: "no properties", body: "body\n", data: {} },
    { label: "a body with no trailing newline", body: "body", data: { title: "x" } },
    { label: "an empty body", body: "", data: { title: "x" } },
  ])("writes the same bytes as gray-matter for $label", ({ body, data }) => {
    expect(stringifyNote(body, data)).toBe(
      matter.stringify({ content: body }, data, GRAY_MATTER_STRINGIFY_OPTIONS),
    )
  })

  it("refuses an empty-data body that would open the note with a prose block", () => {
    const thrown = catchThrown(() => stringifyNote("---\n\nSome text\n\n---\nbody\n", {}))

    expect(describeOutputRefusal(thrown)).toEqual({
      message: `the note would open with a properties block the server cannot keep: ${SINGLE_VALUE_MESSAGE}`,
      causeIsBlockRefusal: true,
    })
  })

  it("refuses removing the last property when a broken second block would then open the note", () => {
    const { content } = parseNote("---\na: 1\n---\n---\ntitle: [unclosed\n---\nbody\n")
    const thrown = catchThrown(() => stringifyNote(content, {}))

    expect(describeOutputRefusal(thrown)).toEqual({
      message: `the note would open with a properties block the server cannot keep: ${UNCLOSED_FLOW_MESSAGE}`,
      causeIsBlockRefusal: true,
    })
  })

  it.each([
    { label: "a valid block", body: "---\ntitle: ok\n---\nbody\n" },
    { label: "a CRLF block", body: "---\r\ntitle: ok\r\n---\r\nbody\r\n" },
    { label: "a Multi Column opener", body: "--- start-multi-column: X\ntext\n" },
    { label: "a horizontal rule with no closer", body: "---\nno closer here\n" },
  ])("writes an empty-data body that opens with $label verbatim", ({ body }) => {
    expect(stringifyNote(body, {})).toBe(body)
  })
})

// ── mergeFrontmatter ─────────────────────────────────────────────

describe("mergeFrontmatter", () => {
  it("adds new keys and overwrites matching ones", () => {
    expect(mergeFrontmatter({ title: "old", type: "note" }, { title: "new" })).toEqual({
      title: "new",
      type: "note",
    })
  })

  it("removes keys explicitly set to null in updates", () => {
    expect(mergeFrontmatter({ title: "old", draft: true }, { draft: null })).toEqual({
      title: "old",
    })
  })

  it("preserves nulls already present in existing frontmatter", () => {
    expect(mergeFrontmatter({ due: null }, { title: "x" })).toEqual({
      due: null,
      title: "x",
    })
  })
})

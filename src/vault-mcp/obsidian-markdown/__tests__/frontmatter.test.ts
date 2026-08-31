import { describe, it, expect } from "vitest"
import { parseNote, stringifyNote, mergeFrontmatter } from "../frontmatter.js"

/** Written as a code point so no invisible literal hides in the source. */
const BOM = String.fromCharCode(0xfeff)

/**
 * Multi Column Markdown template from issue #485 — a `--- <text>` first
 * line that gray-matter alone reads as an unregistered parser-engine
 * name and throws on. Obsidian treats the file as plain text with no
 * properties.
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

// ── parseNote ────────────────────────────────────────────────────

describe("parseNote", () => {
  it("returns the issue #485 Multi Column template as body with no frontmatter", () => {
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
    const unclosedFence =
      "---\ntags:\n  - hello\n# Title\nsome text after, no closing dashes\n"
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
    expect(
      parseNote("---\ntags:\n  - hello\n---,\n# Title\nsome text\n"),
    ).toEqual({
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

  it("throws on invalid YAML inside a real fenced block", () => {
    expect(() => parseNote("---\ntitle: [unclosed\n---\nbody\n")).toThrow(
      "Flow sequence in block collection must be sufficiently indented",
    )
  })
})

// ── stringifyNote ────────────────────────────────────────────────

describe("stringifyNote", () => {
  it("prepends a frontmatter block above a body that opens with plugin syntax", () => {
    const pluginBody =
      "--- start-multi-column: ExampleRegion1\ntext in column\n"
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
    expect(stringifyNote("plain body\n", { title: "x" })).toBe(
      "---\ntitle: x\n---\nplain body\n",
    )
  })

  it("writes no frontmatter block for empty properties", () => {
    expect(stringifyNote("plain body\n", {})).toBe("plain body\n")
  })

  it("round-trips a plugin-syntax body through parseNote", () => {
    const pluginBody =
      "--- start-multi-column: ExampleRegion1\ntext in column\n"
    expect(parseNote(stringifyNote(pluginBody, { title: "x" }))).toEqual({
      data: { title: "x" },
      content: pluginBody,
    })
  })
})

// ── mergeFrontmatter ─────────────────────────────────────────────

describe("mergeFrontmatter", () => {
  it("adds new keys and overwrites matching ones", () => {
    expect(
      mergeFrontmatter({ title: "old", type: "note" }, { title: "new" }),
    ).toEqual({ title: "new", type: "note" })
  })

  it("removes keys explicitly set to null in updates", () => {
    expect(
      mergeFrontmatter({ title: "old", draft: true }, { draft: null }),
    ).toEqual({ title: "old" })
  })

  it("preserves nulls already present in existing frontmatter", () => {
    expect(mergeFrontmatter({ due: null }, { title: "x" })).toEqual({
      due: null,
      title: "x",
    })
  })
})

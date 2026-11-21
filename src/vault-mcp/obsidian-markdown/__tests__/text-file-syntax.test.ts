import { describe, expect, it } from "vitest"
import { assertTextFileSyntax } from "../text-file-syntax.js"
import { LINEAR_GROWTH_ALLOWANCE } from "./helpers/linear-timing.js"

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff)

/** The message JSON.parse gives for `text`, read the way production reads it. */
const jsonParseMessage = (text: string): string => {
  try {
    JSON.parse(text)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`expected JSON.parse to refuse ${JSON.stringify(text)}`)
}

/** A flat YAML mapping of `keyCount` distinct keys. */
const buildBaseMapping = (keyCount: number): string => {
  return Array.from({ length: keyCount }, (_, index) => `key${index}: value`).join("\n")
}

/** The fastest of three runs, in milliseconds, so one slow run cannot fail the test. */
const fastestRunMs = (run: () => void): number => {
  const durations = Array.from({ length: 3 }, () => {
    const startedAt = performance.now()
    run()
    return performance.now() - startedAt
  })
  return Math.min(...durations)
}

describe("assertTextFileSyntax — .canvas", () => {
  it("accepts a canvas with nodes and edges", () => {
    const canvas = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "A" }], edges: [] })

    expect(() =>
      assertTextFileSyntax({ path: "Boards/plan.canvas", content: canvas }),
    ).not.toThrow()
  })

  it("accepts an empty canvas object", () => {
    expect(() => assertTextFileSyntax({ path: "Boards/plan.canvas", content: "{}" })).not.toThrow()
  })

  it("accepts a canvas that starts with a byte-order mark", () => {
    const content = `${BYTE_ORDER_MARK}{"nodes":[]}`

    expect(() => assertTextFileSyntax({ path: "Boards/plan.canvas", content })).not.toThrow()
  })

  it("refuses a canvas that is not JSON, with the canvas parser's message", () => {
    expect(() => assertTextFileSyntax({ path: "Boards/plan.canvas", content: "{nodes" })).toThrow(
      new Error(`invalid .canvas JSON: ${jsonParseMessage("{nodes")}`),
    )
  })

  it("refuses a canvas whose top level is an array", () => {
    expect(() => assertTextFileSyntax({ path: "Boards/plan.canvas", content: "[]" })).toThrow(
      new Error("invalid .canvas JSON: the top level must be an object"),
    )
  })

  it("refuses a canvas whose nodes are not an array", () => {
    const content = JSON.stringify({ nodes: {} })

    expect(() => assertTextFileSyntax({ path: "Boards/plan.canvas", content })).toThrow(
      new Error('invalid .canvas JSON: "nodes" must be an array'),
    )
  })

  it("refuses a canvas whose edges are null", () => {
    const content = JSON.stringify({ nodes: [], edges: null })

    expect(() => assertTextFileSyntax({ path: "Boards/plan.canvas", content })).toThrow(
      new Error('invalid .canvas JSON: "edges" must be an array'),
    )
  })

  it("checks a canvas whatever the extension's letter case", () => {
    expect(() => assertTextFileSyntax({ path: "Boards/plan.CANVAS", content: "[]" })).toThrow(
      new Error("invalid .canvas JSON: the top level must be an object"),
    )
  })
})

describe("assertTextFileSyntax — .json", () => {
  it("accepts any JSON value, an array included", () => {
    expect(() => assertTextFileSyntax({ path: "data/items.json", content: "[1, 2]" })).not.toThrow()
  })

  it("accepts JSON that starts with a byte-order mark", () => {
    const content = `${BYTE_ORDER_MARK}{"a":1}`

    expect(() => assertTextFileSyntax({ path: "data/items.json", content })).not.toThrow()
  })

  it("refuses JSON with a comment", () => {
    const content = '{ // note\n "a": 1 }'

    expect(() => assertTextFileSyntax({ path: "data/items.json", content })).toThrow(
      new Error(`invalid JSON: ${jsonParseMessage(content)}`),
    )
  })

  it("refuses an empty .json file", () => {
    expect(() => assertTextFileSyntax({ path: "data/items.json", content: "" })).toThrow(
      new Error(`invalid JSON: ${jsonParseMessage("")}`),
    )
  })
})

describe("assertTextFileSyntax — .base", () => {
  it("accepts a Bases mapping", () => {
    const content = "views:\n  - type: table\n    name: Table\n"

    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content })).not.toThrow()
  })

  it("accepts an empty Base", () => {
    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content: "" })).not.toThrow()
  })

  it("accepts a Base holding only a comment", () => {
    expect(() =>
      assertTextFileSyntax({ path: "Bases/books.base", content: "# to fill in\n" }),
    ).not.toThrow()
  })

  it("accepts a Base that starts with a byte-order mark", () => {
    const content = `${BYTE_ORDER_MARK}views: []\n`

    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content })).not.toThrow()
  })

  it("refuses a Base with a tab used as indentation, naming the line and column", () => {
    const content = "views:\n\t- type: table\n"

    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content })).toThrow(
      new Error("invalid .base YAML at line 2, column 1: Tabs are not allowed as indentation"),
    )
  })

  it("names a first-line error's column without counting a leading byte-order mark", () => {
    const content = `${BYTE_ORDER_MARK}views: a: b\n`

    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content })).toThrow(
      new Error(
        "invalid .base YAML at line 1, column 8: Nested mappings are not allowed in compact mappings",
      ),
    )
  })

  it("refuses a Base with a duplicate key, naming its line", () => {
    const content = "filters: a\nviews: []\nfilters: b\n"

    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content })).toThrow(
      new Error("invalid .base YAML at line 3, column 1: Map keys must be unique"),
    )
  })

  it("refuses a Base holding two documents", () => {
    const content = "views: []\n---\nviews: []\n"

    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content })).toThrow(
      new Error(
        "invalid .base YAML at line 2, column 1: Source contains multiple documents; please use YAML.parseAllDocuments()",
      ),
    )
  })

  it("refuses a Base whose top level is a scalar", () => {
    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content: "just text" })).toThrow(
      new Error("invalid .base YAML: the top level must be a mapping"),
    )
  })

  it("refuses a Base whose top level is a list", () => {
    expect(() => assertTextFileSyntax({ path: "Bases/books.base", content: "- a\n- b\n" })).toThrow(
      new Error("invalid .base YAML: the top level must be a mapping"),
    )
  })

  it("checks a large Base in time that grows linearly with its key count", () => {
    const smallBase = buildBaseMapping(3_000)
    const largeBase = buildBaseMapping(24_000)

    const smallMs = fastestRunMs(() => {
      assertTextFileSyntax({ path: "Bases/large.base", content: smallBase })
    })
    const largeMs = fastestRunMs(() => {
      assertTextFileSyntax({ path: "Bases/large.base", content: largeBase })
    })

    // Eight times the keys; the library's own duplicate-key check grows about 56-fold here
    expect(largeMs / smallMs).toBeLessThanOrEqual(8 * LINEAR_GROWTH_ALLOWANCE)
  }, 30_000)
})

describe("assertTextFileSyntax — other extensions", () => {
  it.each([
    { label: "a .yaml file", path: "config/settings.yaml", content: "- not: [valid" },
    { label: "a JSON Lines file", path: "data/events.jsonl", content: '{"a":1}\n{"a":2}\n' },
    { label: "a text file", path: "notes/todo.txt", content: "{not json" },
    { label: "a file with no extension", path: "scripts/Makefile", content: "all:\n\techo" },
  ])("accepts any text in $label", ({ path, content }) => {
    expect(() => assertTextFileSyntax({ path, content })).not.toThrow()
  })
})

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { Script } from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { list } from "../list.js"
import type { RemarkParserMembers } from "../../remark-parse-types.js"

/** These values exercise every whitespace code point accepted by the replaced expression. */
const WHITESPACE = [
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  " ",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
]
/** The fixed seed makes every equivalence failure repeatable. */
const RANDOM_SEED = 0x712bca49
/** This budget bounds a regressed predicate even when it blocks its own event loop. */
const CHILD_TIMEOUT_MS = 2_000
/** Repetition makes quadratic retries exceed the budget without timing ratios. */
const TIMING_REPETITIONS = 20
/** This expression is the MIT remark-parse 8.0.3 loose-list predicate. */
const UPSTREAM_LOOSE_LIST_ITEM_RE = /\n\n(?!\s*$)/

const predicateSource = (): string => {
  const sourcePath = new URL("../list.ts", import.meta.url)
  const source = ts.createSourceFile(
    "list.ts",
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
  )
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
  const predicate = declarations.find(
    (declaration) => declaration.name.getText(source) === "hasContentAfterBlankLine",
  )
  const whitespace = declarations.find(
    (declaration) => declaration.name.getText(source) === "WHITESPACE_RE",
  )

  if (!predicate?.initializer || !whitespace?.initializer)
    throw new Error("list predicate is missing")

  const expression = `const WHITESPACE_RE = ${whitespace.initializer.getText(source)}; (${predicate.initializer.getText(source)})`

  return ts.transpile(expression, { target: ts.ScriptTarget.ESNext })
}

const isPredicate = (value: unknown): value is (content: string) => boolean =>
  typeof value === "function"

const loadPredicate = (): ((content: string) => boolean) => {
  const predicate: unknown = new Script(predicateSource()).runInNewContext()

  if (!isPredicate(predicate)) throw new Error("list predicate did not evaluate to a function")

  return predicate
}

type Parser = RemarkParserMembers & {
  setOptions: (options: { commonmark: boolean; gfm: boolean }) => void
  parse: () => unknown
}

type ParserConstructor = new (document: string, file: string) => Parser

const isParserConstructor = (value: unknown): value is ParserConstructor =>
  typeof value === "function"

const parseList = (document: string, listTokenizer?: typeof list): unknown => {
  const require = createRequire(import.meta.url)
  const Parser: unknown = require("remark-parse/lib/parser.js")

  if (!isParserConstructor(Parser)) throw new Error("remark parser is missing")

  const parser = new Parser(document, document)

  parser.setOptions({ commonmark: true, gfm: true })

  if (listTokenizer) parser.blockTokenizers = { ...parser.blockTokenizers, list: listTokenizer }

  return parser.parse()
}

const createRandom = (): (() => number) => {
  // The seeded generator advances once for each character choice.
  let state = RANDOM_SEED

  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

describe("list loose-item predicate", () => {
  it.each([
    { label: "empty content", content: "", expected: false },
    { label: "no blank line", content: "a\nb", expected: false },
    { label: "trailing blank line", content: "a\n\n", expected: false },
    { label: "content after the first pair", content: "a\n\nb", expected: true },
    { label: "content after overlapping pairs", content: "a\n\n\n\nb", expected: true },
    { label: "content before trailing pairs", content: "a\n\nb\n\n", expected: true },
    { label: "CRLF blank line", content: "a\r\n\r\nb", expected: false },
    { label: "CR blank line", content: "a\r\rb", expected: false },
    { label: "CR after LF pair", content: "a\n\n\rb", expected: true },
    { label: "Unicode line endings", content: "a\u2028\u2029b", expected: false },
    { label: "zero-width space", content: "a\n\n\u200b", expected: true },
    { label: "next-line character", content: "a\n\n\u0085", expected: true },
    { label: "lone surrogate", content: "a\n\n\ud800", expected: true },
  ])("preserves $label", ({ content, expected }) => {
    expect(loadPredicate()(content)).toBe(expected)
  })

  it.each(
    WHITESPACE.map((character) => ({ character, label: character.charCodeAt(0).toString(16) })),
  )("treats U+$label as trailing whitespace", ({ character }) => {
    const predicate = loadPredicate()

    expect(predicate(`a\n\n${character.repeat(4)}`)).toBe(false)
    expect(predicate(`a\n\n${character.repeat(4)}b`)).toBe(true)
  })

  it("matches the replaced expression on 10000 fixed-seed strings", () => {
    const predicate = loadPredicate()
    const random = createRandom()
    const alphabet = [...WHITESPACE, "a", "#", "\u0085", "\u200b", "\ud800", "\udfff"]
    const mismatches: { content: string; expected: boolean; actual: boolean }[] = []

    for (let index = 0; index < 10_000; index += 1) {
      const length = Math.floor(random() * 160)
      const prefix = index % 2 === 0 ? "\n\n" : ""
      const content =
        prefix +
        Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("")
      const expected = UPSTREAM_LOOSE_LIST_ITEM_RE.test(content)
      const actual = predicate(content)

      if (actual !== expected) mismatches.push({ content, expected, actual })
    }

    expect(mismatches).toEqual([])
  })

  it("finishes newline-only suffixes within a parent-enforced child deadline", () => {
    const source = predicateSource()

    for (const length of [10_000, 20_000, 40_000]) {
      const childSource = `
        const predicate = eval(${JSON.stringify(source)});
        const input = "\\n".repeat(${length});
        const start = performance.now();
        for (let index = 0; index < ${TIMING_REPETITIONS}; index += 1) {
          if (predicate(input) !== false) throw new Error("newline-only content became loose");
          if (predicate(input + "x") !== true) throw new Error("content after newlines became tight");
        }
        process.stdout.write(JSON.stringify({ length: ${length}, milliseconds: performance.now() - start, trailing: false, content: true }));
      `
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource], {
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        killSignal: "SIGKILL",
      })

      expect({
        length,
        error: child.error?.message,
        signal: child.signal,
        status: child.status,
        stderr: child.stderr,
      }).toEqual({ length, error: undefined, signal: null, status: 0, stderr: "" })
      const result: unknown = JSON.parse(child.stdout)

      expect(result).toEqual({
        length,
        milliseconds: expect.any(Number),
        trailing: false,
        content: true,
      })
    }
  })
})

describe("list tokenizer", () => {
  it.each([
    { label: "tight paragraphs", document: "- a\n- b" },
    { label: "loose item", document: "- a\n\n  b\n- c" },
    { label: "trailing indented blank lines", document: "- a\n  \n  \n- b" },
    { label: "CRLF lines", document: "- a\r\n\r\n  b\r\n- c" },
    { label: "a single CRLF line break", document: "- a\r\n- b" },
    { label: "task and nested items", document: "- [x] a\n\n  b\n  - c" },
    { label: "a dash and no-break space, which is no bullet", document: "- a\n-\u00a0\n- b" },
  ])("preserves the upstream AST for $label", ({ document }) => {
    expect(parseList(document, list)).toEqual(parseList(document))
  })
})

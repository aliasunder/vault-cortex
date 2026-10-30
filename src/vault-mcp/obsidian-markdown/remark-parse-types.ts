/** Local types for the parts of remark-parse 8 that the Obsidian parser
 *  extends. The package's own `types/index.d.ts` describes a unified plugin,
 *  not a parser extension: it has no tokenizer tables, options, offset table,
 *  `tokenizeInline`, interrupt lists or `(doc, file)` constructor, its
 *  `Tokenizer` overloads reject a node-returning function, and its `Eat` has
 *  no `now()`. Everything here was read off the parser's own source. */

/** A point in the source, as `eat.now()` reports it. */
export type SourcePoint = { line: number; column: number; offset: number }

type SourcePosition = { start: SourcePoint; end: SourcePoint; indent?: number[] }

/** A node of the parsed tree. Only `type`, `value` and `children` are read
 *  back; the index signature admits the fields remark's own tokenizers set
 *  (`depth`, `url`, `ordered`, …) without naming each. */
export type ParsedNode = {
  type: string
  value?: string
  children?: ParsedNode[]
  position?: SourcePosition
  [field: string]: unknown
}

/** What `eat(subvalue)` returns: a function that attaches the node, plus
 *  `reset` (attach and give the text back) and `test` (position only). */
type EatenNodeAdder = {
  (node: ParsedNode, parent?: ParsedNode): ParsedNode
  reset: (node: ParsedNode, parent?: ParsedNode) => ParsedNode
  test: () => SourcePosition
}

export type Eat = {
  (subvalue: string): EatenNodeAdder
  now: () => SourcePoint
  file: ParserFile
}

/** A tokenizer returns the eaten node, `true` in silent mode when it would
 *  match, or nothing when it does not match. */
export type TokenizerResult = ParsedNode | true | undefined

export type Tokenizer = (
  this: RemarkParserMembers,
  eat: Eat,
  value: string,
  silent?: boolean,
) => TokenizerResult

/** Finds where an inline tokenizer could next match, or -1. */
export type Locator = (this: RemarkParserMembers, value: string, fromIndex: number) => number

export type InlineTokenizer = Tokenizer & {
  locator?: Locator
  notInLink?: boolean
}

/** A block tokenizer's name, with the option values under which it may cut
 *  the enclosing block short. */
export type InterruptRule = [string, { commonmark?: boolean; pedantic?: boolean }?]

type ParserOptions = {
  position: boolean
  gfm: boolean
  commonmark: boolean
  pedantic: boolean
  blocks: string[]
}

/** The file the parser reads: `String(file)` is the text, and the two
 *  methods receive remark's diagnostics. */
export type ParserFile = {
  toString: () => string
  fail: (reason: Error | string, position?: unknown) => never
  message: (reason: unknown, position?: unknown) => void
}

export type RemarkParserMembers = {
  file: ParserFile
  /** Column shift per line, which nested block tokenizers add to when they
   *  strip a prefix (`> `, a list bullet) before tokenizing the rest. */
  offset: Record<number, number>
  options: ParserOptions
  escape: string[]
  inList: boolean
  inBlock: boolean
  inLink: boolean
  atStart: boolean
  blockTokenizers: Record<string, Tokenizer>
  inlineTokenizers: Record<string, InlineTokenizer>
  blockMethods: string[]
  inlineMethods: string[]
  interruptParagraph: InterruptRule[]
  interruptList: InterruptRule[]
  interruptBlockquote: InterruptRule[]
  tokenizeBlock: (value: string, location: SourcePoint) => ParsedNode[]
  tokenizeInline: (value: string, location: SourcePoint) => ParsedNode[]
  setOptions: (options: Partial<ParserOptions>) => RemarkParserMembers
  parse: () => ParsedNode
  enterBlock: () => () => void
  enterList: () => () => void
  enterLink: () => () => void
  unescape: (value: string) => string
  toOffset: (point: { line: number; column: number }) => number
}

type RemarkParserConstructor = new (doc: string, file: ParserFile) => RemarkParserMembers

export type RemarkParseModule = { Parser: RemarkParserConstructor }

export const isRemarkParseModule = (value: unknown): value is RemarkParseModule => {
  if (typeof value !== "function") return false
  return "Parser" in value && typeof value.Parser === "function"
}

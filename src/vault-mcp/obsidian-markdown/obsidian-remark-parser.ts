/** A remark-parse 8 parser with Obsidian's syntax added, built to read a
 *  note the way Obsidian 1.14.4's metadata cache does. Every rule here was
 *  measured against that Obsidian build (the body-tag vectors and probes),
 *  not read from it: Obsidian's parser is a fork of remark-parse 8 with its
 *  syntax added as tokenizers, so this one adds the same syntax to the
 *  pinned remark-parse 8.0.3 and runs it in CommonMark mode, which is the
 *  mode the escapes and indentation rules matched.
 *
 *  Added block syntax: `$$` math, `%% %%` comments, `[^id]:` footnote
 *  definitions, and callouts (in the ported blockquote). Added inline
 *  syntax: `#tag`, `==highlight==` (with a leading colour marker),
 *  `[[wikilink]]` and `![[embed]]`, `$math$` and `$$math$$`, `[^id]` and
 *  `^[inline]` footnotes, `%% %%` comments and ` ^block-id`. Strikethrough is
 *  re-done beside highlight, because Obsidian reads both with one grammar. */

import { createRequire } from "node:module"
import { blockquote } from "./remark-ports/blockquote.js"
import { getIndentation } from "./remark-ports/get-indentation.js"
import { interrupt } from "./remark-ports/interrupt.js"
import { isAsciiDigit, list } from "./remark-ports/list.js"
import {
  isRemarkParseModule,
  type Eat,
  type InlineTokenizer,
  type InterruptRule,
  type Locator,
  type ParsedNode,
  type ParserFile,
  type RemarkParserMembers,
  type SourcePoint,
  type Tokenizer,
  type TokenizerResult,
} from "./remark-parse-types.js"
import { isDigitsOnlyName, TAG_NAME_CHARACTER_CLASS } from "./tags.js"

// remark-parse 8 is CommonJS with no `exports` map, and the compiled ESM
// build resolves its internal files by `.js` path only, so a CommonJS
// require is the one load that works on both the test and production paths
const requireModule = createRequire(import.meta.url)
const remarkParseModule: unknown = requireModule("remark-parse")

if (!isRemarkParseModule(remarkParseModule)) {
  throw new Error("remark-parse did not export a Parser")
}

const RemarkParser = remarkParseModule.Parser

// ── Inline helpers ─────────────────────────────────────────────────────────

/** Matches one whitespace character as Obsidian's inline rules count it,
 *  which is JavaScript's `\s`: a tag may start after a no-break space or an
 *  em space, and a highlight may not open before one. */
const WHITESPACE_RE = /\s/

const isSpaceOrTab = (character: string): boolean => character === " " || character === "\t"

/** The point `offset` characters after `point`, on the same line. */
const advancePoint = (point: SourcePoint, offset: number): SourcePoint => ({
  line: point.line,
  column: point.column + offset,
  offset: point.offset + offset,
})

const indexOfLocator = (needle: string): Locator => {
  return function (value, fromIndex) {
    return value.indexOf(needle, fromIndex)
  }
}

/** A locator for a token that may start only after a certain character,
 *  from a regex of that character followed by the token's start. The search
 *  begins one character before `fromIndex`, so a token right at `fromIndex`
 *  is found when the character before it fits. remark's text tokenizer is
 *  the only caller of locators and always passes a `fromIndex` of 1, so the
 *  search never starts before the value. */
const locatorAfterCharacter = (tokenAfterCharacter: RegExp): Locator => {
  return function (value, fromIndex) {
    const searchStart = fromIndex - 1
    const match = tokenAfterCharacter.exec(value.slice(searchStart))

    // The match starts at the character before the token
    return match ? searchStart + match.index + 1 : -1
  }
}

const withLocator = (tokenizer: Tokenizer, locator: Locator): InlineTokenizer => {
  return Object.assign(tokenizer, { locator })
}

// ── Tags ───────────────────────────────────────────────────────────────────

/** Matches a body tag at the start of the value: `#` and its name. */
const TAG_RE = new RegExp(`^#(${TAG_NAME_CHARACTER_CLASS}+)`)

/** Matches a `#` that a tag may start at while text is being read: after a
 *  whitespace character, and followed by a tag-name character. A `#` right
 *  after other text (`foo#bar`) is text; a `#` at the start of the value is
 *  the tag tokenizer's own case, since text is read only once no tokenizer
 *  matched there. */
const TAG_AFTER_WHITESPACE_RE = new RegExp(`\\s#${TAG_NAME_CHARACTER_CLASS}`)

const tagTokenizer: InlineTokenizer = withLocator(function (eat, value, silent): TokenizerResult {
  const match = TAG_RE.exec(value)
  const tagName = match?.[1]

  // A name of digits only stays text, and text blocks the next tag, so
  // `#1984#x` holds no tag at all
  if (!match || !tagName || isDigitsOnlyName(tagName)) return undefined
  if (silent) return true

  return eat(match[0])({ type: "tag", value: tagName })
}, locatorAfterCharacter(TAG_AFTER_WHITESPACE_RE))

// ── Wikilinks and embeds ───────────────────────────────────────────────────

/** Matches a wikilink or embed up to its first `]]`: the target, heading,
 *  block and alias are one token whose text is never read for tags, and it
 *  cannot be empty or span lines. */
const WIKILINK_RE = /^(!?)\[\[([^\n]+?)\]\]/

const wikilinkTokenizer: InlineTokenizer = withLocator(
  function (eat, value, silent): TokenizerResult {
    const match = WIKILINK_RE.exec(value)
    const target = match?.[2]

    // A second `[[` before the `]]` means the first one opened nothing
    if (!match || !target || target.includes("[[")) return undefined
    if (silent) return true

    const type = match[1] ? "embed" : "wikilink"

    return eat(match[0])({ type, value: target })
  },
  function (value, fromIndex) {
    const index = value.indexOf("[[", fromIndex)

    // An embed's `!` sits one before the `[[`, which a locator may not
    // report before `fromIndex`
    if (index > fromIndex && value.charAt(index - 1) === "!") return index - 1
    return index
  },
)

// ── Footnotes ──────────────────────────────────────────────────────────────

/** Matches a footnote reference, whose label is one or more characters
 *  with no whitespace or `]` (`[^a[b]` is one). */
const FOOTNOTE_REFERENCE_RE = /^\[\^([^\s\]]+)\]/

const footnoteReferenceTokenizer: InlineTokenizer = withLocator(function (
  eat,
  value,
  silent,
): TokenizerResult {
  const match = FOOTNOTE_REFERENCE_RE.exec(value)
  const label = match?.[1]

  if (!match || !label) return undefined
  if (silent) return true

  return eat(match[0])({ type: "footnoteReference", value: label })
}, indexOfLocator("[^"))

const countBacktickRun = (value: string, runStart: number): number => {
  // The scan measures a run of backticks, so its index is mutable parser state
  let index = runStart

  while (value.charAt(index) === "`") index += 1

  return index - runStart
}

/** The index just past the run that closes a code span opening with the run
 *  at `runStart`, which is the next run of exactly the same length, or -1. */
const findCodeSpanEnd = (value: string, runStart: number): number => {
  const openLength = countBacktickRun(value, runStart)
  // The scan jumps from run to run, so its index is mutable parser state
  let index = runStart + openLength

  while (index < value.length) {
    if (value.charAt(index) !== "`") {
      index += 1
      continue
    }

    const runLength = countBacktickRun(value, index)

    if (runLength === openLength) return index + runLength

    index += runLength
  }

  return -1
}

/** The index just past the `]` that closes a bracketed span opening at
 *  `openIndex`, or -1. Nested brackets and backslash escapes are honoured,
 *  and a code span is skipped whole, so a `]` inside one does not close the
 *  span; a backtick run with no closing run fails the whole span. */
const findBracketedSpanEnd = (value: string, openIndex: number): number => {
  // The scan threads its index and bracket depth through the value, so both
  // are mutable parser state.
  let index = openIndex + 1
  let depth = 0

  while (index < value.length) {
    const character = value.charAt(index)

    if (character === "\\") {
      index += 2
      continue
    }

    if (character === "`") {
      const codeSpanEnd = findCodeSpanEnd(value, index)

      if (codeSpanEnd === -1) return -1

      index = codeSpanEnd
      continue
    }

    if (character === "[") depth += 1

    if (character === "]") {
      if (depth === 0) return index + 1
      depth -= 1
    }

    index += 1
  }

  return -1
}

const inlineFootnoteTokenizer: InlineTokenizer = withLocator(function (
  eat,
  value,
  silent,
): TokenizerResult {
  if (!value.startsWith("^[")) return undefined

  const openingBracketIndex = 1
  const contentStart = openingBracketIndex + 1
  const end = findBracketedSpanEnd(value, openingBracketIndex)

  if (end === -1) return undefined
  if (silent) return true

  const closingBracketIndex = end - 1
  const content = value.slice(contentStart, closingBracketIndex)

  return eat(value.slice(0, end))({
    type: "inlineFootnote",
    children: this.tokenizeInline(content, advancePoint(eat.now(), contentStart)),
  })
}, indexOfLocator("^["))

/** Matches the start of a link or image reference whose label begins `^`. */
const CARET_REFERENCE_START_RE = /^!?\[\^/

/** remark's reference tokenizer, except that a `[^` span is never a link or
 *  image reference, because to Obsidian it is a footnote reference or text. */
const withoutFootnoteLabels = (reference: InlineTokenizer): InlineTokenizer => {
  const { locator } = reference

  if (!locator) throw new Error("remark-parse's reference tokenizer has no locator")

  return withLocator(function (eat, value, silent) {
    if (CARET_REFERENCE_START_RE.test(value)) return undefined
    return reference.call(this, eat, value, silent)
  }, locator)
}

// ── Highlight and strikethrough ────────────────────────────────────────────

/** The colour markers a highlight may open with (`==🔴text==`). Obsidian
 *  reads the marker as the highlight's colour, not as its text, so a tag may
 *  start right after it. Measured one by one: six colours of circle and
 *  square; the brown, black and white ones, hearts, diamonds and a marker
 *  followed by a variation selector are plain text. */
const HIGHLIGHT_COLOUR_MARKERS = [
  "🔴",
  "🟠",
  "🟡",
  "🟢",
  "🔵",
  "🟣",
  "🟥",
  "🟧",
  "🟨",
  "🟩",
  "🟦",
  "🟪",
]

const findHighlightColourMarker = (content: string): string | undefined => {
  return HIGHLIGHT_COLOUR_MARKERS.find((marker) => content.startsWith(marker))
}

/** What sets `==highlight==` apart from `~~strikethrough~~`: a colour
 *  marker may open it, and `====` is no highlight, while `~~~~` is an empty
 *  strikethrough. */
type DelimitedSpanRules = { type: string; allowsColourMarker: boolean; allowsEmptyContent: boolean }

/** A span between two copies of a two-character delimiter, as Obsidian reads
 *  `==highlight==` and `~~strikethrough~~`: the content may not start with
 *  whitespace, the closing delimiter may not follow whitespace (the scan
 *  moves on to the next one), and no escape is honoured. */
const createDelimitedSpanTokenizer = (
  delimiter: string,
  rules: DelimitedSpanRules,
): InlineTokenizer => {
  const contentStart = delimiter.length

  return withLocator(function (eat, value, silent): TokenizerResult {
    if (!value.startsWith(delimiter) || WHITESPACE_RE.test(value.charAt(contentStart))) {
      return undefined
    }

    const closeIndex = findDelimitedSpanClose(value, delimiter)
    const isEmpty = closeIndex === contentStart

    // An empty highlight fails outright rather than looking further on
    if (closeIndex === -1 || (isEmpty && !rules.allowsEmptyContent)) return undefined
    if (silent) return true

    const content = value.slice(contentStart, closeIndex)
    const colourMarker = rules.allowsColourMarker ? findHighlightColourMarker(content) : undefined
    const textStart = colourMarker ? colourMarker.length : 0
    const children = this.tokenizeInline(
      content.slice(textStart),
      advancePoint(eat.now(), contentStart + textStart),
    )

    return eat(value.slice(0, closeIndex + delimiter.length))({ type: rules.type, children })
  }, indexOfLocator(delimiter))
}

const findDelimitedSpanClose = (value: string, delimiter: string): number => {
  // The scan resumes after each rejected closer, so its index is mutable
  // parser state.
  let index = value.indexOf(delimiter, delimiter.length)

  while (index !== -1) {
    if (!WHITESPACE_RE.test(value.charAt(index - 1))) return index

    index = value.indexOf(delimiter, index + 1)
  }

  return -1
}

const highlightTokenizer = createDelimitedSpanTokenizer("==", {
  type: "highlight",
  allowsColourMarker: true,
  allowsEmptyContent: false,
})
const deletionTokenizer = createDelimitedSpanTokenizer("~~", {
  type: "delete",
  allowsColourMarker: false,
  allowsEmptyContent: true,
})

// ── Math ───────────────────────────────────────────────────────────────────

/** The index of the next unescaped `needle` at or after `fromIndex`, or -1.
 *  A backslash hides the character after it, so `\$` never closes math. */
const indexOfUnescaped = (value: string, needle: string, fromIndex: number): number => {
  // The scan jumps past each escape pair, so its index is mutable parser state.
  let index = fromIndex

  while (index < value.length) {
    const character = value.charAt(index)

    if (character === "\\") {
      index += 2
      continue
    }

    if (value.startsWith(needle, index)) return index

    index += 1
  }

  return -1
}

/** Inline math, as Obsidian reads it:
 *  - `$$…$$` may hold anything, spaces and line breaks included, and may be
 *    empty;
 *  - `$…$` may not start with `$`, a space or a tab, may not end with a
 *    space or a tab (a line break is fine either side), may not be empty,
 *    and may not be followed by a digit (`$5 and $10` is not math), so the
 *    scan moves on past a `$` that fails those checks.
 *  Neither has its content read. */
const inlineMathTokenizer: InlineTokenizer = withLocator(function (
  eat,
  value,
  silent,
): TokenizerResult {
  if (value.charAt(0) !== "$") return undefined

  const displayClose = value.charAt(1) === "$" ? indexOfUnescaped(value, "$$", 2) : -1

  if (displayClose !== -1) {
    if (silent) return true
    return eat(value.slice(0, displayClose + 2))({ type: "inlineMath" })
  }

  const closeIndex = findInlineMathClose(value)

  if (closeIndex === -1) return undefined
  if (silent) return true

  return eat(value.slice(0, closeIndex + 1))({ type: "inlineMath" })
}, indexOfLocator("$"))

const findInlineMathClose = (value: string): number => {
  if (isSpaceOrTab(value.charAt(1)) || value.charAt(1) === "$") return -1

  // The scan resumes after each rejected closer, so its index is mutable
  // parser state. It starts at 1 so that a backslash there hides the `$`
  // after it (`$\$m$`); a closer still lands at 2 or later, since the guard
  // above has ruled out a `$` at 1.
  let index = indexOfUnescaped(value, "$", 1)

  while (index !== -1) {
    const closesMath =
      !isSpaceOrTab(value.charAt(index - 1)) && !isAsciiDigit(value.charAt(index + 1))

    if (closesMath) return index

    index = indexOfUnescaped(value, "$", index + 1)
  }

  return -1
}

/** Matches a math block's opening line, which is up to three spaces, a run
 *  of two or more `$`, a rest with no `$` in it (a line that also holds a
 *  closer is inline math) and a line feed (a last line is inline math too). */
const MATH_BLOCK_OPENER_RE = /^ {0,3}(\$\$+)[^$\n]*\n/

/** Matches a line that closes a math block: anything with no `$` before a
 *  run of `$` (`a $$` closes, `$ $$` does not), then only spaces (a tab
 *  after the run keeps the block open). */
const MATH_BLOCK_CLOSER_RE = /^[^$\n]*(\$+) *$/

/** A `$$` math block, whose content is never read. It runs to the first line
 *  that closes it with a `$` run at least as long as the opener's, or to the
 *  end of the document. */
const mathBlockTokenizer: Tokenizer = function (eat, value, silent): TokenizerResult {
  const opener = MATH_BLOCK_OPENER_RE.exec(value)
  const openerRun = opener?.[1]

  if (!opener || !openerRun) return undefined
  if (silent) return true

  const closerEnd = findMathBlockCloserEnd(value, opener[0].length, openerRun.length)

  return eat(value.slice(0, closerEnd))({ type: "math" })
}

/** The index just past the line that closes a math block whose content
 *  starts at `contentStart`, or the value's length when no line does. */
const findMathBlockCloserEnd = (value: string, contentStart: number, openerRun: number): number => {
  // The scan walks line starts, so its index is mutable parser state.
  let lineStart = contentStart

  while (lineStart < value.length) {
    const lineFeedIndex = value.indexOf("\n", lineStart)
    const lineEnd = lineFeedIndex === -1 ? value.length : lineFeedIndex
    const closer = MATH_BLOCK_CLOSER_RE.exec(value.slice(lineStart, lineEnd))
    const closerRun = closer?.[1]

    if (closerRun && closerRun.length >= openerRun) return lineEnd

    lineStart = lineEnd + 1
  }

  return value.length
}

// ── Comments ───────────────────────────────────────────────────────────────

/** The index of the `%%` that closes a comment opened at the start of
 *  `value`, or -1: the first `%%` on the opener's own line, a code span or
 *  escape before it notwithstanding. */
const findInlineCommentClose = (value: string): number => {
  const closeIndex = value.indexOf("%%", 2)
  const lineEnd = value.indexOf("\n", 2)

  return lineEnd !== -1 && closeIndex > lineEnd ? -1 : closeIndex
}

/** An inline `%% %%` comment: one opened after other text on its line, or
 *  one that opens a line but has another `%` on that line. Its text is read
 *  as inline content, so a tag inside it counts; an unclosed one is text. */
const inlineCommentTokenizer: InlineTokenizer = withLocator(function (
  eat,
  value,
  silent,
): TokenizerResult {
  if (!value.startsWith("%%")) return undefined

  const closeIndex = findInlineCommentClose(value)

  if (closeIndex === -1) return undefined
  if (silent) return true

  return eat(value.slice(0, closeIndex + 2))({
    type: "comment",
    children: this.tokenizeInline(value.slice(2, closeIndex), advancePoint(eat.now(), 2)),
  })
}, indexOfLocator("%%"))

/** Matches a line that opens a block comment: any number of spaces (never
 *  a tab), `%%`, and no other `%` on the line. A line with another `%`
 *  (`%% a %%`, `%%#c%`) is read inline instead. */
const COMMENT_BLOCK_OPENER_RE = /^( *%%)[^%\n]*(?:\n|$)/

/** A `%%` comment that opens a line. It runs to the next `%%` anywhere
 *  below, blank lines and other blocks included, or to the end of the
 *  document, and the rest of its closing line is left for the block
 *  tokenizers (an indented tail is code). Its text is read as inline
 *  content, so a `>` or fence inside it is text and a tag inside it counts.
 *  It cuts a paragraph, a list or a quote short, including through a lazy
 *  line (one that continues a list item or quote without its marker or
 *  indent): `    %%#a` ends a list and then reads as indented code, while
 *  ` \t%%#a` stays a lazy line. */
const commentBlockTokenizer: Tokenizer = function (eat, value, silent): TokenizerResult {
  const opener = COMMENT_BLOCK_OPENER_RE.exec(value)
  const openerText = opener?.[1]

  if (!opener || !openerText) return undefined
  if (silent) return true

  const contentStart = openerText.length
  const closeIndex = value.indexOf("%%", contentStart)
  const contentEnd = closeIndex === -1 ? value.length : closeIndex
  const subvalue = closeIndex === -1 ? value : value.slice(0, closeIndex + 2)

  return eat(subvalue)({
    type: "comment",
    children: this.tokenizeInline(
      value.slice(contentStart, contentEnd),
      advancePoint(eat.now(), contentStart),
    ),
  })
}

// ── Tables ─────────────────────────────────────────────────────────────────

/** The lines of `value` that a table may hold: the first two whatever they
 *  are (header and alignment rows), then every line that starts with `|`
 *  exactly when the header does, up to the first that does not. Lines are
 *  read one at a time, so a long document is not split on every attempt. */
const collectTableLines = (value: string): string[] => {
  const lines: string[] = []
  // The scan walks line starts and learns the header's framing from the
  // first line, so both are mutable parser state
  let lineStart = 0
  let headerLeadsWithPipe = false

  while (lineStart <= value.length) {
    const lineFeedIndex = value.indexOf("\n", lineStart)
    const lineEnd = lineFeedIndex === -1 ? value.length : lineFeedIndex
    const line = value.slice(lineStart, lineEnd)
    const isBodyRow = lines.length >= 2

    if (lines.length === 0) headerLeadsWithPipe = line.startsWith("|")
    if (isBodyRow && line.startsWith("|") !== headerLeadsWithPipe) break

    lines.push(line)
    lineStart = lineEnd + 1
  }

  return lines
}

/** remark's table tokenizer, limited to what Obsidian reads as a table: the
 *  alignment row starts with `|` exactly when the header row does, and so
 *  must each body row, the first that does not ending the table. So a `|`
 *  inside a wikilink or code span never makes a table on its own. remark's
 *  own rule that every row needs a `|` after its first character stays. */
const withLeadingPipesAgreeing = (table: Tokenizer): Tokenizer => {
  return function (eat, value, silent) {
    const [headerRow = "", alignmentRow = "", ...bodyRows] = collectTableLines(value)

    if (headerRow.startsWith("|") !== alignmentRow.startsWith("|")) return undefined

    return table.call(this, eat, [headerRow, alignmentRow, ...bodyRows].join("\n"), silent)
  }
}

// ── Block IDs ──────────────────────────────────────────────────────────────

/** Matches a block ID at the end of a line: `^` and a name of letters,
 *  digits and hyphens. */
const BLOCK_ID_RE = /^\^[A-Za-z0-9-]+(?=\n|$)/

/** Matches a block ID in running text: the `^` must follow whitespace. */
const BLOCK_ID_AFTER_WHITESPACE_RE = /\s\^[A-Za-z0-9-]+(?=\n|$)/

const blockIdTokenizer: InlineTokenizer = withLocator(function (
  eat,
  value,
  silent,
): TokenizerResult {
  const match = BLOCK_ID_RE.exec(value)

  if (!match) return undefined
  if (silent) return true

  return eat(match[0])({ type: "blockId", value: match[0].slice(1) })
}, locatorAfterCharacter(BLOCK_ID_AFTER_WHITESPACE_RE))

// ── Footnote definitions ───────────────────────────────────────────────────

/** Matches a footnote definition's opener: up to three spaces and
 *  `[^label]:` with a label of one or more characters with no whitespace or
 *  `]`. The whitespace after the colon is the first line's indent. */
const FOOTNOTE_DEFINITION_RE = /^ {0,3}\[\^([^\s\]]+)\]:/

/** The columns of indent every definition line gives up, and a line after a
 *  blank one must reach to continue. */
const DEFINITION_INDENT_COLUMNS = 4

type DefinitionLine = {
  line: string
  /** The line with up to four columns of indent split off (` \t` reaches
   *  them in two characters, `\t ` in one, `  ` gives up both). */
  content: string
  /** How many characters were split off. */
  indent: number
  /** True when the line's indent reaches four columns. */
  fullyIndented: boolean
}

const toDefinitionLine = (line: string): DefinitionLine => {
  const indentation = getIndentation(line)
  const columns = Math.min(indentation.indent, DEFINITION_INDENT_COLUMNS)
  const stop = indentation.stops[columns]
  // A stop of 0 is a real position, so only a missing one means no indent
  const indent = stop === undefined ? 0 : stop + 1

  return {
    line,
    content: line.slice(indent),
    indent,
    fullyIndented: indentation.indent >= DEFINITION_INDENT_COLUMNS,
  }
}

/** The blocks whose start ends a footnote definition's lazy lines, which is
 *  every block but indented code, a comment block and a paragraph. A second
 *  definition starts a new one. */
const FOOTNOTE_DEFINITION_INTERRUPTORS: ReadonlyArray<InterruptRule> = [
  ["fencedCode"],
  ["mathBlock"],
  ["blockquote"],
  ["atxHeading"],
  ["thematicBreak"],
  ["list"],
  ["setextHeading"],
  ["html"],
  ["footnoteDefinition"],
  ["definition"],
  ["table"],
]

/** The lines of a footnote definition after its first:
 *  - a line indented four columns continues it, blank lines between
 *    included, and a blank line is one with nothing after those columns
 *    (`\t` is blank, five spaces are not);
 *  - a line indented less continues it too right after content, as a lazy
 *    line continues a paragraph, unless one of the listed blocks starts
 *    there or the definition holds nothing yet for it to continue (even
 *    whitespace after the colon counts);
 *  - such a line after a blank line ends it, and the blank lines stay with
 *    the definition (so `$$ #t` on its first line is a math block when a
 *    blank line follows). */
const collectFootnoteContinuation = ({
  parser,
  eat,
  value,
  firstLine,
  firstLineHasText,
}: {
  parser: RemarkParserMembers
  eat: Eat
  value: string
  firstLine: DefinitionLine
  /** Whether anything, whitespace included, follows the first line's colon. */
  firstLineHasText: boolean
}): DefinitionLine[] => {
  const collected: DefinitionLine[] = []
  // Blank lines wait until the next line shows whether more content follows
  const pendingBlankLines: DefinitionLine[] = []
  // Lazy lines need content to continue, which the loop may add, so the
  // flag is mutable parser state
  let hasContent = firstLineHasText
  // The scan walks line starts, so its index is mutable parser state
  let lineStart = firstLine.line.length + 1

  // `<=` so that a trailing line feed's empty line is visited and kept as
  // a blank line of the definition
  while (lineStart <= value.length) {
    const lineFeedIndex = value.indexOf("\n", lineStart)
    const lineEnd = lineFeedIndex === -1 ? value.length : lineFeedIndex
    const definitionLine = toDefinitionLine(value.slice(lineStart, lineEnd))
    const { content, fullyIndented } = definitionLine

    if (!content) {
      pendingBlankLines.push(definitionLine)
      lineStart = lineEnd + 1
      continue
    }

    const isLazyLine = !fullyIndented
    const followsBlankLine = pendingBlankLines.length > 0
    const lazyLineEnds = isLazyLine && (!hasContent || followsBlankLine)

    if (lazyLineEnds) break

    const interrupted =
      isLazyLine &&
      interrupt(FOOTNOTE_DEFINITION_INTERRUPTORS, parser.blockTokenizers, parser, [
        eat,
        value.slice(lineStart),
        true,
      ])

    if (interrupted) break

    collected.push(...pendingBlankLines.splice(0), definitionLine)
    hasContent = true
    lineStart = lineEnd + 1
  }

  return [...collected, ...pendingBlankLines]
}

/** A `[^label]:` footnote definition. Its content is read as blocks, as a
 *  list item's is, after each of its lines gives up at most four columns of
 *  indent. It does not interrupt a paragraph. */
const footnoteDefinitionTokenizer: Tokenizer = function (eat, value, silent): TokenizerResult {
  const opener = FOOTNOTE_DEFINITION_RE.exec(value)
  const label = opener?.[1]

  if (!opener || !label) return undefined
  if (silent) return true

  const firstLineFeed = value.indexOf("\n")
  const firstLineText = value.slice(0, firstLineFeed === -1 ? value.length : firstLineFeed)
  const textAfterColon = firstLineText.slice(opener[0].length)
  // The text after the colon gives up indent like any other line, so
  // `[^1]:\t\t#x` keeps one tab and holds indented code
  const firstLineRest = toDefinitionLine(textAfterColon)
  const firstLine: DefinitionLine = {
    ...firstLineRest,
    line: firstLineText,
    indent: opener[0].length + firstLineRest.indent,
  }
  const definitionLines = [
    firstLine,
    ...collectFootnoteContinuation({
      parser: this,
      eat,
      value,
      firstLine,
      firstLineHasText: textAfterColon.length > 0,
    }),
  ]
  const linesText = definitionLines.map((definitionLine) => definitionLine.line).join("\n")
  // The line feed after the last line belongs to the definition, so a `$$`
  // opener on that line is a math block whenever another line follows
  const lineFeedAfter = value.charAt(linesText.length) === "\n" ? "\n" : ""
  const now = eat.now()

  definitionLines.forEach((definitionLine, lineIndex) => {
    const line = now.line + lineIndex
    this.offset[line] = (this.offset[line] ?? 0) + definitionLine.indent
  })

  const exit = this.enterBlock()
  const children = this.tokenizeBlock(
    definitionLines.map((definitionLine) => definitionLine.content).join("\n") + lineFeedAfter,
    now,
  )
  exit()

  return eat(linesText + lineFeedAfter)({ type: "footnoteDefinition", value: label, children })
}

/** Matches the start of a link definition whose label begins `^`. */
const CARET_DEFINITION_START_RE = /^[ \t]*\[\^/

/** remark's definition tokenizer, except that `[^label]:` is never a link
 *  definition, because to Obsidian it is a footnote definition or text. */
const withoutFootnoteDefinitions = (definition: Tokenizer): Tokenizer => {
  return function (eat, value, silent) {
    if (CARET_DEFINITION_START_RE.test(value)) return undefined
    return definition.call(this, eat, value, silent)
  }
}

// ── The parser ─────────────────────────────────────────────────────────────

/** Inserts `entries` into a method list right after `after`. */
const insertAfter = (
  methods: ReadonlyArray<string>,
  after: string,
  entries: ReadonlyArray<string>,
): string[] => {
  const index = methods.indexOf(after)

  if (index === -1) throw new Error(`remark-parse has no "${after}" tokenizer`)
  return [...methods.slice(0, index + 1), ...entries, ...methods.slice(index + 1)]
}

const requireTokenizer = <T extends Tokenizer>(tokenizers: Record<string, T>, name: string): T => {
  const tokenizer = tokenizers[name]

  if (!tokenizer) throw new Error(`remark-parse has no "${name}" tokenizer`)
  return tokenizer
}

class ObsidianParser extends RemarkParser {
  constructor(doc: string, file: ParserFile) {
    super(doc, file)

    this.setOptions({ commonmark: true, gfm: true })

    const remarkDefinition = requireTokenizer(this.blockTokenizers, "definition")
    const remarkTable = requireTokenizer(this.blockTokenizers, "table")
    const remarkReference = requireTokenizer(this.inlineTokenizers, "reference")

    // Copies of remark's tables, so its prototype is never changed
    this.blockTokenizers = {
      ...this.blockTokenizers,
      blockquote,
      list,
      mathBlock: mathBlockTokenizer,
      commentBlock: commentBlockTokenizer,
      footnoteDefinition: footnoteDefinitionTokenizer,
      definition: withoutFootnoteDefinitions(remarkDefinition),
      table: withLeadingPipesAgreeing(remarkTable),
    }

    const blockMethodsWithMath = insertAfter(this.blockMethods, "fencedCode", [
      "mathBlock",
      "commentBlock",
    ])

    this.blockMethods = insertAfter(blockMethodsWithMath, "html", ["footnoteDefinition"])
    this.inlineTokenizers = {
      ...this.inlineTokenizers,
      tag: tagTokenizer,
      wikilink: wikilinkTokenizer,
      footnoteReference: footnoteReferenceTokenizer,
      reference: withoutFootnoteLabels(remarkReference),
      inlineFootnote: inlineFootnoteTokenizer,
      deletion: deletionTokenizer,
      highlight: highlightTokenizer,
      inlineMath: inlineMathTokenizer,
      inlineComment: inlineCommentTokenizer,
      blockId: blockIdTokenizer,
    }

    // Wikilinks go before links so `[[a]](u)` is a wikilink, and footnote
    // references before references so `[^1]` is never a link reference
    const inlineMethodsWithTags = insertAfter(this.inlineMethods, "html", ["tag", "wikilink"])
    const inlineMethodsWithFootnoteReferences = insertAfter(inlineMethodsWithTags, "link", [
      "footnoteReference",
    ])

    this.inlineMethods = insertAfter(inlineMethodsWithFootnoteReferences, "deletion", [
      "highlight",
      "inlineMath",
      "inlineComment",
      "inlineFootnote",
      "blockId",
    ])
    // A comment block cuts a paragraph, a list or a quote's lazy lines
    // short; a math block cuts a paragraph or a quote short but not a list;
    // a footnote definition cuts nothing
    this.interruptParagraph = [...this.interruptParagraph, ["mathBlock"], ["commentBlock"]]
    this.interruptList = [...this.interruptList, ["commentBlock"]]
    this.interruptBlockquote = [...this.interruptBlockquote, ["mathBlock"], ["commentBlock"]]
  }
}

const createParserFile = (text: string): ParserFile => ({
  toString: () => text,
  fail: (reason) => {
    throw reason instanceof Error ? reason : new Error(reason)
  },
  // remark's warnings (an entity it could not decode, say) describe the
  // note, not a fault, and nothing reads them, so they are discarded
  message: () => undefined,
})

/** Parses a note body into remark's tree with Obsidian's syntax. */
export const parseObsidianMarkdown = (body: string): ParsedNode => {
  return new ObsidianParser(body, createParserFile(body)).parse()
}

/*
 * (The MIT License)
 *
 * Copyright (c) Titus Wormer <tituswormer@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * A TypeScript port of remark-parse 8.0.3 `lib/tokenize/blockquote.js`.
 * Changes:
 * - Callouts. When the quote's first line, after its `>` prefix, is a callout
 *   marker (`[!type]`, an optional `+` or `-` fold sign, then a space, a tab
 *   or the end of the line), the quote becomes a `callout` node: the rest of
 *   that line is its title and the lines below are its body, each read as
 *   blocks of its own. Obsidian 1.14.4 reads tags from a callout this way (a
 *   code span cannot run from the title into the body, the title can be an
 *   HTML block or indented code, and the type is never read), so a plain
 *   blockquote cannot stand in.
 * - `String.prototype.trim` replaces the `trim` package.
 */

import { interrupt } from "./interrupt.js"
import type {
  Eat,
  ParsedNode,
  RemarkParserMembers,
  SourcePoint,
  TokenizerResult,
} from "../remark-parse-types.js"

const LINE_FEED = "\n"
const TAB = "\t"
const SPACE = " "
const GREATER_THAN = ">"

/** Matches a callout marker at the start of a quote's first line: the
 *  type between `[!` and `]` (anything but `]`), an optional fold sign, then
 *  one space or tab, or the end of the line. Only that one character joins
 *  the marker, as one space joins a list bullet, so `[!note]     #x` has an
 *  indented code block for a title. The type is never read, so a `#` inside
 *  it is not a tag. */
const CALLOUT_MARKER_RE = /^\[![^\]\n]+\][+-]?(?:[ \t]|$)/

type QuoteLine = {
  /** The line as written, prefix included. */
  line: string
  /** The line after its `>` prefix and one optional space. */
  content: string
  /** How many characters the prefix took. */
  indent: number
}

const skipSpacesAndTabs = (value: string, fromIndex: number): number => {
  // The scan returns where the leading spaces and tabs end, so the counter is
  // mutable parser state.
  let index = fromIndex

  while (value.charAt(index) === SPACE || value.charAt(index) === TAB) index += 1

  return index
}

/** The index where a prefixed line's content starts: past the `>` at
 *  `markerIndex` and the one optional space after it. */
const skipQuotePrefix = (value: string, markerIndex: number): number => {
  const afterMarker = markerIndex + 1

  return value.charAt(afterMarker) === SPACE ? afterMarker + 1 : afterMarker
}

export const blockquote = function (
  this: RemarkParserMembers,
  eat: Eat,
  value: string,
  silent?: boolean,
): TokenizerResult {
  const offsets = this.offset
  const tokenizers = this.blockTokenizers
  const interruptors = this.interruptBlockquote
  const now = eat.now()
  const length = value.length

  if (value.charAt(skipSpacesAndTabs(value, 0)) !== GREATER_THAN) return undefined
  if (silent) return true

  const quoteLines: QuoteLine[] = []
  // The line loop threads the index of the line being read, so it is mutable
  // parser state.
  let index = 0

  while (index < length) {
    const startIndex = index
    const lineFeedIndex = value.indexOf(LINE_FEED, index)
    const nextIndex = lineFeedIndex === -1 ? length : lineFeedIndex
    const afterIndent = skipSpacesAndTabs(value, index)
    const prefixed = value.charAt(afterIndent) === GREATER_THAN
    const contentIndex = prefixed ? skipQuotePrefix(value, afterIndent) : startIndex
    const content = value.slice(contentIndex, nextIndex)

    if (!prefixed && !content.trim()) break

    // A lazy line (no `>`) that opens another block ends the quote
    if (
      !prefixed &&
      interrupt(interruptors, tokenizers, this, [eat, value.slice(contentIndex), true])
    ) {
      break
    }

    quoteLines.push({
      line: value.slice(startIndex, nextIndex),
      content,
      indent: contentIndex - startIndex,
    })

    index = nextIndex + 1
  }

  const add = eat(quoteLines.map((quoteLine) => quoteLine.line).join(LINE_FEED))

  quoteLines.forEach((quoteLine, lineIndex) => {
    const line = now.line + lineIndex
    offsets[line] = (offsets[line] ?? 0) + quoteLine.indent
  })

  const exit = this.enterBlock()
  const content = tokenizeQuoteContent(this, quoteLines, now)
  exit()

  return add({ type: content.kind, children: content.nodes })
}

type QuoteContent = { kind: "callout" | "blockquote"; nodes: ParsedNode[] }

const tokenizeQuoteContent = (
  parser: RemarkParserMembers,
  quoteLines: ReadonlyArray<QuoteLine>,
  now: SourcePoint,
): QuoteContent => {
  const [firstLine, ...bodyLines] = quoteLines
  const marker = firstLine ? CALLOUT_MARKER_RE.exec(firstLine.content) : null

  if (!firstLine || !marker) {
    const content = quoteLines.map((quoteLine) => quoteLine.content).join(LINE_FEED)
    return { kind: "blockquote", nodes: parser.tokenizeBlock(content, now) }
  }

  // The marker joins the `>` prefix in the offset table, so positions inside
  // the title map back to the source like any stripped prefix
  parser.offset[now.line] = (parser.offset[now.line] ?? 0) + marker[0].length

  const title: ParsedNode = {
    type: "calloutTitle",
    children: parser.tokenizeBlock(firstLine.content.slice(marker[0].length), now),
  }

  if (bodyLines.length === 0) return { kind: "callout", nodes: [title] }

  // The body starts on the line after the title, whose source offset only
  // the parser's line table knows
  const bodyPoint = { line: now.line + 1, column: 1 }
  const bodyStart = { ...bodyPoint, offset: parser.toOffset(bodyPoint) }
  const body = bodyLines.map((quoteLine) => quoteLine.content).join(LINE_FEED)

  return { kind: "callout", nodes: [title, ...parser.tokenizeBlock(body, bodyStart)] }
}

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
 * A TypeScript port of remark-parse 8.0.3 `lib/tokenize/list.js`. Changes:
 * - A task marker is `[` + any one character + `]`, not only a space, `x`,
 *   `X` or a tab, because Obsidian 1.14.4 strips `[/]`, `[?]`, `[✓]` and
 *   the like from an item before reading its content (a fence that follows
 *   such a marker is a code block, not text).
 * - `String.prototype.trim` and `String.prototype.repeat` replace the `trim`
 *   and `repeat-string` packages, and a character test replaces `is-decimal`.
 * - The pedantic list-item path is dropped, because the parser never runs in
 *   pedantic mode.
 */

import { getIndentation } from "./get-indentation.js"
import { interrupt } from "./interrupt.js"
import { removeIndentation } from "./remove-indentation.js"
import type {
  Eat,
  ParsedNode,
  RemarkParserMembers,
  SourcePoint,
  TokenizerResult,
} from "../remark-parse-types.js"

const ASTERISK = "*"
const UNDERSCORE = "_"
const PLUS_SIGN = "+"
const DASH = "-"
const DOT = "."
const SPACE = " "
const LINE_FEED = "\n"
const TAB = "\t"
const RIGHT_PARENTHESIS = ")"
const LOWERCASE_X = "x"
const TAB_SIZE = 4

/** Matches an item whose content holds a blank line followed by more content. */
const LOOSE_LIST_ITEM_RE = /\n\n(?!\s*$)/
/** Matches a task marker at the start of an item's content: any one
 *  character between the brackets, then a space or tab. */
const TASK_ITEM_RE = /^\[(.)\][ \t]/
/** Matches an item's bullet: indent, marker, the spacing after it (one to
 *  four spaces not followed by a fifth, one space, a tab, or nothing), and
 *  the rest of the first line. */
const BULLET_RE = /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$|(?=\n))([^\n]*)/

const isAsciiDigit = (character: string): boolean => character >= "0" && character <= "9"

type ListItemLines = {
  value: string[]
  indent: number
  trail: string[]
}

type LineScan = {
  nextIndex: number
  size: number
  index: number
  currentMarker: string | null
  indented: boolean
}

export const list = function (
  this: RemarkParserMembers,
  eat: Eat,
  value: string,
  silent?: boolean,
): TokenizerResult {
  const commonmark = this.options.commonmark
  const tokenizers = this.blockTokenizers
  const interruptors = this.interruptList
  const length = value.length
  // The whole tokenizer threads line-by-line scanning state (the index into
  // `value`, the item being filled, pending blank lines), so these are
  // mutable parser state, as in the upstream file.
  let index = 0

  while (index < length) {
    const character = value.charAt(index)

    if (character !== TAB && character !== SPACE) break

    index += 1
  }

  const bulletMarker = readBulletMarker(value, index, commonmark)

  if (!bulletMarker) return undefined

  const { ordered, marker, start, digits, markerIndex } = bulletMarker

  // In silent mode the question is whether this list may interrupt a
  // paragraph, and `2. here` may not, because the list does not start at 1
  if (silent && ordered && digits !== "1") return undefined

  const afterMarker = value.charAt(markerIndex + 1)

  if (
    afterMarker !== SPACE &&
    afterMarker !== TAB &&
    afterMarker !== LINE_FEED &&
    afterMarker !== ""
  ) {
    return undefined
  }

  if (silent) return true

  index = 0
  const items: ListItemLines[] = []
  let allLines: string[] = []
  let emptyLines: string[] = []
  let item: ListItemLines | null = null
  let spread = false
  let empty = false

  while (index < length) {
    const startIndex = index
    const scan = scanItemLine(value, index, item, commonmark)
    const { nextIndex, currentMarker, indented } = scan
    const prefixed = Boolean(currentMarker)

    if (currentMarker && marker !== currentMarker) break

    index = prefixed ? scan.index : startIndex

    const line = value.slice(startIndex, nextIndex)
    const content = startIndex === index ? line : value.slice(index, nextIndex)

    if (currentMarker === ASTERISK || currentMarker === UNDERSCORE || currentMarker === DASH) {
      if (tokenizers.thematicBreak?.call(this, eat, line, true)) break
    }

    const previousEmpty = empty

    empty = !prefixed && !content.trim().length

    if (indented && item) {
      item.value = item.value.concat(emptyLines, line)
      allLines = allLines.concat(emptyLines, line)
      emptyLines = []
    } else if (prefixed) {
      if (emptyLines.length !== 0 && item) {
        spread = true
        item.value.push("")
        item.trail = emptyLines.concat()
      }

      item = { value: [line], indent: scan.size, trail: [] }
      items.push(item)
      allLines = allLines.concat(emptyLines, line)
      emptyLines = []
    } else if (empty) {
      if (previousEmpty && !commonmark) break

      emptyLines.push(line)
    } else {
      if (previousEmpty) break
      if (interrupt(interruptors, tokenizers, this, [eat, line, true])) break
      if (!item) break

      item.value = item.value.concat(emptyLines, line)
      allLines = allLines.concat(emptyLines, line)
      emptyLines = []
    }

    index = nextIndex + 1
  }

  const node = eat(allLines.join(LINE_FEED)).reset({
    type: "list",
    ordered,
    start,
    spread,
    children: [],
  })
  const exitList = this.enterList()
  const exitBlock = this.enterBlock()

  items.forEach((listItem, itemIndex) => {
    const itemText = listItem.value.join(LINE_FEED)
    const now = eat.now()

    eat(itemText)(tokenizeListItem(this, itemText, now), node)

    const trail = listItem.trail.join(LINE_FEED)

    eat(itemIndex === items.length - 1 ? trail : trail + LINE_FEED)
  })

  exitList()
  exitBlock()

  return node
}

type BulletMarker = {
  ordered: boolean
  marker: string
  start: number | null
  /** The number as written, so `01` and `1` stay distinct. */
  digits: string
  /** The index of the marker character (`-`, `.`, `)`). */
  markerIndex: number
}

/** Reads the bullet at `index`, which is a `*`, `+` or `-`, or digits
 *  followed by `.` (or by `)` in CommonMark mode). */
const readBulletMarker = (
  value: string,
  index: number,
  commonmark: boolean,
): BulletMarker | null => {
  const character = value.charAt(index)

  if (character === ASTERISK || character === PLUS_SIGN || character === DASH) {
    return { ordered: false, marker: character, start: null, digits: "", markerIndex: index }
  }

  const digits = readDigits(value, index)
  const markerIndex = index + digits.length
  const afterDigits = value.charAt(markerIndex)
  const isOrderedMarker = afterDigits === DOT || (commonmark && afterDigits === RIGHT_PARENTHESIS)

  if (!digits || !isOrderedMarker) return null

  return { ordered: true, marker: afterDigits, start: parseInt(digits, 10), digits, markerIndex }
}

const readDigits = (value: string, fromIndex: number): string => {
  // The scan collects the run of digits at `fromIndex`, so the counter is
  // mutable parser state.
  let index = fromIndex

  while (index < value.length && isAsciiDigit(value.charAt(index))) index += 1

  return value.slice(fromIndex, index)
}

/** Reads one line of a list: its indent, whether it carries a bullet, and
 *  where its content starts. */
const scanItemLine = (
  value: string,
  lineStart: number,
  item: ListItemLines | null,
  commonmark: boolean,
): LineScan => {
  const length = value.length
  const lineFeedIndex = value.indexOf(LINE_FEED, lineStart)
  const nextIndex = lineFeedIndex === -1 ? length : lineFeedIndex
  // The scan threads the index into the line and the column it reached, so
  // both are mutable parser state.
  let index = lineStart
  let size = 0

  while (index < length) {
    const character = value.charAt(index)

    if (character === TAB) {
      size += TAB_SIZE - (size % TAB_SIZE)
    } else if (character === SPACE) {
      size += 1
    } else {
      break
    }

    index += 1
  }

  const indentedByItem = Boolean(item && size >= item.indent)
  let currentMarker: string | null = null

  if (!indentedByItem) {
    const character = value.charAt(index)

    if (character === ASTERISK || character === PLUS_SIGN || character === DASH) {
      currentMarker = character
      index += 1
      size += 1
    } else {
      const digits = readDigits(value, index)
      const afterDigits = value.charAt(index + digits.length)

      index += digits.length + 1

      if (digits && (afterDigits === DOT || (commonmark && afterDigits === RIGHT_PARENTHESIS))) {
        currentMarker = afterDigits
        size += digits.length + 1
      }
    }

    if (currentMarker) {
      const character = value.charAt(index)

      if (character === TAB) {
        size += TAB_SIZE - (size % TAB_SIZE)
        index += 1
      } else if (character === SPACE) {
        const end = index + TAB_SIZE

        while (index < end && value.charAt(index) === SPACE) {
          index += 1
          size += 1
        }

        if (index === end && value.charAt(index) === SPACE) {
          index -= TAB_SIZE - 1
          size -= TAB_SIZE - 1
        }
      } else if (character !== LINE_FEED && character !== "") {
        currentMarker = null
      }
    }
  }

  if (currentMarker) return { nextIndex, size, index, currentMarker, indented: indentedByItem }

  const indented = commonmark && item ? size >= item.indent || size > TAB_SIZE : indentedByItem
  const indentedByLeadingSpace = !commonmark && !indentedByItem && value.charAt(lineStart) === SPACE

  return {
    nextIndex,
    size,
    index: lineStart,
    currentMarker,
    indented: indented || indentedByLeadingSpace,
  }
}

const tokenizeListItem = (
  parser: RemarkParserMembers,
  value: string,
  position: SourcePoint,
): ParsedNode => {
  const offsets = parser.offset
  const withoutBullet = removeListItemBullet(parser, value, position)
  const task = parser.options.gfm ? TASK_ITEM_RE.exec(withoutBullet) : null
  const taskMarker = task ? task[0] : ""
  const taskCharacter = task?.[1]

  if (taskMarker) offsets[position.line] = (offsets[position.line] ?? 0) + taskMarker.length

  const content = withoutBullet.slice(taskMarker.length)

  return {
    type: "listItem",
    spread: LOOSE_LIST_ITEM_RE.test(content),
    checked: taskCharacter ? taskCharacter.toLowerCase() === LOWERCASE_X : null,
    children: parser.tokenizeBlock(content, position),
  }
}

/** Strips the bullet from an item's first line and the matching indent from
 *  the lines below, recording what was removed in the parser's offset table. */
const removeListItemBullet = (
  parser: RemarkParserMembers,
  value: string,
  position: SourcePoint,
): string => {
  const offsets = parser.offset
  const bulletMatch = BULLET_RE.exec(value)

  // The list tokenizer hands over only lines it read a bullet from
  if (!bulletMatch) throw new Error("list item has no bullet")

  const [bulletText, bulletIndent = "", bulletMarker = "", bulletSpacing = "", firstLineRest = ""] =
    bulletMatch
  const bullet = bulletIndent + bulletMarker + bulletSpacing
  // The first nine numbered items may indent with one extra space, which is
  // the case when the bullet did not get an extra final space
  const widenedMarker =
    Number(bulletMarker) < 10 && bullet.length % 2 === 1 ? SPACE + bulletMarker : bulletMarker
  const maximum = bulletIndent + SPACE.repeat(widenedMarker.length) + bulletSpacing
  const replaced = maximum + firstLineRest + value.slice(bulletText.length)
  const lines = replaced.split(LINE_FEED)
  const trimmedLines = removeIndentation(replaced, getIndentation(maximum).indent).split(LINE_FEED)

  // The bullet was replaced by spaces above so that removeIndentation could
  // take matching indent off the lines below; the first line gets its own
  // text back, since those spaces are not part of it
  const contentLines = trimmedLines.map((trimmedLine, lineIndex) =>
    lineIndex === 0 ? firstLineRest : trimmedLine,
  )

  offsets[position.line] = (offsets[position.line] ?? 0) + bullet.length

  lines.forEach((line, lineIndex) => {
    if (lineIndex === 0) return

    const trimmedLine = contentLines[lineIndex] ?? ""
    const offsetLine = position.line + lineIndex

    offsets[offsetLine] = (offsets[offsetLine] ?? 0) + line.length - trimmedLine.length
  })

  return contentLines.join(LINE_FEED)
}

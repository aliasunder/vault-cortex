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
 * A TypeScript port of remark-parse 8.0.3 `lib/util/remove-indentation.js`,
 * imported by the ported `list.ts`. Changes:
 * - A non-blank line without any indent (a lazy line of a list item) no
 *   longer stops the removal; it is left as it is while the indented lines
 *   still give up their shared indent. Obsidian 1.14.4 reads a list item
 *   that way (an indented line after a lazy one is still de-indented, so a
 *   four-space line is text, not code).
 * - `String.prototype.trim` and `String.prototype.repeat` replace the `trim`
 *   and `repeat-string` packages.
 */

import { getIndentation } from "./get-indentation.js"

const LINE_FEED = "\n"

/** Removes the smallest indent shared by the indented non-blank lines of
 *  `value`, up to `maximum` columns, from every line. */
export const removeIndentation = (value: string, maximum: number): string => {
  // A sentinel first line of `maximum` spaces caps the shared indent at
  // `maximum`; it is dropped again before the lines are joined.
  const lines = [`${" ".repeat(maximum)}!`, ...value.split(LINE_FEED)]
  const indentations = lines.map(getIndentation)
  const contentIndents = lines.flatMap((line, index) => {
    const indent = indentations[index]?.indent ?? 0

    if (line.trim().length === 0 || indent === 0) return []
    return [indent]
  })

  if (contentIndents.length === 0) return value

  const minIndent = Math.min(...contentIndents)
  const trimmedLines = lines.map((line, index) => {
    const stops = indentations[index]?.stops ?? {}
    // The largest recorded stop at or below the shared indent, because a tab
    // can jump past it
    const reachedIndent = largestStopAtOrBelow(stops, minIndent)
    const stop = stops[reachedIndent]

    return stop === undefined ? line : line.slice(stop + 1)
  })

  return trimmedLines.slice(1).join(LINE_FEED)
}

const largestStopAtOrBelow = (stops: Record<number, number>, indent: number): number => {
  // Walks down from the shared indent until a column this line's indentation
  // actually reaches, so the counter is mutable parser state.
  let candidate = indent

  while (candidate && !(candidate in stops)) candidate -= 1

  return candidate
}

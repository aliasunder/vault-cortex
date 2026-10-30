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
 * A TypeScript port of remark-parse 8.0.3 `lib/util/get-indentation.js`,
 * imported by the ported `list.ts` and `remove-indentation.ts`. Behaviour is
 * unchanged; the port only adds types.
 */

const TAB = "\t"
const SPACE = " "
const TAB_SIZE = 4

export type Indentation = {
  /** The indent in columns, with a tab advancing to the next multiple of 4. */
  indent: number
  /** For each column up to `indent`, the index of the character that reaches it. */
  stops: Record<number, number>
}

/** Measures the leading tabs and spaces of one line. */
export const getIndentation = (value: string): Indentation => {
  // The scan threads the running column and the last recorded stop through
  // each leading character, so the three counters are mutable parser state.
  let index = 0
  let indent = 0
  let lastIndent = 0
  const stops: Record<number, number> = {}

  while (value.charAt(index) === TAB || value.charAt(index) === SPACE) {
    const size = value.charAt(index) === TAB ? TAB_SIZE : 1

    indent += size

    if (size > 1) indent = Math.floor(indent / size) * size

    while (lastIndent < indent) {
      lastIndent += 1
      stops[lastIndent] = index
    }

    index += 1
  }

  return { indent, stops }
}

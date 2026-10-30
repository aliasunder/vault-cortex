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
 * A TypeScript port of remark-parse 8.0.3 `lib/util/interrupt.js`, imported by
 * the ported block tokenizers. Behaviour is unchanged; the port only adds
 * types.
 */

import type { Eat, InterruptRule, RemarkParserMembers, Tokenizer } from "../remark-parse-types.js"

/** True when one of the listed block tokenizers would match `value`, under
 *  the option values each rule names. */
export const interrupt = (
  interruptors: ReadonlyArray<InterruptRule>,
  tokenizers: Record<string, Tokenizer>,
  parser: RemarkParserMembers,
  parameters: [Eat, string, true],
): boolean => {
  for (const [name, config = {}] of interruptors) {
    if (config.pedantic !== undefined && config.pedantic !== parser.options.pedantic) continue
    if (config.commonmark !== undefined && config.commonmark !== parser.options.commonmark) continue

    const tokenizer = tokenizers[name]

    if (tokenizer && tokenizer.apply(parser, parameters)) return true
  }

  return false
}

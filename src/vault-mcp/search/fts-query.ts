// ── FTS5 query sanitization ─────────────────────────────────────

const FTS5_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"])

/** One FTS5 bareword character: anything except whitespace and ASCII
 *  punctuation. Covers letters, digits, underscore, and all non-ASCII
 *  characters (FTS5 treats code points ≥ 0x80 as bareword characters). */
const BAREWORD_CHARACTER = "[^\\s!-/:-@[-^`{-~]"

/** One compound-joiner character: ASCII punctuation that glues segments of a
 *  single term together (the dot in mcpservers.org, the hyphen in
 *  vault-cortex, the slash in deploy/local). Excludes the FTS5 metacharacters
 *  " * ^ ( ) : (stripped outright, never joiners) and underscore (a bareword
 *  character). */
const COMPOUND_JOINER_CHARACTER = "[!#-'+-/;-@[-\\]`{-~]"

/** Matches compound terms — two or more bareword segments joined by
 *  punctuation — which FTS5 would otherwise reject as a syntax error
 *  (e.g. "fts5: syntax error near '.'" for mcpservers.org). */
const COMPOUND_TERM_REGEX = new RegExp(
  `${BAREWORD_CHARACTER}+(?:${COMPOUND_JOINER_CHARACTER}+${BAREWORD_CHARACTER}+)+`,
  "g",
)

/** Matches a run of joiner punctuation inside a compound term, for
 *  replacement with a single space when the compound becomes a phrase. */
const COMPOUND_JOINER_RUN_REGEX = new RegExp(
  `${COMPOUND_JOINER_CHARACTER}+`,
  "g",
)

/** Matches every ASCII punctuation character except underscore. Used as the
 *  final sweep that turns stray punctuation (word-edge dots, unbalanced
 *  quotes, lone operators) into token separators so it never reaches FTS5. */
const ASCII_PUNCTUATION_REGEX = /[!-/:-@[-^`{-~]/g

/** Sanitizes user input for safe FTS5 querying. Quoted phrases are preserved
 *  for exact-phrase matching. Punctuated compound terms (vault-cortex,
 *  mcpservers.org, deploy/local) are converted to quoted phrases for
 *  adjacent-token matching — the unicode61 tokenizer splits the indexed text
 *  at the same punctuation, so the phrase matches the original term exactly.
 *  Remaining unquoted terms are left bare to preserve porter stemming. FTS5
 *  metacharacters, stray punctuation, and reserved words are stripped, so
 *  literal text can never produce an FTS5 syntax error. */
export const sanitizeFtsQuery = (raw: string): string => {
  const phrases: string[] = []

  // Extract "quoted phrases", strip FTS5 metacharacters inside them,
  // and collect into phrases[]. Other punctuation inside quotes is left
  // alone — the unicode61 tokenizer splits it correctly in phrase queries.
  const remaining = raw.replace(/"([^"]+)"/g, (_, phrase: string) => {
    const cleaned = phrase.replace(/[*^():]/g, "").trim()
    if (cleaned.length > 0) phrases.push(`"${cleaned}"`)
    return " "
  })

  // Convert bare punctuated compounds (vault-cortex → "vault cortex",
  // mcpservers.org → "mcpservers org") so FTS5 doesn't interpret the
  // punctuation as an operator or reject it as a syntax error.
  const afterCompounds = remaining.replace(COMPOUND_TERM_REGEX, (match) => {
    phrases.push(`"${match.replace(COMPOUND_JOINER_RUN_REGEX, " ")}"`)
    return " "
  })

  // Strip all remaining ASCII punctuation (metacharacters, word-edge dots,
  // stray/leading hyphens), split into tokens, and drop reserved words
  // (AND, OR, NOT, NEAR).
  const tokens = afterCompounds
    .replace(ASCII_PUNCTUATION_REGEX, " ")
    .split(/\s+/)
    .filter(
      (token) => token.length > 0 && !FTS5_RESERVED.has(token.toUpperCase()),
    )

  const parts = [...phrases, ...tokens]
  return parts.length === 0 ? '""' : parts.join(" ")
}

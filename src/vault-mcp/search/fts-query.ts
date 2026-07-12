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

/** Shared tokenizer behind both sanitizers. Quoted phrases are preserved
 *  for exact-phrase matching. Punctuated compound terms (vault-cortex,
 *  mcpservers.org, deploy/local) are converted to quoted phrases for
 *  adjacent-token matching — the unicode61 tokenizer splits the indexed text
 *  at the same punctuation, so the phrase matches the original term exactly.
 *  Remaining unquoted terms are left bare to preserve porter stemming. FTS5
 *  metacharacters, stray punctuation, and reserved words are stripped, so
 *  literal text can never produce an FTS5 syntax error. */
const sanitizedFtsParts = (raw: string): string[] => {
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

  return [...phrases, ...tokens]
}

/** Sanitizes user input for safe FTS5 querying with all-terms (implicit AND)
 *  semantics — every part must match. See sanitizedFtsParts for the
 *  sanitization rules. */
export const sanitizeFtsQuery = (raw: string): string => {
  const parts = sanitizedFtsParts(raw)
  return parts.length === 0 ? '""' : parts.join(" ")
}

/** English function words that would let an OR query match most of the
 *  corpus ("on", "in", "the") — live verification showed a nonsense query
 *  matching 176 entries through "in" alone. Lucene's classic English stopword
 *  list plus the meta-question words recall queries carry ("what do I think
 *  about…"). Applied only to the any-term rescue; the all-terms sanitizer
 *  keeps every token. */
const ANY_TERM_STOPWORDS = new Set([
  ...["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if"],
  ...["in", "into", "is", "it", "no", "not", "of", "on", "or", "such"],
  ...["that", "the", "their", "then", "there", "these", "they", "this"],
  ...["to", "was", "will", "with"],
  ...["i", "me", "my", "you", "your", "do", "does", "about"],
  ...["what", "when", "where", "which", "who", "whom", "why", "how"],
])

/** Any-term (OR) variant of sanitizeFtsQuery — an entry matches when it
 *  contains ANY sanitized content word instead of all tokens. Used only by
 *  memoryRecall's zero-result rescue. Stopwords are dropped so only content
 *  words can anchor a match — an OR hit on "on" is every entry, not a signal
 *  — and bm25's idf weighting orders the survivors by their rarest stems.
 *  Quoted phrases and punctuated compounds are deliberate and always kept. */
export const sanitizeFtsQueryAnyTerm = (raw: string): string => {
  const parts = sanitizedFtsParts(raw)
  const contentParts = parts.filter(
    (part) =>
      part.startsWith('"') || !ANY_TERM_STOPWORDS.has(part.toLowerCase()),
  )
  return contentParts.length === 0 ? '""' : contentParts.join(" OR ")
}

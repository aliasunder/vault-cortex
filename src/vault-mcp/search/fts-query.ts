// ── FTS5 query sanitization ─────────────────────────────────────

/** FTS5 reads these only in uppercase as operators; "and" and "Not" are
 *  ordinary terms, so sanitizedFtsParts drops only this exact spelling, and
 *  only from unquoted terms. NEAR is not listed: FTS5 reads it as an operator
 *  only when "(" follows, and every "(" is stripped before this check. */
const FTS5_RESERVED = new Set(["AND", "OR", "NOT"])

/** Every ASCII punctuation character except underscore, which FTS5 reads as
 *  part of a word. The character classes below insert it through
 *  RegExp.escape, whose escapes each still match one character inside [...]. */
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~"

/** FTS5 query-syntax characters: stripped outright, never compound joiners. */
const FTS5_METACHARACTERS = '"*^():'

/** One FTS5 bareword character: anything except whitespace and ASCII
 *  punctuation. Covers letters, digits, underscore, and all non-ASCII
 *  characters (FTS5 treats code points ≥ 0x80 as bareword characters). */
const BAREWORD_CHARACTER = `[^\\s${RegExp.escape(ASCII_PUNCTUATION)}]`

/** Compound joiners: ASCII punctuation that glues segments of a single term
 *  together (the dot in mcpservers.org, the hyphen in vault-cortex, the slash
 *  in deploy/local). */
const COMPOUND_JOINERS = [...ASCII_PUNCTUATION]
  .filter((character) => !FTS5_METACHARACTERS.includes(character))
  .join("")

const COMPOUND_JOINER_CHARACTER = `[${RegExp.escape(COMPOUND_JOINERS)}]`

/** Matches compound terms — two or more bareword segments joined by
 *  punctuation — which FTS5 would otherwise reject as a syntax error
 *  (e.g. "fts5: syntax error near '.'" for mcpservers.org). The lookbehind
 *  keeps a long run with no joiner from being rescanned at each of its
 *  characters, which takes time quadratic in the run's length. */
const COMPOUND_TERM_REGEX = new RegExp(
  `(?<!${BAREWORD_CHARACTER})${BAREWORD_CHARACTER}+(?:${COMPOUND_JOINER_CHARACTER}+${BAREWORD_CHARACTER}+)+`,
  "g",
)

/** Matches a run of joiner punctuation inside a compound term, for
 *  replacement with a single space when the compound becomes a phrase. */
const COMPOUND_JOINER_RUN_REGEX = new RegExp(`${COMPOUND_JOINER_CHARACTER}+`, "g")

/** Matches one ASCII_PUNCTUATION character. Used as the final sweep that
 *  turns stray punctuation (word-edge dots, unbalanced quotes, lone
 *  operators) into token separators so it never reaches FTS5. */
const ASCII_PUNCTUATION_REGEX = new RegExp(`[${RegExp.escape(ASCII_PUNCTUATION)}]`, "g")

/** Matches one FTS5_METACHARACTERS character. */
const FTS5_METACHARACTER_REGEX = new RegExp(`[${RegExp.escape(FTS5_METACHARACTERS)}]`, "g")

/** FTS5 rejects an empty MATCH string as a syntax error; an empty quoted
 *  phrase is valid and matches no rows. */
const MATCH_NOTHING_QUERY = '""'

/** Matches control characters (Unicode category Cc). FTS5 rejects most ASCII
 *  ones, NUL even inside a quoted phrase; the unicode61 tokenizer splits
 *  indexed text at all of them, just as at a space. */
const CONTROL_CHARACTER_REGEX = /\p{Cc}/gu

/** Matches a double-quoted phrase, capturing the text between the quotes. */
const QUOTED_PHRASE_REGEX = /"([^"]+)"/g

/** Shared tokenizer behind both sanitizers. Quoted phrases are preserved
 *  for exact-phrase matching. Punctuated compound terms (vault-cortex,
 *  mcpservers.org, deploy/local) are converted to quoted phrases for
 *  adjacent-token matching — the unicode61 tokenizer splits the indexed text
 *  at the same punctuation, so the phrase matches the original term exactly.
 *  Remaining unquoted terms are left bare to preserve porter stemming. FTS5
 *  metacharacters, stray punctuation, control characters, and reserved words
 *  are stripped, so literal text can never produce an FTS5 syntax error.
 *  Returns the phrases, double quotes included, before the bare tokens; the
 *  order does not change what FTS5 matches. */
const sanitizedFtsParts = (raw: string): string[] => {
  const phrases: string[] = []

  // Control characters go first, so none survives inside a quoted phrase
  const controlFreeQuery = raw.replace(CONTROL_CHARACTER_REGEX, " ")

  // Extract "quoted phrases", turn FTS5 metacharacters inside them into
  // spaces, and collect into phrases[]. A space keeps "10:30" as the two
  // words the index holds; deleting the colon would search for "1030".
  // Other punctuation inside quotes is left alone — the unicode61
  // tokenizer splits it correctly in phrase queries.
  const remaining = controlFreeQuery.replace(QUOTED_PHRASE_REGEX, (_, phrase: string) => {
    const cleaned = phrase.replace(FTS5_METACHARACTER_REGEX, " ").trim()

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
  // stray/leading hyphens), split into tokens, and drop the uppercase
  // reserved words (AND, OR, NOT).
  const tokens = afterCompounds
    .replace(ASCII_PUNCTUATION_REGEX, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !FTS5_RESERVED.has(token))

  return [...phrases, ...tokens]
}

/** Sanitizes user input for safe FTS5 querying with all-terms (implicit AND)
 *  semantics — every part must match. See sanitizedFtsParts for the
 *  sanitization rules. */
export const sanitizeFtsQuery = (raw: string): string => {
  const parts = sanitizedFtsParts(raw)
  return parts.length === 0 ? MATCH_NOTHING_QUERY : parts.join(" ")
}

/** English function words that would let an OR query match most of the
 *  corpus ("on", "in", "the"). Applied only by sanitizeFtsQueryAnyTerm; the
 *  all-terms sanitizer keeps every token. */
const ANY_TERM_STOPWORDS = new Set([
  // Lucene's classic English stopword list
  ...["a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if"],
  ...["in", "into", "is", "it", "no", "not", "of", "on", "or", "such"],
  ...["that", "the", "their", "then", "there", "these", "they", "this"],
  ...["to", "was", "will", "with"],
  // The meta-question words recall queries carry ("what do I think about…")
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
    (part) => part.startsWith('"') || !ANY_TERM_STOPWORDS.has(part.toLowerCase()),
  )
  return contentParts.length === 0 ? MATCH_NOTHING_QUERY : contentParts.join(" OR ")
}

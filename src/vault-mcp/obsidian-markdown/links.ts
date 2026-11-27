/** The Obsidian/Markdown link domain: recognizing links in text, parsing them
 *  into parts, extracting their targets from a note, resolving a target to a
 *  vault path, and writing a path as a markdown link destination. Both the indexer (search/search-index.ts) and the link rewriter
 *  (vault-operations/note-mover.ts) depend on this module as a peer, so the two
 *  read links with one grammar and resolve them by one set of rules.
 *
 *  Recognition stays private so callers share the grammar and receive
 *  position-safe matches through the methods on `links`. */

import { posix } from "node:path"
import parseEntities from "parse-entities"
import { classifyLines } from "./lines.js"

// ── Grammar (private) ───────────────────────────────────────────

/** JavaScript whitespace also includes non-ASCII spaces and line terminators. */
const WHITESPACE = /\s/

/** One of CommonMark's ASCII punctuation characters
 *  (https://spec.commonmark.org/0.31.2/#ascii-punctuation-character). */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/

/** A backslash before ASCII punctuation, which Obsidian drops from a stored
 *  markdown link. Global — use only with replace. */
const ESCAPED_PUNCTUATION = new RegExp(String.raw`\\(${ASCII_PUNCTUATION.source})`, "g")

/** An ASCII letter or digit, the characters parse-entities reads as part of a
 *  character reference's name. */
const REFERENCE_NAME_CHARACTER = /[0-9A-Za-z]/

/** The longest named character reference, `CounterClockwiseContourIntegral`,
 *  has 31 characters. */
const LONGEST_REFERENCE_NAME = 31

/** Obsidian reads links with a fork of remark-parse 8, which decodes a link
 *  destination's character references through parse-entities with these
 *  options: a reference counts only when a `;` ends it. */
const REFERENCE_OPTIONS = { nonTerminated: false }

/** Matches the numeric reference a text opens with: `&#`, then an `x` and hex
 *  digits or decimal digits, then an optional `;`. */
const NUMERIC_REFERENCE =
  /^&#(?:(?<hexMarker>[xX])(?<hexDigits>[0-9A-Fa-f]*)|(?<decimalDigits>[0-9]*))(?<semicolon>;?)/

/** Matches the zeros a digit run opens with, short of its last digit. */
const LEADING_ZEROS = /^0+(?=.)/

/** The most digits a code point takes past its leading zeros: U+10FFFF is
 *  1,114,111, seven decimal digits or six hex digits. */
const CODE_POINT_DIGITS = { decimal: 7, hex: 6 }

/** parse-entities decodes a numeric reference past U+10FFFF as U+FFFD. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd)

/** How many decoded pieces the reference decoder holds before it joins them.
 *  A text dense with `&` has one piece per character, and one string per piece
 *  costs about 90 bytes of heap per character; a batch this size stays under a
 *  megabyte. */
const PIECES_PER_JOIN = 4096

const NO_BREAK_SPACE = "\u00a0"

/** A link that starts in the linking note's folder (`./`) or its parent
 *  (`../`), which Obsidian keeps as a vault link even when it holds a `:`. */
const RELATIVE_LINK_START = /^\.\.?\//

/** JavaScript's line terminators: LF, CR, the line separator (U+2028) and
 *  the paragraph separator (U+2029). */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

/** Matches inline code spans so links inside backticks (e.g. `[[Note]]`) can be
 *  ignored. Global — use only with replace. */
const INLINE_CODE_RE = /`+[^`\n]*`+/g

/** Splits a matched wikilink into capture groups 1–4: embed `!`, target,
 *  `#heading`, `|alias`. Anchored and non-global — safe for .exec().
 *  scanWikilinks finds the links this parses, so the two must accept the same
 *  grammar. */
const WIKILINK_PARTS = /^(!?)\[\[([^\]#|]+)(#[^\]|]*)?(\|[^\]]+)?\]\]$/

/** Treats a trailing backslash as Obsidian's table-pipe escape (`[[path\|alias]]`), even
 *  outside a table, because Obsidian does not allow a backslash in a file name. */
const stripEscapedPipe = (target: string): string => target.replace(/\\$/, "")

/** Trims a wikilink's target and drops a table-pipe escape, then trims the
 *  space before that escape too, as Obsidian stores `[[Note \|Alias]]` as `Note`. */
const readStoredWikilinkTarget = (rawTarget: string): string => {
  return stripEscapedPipe(rawTarget.trim()).trimEnd()
}

// ── Types ───────────────────────────────────────────────────────

/** A link found in a single line, with the character offsets needed to splice a
 *  replacement around it. */
type LinkMatch = {
  text: string
  start: number
  end: number
  kind: "wikilink" | "markdown"
}

/** A link a scanner found: [start, end) covers the whole link, and
 *  [targetStart, targetEnd) its target alone, without any `#heading` or `|alias`. */
type LinkSpan = { start: number; end: number; targetStart: number; targetEnd: number }

/** How a markdown link writes its destination: in angle brackets
 *  (`[x](<My Note.md>)`) or bare (`[x](My%20Note.md)`). */
type DestinationForm = "angle" | "bare"

/** Whether a markdown link is an embed (`![alt](photo.png)`) or a plain link. */
type MarkdownLinkKind = "embed" | "link"

/** A markdown link a scanner found:
 *  - [start, end) starts at an embed's `!`, as a wikilink embed's span does;
 *  - [targetEnd, headingEnd) holds the raw `#heading`, empty without one;
 *  - storedTarget is the target as Obsidian stores it, decoded and without
 *    the heading. */
type MarkdownLinkSpan = LinkSpan & {
  destinationForm: DestinationForm
  headingEnd: number
  storedTarget: string
}

/** The structural parts of a wikilink ![[target#heading|alias]]. heading/alias
 *  keep their leading `#` / `|`, and whichever follows the target also starts
 *  with a backslash the target ended in, with the whitespace after it
 *  (`[[a\ |b]]` gives alias `\ |b`, `[[a\#h]]` heading `\#h`), so
 *  reconstruction is plain concatenation; target is not trimmed (the caller
 *  trims). */
type WikilinkParts = {
  embed: string
  target: string
  heading: string
  alias: string
}

/** The parts of a markdown link `[text](<path.ext#heading> "title")`.
 *  prefix + writtenTarget + heading + suffix is the link's text:
 *  - prefix: everything before the target (`[text](`, spaces, `<`);
 *  - writtenTarget: the target as written;
 *  - storedTarget: the target as Obsidian stores it, decoded;
 *  - heading: the raw `#heading`, "" without one;
 *  - suffix: everything after (spaces, `>`, the title, `)`);
 *  - destinationForm: how the destination is written. */
type MarkdownLinkParts = {
  prefix: string
  writtenTarget: string
  storedTarget: string
  heading: string
  suffix: string
  destinationForm: DestinationForm
}

// ── Line scanning ───────────────────────────────────────────────

/** Calls `visit` for each wikilink in `text`, left to right and never
 *  overlapping: `[[target#heading|alias]]`, with an optional `!` embed prefix.
 *  The target must be nonempty and the heading may be empty, but an alias
 *  must not be. */
const scanWikilinks = (text: string, visit: (span: LinkSpan) => void): void => {
  // Each delimiter cursor outlives a failed opener and only moves forward: a
  // later opener finds no delimiter before the one already found. This keeps
  // the scan linear on a line where many `[[` never close.
  let targetEnd = 0
  let headingEnd = 0
  let closeBracket = 0

  for (let start = 0; start < text.length; start++) {
    const open = text[start] === "!" ? start + 1 : start

    if (text[open] !== "[" || text[open + 1] !== "[") continue
    const targetStart = open + 2
    targetEnd = Math.max(targetEnd, targetStart)

    while (targetEnd < text.length && !"]#|".includes(text.charAt(targetEnd))) targetEnd++
    if (targetEnd === targetStart) continue
    let end = targetEnd

    if (text[end] === "#") {
      headingEnd = Math.max(headingEnd, end + 1)
      while (headingEnd < text.length && !"]|".includes(text.charAt(headingEnd))) headingEnd++
      end = headingEnd
    }
    if (text[end] === "|") {
      const aliasStart = end + 1
      closeBracket = Math.max(closeBracket, aliasStart)
      while (closeBracket < text.length && text[closeBracket] !== "]") closeBracket++
      if (closeBracket === aliasStart) continue
      end = closeBracket
    }
    if (text[end] !== "]" || text[end + 1] !== "]") continue
    visit({ start, end: end + 2, targetStart, targetEnd })
    // end + 1 is the second "]", and the loop's start++ moves past it.
    start = end + 1
  }
}

// ── Markdown link destinations ──────────────────────────────────

/** Decodes the numeric reference a piece opens with and keeps the rest of the
 *  piece as written. parse-entities decodes one only when a `;` ends a
 *  nonempty digit run, and it reads the run whole, so a long run reaches it
 *  without its leading zeros, which do not change the code point
 *  (`&#0000065;` is `A`). */
const decodeNumericReference = (piece: string): string => {
  const reference = NUMERIC_REFERENCE.exec(piece)

  // The pattern matches every text that opens with `&#`, as each piece here does.
  if (!reference?.groups) throw new Error("decodeNumericReference takes a piece that opens with &#")
  const { hexMarker = "", hexDigits, decimalDigits, semicolon } = reference.groups
  const digits = hexDigits ?? decimalDigits

  if (!digits || !semicolon) return piece
  const significantDigits = digits.replace(LEADING_ZEROS, "")
  const longestDigits = hexMarker ? CODE_POINT_DIGITS.hex : CODE_POINT_DIGITS.decimal
  const rest = piece.slice(reference[0].length)

  if (significantDigits.length > longestDigits) return `${REPLACEMENT_CHARACTER}${rest}`
  return `${parseEntities(`&#${hexMarker}${significantDigits};`, REFERENCE_OPTIONS)}${rest}`
}

/** Decodes the character references in one piece of text that holds no `&`
 *  after its first character.
 *  - Only the reference the piece opens with reaches parse-entities, which
 *    copies the text after a reference one character at a time; the rest of
 *    the piece is appended as written.
 *  - Legacy names are the HTML references that may omit their `;`, such as
 *    `&not`. In a longer name that a `;` ends, parse-entities decodes the
 *    longest legacy name it starts with: `&notit;` becomes `¬it;`.
 *  - parse-entities checks every prefix of a name for a legacy one, which
 *    costs quadratic time on a long run of letters. A name longer than any
 *    reference can only decode through a legacy prefix, so its head alone
 *    decides the output. */
const decodeReferencePiece = (piece: string): string => {
  if (!piece.startsWith("&")) return piece
  if (piece[1] === "#") return decodeNumericReference(piece)

  // The name's length is counted with a forward walk, so a long run is read once.
  let nameEnd = 1
  while (nameEnd < piece.length && REFERENCE_NAME_CHARACTER.test(piece.charAt(nameEnd))) nameEnd++
  const nameLength = nameEnd - 1

  // With REFERENCE_OPTIONS, a name no `;` ends decodes to itself.
  if (piece[nameEnd] !== ";") return piece
  if (nameLength <= LONGEST_REFERENCE_NAME) {
    const referenceEnd = nameEnd + ";".length
    return `${parseEntities(piece.slice(0, referenceEnd), REFERENCE_OPTIONS)}${piece.slice(referenceEnd)}`
  }

  // The head keeps `&` and one name character more than the longest name, so
  // the appended `;` cannot complete a whole name. Only a legacy prefix
  // decodes, as in the whole piece, and the `;` survives for the slice to drop.
  const headEnd = LONGEST_REFERENCE_NAME + 2
  const decodedHead = parseEntities(`${piece.slice(0, headEnd)};`, REFERENCE_OPTIONS)
  return `${decodedHead.slice(0, -";".length)}${piece.slice(headEnd)}`
}

/** The offset in `piece` of the source of the first `#` in `decodedPiece`, or
 *  -1 without one. A piece that opens with `&` decodes its reference first and
 *  keeps the rest as written, so a `#` at the start came from the reference
 *  (`&num;`) and any later `#` keeps its distance from the piece's end. */
const findHashSource = (params: { piece: string; decodedPiece: string }): number => {
  const { piece, decodedPiece } = params
  const hashIndex = decodedPiece.indexOf("#")

  if (hashIndex === -1) return -1
  if (hashIndex === 0) return 0

  const hashDistanceFromEnd = decodedPiece.length - hashIndex
  return piece.length - hashDistanceFromEnd
}

/** Decodes character references as Obsidian does in a link destination, and
 *  finds where the first `#` of the output came from.
 *  - A reference never holds an `&` after its first character, so the text
 *    decodes piece by piece, each piece after the first starting at an `&`.
 *    One parse-entities call over the whole text would repeat its last
 *    reference for a later `&` that decodes to nothing (`&lt;&gt.md` as
 *    `<<.md`), which Obsidian does not.
 *  - hashSource is the offset in `text` of that `#`, or of the reference that
 *    produced it, or -1 without one. */
const decodeCharacterReferences = (text: string): { decoded: string; hashSource: number } => {
  if (!text.includes("&")) return { decoded: text, hashSource: text.indexOf("#") }

  const decodedRuns: string[] = []
  const pendingPieces: string[] = []
  // The walk threads each piece's offset, and keeps the first `#` it finds.
  let pieceStart = 0
  let hashSource = -1

  while (pieceStart < text.length) {
    const nextAmpersand = text.indexOf("&", pieceStart + 1)
    const pieceEnd = nextAmpersand === -1 ? text.length : nextAmpersand
    const piece = text.slice(pieceStart, pieceEnd)
    const decodedPiece = decodeReferencePiece(piece)
    const hashInPiece = hashSource === -1 ? findHashSource({ piece, decodedPiece }) : -1

    if (hashInPiece !== -1) hashSource = pieceStart + hashInPiece
    pendingPieces.push(decodedPiece)
    if (pendingPieces.length === PIECES_PER_JOIN) {
      decodedRuns.push(pendingPieces.join(""))
      pendingPieces.length = 0
    }
    pieceStart = pieceEnd
  }
  decodedRuns.push(pendingPieces.join(""))
  return { decoded: decodedRuns.join(""), hashSource }
}

const isEscapePairAt = (text: string, position: number): boolean => {
  return text[position] === "\\" && ASCII_PUNCTUATION.test(text.charAt(position + 1))
}

/** Maps `unescapedOffset`, an offset in `content` with its escape backslashes
 *  dropped, back to an offset in `content`. An escaped character maps to its
 *  backslash. */
const findRawOffset = (content: string, unescapedOffset: number): number => {
  // Each step reads one character of the unescaped text: an escape pair or a
  // single character.
  let rawOffset = 0

  for (let unescapedIndex = 0; unescapedIndex < unescapedOffset; unescapedIndex++) {
    rawOffset += isEscapePairAt(content, rawOffset) ? 2 : 1
  }
  return rawOffset
}

const decodeUriOrNull = (encoded: string): string | null => {
  try {
    return decodeURI(encoded)
  } catch {
    // The text holds a malformed escape; each caller decides what that means.
    return null
  }
}

/** A destination's target as Obsidian stores it. rawHeadingOffset is where the
 *  raw `#heading` starts in the destination's content, or null without one. */
type StoredTarget = { target: string; rawHeadingOffset: number | null }

/** Reads a markdown link destination's content the way Obsidian stores the
 *  link, or returns null for a destination that names no other note or file:
 *  1. drop each backslash before ASCII punctuation;
 *  2. decode character references (`&amp;`, `&#35;`);
 *  3. percent-decode like `decodeURI`, which keeps reserved escapes such as
 *     `%26` and `%23`. A malformed escape drops a plain link, while an embed
 *     keeps its text undecoded (`![i](100%.png)` stores `100%.png`);
 *  4. replace each no-break space with a space, and trim;
 *  5. drop a link holding a `:`, which Obsidian reads as a URL, unless step
 *     2's output starts with `./` or `../`;
 *  6. split at the first `#`, and drop a link with no target before it (a
 *     heading in the same note). */
const readStoredTarget = (params: {
  content: string
  linkKind: MarkdownLinkKind
}): StoredTarget | null => {
  const { content, linkKind } = params
  const unescaped = content.replace(ESCAPED_PUNCTUATION, "$1")
  const { decoded, hashSource } = decodeCharacterReferences(unescaped)
  const decodedLink = decodeUriOrNull(decoded) ?? (linkKind === "embed" ? decoded : null)

  if (decodedLink === null) return null

  const storedLink = decodedLink.replaceAll(NO_BREAK_SPACE, " ").trim()
  // Obsidian checks how the link starts before percent-decoding and trimming, so
  // `%2E%2E/a:b.md` and `< ../a:b.md>` are still URLs.
  const readsAsUrl = storedLink.includes(":") && !RELATIVE_LINK_START.test(decoded)

  if (readsAsUrl) return null

  const hashIndex = storedLink.indexOf("#")
  const linkpath = hashIndex === -1 ? storedLink : storedLink.slice(0, hashIndex)
  // A space before the `#` (`<a.md #h>`) stays out of the target.
  const target = linkpath.trim()

  if (!target) return null

  // The stored link's first `#` is the first one references produced:
  // percent-decoding keeps `%23` encoded, and trimming removes only whitespace.
  const rawHeadingOffset = hashSource === -1 ? null : findRawOffset(content, hashSource)
  return { target, rawHeadingOffset }
}

/** A run of percent escapes. Global — use only with replace. */
const PERCENT_ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g

/** A character a link's destination decodes: an escape backslash, a percent
 *  escape's `%`, a character reference's `&`, or a no-break space. */
const LINK_DECODED_CHARACTER = /[\\%&\u00a0]/

/** Decodes a whole file's text the way a stored markdown link decodes its
 *  destination, so a substring search for a target finds the links that
 *  store it:
 *  - escape backslashes are dropped and character references decoded;
 *  - each run of percent escapes is decoded like decodeURI, and a malformed
 *    run stays as written, so one bad escape leaves the file's other links
 *    decoded;
 *  - no-break spaces become spaces.
 *  It neither trims nor drops URLs, because it reads many links at once, and
 *  it returns text with none of those characters unchanged. */
const decodeLinkSpellings = (text: string): string => {
  // Most files hold none of the characters a link decodes, so they skip the
  // passes below.
  if (!LINK_DECODED_CHARACTER.test(text)) return text

  const unescaped = text.replace(ESCAPED_PUNCTUATION, "$1")
  const { decoded } = decodeCharacterReferences(unescaped)
  const percentDecoded = decoded.replace(PERCENT_ESCAPE_RUN, (run) => decodeUriOrNull(run) ?? run)
  return percentDecoded.replaceAll(NO_BREAK_SPACE, " ")
}

/** Characters a backslash keeps literal in both destination forms:
 *  - a raw `*` or `$` pairs with one earlier on the line, and Obsidian then
 *    reads emphasis or math that hides the link (`*a [x](b*c.md)` holds no
 *    link);
 *  - a raw `[` or `]` could end the link's text. */
const BACKSLASH_ESCAPED_CHARACTERS: ReadonlySet<string> = new Set(["*", "$", "[", "]"])

/** Characters that open emphasis, strikethrough or a highlight only in a run
 *  or at a word's edge, so a single one between two other characters stays
 *  raw (`meeting_notes.md`). */
const RUN_DELIMITER_CHARACTERS: ReadonlySet<string> = new Set(["_", "~", "="])

/** A character a destination writes percent-encoded in both forms:
 *  - `%`, because Obsidian percent-decodes the link;
 *  - `#`, which would start a heading;
 *  - `` ` ``, because a backslash before one still opens a code span;
 *  - `"`, `\`, `^`, `{`, `|`, `}`, which encodeURI escapes too. */
const PERCENT_ENCODED_CHARACTERS: ReadonlySet<string> = new Set([
  "%",
  "#",
  "`",
  '"',
  "\\",
  "^",
  "{",
  "|",
  "}",
])

const ASCII_LETTER = /[A-Za-z]/

const ASCII_LETTER_OR_DIGIT = /[A-Za-z0-9]/

/** C0 controls (below U+0020) and DEL (U+007F). */
const isControlCharacter = (character: string): boolean => {
  const codeUnit = character.charCodeAt(0)
  return codeUnit < 0x20 || codeUnit === 0x7f
}

const percentEncode = (character: string): string => {
  return [...Buffer.from(character, "utf8")]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("")
}

/** Whether every prefix of `path` closes no more parentheses than it opens,
 *  and the whole path closes them all, so raw parentheses cannot end a bare
 *  destination early. */
const hasBalancedParentheses = (path: string): boolean => {
  // The walk threads the open-parenthesis depth.
  let depth = 0

  for (const character of path) {
    if (character === "(") depth++
    if (character === ")") depth--
    if (depth < 0) return false
  }
  return depth === 0
}

/** One character of a new path with its neighbours, which are undefined at
 *  the path's edges. */
type PathCharacter = {
  character: string
  previous: string | undefined
  next: string | undefined
}

const toPathCharacters = (path: string): PathCharacter[] => {
  const characters = [...path]

  return characters.map((character, index) => {
    return { character, previous: characters[index - 1], next: characters[index + 1] }
  })
}

/** Whether a `_`, `~` or equals sign stands alone between two characters
 *  that are not whitespace. */
const isSingleBetweenNonWhitespace = ({ character, previous, next }: PathCharacter): boolean => {
  if (!previous || !next) return false
  return (
    previous !== character &&
    next !== character &&
    !WHITESPACE.test(previous) &&
    !WHITESPACE.test(next)
  )
}

/** How one character of a new path is written in a destination, by the
 *  rules both forms share, or null when the form decides. */
const encodeSharedCharacter = (pathCharacter: PathCharacter): string | null => {
  const { character, previous, next } = pathCharacter

  if (PERCENT_ENCODED_CHARACTERS.has(character)) return percentEncode(character)
  if (BACKSLASH_ESCAPED_CHARACTERS.has(character)) return `\\${character}`
  // A `_` before anything but an ASCII letter or digit closes emphasis that
  // an earlier `_` on the line opens, and Obsidian then reads no link
  // (`snake_case [x](a_(b).md)`). The run rule below escapes a `_` that ends
  // the path.
  if (character === "_" && next && !ASCII_LETTER_OR_DIGIT.test(next)) return "\\_"
  // A heading written after the path can complete a reference that a final
  // `&` opens (`R&D&` before `#35;`), so that `&` is written as a reference.
  if (character === "&" && !next) return "&amp;"
  if (RUN_DELIMITER_CHARACTERS.has(character)) {
    return isSingleBetweenNonWhitespace(pathCharacter) ? character : `\\${character}`
  }
  // A letter after `&` could start a character reference (`&amp;`), and a
  // backslash does not stop Obsidian decoding one, so the letter is encoded.
  if (ASCII_LETTER.test(character) && previous === "&") return percentEncode(character)
  return null
}

/** Writes a new path as a bare destination that Obsidian stores as that
 *  path: what encodeURI escapes is percent-encoded, `<` and `>` are
 *  backslash-escaped, and parentheses stay raw when they balance. */
const encodeBareDestination = (path: string): string => {
  const keepsParentheses = hasBalancedParentheses(path)

  return toPathCharacters(path)
    .map((pathCharacter) => {
      const { character } = pathCharacter
      const sharedEncoding = encodeSharedCharacter(pathCharacter)

      if (sharedEncoding !== null) return sharedEncoding
      if (character === "<" || character === ">") return `\\${character}`
      if (character === "(" || character === ")") {
        return keepsParentheses ? character : percentEncode(character)
      }
      return encodeURI(character)
    })
    .join("")
}

/** Writes a new path as an angle destination that Obsidian stores as that
 *  path: spaces, parentheses and non-ASCII characters stay raw, control
 *  characters are percent-encoded, and so are `<` and `>`, since the first
 *  `>` closes the brackets. */
const encodeAngleDestination = (path: string): string => {
  return toPathCharacters(path)
    .map((pathCharacter) => {
      const { character } = pathCharacter
      const sharedEncoding = encodeSharedCharacter(pathCharacter)

      if (sharedEncoding !== null) return sharedEncoding
      if (character === "<" || character === ">" || isControlCharacter(character)) {
        return percentEncode(character)
      }
      return character
    })
    .join("")
}

/** Writes a new path in a markdown link's destination form, in a spelling
 *  that Obsidian stores as the path and extractFromBody reads back as the
 *  path. Three kinds of path have no such spelling, so a link written to one
 *  does not reach it:
 *  - one holding `#` or `:`, which Obsidian forbids in file names;
 *  - one with whitespace at its edges, which Obsidian trims;
 *  - one holding a no-break space, which Obsidian reads as a space. */
const encodeMarkdownDestination = (path: string, form: DestinationForm): string => {
  switch (form) {
    case "bare":
      return encodeBareDestination(path)
    case "angle":
      return encodeAngleDestination(path)
  }
}

/** The first position at or after `from` whose character `accepts` takes
 *  with an even run of backslashes before it, or text.length. The character
 *  before `from` must not be a backslash. */
const findUnescaped = (params: {
  text: string
  from: number
  accepts: (character: string) => boolean
}): number => {
  const { text, from, accepts } = params
  // The backslash run before each character decides whether it is escaped.
  let backslashRun = 0

  for (let position = from; position < text.length; position++) {
    const character = text.charAt(position)

    if (backslashRun % 2 === 0 && accepts(character)) return position
    backslashRun = character === "\\" ? backslashRun + 1 : 0
  }
  return text.length
}

/** Each unescaped parenthesis of a line, in order. matches holds the record
 *  index of each `(`'s matching `)`, or -1 for a `)` and for a `(` without
 *  one. The two arrays take 8 bytes per parenthesis and nothing per other
 *  character. */
type ParenRecords = { positions: Int32Array; matches: Int32Array }

/** Calls `visit` with each unescaped parenthesis's position. It walks the
 *  line itself rather than calling findUnescaped once per parenthesis, so a
 *  parenthesis-dense line allocates nothing per parenthesis. */
const forEachUnescapedParenthesis = (text: string, visit: (position: number) => void): void => {
  // Whether a character is escaped depends on the backslash run before it,
  // so the walk threads that run's length.
  let backslashRun = 0

  for (let position = 0; position < text.length; position++) {
    const character = text[position]
    const isUnescapedParenthesis =
      (character === "(" || character === ")") && backslashRun % 2 === 0

    if (isUnescapedParenthesis) visit(position)
    backslashRun = character === "\\" ? backslashRun + 1 : 0
  }
}

/** Every caller passes an index in range, so the -1 fallback only narrows
 *  the typed array's element type. */
const readRecord = (records: Int32Array, recordIndex: number): number => {
  return records[recordIndex] ?? -1
}

const buildParenRecords = (text: string): ParenRecords => {
  // A first pass counts the parentheses, so the arrays are sized to them.
  let parenthesisCount = 0
  forEachUnescapedParenthesis(text, () => {
    parenthesisCount++
  })

  const positions = new Int32Array(parenthesisCount)
  const matches = new Int32Array(parenthesisCount)
  // While a `(` is open, its slot in matches holds the record of the open `(`
  // below it, so the stack of open parentheses needs no array of its own.
  let openRecord = -1
  let recordIndex = 0

  forEachUnescapedParenthesis(text, (position) => {
    positions[recordIndex] = position
    matches[recordIndex] = -1

    if (text[position] === "(") {
      matches[recordIndex] = openRecord
      openRecord = recordIndex
    } else if (openRecord !== -1) {
      const recordBelow = readRecord(matches, openRecord)
      matches[openRecord] = recordIndex
      openRecord = recordBelow
    }
    recordIndex++
  })

  // A `(` still open at the line's end has no match, but its slot holds the
  // record below it, which would read as a match. Each such slot is reset.
  while (openRecord !== -1) {
    const recordBelow = readRecord(matches, openRecord)
    matches[openRecord] = -1
    openRecord = recordBelow
  }
  return { positions, matches }
}

const findNonWhitespace = (text: string, from: number): number => {
  // A caller that can revisit a run wraps this walk in a forward cursor.
  let position = from

  while (position < text.length && WHITESPACE.test(text.charAt(position))) position++
  return position
}

/** Wraps a search for the first match at or after a position as a cursor:
 *  while a search starts at or before the last match, that match is still
 *  the first one, so the cursor returns it without scanning. The caller's
 *  search starts must never move backward, which keeps each stretch of the
 *  line scanned at most once. */
const createForwardCursor = (search: (from: number) => number): ((from: number) => number) => {
  // The last match found, reused while later searches start at or before it.
  let lastMatch = -1

  return (from) => {
    if (lastMatch < from) lastMatch = search(from)
    return lastMatch
  }
}

/** The characters that close a link title opened by `"`, `'` or `(`. */
type TitleCloser = '"' | "'" | ")"

const TITLE_CLOSERS: ReadonlyMap<string, TitleCloser> = new Map([
  ['"', '"'],
  ["'", "'"],
  ["(", ")"],
])

/** One destination form's cursors after the destination:
 *  - the end of the whitespace run that follows it;
 *  - per title closer, the closer and the end of the whitespace run after it.
 *    Each closer kind keeps its own cursors, because a later title closed by
 *    `'` can end before an earlier one closed by `"`. */
type FormCursors = {
  skipAfterDestination: (from: number) => number
  findTitleCloser: Record<TitleCloser, (from: number) => number>
  skipAfterTitle: Record<TitleCloser, (from: number) => number>
}

const createFormCursors = (text: string): FormCursors => {
  const createTitleCloserCursor = (closer: TitleCloser): ((from: number) => number) => {
    return createForwardCursor((from) => {
      return findUnescaped({ text, from, accepts: (character) => character === closer })
    })
  }
  const createWhitespaceSkip = (): ((from: number) => number) => {
    return createForwardCursor((from) => findNonWhitespace(text, from))
  }

  return {
    skipAfterDestination: createWhitespaceSkip(),
    findTitleCloser: {
      '"': createTitleCloserCursor('"'),
      "'": createTitleCloserCursor("'"),
      ")": createTitleCloserCursor(")"),
    },
    skipAfterTitle: {
      '"': createWhitespaceSkip(),
      "'": createWhitespaceSkip(),
      ")": createWhitespaceSkip(),
    },
  }
}

/** A destination's content [contentStart, contentEnd), and where the scan
 *  reads on after it. */
type ScannedDestination = {
  form: DestinationForm
  contentStart: number
  contentEnd: number
  after: number
}

/** A complete markdown link destination, from its `(` to the `)` at `end - 1`. */
type ScannedLink = ScannedDestination & { end: number }

/** Builds the reader that scans the destination after one `](`, for every
 *  `](` of a line in left-to-right order. It holds the line's parenthesis
 *  records and one cursor per search, and each cursor only moves forward,
 *  so the line costs linear time:
 *  - the bare whitespace and angle cursors serve destination starts, which
 *    only move forward;
 *  - each form's cursors after the destination serve positions that only
 *    move forward within that form. A bare destination that starts inside
 *    an earlier one either closes at its own `)` or shares that one's first
 *    whitespace: in `[a](x[b](y z)`, both `x[b](y` and `y` end at the space
 *    before `z`. The forms keep separate cursors because a bare title can
 *    start before a failed angle title: `[a](< [b](x.md "t") > "x`.
 *
 *  Openers whose link text ends at the same `]` read one destination, so the
 *  last result, a rejection included, is cached by its `(`. */
const createDestinationReader = (text: string): ((openParen: number) => ScannedLink | null) => {
  const parens = buildParenRecords(text)
  const findBareWhitespace = createForwardCursor((from) => {
    return findUnescaped({ text, from, accepts: (character) => WHITESPACE.test(character) })
  })
  const findAngleCloser = createForwardCursor((from) => {
    const closer = text.indexOf(">", from)
    return closer === -1 ? text.length : closer
  })
  const findLineBreak = createForwardCursor((from) => {
    // A plain walk: the cursor keeps each stretch from being walked twice.
    let position = from

    while (position < text.length && text[position] !== "\n" && text[position] !== "\r") position++
    return position
  })
  const formCursors: Record<DestinationForm, FormCursors> = {
    angle: createFormCursors(text),
    bare: createFormCursors(text),
  }
  // The paren record index serves `(` positions, which only move forward.
  let parenOrdinal = 0
  // The last `(` read and its result, reused by the openers that share it.
  let cachedOpenParen = -1
  let cachedLink: ScannedLink | null = null

  /** The position of the `)` that matches the `(` at openParen, or -1. The
   *  `(` of `](` follows a `]`, so it is unescaped and has a record. */
  const findMatchingParen = (openParen: number): number => {
    while ((parens.positions[parenOrdinal] ?? text.length) < openParen) parenOrdinal++
    const matchRecord = readRecord(parens.matches, parenOrdinal)
    return matchRecord === -1 ? -1 : readRecord(parens.positions, matchRecord)
  }

  /** `<…>`: the first `>` closes it, and an LF or CR before that `>` fails
   *  it. U+2028 and U+2029 stay inside it, as in Obsidian. */
  const scanAngleDestination = (openBracket: number): ScannedDestination | null => {
    const contentStart = openBracket + 1
    const closeBracket = findAngleCloser(contentStart)

    if (closeBracket === text.length || findLineBreak(contentStart) < closeBracket) return null
    return { form: "angle", contentStart, contentEnd: closeBracket, after: closeBracket + 1 }
  }

  /** A bare destination runs to its first unescaped whitespace, or to the `)`
   *  that matches the link's own `(`, whichever comes first. Without either,
   *  it fails. */
  const scanBareDestination = (params: {
    contentStart: number
    openParen: number
  }): ScannedDestination | null => {
    const { contentStart, openParen } = params
    const whitespace = findBareWhitespace(contentStart)
    const matchingParen = findMatchingParen(openParen)
    const endsAtParen = matchingParen !== -1 && matchingParen < whitespace
    const contentEnd = endsAtParen ? matchingParen : whitespace

    if (contentEnd === text.length) return null
    return { form: "bare", contentStart, contentEnd, after: contentEnd }
  }

  /** The end of the link after its destination, or -1: whitespace, then an
   *  optional title in `"…"`, `'…'` or `(…)` after at least one whitespace
   *  character, then whitespace and `)`. */
  const scanTitleAndClose = (destination: ScannedDestination): number => {
    // A bare destination that ends at its `)` closes there. That `)` can sit
    // before an earlier attempt's destination end (`[b](y)` inside
    // `[a](x[b](y)z w`), so checking first keeps it out of the cursors.
    if (text[destination.after] === ")") return destination.after + 1

    const cursors = formCursors[destination.form]
    const titleStart = cursors.skipAfterDestination(destination.after)

    if (text[titleStart] === ")") return titleStart + 1

    const closer = TITLE_CLOSERS.get(text.charAt(titleStart))
    const followsWhitespace = titleStart > destination.after

    if (!closer || !followsWhitespace) return -1

    const titleEnd = cursors.findTitleCloser[closer](titleStart + 1)

    if (titleEnd === text.length) return -1

    const closeParen = cursors.skipAfterTitle[closer](titleEnd + 1)
    return text[closeParen] === ")" ? closeParen + 1 : -1
  }

  const scanLink = (openParen: number): ScannedLink | null => {
    // Each `(` is read once, and its leading whitespace ends before the next
    // `](`, so this walk needs no cursor.
    const destinationStart = findNonWhitespace(text, openParen + 1)
    const destination =
      text[destinationStart] === "<"
        ? scanAngleDestination(destinationStart)
        : scanBareDestination({ contentStart: destinationStart, openParen })

    if (!destination) return null

    const end = scanTitleAndClose(destination)
    return end === -1 ? null : { ...destination, end }
  }

  return (openParen) => {
    if (openParen !== cachedOpenParen) {
      cachedLink = scanLink(openParen)
      cachedOpenParen = openParen
    }
    return cachedLink
  }
}

/** Whether the character at `position` (a `[` or `]`, or the `!` before a
 *  `[`) is escaped by an odd run of backslashes. A backslash run sits
 *  directly before one character, which the scan checks at most once, so a
 *  line's walks add up to its length. */
const isEscapedAt = (text: string, position: number): boolean => {
  // The walk counts the backslashes directly before the character.
  let backslashStart = position

  while (backslashStart > 0 && text[backslashStart - 1] === "\\") backslashStart--
  return (position - backslashStart) % 2 === 1
}

/** The span of a scanned link with a stored target, or null for one without.
 *  start is the link's `[`, or an embed's `!`. */
const toMarkdownLinkSpan = (params: {
  text: string
  start: number
  link: ScannedLink
  linkKind: MarkdownLinkKind
}): MarkdownLinkSpan | null => {
  const { text, start, link, linkKind } = params
  const { form, contentStart, contentEnd, end } = link
  const content = text.slice(contentStart, contentEnd)
  const storedTarget = readStoredTarget({ content, linkKind })

  if (!storedTarget) return null

  // Spaces around the target stay outside it, so a rewrite keeps them.
  // Encoded spaces (`%20a.md`) stay inside it, though the stored target
  // trims them.
  const targetStart = contentStart + (content.length - content.trimStart().length)
  const { rawHeadingOffset } = storedTarget
  const hasHeading = rawHeadingOffset !== null
  const targetEnd = hasHeading
    ? contentStart + rawHeadingOffset
    : contentStart + content.trimEnd().length
  const headingEnd = hasHeading ? contentEnd : targetEnd

  return {
    start,
    end,
    targetStart,
    targetEnd,
    destinationForm: form,
    headingEnd,
    storedTarget: storedTarget.target,
  }
}

/** Calls `visit` for each markdown link `[text](destination "title")` that
 *  names another note or file, left to right and never overlapping. The
 *  grammar follows Obsidian's, except that the link text ends at its first
 *  unescaped `]`, so `[a [b] c](d.md)` holds no link:
 *  - openers and link-text brackets are found in `maskedText`, where a caller
 *    may blank inline code and other spans it skips, keeping every offset;
 *  - destinations and titles are read from `destinationText`, the same text
 *    as written, because Obsidian reads backticks there as part of the
 *    destination (``[x](<a`b`.md>)`` stores ``a`b`.md``);
 *  - a `[` or `]` after an odd run of backslashes is text, so `[a\](b.md)`
 *    holds no link;
 *  - an unescaped `!` directly before the `[` makes the link an embed;
 *  - the destination is `<…>` or bare, after optional whitespace;
 *  - a title in `"…"`, `'…'` or `(…)` may follow after whitespace;
 *  - a complete link is used up even when it names nothing (a URL, a heading
 *    in the same note), so the scan resumes after its `)`;
 *  - `visitDestinationAndTitle` receives each complete link's destination and
 *    title, from the character after its `(` to its end. */
const scanMarkdownLinks = (params: {
  maskedText: string
  destinationText: string
  visit: (span: MarkdownLinkSpan) => void
  visitDestinationAndTitle?: (region: { start: number; end: number }) => void
}): void => {
  const { maskedText, destinationText, visit, visitDestinationAndTitle } = params
  // The link text cursor outlives a failed opener and only moves forward: a
  // later opener reaches the same `]` or a later one.
  let textEnd = 0
  // Built at the line's first `](`, so a line without one allocates nothing.
  let readLink: ((openParen: number) => ScannedLink | null) | undefined

  // The position the cursor last stopped at, an unescaped `]` or the line's
  // end. Openers that reach it again return it without walking the backslash
  // run before it, so each `]` is checked once and the scan stays linear on
  // `[[[…\\\\…]`.
  let checkedTextEnd = -1

  const isUnescapedAt = (position: number, character: string): boolean => {
    return maskedText[position] === character && !isEscapedAt(maskedText, position)
  }

  const findLinkTextEnd = (start: number): number => {
    textEnd = Math.max(textEnd, start + 1)

    if (textEnd === checkedTextEnd) return textEnd
    while (textEnd < maskedText.length && !isUnescapedAt(textEnd, "]")) textEnd++
    checkedTextEnd = textEnd
    return textEnd
  }

  for (let start = 0; start < maskedText.length; start++) {
    if (!isUnescapedAt(start, "[")) continue

    const openParen = findLinkTextEnd(start) + 1

    if (maskedText[openParen] !== "(") continue

    readLink ??= createDestinationReader(destinationText)
    const link = readLink(openParen)

    if (!link) continue

    // An unescaped `!` directly before the `[` makes the link an embed.
    const markerStart = start - 1
    const opensEmbed = isUnescapedAt(markerStart, "!")
    const span = opensEmbed
      ? toMarkdownLinkSpan({ text: destinationText, start: markerStart, link, linkKind: "embed" })
      : toMarkdownLinkSpan({ text: destinationText, start, link, linkKind: "link" })

    if (span) visit(span)
    visitDestinationAndTitle?.({ start: openParen + 1, end: link.end })
    // end - 1 is the link's `)`, and the loop's start++ moves past it.
    start = link.end - 1
  }
}

/** Replaces each Templater expression in `text` with as many spaces, so links
 *  inside one are not extracted and every offset after it stays the same.
 *  - Templater is an Obsidian plugin whose `<% … %>` (and `<%+ … %>`)
 *    expressions run when a template is applied; links in them are template
 *    code, not links in the note.
 *  - An expression must close before the next line terminator, so a CR or a
 *    Unicode line separator inside `text` ends it too. */
const maskTemplaterExpressions = (text: string): string => {
  const pieces: string[] = []
  // The closer cursor outlives a failed opener: a later opener finds no `%>`
  // or line terminator before it.
  let close = 0
  let copiedThrough = 0

  const isCloserAt = (position: number): boolean => {
    return text[position] === "%" && text[position + 1] === ">"
  }

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "<" || text[start + 1] !== "%") continue
    close = Math.max(close, start + 2)
    while (close < text.length && !LINE_TERMINATOR.test(text.charAt(close)) && !isCloserAt(close)) {
      close++
    }
    if (!isCloserAt(close)) continue
    const end = close + 2
    pieces.push(text.slice(copiedThrough, start), " ".repeat(end - start))
    copiedThrough = end
    start = end - 1
  }
  if (pieces.length === 0) return text
  pieces.push(text.slice(copiedThrough))
  return pieces.join("")
}

/** Matches what ends a wikilink's target as Obsidian reads it: `#`, `|` or
 *  `]]`, but not a lone `]`. */
const WIKILINK_TARGET_DELIMITER = /[#|]|\]\]/

/** Calls the visitors for each link in a body line, wikilinks first and then
 *  markdown links:
 *  - `maskedLine` is `line` with the spans a caller skips blanked to spaces;
 *    markdown links are found in it and their destinations and titles read
 *    from `line`, as scanMarkdownLinks describes;
 *  - a wikilink inside a markdown link's destination or title is part of that
 *    link, as Obsidian reads `[x](a.md "[[b]]")` and
 *    `[x](https://example.com "[[b]]")`, so wikilinks are found with every
 *    complete destination and title blanked too;
 *  - a wikilink's target ends at its first `#`, `|` or `]]` in `line`, and the
 *    link at its first `]]` after the target, inside a code span or a
 *    Templater expression too, as Obsidian stores ``[[a `|` b]]`` as ``a ` ``. */
const scanBodyLineLinks = (params: {
  maskedLine: string
  line: string
  visitWikilink: (span: LinkSpan) => void
  visitMarkdownLink: (span: MarkdownLinkSpan) => void
}): void => {
  const { maskedLine, line, visitWikilink, visitMarkdownLink } = params
  const markdownSpans: MarkdownLinkSpan[] = []
  // The masked line with each destination and title blanked, built in pieces
  // as the scan reports them in text order. A wikilink cannot cross a link's
  // `](`, so the blanking removes only wikilinks that start inside a
  // destination or title.
  const wikilinkLinePieces: string[] = []
  // How much of the masked line the pieces already hold.
  let copiedThrough = 0

  scanMarkdownLinks({
    maskedText: maskedLine,
    destinationText: line,
    visit: (span) => markdownSpans.push(span),
    visitDestinationAndTitle: ({ start, end }) => {
      wikilinkLinePieces.push(maskedLine.slice(copiedThrough, start), " ".repeat(end - start))
      copiedThrough = end
    },
  })

  // A line with no complete markdown link is scanned as it is, so it is not copied.
  const wikilinkLine =
    wikilinkLinePieces.length === 0
      ? maskedLine
      : [...wikilinkLinePieces, maskedLine.slice(copiedThrough)].join("")

  // Masking only blanks characters, so each delimiter found in `line` is never
  // after the one the masked scan stopped at, and both searches stay inside
  // the span.
  const visitWikilinkAsWritten = (span: LinkSpan): void => {
    const delimiterOffset = line
      .slice(span.targetStart, span.targetEnd)
      .search(WIKILINK_TARGET_DELIMITER)
    const targetEnd = delimiterOffset === -1 ? span.targetEnd : span.targetStart + delimiterOffset
    // The first `]]` after the target closes the link, in a heading or an alias
    // too, as Obsidian reads ``[[a#h `]]` c]]`` as ``[[a#h `]]``, so a rewrite
    // keeps the text after it.
    const end = line.indexOf("]]", targetEnd) + "]]".length
    visitWikilink({ ...span, targetEnd, end })
  }

  scanWikilinks(wikilinkLine, visitWikilinkAsWritten)
  for (const span of markdownSpans) visitMarkdownLink(span)
}

/** Finds a body line's wikilinks, then its markdown links (not in text order),
 *  outside inline code, as links.extractFromBody reads them. Unlike
 *  extractFromBody, it also finds links inside Templater expressions.
 *  Offsets and each match's `text` come from `line` as written. */
const matchLinksInLine = (line: string): LinkMatch[] => {
  const matches: LinkMatch[] = []
  scanBodyLineLinks({
    maskedLine: maskInlineCode(line),
    line,
    visitWikilink: ({ start, end }) => {
      matches.push({ text: line.slice(start, end), start, end, kind: "wikilink" })
    },
    visitMarkdownLink: ({ start, end }) => {
      matches.push({ text: line.slice(start, end), start, end, kind: "markdown" })
    },
  })
  return matches
}

/** Finds every wikilink in `text`, such as a frontmatter value, where
 *  markdown links are not read. */
const matchWikilinks = (text: string): LinkMatch[] => {
  const matches: LinkMatch[] = []
  scanWikilinks(text, ({ start, end }) => {
    matches.push({ text: text.slice(start, end), start, end, kind: "wikilink" })
  })
  return matches
}

/** Replaces each inline code span in `line` with as many spaces, so a scan
 *  finds no link inside one and every offset after it stays the same. The
 *  spaces keep text on either side of a span from joining into a new link. */
const maskInlineCode = (line: string): string => {
  return line.replace(INLINE_CODE_RE, (codeSpan) => " ".repeat(codeSpan.length))
}

// ── Parsing ─────────────────────────────────────────────────────

const stripExtension = (filePath: string): string => {
  const extension = posix.extname(filePath)
  return filePath.slice(0, filePath.length - extension.length)
}

/** The key that pairs a link's text with the files it could name. A link and
 *  a file a resolver could match must share a key; a key shared more widely
 *  costs only an extra re-resolve of the search index's links rows, which
 *  store it as link_name. The key is:
 *  - the last path segment, minus one trailing ".md" (case-sensitive, as
 *    noteTargetWithExtension adds it), lowercased;
 *  - "ς" folded to "σ", because toLowerCase turns a capital "Σ" into either one depending
 *    on what follows it, so one name could otherwise lowercase two ways. */
const pathToLinkName = (path: string): string => {
  const lastSegment = posix.basename(path)
  const name = lastSegment.endsWith(".md") ? lastSegment.slice(0, -".md".length) : lastSegment
  return name.toLowerCase().replaceAll("ς", "σ")
}

/** Splits a matched wikilink, or returns null for malformed text.
 *  A trailing backslash, with any whitespace after it, moves from the target
 *  into the heading, or into the alias when there is no heading, so the
 *  rebuilt link keeps it and the target reads as the index stores it
 *  (`[[a\ |b]]` stores `a`). */
const splitWikilink = (linkText: string): WikilinkParts | null => {
  const parts = WIKILINK_PARTS.exec(linkText)

  if (!parts) return null
  const [, embed, rawTarget, heading = "", alias = ""] = parts

  // Both groups take part in every match; the check only narrows their types.
  if (embed === undefined || rawTarget === undefined) return null
  const trimmedTarget = rawTarget.trimEnd()

  if (!trimmedTarget.endsWith("\\")) return { embed, target: rawTarget, heading, alias }
  const target = trimmedTarget.slice(0, -1)
  const escape = rawTarget.slice(target.length)

  if (heading) return { embed, target, heading: `${escape}${heading}`, alias }
  return { embed, target, heading, alias: `${escape}${alias}` }
}

/** Splits a markdown link's text into its parts with the scanner's grammar,
 *  or returns null when the text is not one whole link that names a note or
 *  file:
 *  - any vault target parses (notes, assets and extensionless targets), so
 *    moveNote can rewrite all of them;
 *  - `linkText` is scanned with its inline code blanked, as its line was. A
 *    code span that starts inside the link and ends after it must start after
 *    the `(`, since one starting earlier would have hidden the link from the
 *    line scan. It then lies in the destination or title, which are read as
 *    written, so cutting it off changes nothing. */
const splitMarkdownLink = (linkText: string): MarkdownLinkParts | null => {
  const spans: MarkdownLinkSpan[] = []
  scanMarkdownLinks({
    maskedText: maskInlineCode(linkText),
    destinationText: linkText,
    visit: (span) => spans.push(span),
  })
  const wholeSpan = spans.find(({ start, end }) => start === 0 && end === linkText.length)

  if (!wholeSpan) return null

  const { targetStart, targetEnd, headingEnd, storedTarget, destinationForm } = wholeSpan
  return {
    prefix: linkText.slice(0, targetStart),
    writtenTarget: linkText.slice(targetStart, targetEnd),
    storedTarget,
    heading: linkText.slice(targetEnd, headingEnd),
    suffix: linkText.slice(headingEnd),
    destinationForm,
  }
}

// ── Link-target limits ──────────────────────────────────────────

/** Linux's PATH_MAX is 4,096 bytes and counts the terminating NUL, so no file
 *  path is longer than this. It must match MAX_PATH_BYTES in
 *  utils/assert-path-within-max-length.ts, which this leaf layer cannot import. */
const MAX_PATH_BYTES = 4095

/** The longest link Obsidian writes from the current file, 10,236 bytes. Such
 *  a link climbs at most one "../" per folder of the linking note, and a note
 *  sits at most 2,047 folders deep (a folder takes at least 2 bytes with its
 *  slash, the file name at least 1). It then names a path of at most
 *  MAX_PATH_BYTES. */
const MAX_RELATIVE_LINK_BYTES = "../".length * 2047 + MAX_PATH_BYTES

/** A link target's path segments without the "." and empty ones, which path
 *  normalization skips. */
const meaningfulSegments = (target: string): string[] => {
  return target.split("/").filter((segment) => segment !== "" && segment !== ".")
}

const countLeadingParentSegments = (segments: readonly string[]): number => {
  const firstNameIndex = segments.findIndex((segment) => segment !== "..")
  return firstNameIndex === -1 ? segments.length : firstNameIndex
}

/** Whether a link target is within the length limits that every link Obsidian
 *  writes meets. Extraction skips a target over them, and resolution finds no
 *  match for it. A target fits when it is:
 *  - at most MAX_PATH_BYTES of UTF-8, in any shape;
 *  - at most MAX_RELATIVE_LINK_BYTES, with every ".." segment before every
 *    other segment, ignoring "." and empty ones, as in a link from the
 *    current file.
 *
 *  Two steps cost more than linear time on a longer crafted target:
 *  - normalizing it with posix.join in joinToSourceFolder;
 *  - deduplicating it in the extractors' Sets, because V8 hashes a string longer than 16,383
 *    characters by its length alone, so a Set of many such targets of one
 *    length compares each new target with all of them. */
const isWithinLinkTargetLimit = (target: string): boolean => {
  const targetBytes = Buffer.byteLength(target, "utf8")

  if (targetBytes <= MAX_PATH_BYTES) return true
  if (targetBytes > MAX_RELATIVE_LINK_BYTES) return false

  const segments = meaningfulSegments(target)
  const leadingParentCount = countLeadingParentSegments(segments)
  return !segments.slice(leadingParentCount).includes("..")
}

const isExtractableTarget = (target: string): boolean => {
  return target.length > 0 && isWithinLinkTargetLimit(target)
}

/** Joins a link target to the linking note's folder ("path from current
 *  file"), or returns null when the target's leading ".." run climbs above the
 *  vault root, where no vault file is. Skipping that join keeps a long leading
 *  run of "../" from costing more than linear time. A caller bounds every other
 *  shape by checking isWithinLinkTargetLimit first. */
const joinToSourceFolder = (sourcePath: string, target: string): string | null => {
  const sourceFolder = posix.dirname(sourcePath)
  const leadingParentCount = countLeadingParentSegments(meaningfulSegments(target))
  const sourceFolderDepth = meaningfulSegments(sourceFolder).length

  if (leadingParentCount > sourceFolderDepth) return null
  return posix.join(sourceFolder, target)
}

// ── Extraction ──────────────────────────────────────────────────

/** Extracts link targets from a note body, skipping links inside fenced code
 *  blocks, inline code spans and Templater expressions. Returns deduplicated
 *  raw targets (pre-resolution) within the link-target limit. */
const extractFromBody = (content: string): string[] => {
  const targets = new Set<string>()

  for (const { text, inCode } of classifyLines(content)) {
    if (inCode) continue

    const linkExtractableLine = maskTemplaterExpressions(maskInlineCode(text))

    scanBodyLineLinks({
      maskedLine: linkExtractableLine,
      line: text,
      visitWikilink: ({ targetStart, targetEnd }) => {
        // Obsidian reads a wikilink's target as written, backticks and
        // Templater expressions included (``[[a `b` c]]`` stores ``a `b` c``).
        const rawTarget = text.slice(targetStart, targetEnd)
        const target = readStoredWikilinkTarget(rawTarget)

        if (isExtractableTarget(target)) targets.add(target)
      },
      visitMarkdownLink: ({ storedTarget }) => {
        if (isExtractableTarget(storedTarget)) targets.add(storedTarget)
      },
    })
  }
  return [...targets]
}

/** Extracts [[wikilink]] targets from frontmatter property values. Obsidian
 *  resolves wikilinks in any frontmatter property (e.g. `related:`), so they are
 *  real graph edges — body-only extraction silently drops them. Recursively walks
 *  strings, arrays, and nested objects, applying the wikilink grammar to every
 *  string. Frontmatter is YAML (no code fences or inline-code spans), so the body
 *  extractor's fence handling doesn't apply. Markdown [text](path.md) links are a
 *  body convention and are intentionally not scanned here. Returns deduplicated
 *  raw targets (pre-resolution) within the link-target limit, matching
 *  extractFromBody's contract. */
const extractFromFrontmatter = (data: Record<string, unknown>): string[] => {
  const targets = new Set<string>()

  // Walks one frontmatter value, adding every [[wikilink]] target it finds to
  // `targets`. A string holds links, an array or object recurses into its
  // values, and anything else (a number, a boolean, null) holds no link.
  const collectWikilinksFrom = (frontmatterValue: unknown): void => {
    // Leaf: a string may hold one or more wikilinks — pull out each target.
    if (typeof frontmatterValue === "string") {
      scanWikilinks(frontmatterValue, ({ targetStart, targetEnd }) => {
        const rawTarget = frontmatterValue.slice(targetStart, targetEnd)
        const target = readStoredWikilinkTarget(rawTarget)

        if (isExtractableTarget(target)) targets.add(target)
      })
      return
    }
    // Array (e.g. a multi-value `related:`): recurse into every element.
    if (Array.isArray(frontmatterValue)) {
      for (const item of frontmatterValue) collectWikilinksFrom(item)
      return
    }
    // Nested object: recurse into every value. The null guard is required —
    // `typeof null === "object"`, and Object.values(null) would throw.
    if (frontmatterValue !== null && typeof frontmatterValue === "object") {
      for (const nestedValue of Object.values(frontmatterValue)) {
        collectWikilinksFrom(nestedValue)
      }
    }
  }

  collectWikilinksFrom(data)
  return [...targets]
}

// ── Resolution ──────────────────────────────────────────────────

/** Code-point count of a path, not the UTF-16 code-unit count that
 *  String.length reports, so a non-BMP character, which takes two UTF-16
 *  units, counts as one. */
const codePointLength = (path: string): number => [...path].length

const foldAsciiCase = (path: string): string => {
  return path.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/** Orders same-tier resolution matches, winner first: the path with fewer
 *  code points, then the one earlier in UTF-8 byte order, so the winner never
 *  depends on the order of the path list. */
const compareShortestPathFirst = (leftPath: string, rightPath: string): number => {
  const lengthDifference = codePointLength(leftPath) - codePointLength(rightPath)

  if (lengthDifference !== 0) return lengthDifference

  // This leaf layer cannot import utils, so it compares the bytes here rather
  // than calling compareByUtf8Bytes.
  return Buffer.compare(Buffer.from(leftPath), Buffer.from(rightPath))
}

/** Wraps `build` so it runs on the first call only; every call returns what it built. */
const buildOnFirstCall = <Built>(build: () => Built): (() => Built) => {
  // Empty until the first call. The wrapper object tells a value that is
  // built but undefined apart from one not built yet.
  let builtValue: { value: Built } | undefined

  return () => {
    builtValue ??= { value: build() }
    return builtValue.value
  }
}

/** How one resolution pass compares paths: in their own letter case, or with
 *  letter case folded. The folded pass runs only after the exact pass finds
 *  nothing, so a link that resolves with its own letter case keeps its target. */
type LetterCase = "exact" | "folded"

/** A stored path beside its comparable path, the path in one pass's letter
 *  case. A lookup's form is what its `toForm` derives from the comparable
 *  path: the path itself, the path without its extension, or the file name
 *  without its extension. */
type ComparablePath = { storedPath: string; comparablePath: string }

/** The shortest stored path whose form equals `form`, or null. */
type FormLookup = (form: string) => string | null

/** The shortest stored path whose form ends with "/" followed by
 *  `formSuffix`, or null. A path whose form equals `formSuffix` does not
 *  count, because the resolver's equality tiers match that case. */
type SuffixLookup = (formSuffix: string) => string | null

/** Builds a map from each form of a list's paths to the shortest stored path
 *  with that form, on the first lookup. */
const createFormLookup = (params: {
  getComparablePaths: () => readonly ComparablePath[]
  toForm: (comparablePath: string) => string
}): FormLookup => {
  const { getComparablePaths, toForm } = params

  const getShortestPathByForm = buildOnFirstCall(() => {
    const shortestPathByForm = new Map<string, string>()
    for (const { storedPath, comparablePath } of getComparablePaths()) {
      const form = toForm(comparablePath)
      const shortestPathSoFar = shortestPathByForm.get(form)
      // Most forms belong to one path, so the comparison, which measures both
      // paths, runs only when a second path shares the form.
      const isShortestSoFar =
        shortestPathSoFar === undefined ||
        compareShortestPathFirst(storedPath, shortestPathSoFar) < 0

      if (isShortestSoFar) shortestPathByForm.set(form, storedPath)
    }
    return shortestPathByForm
  })

  return (form) => getShortestPathByForm().get(form) ?? null
}

/** A stored path with the folder segments of its form, the segments before
 *  its last one. */
type FolderedPath = { storedPath: string; folderSegments: readonly string[] }

/** A node's paths stay in one list until a lookup first walks to one of the
 *  node's children. The lookup then splits the list into child nodes by each
 *  path's next folder segment toward the start of the path, and the node
 *  drops the list. */
type SuffixBranches =
  | { status: "unsplit"; longerPaths: readonly FolderedPath[] }
  | { status: "split"; childrenBySegment: ReadonlyMap<string, SuffixNode> }

/** A node of one last segment's suffix tree. Its paths all end with the last
 *  segment and the `depth` folder segments walked to reach the node, and each
 *  has at least one more folder segment before them. */
type SuffixNode = {
  depth: number
  /** The node's shortest path, or null when the node holds none. */
  shortestLongerPath: string | null
  branches: SuffixBranches
}

/** A node over `paths`, which must be ordered shortest first. */
const createSuffixNode = (params: {
  paths: readonly FolderedPath[]
  depth: number
}): SuffixNode => {
  const { paths, depth } = params
  // A path with exactly `depth` folder segments has a form equal to the
  // suffix that walked here, which a suffix lookup excludes, so the node
  // keeps only the paths longer than that suffix.
  const longerPaths = paths.filter((path) => path.folderSegments.length > depth)

  return {
    depth,
    shortestLongerPath: longerPaths[0]?.storedPath ?? null,
    branches: { status: "unsplit", longerPaths },
  }
}

/** The child of `node` whose paths have `segment` as their next folder segment
 *  toward the start of the path, or undefined when no path does. The first
 *  call splits the node in place, so the tree holds each path once and has
 *  nodes only for the children of nodes a lookup walked through. */
const findSuffixChild = (node: SuffixNode, segment: string): SuffixNode | undefined => {
  if (node.branches.status === "unsplit") {
    // Map.groupBy keeps each group in list order, so each child's paths stay
    // shortest first. The key is the folder segment `depth` places before
    // the path's last folder segment, counted from the end: at depth 1,
    // `a/b/c/Note.md` is keyed by `b`.
    const pathsBySegment = Map.groupBy(node.branches.longerPaths, (path) => {
      const nextSegment = path.folderSegments.at(-1 - node.depth)

      // createSuffixNode kept only paths with a folder segment at this depth.
      if (nextSegment === undefined) throw new Error("suffix node holds a path too short for it")
      return nextSegment
    })
    const childrenBySegment = new Map(
      [...pathsBySegment].map(([nextSegment, nextPaths]) => {
        return [nextSegment, createSuffixNode({ paths: nextPaths, depth: node.depth + 1 })]
      }),
    )
    node.branches = { status: "split", childrenBySegment }
  }
  return node.branches.childrenBySegment.get(segment)
}

/** The text after a form's last "/", the last element of `form.split("/")`,
 *  so it always agrees with the folder segments a lookup walks.
 *  posix.basename would drop a trailing "/" and name the segment before it. */
const getLastSegment = (form: string): string => form.slice(form.lastIndexOf("/") + 1)

/** Answers suffix lookups over a list's paths, building its parts on demand:
 *  - the first lookup groups the list's paths by the last segment of their form;
 *  - the first lookup of each last segment sorts that group and builds its
 *    suffix tree's root;
 *  - every lookup then walks one node per folder segment of the suffix, so a
 *    lookup's walk does not grow with the list. */
const createSuffixLookup = (params: {
  getComparablePaths: () => readonly ComparablePath[]
  toForm: (comparablePath: string) => string
}): SuffixLookup => {
  const { getComparablePaths, toForm } = params

  const getPathsByLastSegment = buildOnFirstCall(() => {
    const formedPaths = getComparablePaths().map(({ storedPath, comparablePath }) => {
      return { storedPath, form: toForm(comparablePath) }
    })
    return Map.groupBy(formedPaths, ({ form }) => getLastSegment(form))
  })
  const rootsByLastSegment = new Map<string, SuffixNode>()

  const findRoot = (lastSegment: string): SuffixNode | undefined => {
    const cachedRoot = rootsByLastSegment.get(lastSegment)

    if (cachedRoot) return cachedRoot

    const formedPaths = getPathsByLastSegment().get(lastSegment)

    if (!formedPaths) return undefined

    const folderedPaths = formedPaths
      .toSorted((left, right) => compareShortestPathFirst(left.storedPath, right.storedPath))
      .map(({ storedPath, form }) => {
        return { storedPath, folderSegments: form.split("/").slice(0, -1) }
      })
    const root = createSuffixNode({ paths: folderedPaths, depth: 0 })
    rootsByLastSegment.set(lastSegment, root)
    return root
  }

  return (formSuffix) => {
    const root = findRoot(getLastSegment(formSuffix))

    if (!root) return null

    // Walks from the last segment's root through the suffix's folder
    // segments, nearest the last segment first; a segment no path has ends
    // the lookup.
    const suffixFolderSegments = formSuffix.split("/").slice(0, -1)
    // The node the walk has reached so far.
    let node = root
    for (const segment of suffixFolderSegments.toReversed()) {
      const child = findSuffixChild(node, segment)

      if (!child) return null
      node = child
    }
    return node.shortestLongerPath
  }
}

/** Builds one set of lookups per path list, on the list's first resolve. The
 *  cache is keyed by the list itself, so a caller must not change a list after
 *  passing it in; passing a new array builds new lookups. */
const createLookupsCache = <Lookups>(
  createLookups: (paths: readonly string[]) => Lookups,
): ((paths: readonly string[]) => Lookups) => {
  const lookupsByList = new WeakMap<readonly string[], Lookups>()

  return (paths) => {
    const cachedLookups = lookupsByList.get(paths)

    if (cachedLookups) return cachedLookups

    const lookups = createLookups(paths)
    lookupsByList.set(paths, lookups)
    return lookups
  }
}

/** Pairs each path of a list with its comparable path in one pass, on the
 *  first call. */
const createComparablePaths = (params: {
  paths: readonly string[]
  toComparablePath: (path: string) => string
}): (() => readonly ComparablePath[]) => {
  const { paths, toComparablePath } = params

  return buildOnFirstCall(() => {
    return paths.map((storedPath) => {
      return { storedPath, comparablePath: toComparablePath(storedPath) }
    })
  })
}

const keepPath = (path: string): string => path

/** The folded note form lowercases every letter, so `[[éclair]]` reaches
 *  `Éclair.md`; file links fold ASCII letters only (assetPathForComparison). */
const lowercaseNotePath = (path: string): string => path.toLowerCase()

/** The form of a note path or link target that one pass compares. */
const notePathForComparison = (path: string, letterCase: LetterCase): string => {
  switch (letterCase) {
    case "exact":
      return path
    case "folded":
      return lowercaseNotePath(path)
  }
}

/** The form of an asset path or link target that one pass compares. */
const assetPathForComparison = (path: string, letterCase: LetterCase): string => {
  switch (letterCase) {
    case "exact":
      return path
    case "folded":
      // Folding every letter would change which file an existing link names.
      return foldAsciiCase(path)
  }
}

/** One letter case's note lookups, over its comparable paths. */
type NoteLookups = { pathWithForm: FormLookup; pathEndingWith: SuffixLookup }

const createNoteLookups = (paths: readonly string[]): Record<LetterCase, NoteLookups> => {
  const createLookupsInLetterCase = (letterCase: LetterCase): NoteLookups => {
    const getComparablePaths = createComparablePaths({
      paths,
      toComparablePath: (path) => notePathForComparison(path, letterCase),
    })

    return {
      pathWithForm: createFormLookup({ getComparablePaths, toForm: keepPath }),
      pathEndingWith: createSuffixLookup({ getComparablePaths, toForm: keepPath }),
    }
  }

  return { exact: createLookupsInLetterCase("exact"), folded: createLookupsInLetterCase("folded") }
}

const getNoteLookups = createLookupsCache(createNoteLookups)

/** One letter case's asset lookups, over its comparable paths. */
type AssetLookupsInLetterCase = {
  pathWithForm: FormLookup
  pathWithStem: FormLookup
  pathWithBareStem: FormLookup
}

/** The asset lookups. The two suffix lookups compare ASCII-folded forms and
 *  serve the exact pass only, as resolveAssetInLetterCase explains. */
type AssetLookups = {
  inLetterCase: Record<LetterCase, AssetLookupsInLetterCase>
  foldedPathEndingWith: SuffixLookup
  foldedStemEndingWith: SuffixLookup
}

const pathToBareStem = (path: string): string => stripExtension(posix.basename(path))

const createAssetLookups = (paths: readonly string[]): AssetLookups => {
  const getExactPaths = createComparablePaths({
    paths,
    toComparablePath: (path) => assetPathForComparison(path, "exact"),
  })
  const getAsciiFoldedPaths = createComparablePaths({
    paths,
    toComparablePath: (path) => assetPathForComparison(path, "folded"),
  })

  const createLookupsOverComparablePaths = (
    getComparablePaths: () => readonly ComparablePath[],
  ): AssetLookupsInLetterCase => {
    return {
      pathWithForm: createFormLookup({ getComparablePaths, toForm: keepPath }),
      pathWithStem: createFormLookup({ getComparablePaths, toForm: stripExtension }),
      pathWithBareStem: createFormLookup({ getComparablePaths, toForm: pathToBareStem }),
    }
  }

  return {
    inLetterCase: {
      exact: createLookupsOverComparablePaths(getExactPaths),
      folded: createLookupsOverComparablePaths(getAsciiFoldedPaths),
    },
    foldedPathEndingWith: createSuffixLookup({
      getComparablePaths: getAsciiFoldedPaths,
      toForm: keepPath,
    }),
    // ASCII folding keeps every "." and "/", so stripping the extension from
    // the folded path gives the folded stem.
    foldedStemEndingWith: createSuffixLookup({
      getComparablePaths: getAsciiFoldedPaths,
      toForm: stripExtension,
    }),
  }
}

const getAssetLookups = createLookupsCache(createAssetLookups)

/** One pass over the three note tiers, comparing paths in `letterCase`. A
 *  match returns the stored path, never the link's spelling. In the folded
 *  pass, two notes that differ only in letter case share a form, and each
 *  lookup returns the shorter. */
const resolveNoteInLetterCase = (params: {
  targetWithExtension: string
  targetRelativeToSource: string | null
  lookups: Record<LetterCase, NoteLookups>
  letterCase: LetterCase
}): string | null => {
  const { targetWithExtension, targetRelativeToSource, lookups, letterCase } = params
  const { pathWithForm, pathEndingWith } = lookups[letterCase]
  const comparableTarget = notePathForComparison(targetWithExtension, letterCase)

  // Exact path match ("path from vault folder"): "folder/Note.md" or "Note.md"
  const exactMatch = pathWithForm(comparableTarget)

  if (exactMatch) return exactMatch

  // Relative-to-source match ("path from current file"): the target joined
  // to the linking note's folder, so "../C/target" and "sub/target" land on
  // the right note.
  if (targetRelativeToSource) {
    const relativeMatch = pathWithForm(notePathForComparison(targetRelativeToSource, letterCase))

    if (relativeMatch) return relativeMatch
  }

  // A path-suffix match is any path that ends with the whole target, folders
  // included, so [[sub/Note]] reaches A/sub/Note.md. With multiple matches,
  // Obsidian's heuristic prefers the shortest path, and the byte-order
  // tie-break keeps the winner independent of the list's order (callers feed
  // it from unordered SQL scans that change across index rebuilds).
  return pathEndingWith(comparableTarget)
}

/** Adds ".md" unless the target already ends with it in lowercase, so
 *  `[[x.MD]]` looks for `x.MD.md`. pathToLinkName strips the same ending. */
const noteTargetWithExtension = (target: string): string => {
  return target.endsWith(".md") ? target : `${target}.md`
}

/** The target joined to the linking note's folder, or null without a source.
 *  The join collapses ".."/".". A target whose leading ".." run climbs above
 *  the vault root gets no join; one that escapes later, as "a/../../x" does
 *  from a note at the vault root, joins to a path that starts with ".." and
 *  matches no vault path. */
const joinToOptionalSourceFolder = (
  sourcePath: string | undefined,
  target: string,
): string | null => {
  return sourcePath ? joinToSourceFolder(sourcePath, target) : null
}

/** Resolves a link target the way `resolve` does, but only in the link's own
 *  letter case, so `[[real]]` misses `Folder/Real.md`. A match means the link
 *  already spells the path in that path's letter case. The move rewriter
 *  asks it whether a link still reaches a note whose file name the move
 *  changes. */
const resolveInExactCase = (params: {
  target: string
  allPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  const targetWithExtension = noteTargetWithExtension(target)

  return resolveNoteInLetterCase({
    targetWithExtension,
    targetRelativeToSource: joinToOptionalSourceFolder(sourcePath, targetWithExtension),
    lookups: getNoteLookups(allPaths),
    letterCase: "exact",
  })
}

/** Resolves a link target to a vault-relative path using all known paths,
 *  covering Obsidian's three "New link format" modes: path from vault folder
 *  (exact), shortest path / basename, and — when the linking note's `sourcePath`
 *  is supplied — path from current file, including upward "../" segments.
 *  All three tiers run with exact letter case first, then again with letter
 *  case folded, so `[[real]]` reaches `Folder/Real.md` only when no note
 *  matches it exactly. Returns null if unresolvable, including for a target
 *  over the link-target limit. The lookups built over `allPaths` are cached by
 *  the array, so the caller must not change it after the call. */
const resolve = (params: {
  target: string
  allPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  const targetWithExtension = noteTargetWithExtension(target)
  const targetRelativeToSource = joinToOptionalSourceFolder(sourcePath, targetWithExtension)
  const lookups = getNoteLookups(allPaths)

  return (
    resolveNoteInLetterCase({
      targetWithExtension,
      targetRelativeToSource,
      lookups,
      letterCase: "exact",
    }) ??
    resolveNoteInLetterCase({
      targetWithExtension,
      targetRelativeToSource,
      lookups,
      letterCase: "folded",
    })
  )
}

/** One pass over the asset tiers, with the exact, relative, stem exact, stem
 *  relative and bare-stem comparisons in `letterCase`. The two suffix tiers
 *  run in the exact pass only. In the folded pass, two files that differ only
 *  in letter case share a form, and each lookup returns the shorter. */
const resolveAssetInLetterCase = (params: {
  target: string
  relativeTarget: string | null
  lookups: AssetLookups
  letterCase: LetterCase
}): string | null => {
  const { target, relativeTarget, lookups, letterCase } = params
  const { pathWithForm, pathWithStem, pathWithBareStem } = lookups.inLetterCase[letterCase]
  const comparableTarget = assetPathForComparison(target, letterCase)
  const comparableRelativeTarget = relativeTarget
    ? assetPathForComparison(relativeTarget, letterCase)
    : null

  // ── Full-filename family: exact → relative → path suffix ──

  const exactMatch = pathWithForm(comparableTarget)

  if (exactMatch) return exactMatch

  if (comparableRelativeTarget) {
    const relativeMatch = pathWithForm(comparableRelativeTarget)

    if (relativeMatch) return relativeMatch
  }

  // The suffix tiers compare ASCII-folded paths in the exact pass, so the
  // shortest path wins whatever its letter case: ![[photo.png]] reaches
  // A/Photo.PNG over B/sub/photo.png. The other tiers compare in the pass's
  // letter case. Folded from the start, a suffix tier could only repeat its
  // miss in the folded pass, so that pass skips it.
  const runsSuffixTiers = letterCase === "exact"
  const foldedTarget = assetPathForComparison(target, "folded")
  const fullPathSuffixMatch = runsSuffixTiers ? lookups.foldedPathEndingWith(foldedTarget) : null

  if (fullPathSuffixMatch) return fullPathSuffixMatch

  // ── Stem family: exact → relative → suffix/basename ──

  const exactStemMatch = pathWithStem(comparableTarget)

  if (exactStemMatch) return exactStemMatch

  if (comparableRelativeTarget) {
    const relativeStemMatch = pathWithStem(comparableRelativeTarget)

    if (relativeStemMatch) return relativeStemMatch
  }

  // The pass's last tier. A target with folder segments matches the stem
  // that ends with it, ASCII-folded and in the exact pass only, like the
  // full-path suffix tier.
  if (target.includes("/")) {
    return runsSuffixTiers ? lookups.foldedStemEndingWith(foldedTarget) : null
  }
  // A bare name matches a file name's stem in the pass's letter case.
  return pathWithBareStem(comparableTarget)
}

/** Resolves a link target to a known non-markdown vault file, or null when no
 *  match exists. The index (search/search-index.ts) and the move rewriter both
 *  resolve file links with it, so they agree on where an asset link points.
 *  The tiers run in this order, and the first match wins:
 *  1. Full file name: the exact path, the path joined to the source note's
 *     folder, then the shortest path ending with the target ([[photo.png]],
 *     ![img](../assets/photo.png), [[LICENSE]]).
 *  2. Stem, the path without its extension: the exact stem, the stem joined
 *     to the source note's folder, then the shortest stem ending with a
 *     target that has folders, or the shortest path whose file name's stem
 *     equals a bare target ([[Trip Route]] → Trip Route.canvas).
 *  3. Tiers 1 and 2 again with ASCII letter case folded, without the two
 *     suffix tiers, so `![[Photo.PNG]]` reaches `photo.png` only when no file
 *     matches it exactly.
 *
 *  - Full file names run first because a multi-dot file name's stem keeps its
 *    inner dots: [[photo.png]] prefers photo.png over photo.png.canvas, whose
 *    stem is "photo.png", and still reaches photo.png.canvas when no
 *    photo.png exists, as Obsidian's stem matching does.
 *  - The two suffix tiers fold ASCII letter case already in tiers 1 and 2, so
 *    `![[photo.png]]` reaches the shorter of `A/Photo.PNG` and `B/sub/photo.png`.
 *  - A target over the link-target limit resolves to null.
 *  - The lookups built over `allAssetPaths` are cached by the array, so the
 *    caller must not change it after the call. */
const resolveAsset = (params: {
  target: string
  allAssetPaths: readonly string[]
  sourcePath?: string
}): string | null => {
  const { target, allAssetPaths, sourcePath } = params

  if (!isWithinLinkTargetLimit(target)) return null

  const relativeTarget = joinToOptionalSourceFolder(sourcePath, target)
  const lookups = getAssetLookups(allAssetPaths)

  return (
    resolveAssetInLetterCase({ target, relativeTarget, lookups, letterCase: "exact" }) ??
    resolveAssetInLetterCase({ target, relativeTarget, lookups, letterCase: "folded" })
  )
}

type ResolvedLinkTarget = { kind: "note" | "asset"; path: string }

/** Resolves a link target to a note, or to a non-markdown file when no note
 *  matches, so a target that names both reaches the note. Returns null when
 *  neither matches. */
const resolveNoteOrAsset = (params: {
  target: string
  allPaths: readonly string[]
  allAssetPaths: readonly string[]
  sourcePath?: string
}): ResolvedLinkTarget | null => {
  const { allPaths, allAssetPaths, ...targetAndSource } = params
  const notePath = resolve({ ...targetAndSource, allPaths })

  if (notePath) return { kind: "note", path: notePath }

  const assetPath = resolveAsset({ ...targetAndSource, allAssetPaths })

  return assetPath ? { kind: "asset", path: assetPath } : null
}

/** A note's complete link set — body links unioned with frontmatter wikilinks,
 *  deduplicated. Single source of truth for "what does this note link to",
 *  shared by incremental upsert and full rebuild — must not diverge. */
const extractAll = (content: string, data: Record<string, unknown>): string[] => [
  ...new Set([...extractFromBody(content), ...extractFromFrontmatter(data)]),
]

/** The link domain — grammar recognition, traversal, parsing, destination
 *  encoding, extraction, and resolution. Single namespace export so call sites read `links.resolve(...)`. */
export const links = {
  matchLinksInLine,
  matchWikilinks,
  splitWikilink,
  splitMarkdownLink,
  decodeLinkSpellings,
  encodeMarkdownDestination,
  extractFromBody,
  extractFromFrontmatter,
  extractAll,
  isWithinLinkTargetLimit,
  resolve,
  resolveInExactCase,
  stripExtension,
  pathToLinkName,
  resolveAsset,
  resolveNoteOrAsset,
}

/** Strips Obsidian/Markdown syntax to produce plain text for embedding.
 *
 * Pure transform: string in, string out. The result preserves semantic content
 * (words, sentences) while removing markup that degrades embedding quality. */

/** JavaScript whitespace includes line terminators and non-ASCII spaces. */
const WHITESPACE = /\s/

/** Multiline anchors also recognize these separators beside LF and CR. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

const stripWikilinkAliases = (text: string): string => {
  const pieces: string[] = []
  // Delimiter cursors retain failed searches across overlapping openers.
  let targetEnd = 0
  let close = 0
  let copiedThrough = 0

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "[" || text[start + 1] !== "[") continue
    const targetStart = start + 2
    targetEnd = Math.max(targetEnd, targetStart)
    while (targetEnd < text.length && text[targetEnd] !== "|" && text[targetEnd] !== "]")
      targetEnd++
    if (targetEnd === targetStart || text[targetEnd] !== "|") continue
    const aliasStart = targetEnd + 1
    close = Math.max(close, aliasStart)
    while (close < text.length && text[close] !== "]") close++
    if (close === aliasStart || text[close + 1] !== "]") continue
    pieces.push(text.slice(copiedThrough, start), text.slice(aliasStart, close))
    copiedThrough = close + 2
    start = close + 1
  }
  if (!copiedThrough) return text
  pieces.push(text.slice(copiedThrough))
  return pieces.join("")
}

const stripWikilinks = (text: string): string => {
  const pieces: string[] = []
  // A failed opener never restarts the search for the next closing bracket.
  let close = 0
  let copiedThrough = 0

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "[" || text[start + 1] !== "[") continue
    const targetStart = start + 2
    close = Math.max(close, targetStart)
    while (close < text.length && text[close] !== "]") close++
    if (close === targetStart || text[close + 1] !== "]") continue
    pieces.push(text.slice(copiedThrough, start), text.slice(targetStart, close))
    copiedThrough = close + 2
    start = close + 1
  }
  if (!copiedThrough) return text
  pieces.push(text.slice(copiedThrough))
  return pieces.join("")
}

const stripMarkdownLinks = (text: string): string => {
  const pieces: string[] = []
  // Labels may overlap; the closing delimiters are still visited only once.
  let labelEnd = 0
  let close = 0
  let copiedThrough = 0

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "[") continue
    labelEnd = Math.max(labelEnd, start + 1)
    while (labelEnd < text.length && text[labelEnd] !== "]") labelEnd++
    if (labelEnd === start + 1 || text[labelEnd + 1] !== "(") continue
    const targetStart = labelEnd + 2
    close = Math.max(close, targetStart)
    while (close < text.length && text[close] !== ")") close++
    if (close === targetStart || text[close] !== ")") continue
    pieces.push(text.slice(copiedThrough, start), text.slice(start + 1, labelEnd))
    copiedThrough = close + 1
    start = close
  }
  if (!copiedThrough) return text
  pieces.push(text.slice(copiedThrough))
  return pieces.join("")
}

const stripCalloutMarkers = (text: string): string => {
  const pieces: string[] = []
  // Whitespace can cross physical lines; both cursors keep that legacy grammar.
  let markerStart = 0
  let close = 0
  let copiedThrough = 0

  for (let start = 0; start < text.length; start++) {
    const atLineStart = start === 0 || LINE_TERMINATOR.test(text.charAt(start - 1))

    if (text[start] !== ">" || !atLineStart) continue
    markerStart = Math.max(markerStart, start + 1)
    while (markerStart < text.length && WHITESPACE.test(text.charAt(markerStart))) markerStart++
    if (text[markerStart] !== "[" || text[markerStart + 1] !== "!") continue
    close = Math.max(close, markerStart + 2)
    while (close < text.length && text[close] !== "]") close++
    if (text[close] !== "]") continue
    // The trailing whitespace belongs to the removed marker too.
    let end = close + 1

    while (end < text.length && WHITESPACE.test(text.charAt(end))) end++
    pieces.push(text.slice(copiedThrough, start))
    copiedThrough = end
    start = end - 1
  }
  if (!copiedThrough) return text
  pieces.push(text.slice(copiedThrough))
  return pieces.join("")
}

/** Strips markdown and Obsidian syntax, keeping only the semantic text content.
 *  Wikilinks become their display text, comments are removed, formatting
 *  markers (bold, italic, headings, callouts, block quotes) are stripped. */
export const stripMarkdownSyntax = (text: string): string => {
  const withoutAliases = stripWikilinkAliases(text)
  const withoutWikilinks = stripWikilinks(withoutAliases)
  const withoutLinks = stripMarkdownLinks(withoutWikilinks)
  const withoutFormatting = withoutLinks
    // Obsidian comments: %% ... %% (single-line and multi-line)
    .replace(/%%[^]*?%%/g, "")
    // Heading markers: ## → removed (keep the text; 0-3 leading spaces per §4.2,
    // empty headings match via the end-of-line alternative)
    .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/gm, "")
    // Setext heading underlines: === or --- lines (0-3 leading spaces per §4.3)
    .replace(/^ {0,3}(?:=+|-+)[ \t]*$/gm, "")
    // Bold/italic markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
  const withoutCallouts = stripCalloutMarkers(withoutFormatting)
  // Block quotes: > text → text
  return withoutCallouts.replace(/^>\s?/gm, "")
}

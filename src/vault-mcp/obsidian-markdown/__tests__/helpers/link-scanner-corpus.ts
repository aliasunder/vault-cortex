import parseEntities from "parse-entities"
import { parseObsidianMarkdown } from "../../obsidian-remark-parser.js"
import type { ParsedNode } from "../../remark-parse-types.js"

/** Frozen recognizers are independent compatibility oracles for the scanner rewrites. */
export const legacyWiki = /!?\[\[([^\]#|]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g
const legacyTemplater = /<%[-+*_~]?.*?%>/g

/** The inline code spans extractFromBody masks before it scans a line. */
const inlineCode = /`+[^`\n]*`+/g

/** Replaces inline code and Templater expressions with spaces, as
 *  extractFromBody does before it scans a line. */
export const maskLikeExtraction = (line: string): string => {
  return line
    .replace(inlineCode, (match) => " ".repeat(match.length))
    .replace(legacyTemplater, (match) => " ".repeat(match.length))
}

const safeDecodeUri = (encoded: string): string | null => {
  try {
    return decodeURI(encoded)
  } catch {
    return null
  }
}

/** A remark link URL normalized the way Obsidian stores a link, then cut to
 *  the target: percent-decoded like decodeURI, no-break spaces replaced,
 *  trimmed, dropped when it holds a `:`, and split at the first `#`. remark
 *  has already dropped escape backslashes and decoded character references. */
const normalizeRemarkUrl = (url: string): string | null => {
  const decodedLink = safeDecodeUri(url)

  if (decodedLink === null) return null

  const storedLink = decodedLink.replaceAll("\u00a0", " ").trim()

  if (storedLink.includes(":")) return null

  const hashIndex = storedLink.indexOf("#")
  const target = (hashIndex === -1 ? storedLink : storedLink.slice(0, hashIndex)).trim()
  return target === "" ? null : target
}

/** A link the remark oracle found: its stored target, and the span from its
 *  `[` to the end of its `)`, the span matchLinksInLine reports. */
type ReferenceLink = { target: string; start: number; end: number }

const collectReferenceLinks = (node: ParsedNode, found: ReferenceLink[]): void => {
  const isLink = node.type === "link" || node.type === "image"
  const target = isLink && typeof node.url === "string" ? normalizeRemarkUrl(node.url) : null

  if (target !== null && node.position) {
    // An image's node starts at its `!`, one character before the `[`.
    const imageMarkerLength = node.type === "image" ? 1 : 0
    const start = node.position.start.offset + imageMarkerLength
    found.push({ target, start, end: node.position.end.offset })
  }
  for (const child of node.children ?? []) collectReferenceLinks(child, found)
}

/** The markdown links the repository's Obsidian-tuned remark parser finds in
 *  a one-line document that name a note or file, after the masks
 *  extractFromBody applies. */
export const referenceMarkdownLinks = (document: string): ReferenceLink[] => {
  const found: ReferenceLink[] = []
  collectReferenceLinks(parseObsidianMarkdown(maskLikeExtraction(document)), found)
  return found
}

/** A pair of `delimiter` with a markdown link opener between them. */
const surroundingLink = (delimiter: string): RegExp => {
  const escapedDelimiter = delimiter.replace(/[$*=~]/g, "\\$&")
  return new RegExp(`${escapedDelimiter}.*\\]\\(.*${escapedDelimiter}`)
}

/** remark-parse 8 decodes a destination's references in one parse-entities
 *  call, which repeats the last reference for a later `&` that decodes to
 *  nothing (`&lt;&gt.md` gives `<<.md`). Obsidian 1.15.1 keeps that `&` as
 *  written, as decoding each `&` on its own does. */
const decodesUnlikeObsidian = (document: string): boolean => {
  const decodedPerAmpersand = document
    .split(/(?=&)/)
    .map((piece) => parseEntities(piece, { nonTerminated: false }))
    .join("")
  return parseEntities(document, { nonTerminated: false }) !== decodedPerAmpersand
}

/** A construct that puts a document outside the comparison, found by where
 *  it sits relative to a link. */
type ExcludedConstruct =
  { label: string; pattern: RegExp } | { label: string; matches: (document: string) => boolean }

/** The constructs the scanner does not model, which change grammar outside
 *  the destination or hide a link from Obsidian, then the two places where
 *  the remark oracle disagrees with Obsidian 1.15.1. */
const EXCLUDED_CONSTRUCTS: ReadonlyArray<ExcludedConstruct> = [
  { label: "a bracket inside the link text", pattern: /\[[^\]]*\[[^\]]*\]\(/ },
  { label: "an escaped bracket inside the link text", pattern: /\[[^\]]*\\\]/ },
  { label: "a reference form before the `(`", pattern: /\]\[[^\]]*\]\(/ },
  { label: "an indented code line", pattern: /^(?:\t| {4})/ },
  { label: "an inline footnote opener before the `[`", pattern: /\^\[/ },
  ...["**", "*", "__", "~~", "==", "$"].map((delimiter) => ({
    label: `${delimiter} around a link`,
    pattern: surroundingLink(delimiter),
  })),
  { label: "an HTML comment around a link", pattern: /<!--.*\]\(.*-->/ },
  { label: "an HTML tag around a link", pattern: /<[A-Za-z][A-Za-z0-9-]*\s[^<>]*\]\([^<>]*>/ },
  {
    label: "an autolink around a link",
    pattern: /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*\]\([^\s<>]*>/,
  },
  { label: "a bare URL before a link", pattern: /(?:https?:\/\/|www\.)\S*\]\(/ },
  {
    label: "an Obsidian comment around a link, which remark hides and Obsidian keeps",
    pattern: surroundingLink("%%"),
  },
  { label: "a reference remark decodes unlike Obsidian", matches: decodesUnlikeObsidian },
]

const holdsConstruct = (document: string, construct: ExcludedConstruct): boolean => {
  return "pattern" in construct ? construct.pattern.test(document) : construct.matches(document)
}

/** The label of the first excluded construct a document holds, or null. */
export const findExcludedConstruct = (document: string): string | null => {
  const construct = EXCLUDED_CONSTRUCTS.find((candidate) => holdsConstruct(document, candidate))
  return construct?.label ?? null
}

/** Tokens dense in markdown link syntax, with `[x](` and `)` weighted up so
 *  that many documents hold a link. */
const LINK_TOKENS = [
  "[x](",
  "[x](",
  "[x](",
  "[x](",
  "[x](",
  "](",
  "<",
  ">",
  "(",
  ")",
  ")",
  ")",
  ")",
  "\\",
  '"',
  "'",
  " ",
  " ",
  "\t",
  "\u00a0",
  "%20",
  "%",
  "&amp;",
  "&",
  ";",
  ":",
  "h:",
  "#",
  "a",
  "a.md",
  "Note",
  "b c",
]

/** A linear congruential generator drawing integers below `limit`. A fixed
 *  seed makes every failing document reproducible across runtimes. */
const createDraw = (seed: number): ((limit: number) => number) => {
  // The generator's state advances on every draw.
  let state = seed

  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return Math.floor((state / 0x1_0000_0000) * limit)
  }
}

/** Seeded one-line documents of 2 to 19 link tokens. Each starts with "x " so
 *  no document opens a block construct. */
export const createLinkTokenDocuments = (count: number): string[] => {
  const draw = createDraw(0x5eed_0004)

  return Array.from({ length: count }, () => {
    const tokens = Array.from({ length: 2 + draw(18) }, () => LINK_TOKENS[draw(LINK_TOKENS.length)])
    return `x ${tokens.join("")}`
  })
}

export const legacyPlaintext = (text: string): string => {
  return text
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/%%[^]*?%%/g, "")
    .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/gm, "")
    .replace(/^ {0,3}(?:=+|-+)[ \t]*$/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^>\s*\[![^\]]*\]\s*/gm, "")
    .replace(/^>\s?/gm, "")
}

export const scannerCorpora = [
  { label: "wikilinks", alphabet: ["[", "[", "]", "#", "|", "!", "a", " ", "\\", "😀", "\n"] },
  {
    label: "Templater",
    alphabet: [
      "<",
      "%",
      "%",
      ">",
      "-",
      "+",
      "*",
      "_",
      "~",
      "[",
      "]",
      "a",
      "\r",
      "\u2028",
      "\u2029",
      "\n",
    ],
  },
  { label: "plaintext aliases", alphabet: ["[", "[", "]", "|", "|", "a", "#", " ", "😀", "\n"] },
  { label: "plaintext wikilinks", alphabet: ["[", "[", "]", "a", "#", " ", "😀", "\n"] },
  { label: "plaintext Markdown", alphabet: ["[", "[", "]", "(", ")", "a", " ", "\n"] },
  {
    label: "plaintext callouts",
    alphabet: [">", ">", "[", "!", "]", " ", "\t", "\n", "\r", "\u2028", "\u2029", "a"],
  },
]

export const createScannerDocuments = (
  alphabet: ReadonlyArray<string>,
  count: number,
): string[] => {
  const draw = createDraw(0x51ca77e2)
  const documents: string[] = []

  for (let index = 0; index < count; index++) {
    const length = draw(160)
    const characters = Array.from({ length }, () => {
      const character = alphabet[draw(alphabet.length)]

      if (character === undefined) throw new Error("random character is out of bounds")
      return character
    })
    documents.push(characters.join(""))
  }
  return documents
}

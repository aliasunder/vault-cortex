import { Tokenizer } from "htmlparser2"

/** Elements whose content a browser does not show on the page.
 *  - script, style, noscript and template hold code, styling, fallback and
 *    inert markup.
 *  - iframe, noembed and noframes hold fallback content that the tokenizer
 *    reads as raw text, markup included, and that modern browsers never show. */
const HIDDEN_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "noembed",
  "noframes",
])

/** Elements that start and end on a line of their own when a page renders. */
const LINE_BREAKING_ELEMENTS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "title",
  "tr",
  "ul",
])

/** Table cells sit side by side, so a cell boundary separates words. */
const CELL_ELEMENTS: ReadonlySet<string> = new Set(["td", "th"])

/** Any run of whitespace, the no-break space included. */
const WHITESPACE_RUN = /\s+/g

/** Attributes, comments, doctypes and the tokenizer's other events hold no
 *  visible text. */
const ignoreToken = (): void => {}

/**
 * The text a browser would show for an HTML page: hidden elements, tags and
 * comments dropped, entities decoded, one line per block element, and every
 * other run of whitespace collapsed to one space.
 * - Reading stops once the text reaches `maxBytes` of UTF-8, so the result can
 *   run past it by up to the text between two tags; the caller cuts it to size.
 * - The tokenizer keeps no element stack, so unclosed tags cost no more than
 *   closed ones and the time stays linear in the page's size.
 * - A hidden element ends only at a closing tag with its own name, so a stray
 *   or mismatched closing tag never shows the text inside it.
 */
export const extractHtmlVisibleText = (params: { html: string; maxBytes: number }): string => {
  const { html, maxBytes } = params
  const textParts: string[] = []
  const hiddenElementStack: string[] = []

  // Collapsing state threads through every callback in document order, so
  // these are lets: whether the output sits at a line start, whether a space
  // is owed before the next word, and the UTF-8 bytes written so far.
  let atLineStart = true
  let spaceOwed = false
  let textBytes = 0

  const emit = (text: string): void => {
    textParts.push(text)
    textBytes += Buffer.byteLength(text, "utf8")

    // emit runs only inside tokenizer.write below, so `tokenizer` exists by then
    if (textBytes >= maxBytes) tokenizer.pause()
  }

  const appendText = (text: string): void => {
    if (hiddenElementStack.length > 0) return

    const collapsedText = text.replace(WHITESPACE_RUN, " ")
    const words = collapsedText.trim()
    const hasLeadingGap = collapsedText.startsWith(" ")
    const hasTrailingGap = collapsedText.endsWith(" ")

    if (!words) {
      // Text that is only whitespace still separates the words around it
      if (hasLeadingGap) spaceOwed = true
      return
    }

    const needsSpaceBefore = !atLineStart && (spaceOwed || hasLeadingGap)

    if (needsSpaceBefore) emit(" ")
    emit(words)
    atLineStart = false
    spaceOwed = hasTrailingGap
  }

  const breakLine = (): void => {
    if (!atLineStart) emit("\n")
    atLineStart = true
    spaceOwed = false
  }

  /** Lowercased, because HTML tag names ignore letter case. */
  const readTagName = (start: number, end: number): string => html.slice(start, end).toLowerCase()

  const handleTagBoundary = (tagName: string): void => {
    if (LINE_BREAKING_ELEMENTS.has(tagName)) breakLine()
    if (CELL_ELEMENTS.has(tagName)) spaceOwed = true
  }

  const tokenizer = new Tokenizer(
    {},
    {
      ontext: (start, end) => appendText(html.slice(start, end)),
      ontextentity: (codePoint) => appendText(String.fromCodePoint(codePoint)),
      // A self-closing <script/> still opens it, because HTML ignores the
      // slash on an element that is not void, so the name alone decides.
      onopentagname: (start, end) => {
        const tagName = readTagName(start, end)

        if (HIDDEN_ELEMENTS.has(tagName)) {
          hiddenElementStack.push(tagName)
          return
        }
        if (hiddenElementStack.length === 0) handleTagBoundary(tagName)
      },
      onclosetag: (start, end) => {
        const tagName = readTagName(start, end)

        if (hiddenElementStack.length > 0) {
          if (hiddenElementStack.at(-1) === tagName) hiddenElementStack.pop()
          return
        }
        handleTagBoundary(tagName)
      },
      onattribdata: ignoreToken,
      onattribentity: ignoreToken,
      onattribend: ignoreToken,
      onattribname: ignoreToken,
      oncdata: ignoreToken,
      oncomment: ignoreToken,
      ondeclaration: ignoreToken,
      onend: ignoreToken,
      onopentagend: ignoreToken,
      onprocessinginstruction: ignoreToken,
      onselfclosingtag: ignoreToken,
    },
  )

  tokenizer.write(html)

  // pause() clears `running`, so only a page read to its end is ended. Ending
  // emits the text the tokenizer still holds there, such as an unfinished entity.
  if (tokenizer.running) tokenizer.end()
  return textParts.join("").trimEnd()
}

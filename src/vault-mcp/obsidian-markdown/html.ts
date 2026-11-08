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

/** Inside an inline <svg>, the tooltip and the description a browser never
 *  shows on the page. Outside one, <title> is the page's own title. */
const SVG_TOOLTIP_ELEMENTS: ReadonlySet<string> = new Set(["title", "desc"])

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
  // Also threaded in document order: how many inline <svg> elements are open,
  // and what opening the last tag did, so a self-closing slash can undo it
  let openSvgCount = 0
  let lastOpenEffect: "pushed-svg-tooltip" | "counted-svg" | "none" = "none"

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
        const isSvgTooltip = openSvgCount > 0 && SVG_TOOLTIP_ELEMENTS.has(tagName)
        const opensHiddenElement = HIDDEN_ELEMENTS.has(tagName) || isSvgTooltip

        if (opensHiddenElement) {
          hiddenElementStack.push(tagName)
          lastOpenEffect = isSvgTooltip ? "pushed-svg-tooltip" : "none"
          return
        }

        lastOpenEffect = "none"
        if (hiddenElementStack.length > 0) return

        if (tagName === "svg") {
          openSvgCount += 1
          lastOpenEffect = "counted-svg"
        }
        handleTagBoundary(tagName)
      },
      onclosetag: (start, end) => {
        const tagName = readTagName(start, end)

        if (hiddenElementStack.length > 0) {
          if (hiddenElementStack.at(-1) === tagName) hiddenElementStack.pop()
          return
        }
        // A stray </svg> leaves the count at zero
        if (tagName === "svg") openSvgCount = Math.max(0, openSvgCount - 1)
        handleTagBoundary(tagName)
      },
      // SVG honours a self-closing slash, so <svg/>, and a <desc/> or <title/>
      // inside one, hold nothing; a tooltip left open would hide the rest of the
      // page. The tokenizer still reads text after a <title/> raw until
      // </title>, as it does after a self-closing <script/>, which stays open.
      // The callback fires right after its tag opens, so it undoes that tag alone.
      onselfclosingtag: () => {
        const insideSvg = openSvgCount > 0

        if (!insideSvg) return
        switch (lastOpenEffect) {
          case "pushed-svg-tooltip":
            hiddenElementStack.pop()
            break
          case "counted-svg":
            openSvgCount -= 1
            break
          case "none":
            break
        }
        lastOpenEffect = "none"
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
    },
  )

  tokenizer.write(html)

  // pause() clears `running`, so only a page read to its end is ended. Ending
  // emits the text the tokenizer still holds there, such as an unfinished entity.
  if (tokenizer.running) tokenizer.end()
  return textParts.join("").trimEnd()
}

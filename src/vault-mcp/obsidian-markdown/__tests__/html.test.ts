import { describe, it, expect } from "vitest"
import { DateTime } from "luxon"
import { extractHtmlVisibleText } from "../html.js"

const LARGE_CAP = 1_000_000

const extractAll = (html: string): string => extractHtmlVisibleText({ html, maxBytes: LARGE_CAP })

describe("extractHtmlVisibleText", () => {
  it("returns the visible text of a page, one line per block element", () => {
    const page =
      "<!doctype html><html><head><title>Restart runbook</title></head>" +
      "<body><h1>Restart</h1><p>Stop the <b>service</b> first.</p>" +
      "<ul><li>Check logs</li><li>Start it</li></ul></body></html>"

    expect(extractAll(page)).toBe(
      "Restart runbook\nRestart\nStop the service first.\nCheck logs\nStart it",
    )
  })

  it("drops the text of script, style, noscript and template elements", () => {
    const page =
      "<p>before</p><script>var secret = 1</script><style>p { color: red }</style>" +
      "<noscript>enable scripts</noscript><template><p>inert</p></template><p>after</p>"

    expect(extractAll(page)).toBe("before\nafter")
  })

  it("drops the raw text of iframe, noembed and noframes fallback content", () => {
    const page =
      "<p>shown</p><iframe><p>iframe fallback</p></iframe>" +
      "<noembed>embed fallback</noembed><noframes>frames fallback</noframes>"

    expect(extractAll(page)).toBe("shown")
  })

  it("drops an uppercase SCRIPT element's text", () => {
    expect(extractAll("<P>shown</P><SCRIPT>hidden()</SCRIPT>")).toBe("shown")
  })

  it("ignores a stray closing tag for a hidden element that never opened", () => {
    expect(extractAll("</noscript><p>VISIBLE</p>")).toBe("VISIBLE")
  })

  it("keeps a hidden element's text hidden through a closing tag with another name", () => {
    expect(extractAll("<template>SECRET</noscript>LEAKED</template><p>VISIBLE</p>")).toBe("VISIBLE")
  })

  it("keeps text hidden until the outer element of nested hidden elements closes", () => {
    expect(extractAll("<template><style>a{}</style>inner</template>outer")).toBe("outer")
  })

  it("treats a self-closing script tag as open, as HTML does", () => {
    expect(extractAll('<p>shown</p><script src="app.js"/>hidden()</script><p>after</p>')).toBe(
      "shown\nafter",
    )
  })

  it("drops an inline SVG's title and desc but keeps its visible text", () => {
    const page =
      "<p>Download</p><svg><title>download icon</title><desc>an arrow</desc>" +
      "<text>Q3 total</text></svg><p>After</p>"

    expect(extractAll(page)).toBe("Download\nQ3 total\nAfter")
  })

  it("shows a title after the SVG holding another title closes", () => {
    expect(extractAll("<svg><title>icon</title></svg><title>Page title</title>")).toBe("Page title")
  })

  it("keeps an SVG title hidden after a nested svg closes", () => {
    expect(extractAll("<svg><svg></svg><title>tooltip</title></svg><p>shown</p>")).toBe("shown")
  })

  it("shows the rest of the page after a self-closing desc inside an SVG", () => {
    expect(extractAll("<svg><desc/></svg><p>shown</p>")).toBe("shown")
  })

  it("shows a title after a self-closing svg", () => {
    expect(extractAll("<svg/><title>Page title</title>")).toBe("Page title")
  })

  it("breaks no line for a block element inside a hidden element", () => {
    expect(extractAll("<p>one <template><div>inert</div></template>two</p>")).toBe("one two")
  })

  it("hides everything after a template that never closes", () => {
    expect(extractAll("<p>shown</p><template><p>never shown</p>")).toBe("shown")
  })

  it("drops comments", () => {
    expect(extractAll("<p>kept<!-- dropped --> text</p>")).toBe("kept text")
  })

  it("decodes named and numeric entities", () => {
    expect(extractAll("<p>A &mdash; B &amp; C &#169; &#x2713;</p>")).toBe("A — B & C © ✓")
  })

  it("collapses whitespace runs, line breaks and no-break spaces to one space", () => {
    expect(extractAll("<p>  one \n\t two&nbsp;&nbsp;three  </p>")).toBe("one two three")
  })

  it("keeps a space between words split across inline tags", () => {
    expect(extractAll("<p><span>one</span> <span>two</span><em> three</em></p>")).toBe(
      "one two three",
    )
  })

  it("keeps a space that ends the text inside an inline tag", () => {
    expect(extractAll("<p><b>one </b>two</p>")).toBe("one two")
  })

  it("joins words that inline tags split with no whitespace", () => {
    expect(extractAll("<p>un<b>broken</b></p>")).toBe("unbroken")
  })

  it("separates table cells with spaces and rows with line breaks", () => {
    const table =
      "<table><tr><th>Name</th><th>Port</th></tr><tr><td>api</td><td>8000</td></tr></table>"

    expect(extractAll(table)).toBe("Name Port\napi 8000")
  })

  it("breaks the line at a br element", () => {
    expect(extractAll("<p>first<br>second</p>")).toBe("first\nsecond")
  })

  it("returns an empty string for an empty page", () => {
    expect(extractAll("")).toBe("")
  })

  it("returns an empty string for a page with no visible text", () => {
    expect(extractAll("<html><head><script>x()</script></head><body> </body></html>")).toBe("")
  })

  it("stops reading once the text reaches maxBytes", () => {
    const page = Array.from({ length: 50 }, (_, index) => `<p>paragraph ${index}</p>`).join("")

    // "paragraph 0" is 11 bytes, and each later line adds a line break first
    expect(extractHtmlVisibleText({ html: page, maxBytes: 20 })).toBe("paragraph 0\nparagraph 1")
  })

  it("extracts 1 MB of unclosed nested tags within a second", () => {
    const repeatCount = Math.ceil(1_000_000 / 15)
    const unclosedTags = "<div><span><b>x".repeat(repeatCount)

    const startedAt = DateTime.now()
    const text = extractAll(unclosedTags)
    const elapsedMs = DateTime.now().diff(startedAt).as("milliseconds")

    // Each <div> starts a line of its own, so every "x" sits on its own line
    expect(text).toBe(Array.from({ length: repeatCount }, () => "x").join("\n"))
    expect(elapsedMs).toBeLessThan(1_000)
  })
})

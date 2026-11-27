import { describe, it, expect, vi, onTestFinished } from "vitest"
import { execFileSync } from "node:child_process"
import { posix } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { Worker } from "node:worker_threads"
import { links } from "../links.js"
import { classifyLines } from "../lines.js"
import {
  assertPathWithinMaxLength,
  PathTooLongError,
} from "../../../utils/assert-path-within-max-length.js"
import {
  CHILD_DEADLINE_MS,
  CHILD_TEST_TIMEOUT_MS,
  LINEAR_GROWTH_ALLOWANCE,
  TIMING_FLOOR_MS,
} from "./helpers/linear-timing.js"
import {
  createLinkTokenDocuments,
  createScannerDocuments,
  findExcludedConstruct,
  maskLikeExtraction,
  referenceMarkdownLinks,
  scannerCorpora,
  legacyWiki,
} from "./helpers/link-scanner-corpus.js"
import { linkResolverOracle } from "./helpers/link-resolver-oracle.js"

// ── matchLinksInLine ─────────────────────────────────────────────

describe("matchLinksInLine", () => {
  it("returns no wikilink inside a markdown link's title, and keeps one outside it", () => {
    const line = '[[A]] [x](b.md "[[C]]")'

    expect(links.matchLinksInLine(line)).toEqual([
      { text: "[[A]]", start: 0, end: 5, kind: "wikilink" },
      { text: '[x](b.md "[[C]]")', start: 6, end: 23, kind: "markdown" },
    ])
  })

  it.each([{ variant: "wiki" }, { variant: "markdown" }, { variant: "templater" }])(
    "bounds repeated failing $variant openers in an externally killed child",
    ({ variant }) => {
      const fixturePath = new URL("./helpers/link-scanner-adversary.ts", import.meta.url)
      // The parent deadline interrupts synchronous parser stalls, including legacy regex regressions.
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", fixturePath.pathname, variant],
        {
          encoding: "utf8",
          timeout: 30_000,
          killSignal: "SIGKILL",
        },
      )
      const result = JSON.parse(output)

      expect(result.variant).toBe(variant)
      expect(
        result.measurements.map((measurement: { bytes: number }) => measurement.bytes),
      ).toEqual(variant === "markdown" ? [20_016, 40_016, 80_016] : [20_009, 40_009, 80_009])
      for (const [index, measurement] of result.measurements.entries()) {
        // Ratios below 10 ms are noise; the ceiling still bounds those samples.
        expect(measurement.median).toBeLessThan(1_000)
        const previous = result.measurements[index - 1]

        if (previous?.median > 10) expect(measurement.median / previous.median).toBeLessThan(3)
      }
    },
    35_000,
  )

  // The child builds each family at 20,000, 40,000 and 80,000 characters and
  // checks its exact output.
  it.each([
    { family: "unclosed bare parentheses" },
    { family: "unclosed angle brackets" },
    { family: "unclosed double-quoted titles" },
    { family: "unclosed single-quoted titles" },
    { family: "unclosed parenthesized titles" },
    { family: "whitespace and no-break spaces after one shared `](`" },
    { family: "bare destinations sharing one whitespace run" },
    { family: "parenthesized titles sharing one closer and whitespace run" },
    { family: "angle destinations sharing one closer and whitespace run" },
    { family: "backslash runs before parentheses" },
    { family: "nested URL openers" },
    { family: "nested heading openers" },
    { family: "openers before one long rejected destination" },
    { family: "openers before one closer after an even backslash run" },
    { family: "outer angle links failing after an inner link's title" },
  ])(
    "scans markdown destinations with $family in linear time in an externally killed child",
    ({ family }) => {
      const fixturePath = new URL("./helpers/link-scanner-adversary.ts", import.meta.url)
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", fixturePath.pathname, family],
        {
          encoding: "utf8",
          timeout: CHILD_DEADLINE_MS,
          killSignal: "SIGKILL",
        },
      )
      const result = JSON.parse(output)

      expect(result.variant).toBe(family)
      for (const [index, measurement] of result.measurements.entries()) {
        expect(measurement.median).toBeLessThan(1_000)
        const previous = result.measurements[index - 1]

        if (previous?.median > TIMING_FLOOR_MS) {
          expect(measurement.median / previous.median).toBeLessThan(3)
        }
      }
    },
    CHILD_TEST_TIMEOUT_MS,
  )

  // Neither alphabet holds a `(`, so no markdown link forms in these documents.
  it.each(scannerCorpora.slice(0, 2))(
    "preserves every legacy wikilink match, capture and UTF-16 offset in 10,000 $label documents",
    ({ alphabet }) => {
      for (const document of createScannerDocuments(alphabet, 10_000)) {
        const expected = [...document.matchAll(legacyWiki)].map((match) => ({
          text: match[0],
          start: match.index,
          end: match.index + match[0].length,
          kind: "wikilink",
        }))
        expect(links.matchLinksInLine(document)).toEqual(expected)
        const expectedTargets = new Set<string>()

        for (const { text, inCode } of classifyLines(document)) {
          if (inCode) continue
          for (const match of maskLikeExtraction(text).matchAll(legacyWiki)) {
            const target = (match[1] ?? "").trim().replace(/\\$/, "")

            if (target) expectedTargets.add(target)
          }
        }
        expect(links.extractFromBody(document)).toEqual([...expectedTargets])
      }
    },
  )

  it("finds a wikilink with its offsets and kind", () => {
    expect(links.matchLinksInLine("see [[Note A]] end")).toEqual([
      { text: "[[Note A]]", start: 4, end: 14, kind: "wikilink" },
    ])
  })

  it("finds a markdown link with its offsets and kind", () => {
    expect(links.matchLinksInLine("see [x](a/b.md) end")).toEqual([
      { text: "[x](a/b.md)", start: 4, end: 15, kind: "markdown" },
    ])
  })

  it("finds both link kinds in one line", () => {
    expect(links.matchLinksInLine("[[A]] and [x](b.md)")).toEqual([
      { text: "[[A]]", start: 0, end: 5, kind: "wikilink" },
      { text: "[x](b.md)", start: 10, end: 19, kind: "markdown" },
    ])
  })

  it("returns an empty array when the line has no links", () => {
    expect(links.matchLinksInLine("just plain text")).toEqual([])
  })

  it("does not match scheme-prefixed or anchor targets even when they end in .md", () => {
    // .md targets so the scheme/anchor guard — not the .md filter — excludes them.
    expect(links.matchLinksInLine("[g](https://x.com/g.md) [m](mailto:m@x.md) [a](#a.md)")).toEqual(
      [],
    )
  })

  it("finds a markdown asset embed with kind markdown, offsets including the embed marker", () => {
    expect(links.matchLinksInLine("see ![alt](image.png) end")).toEqual([
      { text: "![alt](image.png)", start: 4, end: 21, kind: "markdown" },
    ])
  })

  it("starts a markdown link after an escaped embed marker at its bracket", () => {
    expect(links.matchLinksInLine("see \\![alt](image.png) end")).toEqual([
      { text: "[alt](image.png)", start: 6, end: 22, kind: "markdown" },
    ])
  })
})

// ── maskInlineCode ───────────────────────────────────────────────

describe("maskInlineCode", () => {
  it("replaces an inline code span with as many spaces", () => {
    expect(links.maskInlineCode("use `code` here")).toBe("use        here")
  })

  it("replaces every span on the line, keeping each offset", () => {
    expect(links.maskInlineCode("`a` and ``bb`` [x](y.md)")).toBe("    and        [x](y.md)")
  })

  it("returns a line without inline code unchanged", () => {
    expect(links.maskInlineCode("plain [[text]]")).toBe("plain [[text]]")
  })
})

// ── splitWikilink ────────────────────────────────────────────────

describe("splitWikilink", () => {
  const scenarios = [
    {
      name: "splits a bare wikilink",
      input: "[[A]]",
      expected: { embed: "", target: "A", heading: "", alias: "" },
    },
    {
      name: "splits a wikilink with an alias",
      input: "[[A|x]]",
      expected: { embed: "", target: "A", heading: "", alias: "|x" },
    },
    {
      name: "splits a wikilink with a heading",
      input: "[[A#h]]",
      expected: { embed: "", target: "A", heading: "#h", alias: "" },
    },
    {
      name: "splits a wikilink with a heading and an alias",
      input: "[[A#h|x]]",
      expected: { embed: "", target: "A", heading: "#h", alias: "|x" },
    },
    {
      name: "preserves the embed marker",
      input: "![[A]]",
      expected: { embed: "!", target: "A", heading: "", alias: "" },
    },
    {
      name: "strips the escaped pipe backslash and shifts it into the alias",
      input: "[[sessions/log-a\\|log-a]]",
      expected: {
        embed: "",
        target: "sessions/log-a",
        heading: "",
        alias: "\\|log-a",
      },
    },
    {
      name: "strips the escaped pipe backslash from a nested path",
      input: "[[Projects/Foo\\|display]]",
      expected: {
        embed: "",
        target: "Projects/Foo",
        heading: "",
        alias: "\\|display",
      },
    },
    {
      name: "strips the escaped pipe backslash from an embedded wikilink",
      input: "![[Photo\\|thumbnail]]",
      expected: {
        embed: "!",
        target: "Photo",
        heading: "",
        alias: "\\|thumbnail",
      },
    },
    {
      name: "strips a trailing backslash even when there is no alias",
      input: "[[path\\]]",
      expected: { embed: "", target: "path", heading: "", alias: "\\" },
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(links.splitWikilink(input)).toEqual(expected)
  })

  it("returns null for text that is not a well-formed wikilink", () => {
    expect(links.splitWikilink("[[A")).toBeNull()
  })
})

// ── splitMarkdownLink ────────────────────────────────────────────

describe("splitMarkdownLink", () => {
  const scenarios = [
    {
      name: "splits a plain markdown link, capturing the .md extension",
      input: "[t](a/b.md)",
      expected: {
        prefix: "[t](",
        writtenTarget: "a/b.md",
        path: "a/b",
        extension: ".md",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "splits a markdown link with a heading",
      input: "[t](a/b.md#sec)",
      expected: {
        prefix: "[t](",
        writtenTarget: "a/b.md",
        path: "a/b",
        extension: ".md",
        heading: "#sec",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "decodes a percent-encoded path and keeps the raw target",
      input: "[t](My%20Note.md)",
      expected: {
        prefix: "[t](",
        writtenTarget: "My%20Note.md",
        path: "My Note",
        extension: ".md",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "captures a non-.md asset extension",
      input: "[alt](assets/photo.png)",
      expected: {
        prefix: "[alt](",
        writtenTarget: "assets/photo.png",
        path: "assets/photo",
        extension: ".png",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "parses an extensionless target with an empty extension",
      input: "[t](Extensionless%20Note)",
      expected: {
        prefix: "[t](",
        writtenTarget: "Extensionless%20Note",
        path: "Extensionless Note",
        extension: "",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "does not read a dot in a folder name as the extension",
      input: "[t](dir.v2/note)",
      expected: {
        prefix: "[t](",
        writtenTarget: "dir.v2/note",
        path: "dir.v2/note",
        extension: "",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "splits at the last dot of a multi-dot target",
      input: "[t](archive.tar.gz)",
      expected: {
        prefix: "[t](",
        writtenTarget: "archive.tar.gz",
        path: "archive.tar",
        extension: ".gz",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "recognizes an extension hidden behind a percent-encoded dot",
      input: "[alt](photo%2Epng)",
      expected: {
        prefix: "[alt](",
        writtenTarget: "photo%2Epng",
        path: "photo",
        extension: ".png",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "decodes percent-encoding inside the extension",
      input: "[alt](photo.p%6Eg)",
      expected: {
        prefix: "[alt](",
        writtenTarget: "photo.p%6Eg",
        path: "photo",
        extension: ".png",
        heading: "",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "keeps an angle destination's brackets, spaces and title outside the target",
      input: '[t]( < My Note.md > "tip" )',
      expected: {
        prefix: "[t]( < ",
        writtenTarget: "My Note.md",
        path: "My Note",
        extension: ".md",
        heading: "",
        suffix: ' > "tip" )',
        destinationForm: "angle",
      },
    },
    {
      name: "keeps an angle destination's heading as written",
      input: "[t](<My Note.md#Head ing>)",
      expected: {
        prefix: "[t](<",
        writtenTarget: "My Note.md",
        path: "My Note",
        extension: ".md",
        heading: "#Head ing",
        suffix: ">)",
        destinationForm: "angle",
      },
    },
    {
      name: "keeps parentheses and escapes in a bare target as written",
      input: "[t](a\\(b\\)c.md 'tip')",
      expected: {
        prefix: "[t](",
        writtenTarget: "a\\(b\\)c.md",
        path: "a(b)c",
        extension: ".md",
        heading: "",
        suffix: " 'tip')",
        destinationForm: "bare",
      },
    },
    {
      name: "starts the heading at the character reference that makes its #",
      input: "[t](Old&num;Heading)",
      expected: {
        prefix: "[t](",
        writtenTarget: "Old",
        path: "Old",
        extension: "",
        heading: "&num;Heading",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "starts the heading at the escape pair that makes its #",
      input: "[t](Old\\#Heading)",
      expected: {
        prefix: "[t](",
        writtenTarget: "Old",
        path: "Old",
        extension: "",
        heading: "\\#Heading",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "keeps a character reference before the heading inside the written target",
      input: "[t](A&amp;B.md#h)",
      expected: {
        prefix: "[t](",
        writtenTarget: "A&amp;B.md",
        path: "A&B",
        extension: ".md",
        heading: "#h",
        suffix: ")",
        destinationForm: "bare",
      },
    },
    {
      name: "keeps escape pairs and references before the heading inside the written target",
      input: "[t](a\\_b&amp;c\\_d.md#h)",
      expected: {
        prefix: "[t](",
        writtenTarget: "a\\_b&amp;c\\_d.md",
        path: "a_b&c_d",
        extension: ".md",
        heading: "#h",
        suffix: ")",
        destinationForm: "bare",
      },
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(links.splitMarkdownLink(input)).toEqual(expected)
  })

  it("returns null for malformed link text (missing closing paren)", () => {
    expect(links.splitMarkdownLink("[t](path.md")).toBeNull()
  })

  it("returns null for a link that does not cover the whole text", () => {
    expect(links.splitMarkdownLink("[t](a.md) tail")).toBeNull()
  })

  it("returns null for a link whose destination names no note or file", () => {
    expect(links.splitMarkdownLink("[t](https://example.com/a.md)")).toBeNull()
  })

  it("returns null for a destination with a malformed percent escape", () => {
    expect(links.splitMarkdownLink("[t](100%zzcomplete.md)")).toBeNull()
  })

  it("splits an embed with a malformed percent escape, its marker in the prefix", () => {
    expect(links.splitMarkdownLink("![n](100%.md)")).toEqual({
      prefix: "![n](",
      writtenTarget: "100%.md",
      path: "100%",
      extension: ".md",
      heading: "",
      suffix: ")",
      destinationForm: "bare",
    })
  })
})

// ── extractFromBody ──────────────────────────────────────────────

describe("extractFromBody", () => {
  it("extracts basic wikilinks", () => {
    const targets = links.extractFromBody("See [[Note A]] and [[Note B]].")
    expect(targets).toEqual(["Note A", "Note B"])
  })

  it("extracts wikilinks with display text", () => {
    const targets = links.extractFromBody("See [[Note A|my note]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks with heading anchors", () => {
    const targets = links.extractFromBody("See [[Note A#Section One]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks with heading and display text", () => {
    const targets = links.extractFromBody("See [[Note A#Section|display]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks with folder paths", () => {
    const targets = links.extractFromBody("See [[Projects/vault-cortex]].")
    expect(targets).toEqual(["Projects/vault-cortex"])
  })

  it("extracts embeds as links", () => {
    const targets = links.extractFromBody("![[Embedded Note]]")
    expect(targets).toEqual(["Embedded Note"])
  })

  it("extracts markdown internal links with the target as written", () => {
    const targets = links.extractFromBody("[click here](Projects/plan.md)")
    expect(targets).toEqual(["Projects/plan.md"])
  })

  it("excludes a scheme-prefixed URL even when it ends in .md", () => {
    // .md target so the https:// guard — not the .md filter — is what excludes it;
    // the [[Internal]] link proves extraction still happens.
    const targets = links.extractFromBody("[Google](https://google.com/page.md) and [[Internal]]")
    expect(targets).toEqual(["Internal"])
  })

  it("excludes a mailto target even when it ends in .md", () => {
    // .md target so the mailto: guard — not the .md filter — is what excludes it.
    const targets = links.extractFromBody("[email](mailto:hi@example.md) and [[Reach Out]]")
    expect(targets).toEqual(["Reach Out"])
  })

  it("excludes same-page anchors", () => {
    const targets = links.extractFromBody("[section](#heading) — see [[Details]]")
    expect(targets).toEqual(["Details"])
  })

  it("deduplicates repeated targets", () => {
    const targets = links.extractFromBody("[[Note A]] and again [[Note A]]")
    expect(targets).toEqual(["Note A"])
  })

  it("skips links inside fenced code blocks", () => {
    const content = [
      "before [[Real Link]]",
      "```",
      "[[Fake Link]]",
      "```",
      "after [[Another Real Link]]",
    ].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link", "Another Real Link"])
  })

  it("skips links inside tilde fenced blocks", () => {
    const content = ["[[Before]]", "~~~", "[[Fake]]", "~~~", "[[After]]"].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Before", "After"])
  })

  it("handles nested fences correctly", () => {
    const content = ["````", "```", "[[Inside Nested]]", "```", "````", "[[Outside]]"].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Outside"])
  })

  it("returns empty for content with no links", () => {
    expect(links.extractFromBody("Just plain text.")).toEqual([])
  })

  it("skips wikilinks inside inline code spans", () => {
    const targets = links.extractFromBody("See [[Live Note]] but not the `[[Code Note]]` example.")
    expect(targets).toEqual(["Live Note"])
  })

  it("skips markdown links inside inline code spans", () => {
    const targets = links.extractFromBody("Real [link](real.md) but `[code](code.md)` is inert.")
    expect(targets).toEqual(["real.md"])
  })

  it("skips links inside indented fences (CommonMark §4.5)", () => {
    const content = ["- list item:", "  ```", "  [[Fake Link]]", "  ```", "[[Real Link]]"].join(
      "\n",
    )
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link"])
  })

  it("skips wikilink-like patterns inside Templater expressions", () => {
    const content = "[[Real Link]] and <% tp.file.include('[[Daily Template]]') %>"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link"])
  })

  it("skips links inside <%+ output expressions", () => {
    const content = "[[Before]] <%+ tp.file.include('[[Template]]') %> [[After]]"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Before", "After"])
  })

  it("handles multiple Templater expressions on one line", () => {
    const content =
      "<% tp.file.include('[[Header]]') %> [[Real]] <% tp.file.include('[[Footer]]') %>"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real"])
  })

  it("does not suppress links when <% has no closing %>", () => {
    const content = "<% unclosed expression [[Real Link]]"
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["Real Link"])
  })

  it("extracts markdown links and embeds to non-.md assets", () => {
    const targets = links.extractFromBody(
      "![photo](pics/photo.png), [doc](papers/report.pdf), and [[Caption]]",
    )
    expect(targets).toEqual(["Caption", "pics/photo.png", "papers/report.pdf"])
  })

  it("extracts extensionless markdown links, percent-decoded", () => {
    const targets = links.extractFromBody("[team notes](Some%20Note)")
    expect(targets).toEqual(["Some Note"])
  })

  it("percent-decodes markdown asset paths with folders and spaces", () => {
    const targets = links.extractFromBody("![shot](Trip%20Photos/pic%201.png)")
    expect(targets).toEqual(["Trip Photos/pic 1.png"])
  })

  it("excludes scheme-prefixed targets of any scheme, not just http and mailto", () => {
    // The control wikilink proves extraction ran — a wrong lookahead would
    // extract the scheme targets alongside it.
    const targets = links.extractFromBody(
      [
        "[o](obsidian://open?vault=v)",
        "[z](zotero://select/items/123)",
        "[f](ftp://host/file.pdf)",
        "[u](HTTPS://x.com/a.png)",
        "[[Control]]",
      ].join(" "),
    )
    expect(targets).toEqual(["Control"])
  })

  it("strips the heading anchor from a non-md markdown link", () => {
    const targets = links.extractFromBody("[docs](papers/report.pdf#page=2)")
    expect(targets).toEqual(["papers/report.pdf"])
  })

  it("drops a markdown link with a malformed percent escape, as Obsidian does", () => {
    const targets = links.extractFromBody("[done](100%zzcomplete.md) and [[Control]]")
    expect(targets).toEqual(["Control"])
  })

  it("strips the escaped pipe backslash from wikilink targets in table cells", () => {
    const content = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[sessions/log-a\\|log-a]] | First session |",
      "| [[sessions/log-b\\|log-b]] | Second session |",
    ].join("\n")
    const targets = links.extractFromBody(content)
    expect(targets).toEqual(["sessions/log-a", "sessions/log-b"])
  })

  it("strips the escaped pipe backslash from aliased wikilinks outside tables", () => {
    const targets = links.extractFromBody("See [[Note A\\|display text]].")
    expect(targets).toEqual(["Note A"])
  })

  it("does not alter wikilinks that use a plain pipe alias", () => {
    const targets = links.extractFromBody("See [[Note A|display]].")
    expect(targets).toEqual(["Note A"])
  })

  it("extracts wikilinks to non-markdown assets alongside note links", () => {
    const targets = links.extractFromBody(
      "![[photo.png]] and ![[report.pdf]] and ![[song.mp3]] and [[Note A]]",
    )
    expect(targets).toEqual(["photo.png", "report.pdf", "song.mp3", "Note A"])
  })

  it("extracts embedded assets with folder paths", () => {
    const targets = links.extractFromBody("![[attachments/diagram.svg]] and [[Real Note]]")
    expect(targets).toEqual(["attachments/diagram.svg", "Real Note"])
  })

  it("keeps wikilinks to notes with dots in the name", () => {
    const targets = links.extractFromBody("[[v2.0]] and [[release-1.3]]")
    expect(targets).toEqual(["v2.0", "release-1.3"])
  })

  it("keeps wikilinks with explicit .md extension", () => {
    const targets = links.extractFromBody("[[Projects/plan.md]]")
    expect(targets).toEqual(["Projects/plan.md"])
  })
})

// ── extractFromBody against Obsidian ─────────────────────────────

describe("extractFromBody against Obsidian 1.15.1", () => {
  // Each case holds the links Obsidian 1.15.1's metadata cache stored for its
  // input, recorded by running the app's worker as a black box, and the
  // targets extraction returns: each link with its heading removed and
  // trimmed, without the heading-only ones.
  const obsidianCases = [
    // The plan's vector table.
    { input: "[x](<My Note.md>)", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](<New (Draft).md>)", obsidian: ["New (Draft).md"], expected: ["New (Draft).md"] },
    {
      input: "[x](<Folder/Sub Note>)",
      obsidian: ["Folder/Sub Note"],
      expected: ["Folder/Sub Note"],
    },
    { input: "[x](<MyNote.md>)", obsidian: ["MyNote.md"], expected: ["MyNote.md"] },
    { input: "[x](<My%20Note.md>)", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](New%20(Draft).md)", obsidian: ["New (Draft).md"], expected: ["New (Draft).md"] },
    { input: "[x](a(b)c.md)", obsidian: ["a(b)c.md"], expected: ["a(b)c.md"] },
    { input: "[x](a((b)).md)", obsidian: ["a((b)).md"], expected: ["a((b)).md"] },
    { input: "[x](a(b.md)", obsidian: [], expected: [] },
    { input: "[x](a)b).md)", obsidian: ["a"], expected: ["a"] },
    { input: "[x](a\\)b.md)", obsidian: ["a)b.md"], expected: ["a)b.md"] },
    { input: "[x](a\\(b.md)", obsidian: ["a(b.md"], expected: ["a(b.md"] },
    { input: '[x](My%20Note.md "title")', obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](My%20Note.md 'title')", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](My%20Note.md (title))", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](<a.md> 't')", obsidian: ["a.md"], expected: ["a.md"] },
    { input: '[x](a.md "ti)tle")', obsidian: ["a.md"], expected: ["a.md"] },
    { input: '[x](a(b)c.md "t(1)")', obsidian: ["a(b)c.md"], expected: ["a(b)c.md"] },
    { input: "[x]( <My Note.md> )", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x]( My%20Note.md )", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](< My Note.md >)", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](\t<My Note.md>\t)", obsidian: ["My Note.md"], expected: ["My Note.md"] },
    { input: "[x](a.md\t)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](<a.md>  )", obsidian: ["a.md"], expected: ["a.md"] },
    {
      input: "[x](<My Note.md#Head ing>)",
      obsidian: ["My Note.md#Head ing"],
      expected: ["My Note.md"],
    },
    { input: "[x](a(b)c.md#h(1))", obsidian: ["a(b)c.md#h(1)"], expected: ["a(b)c.md"] },
    {
      input: "[a](<x y.md>) and [b](z(1).md)",
      obsidian: ["x y.md", "z(1).md"],
      expected: ["x y.md", "z(1).md"],
    },
    { input: '[x](a.md"title")', obsidian: ['a.md"title"'], expected: ['a.md"title"'] },
    { input: '[x](<a.md>"t")', obsidian: [], expected: [] },
    { input: "[x](<a.md>x)", obsidian: [], expected: [] },
    { input: "[x](a.md x)", obsidian: [], expected: [] },
    { input: '[x](a.md "t" x)', obsidian: [], expected: [] },
    { input: '[x](a.md "title)', obsidian: [], expected: [] },
    { input: "[x](<a>b.md>)", obsidian: [], expected: [] },
    { input: "[x](<a\\>b.md>)", obsidian: [], expected: [] },
    { input: "[x](<a\\>.md>)", obsidian: [], expected: [] },
    { input: "[x](<>)", obsidian: [], expected: [] },
    { input: "[x](<a.md>", obsidian: [], expected: [] },
    { input: "[x](<a.md\\>)", obsidian: ["a.md\\"], expected: ["a.md\\"] },
    { input: "[x](<a<b.md>)", obsidian: ["a<b.md"], expected: ["a<b.md"] },
    { input: "[x](<a(b.md>)", obsidian: ["a(b.md"], expected: ["a(b.md"] },
    { input: "[x](<a\tb.md>)", obsidian: ["a\tb.md"], expected: ["a\tb.md"] },
    { input: "[x](a\\ b.md)", obsidian: ["a\\ b.md"], expected: ["a\\ b.md"] },
    { input: "[x](a\\(b c.md)", obsidian: [], expected: [] },
    { input: "[x](a\\#b.md)", obsidian: ["a#b.md"], expected: ["a"] },
    { input: "[x](a\\_b.md)", obsidian: ["a_b.md"], expected: ["a_b.md"] },
    { input: "[x](a\\&b.md)", obsidian: ["a&b.md"], expected: ["a&b.md"] },
    { input: "[x](a\\\\b.md)", obsidian: ["a\\b.md"], expected: ["a\\b.md"] },
    { input: "[x](a\\b.md)", obsidian: ["a\\b.md"], expected: ["a\\b.md"] },
    { input: "[x](\\<a.md\\>)", obsidian: ["<a.md>"], expected: ["<a.md>"] },
    { input: "[x](<https://example.com>)", obsidian: [], expected: [] },
    { input: "[x](<mailto:a@b.c>)", obsidian: [], expected: [] },
    { input: "[x](<C:/x.md>)", obsidian: [], expected: [] },
    { input: "[x](https\\://example.com)", obsidian: [], expected: [] },
    { input: "[x](#Heading)", obsidian: ["#Heading"], expected: [] },
    { input: "[x](<#Heading>)", obsidian: ["#Heading"], expected: [] },
    { input: "[x](a.md#)", obsidian: ["a.md#"], expected: ["a.md"] },
    { input: "[x](<a.md#>)", obsidian: ["a.md#"], expected: ["a.md"] },
    { input: "[x](%20a.md)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](a.md%20)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](<%20a.md>)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](a%2Fb.md)", obsidian: ["a%2Fb.md"], expected: ["a%2Fb.md"] },
    { input: "[x](a%3Fb.md)", obsidian: ["a%3Fb.md"], expected: ["a%3Fb.md"] },
    { input: "[x](a%26b.md)", obsidian: ["a%26b.md"], expected: ["a%26b.md"] },
    { input: "[x](a%23b.md)", obsidian: ["a%23b.md"], expected: ["a%23b.md"] },
    { input: "[x](a%5Cb.md)", obsidian: ["a\\b.md"], expected: ["a\\b.md"] },
    { input: "[x](<a%3Eb.md>)", obsidian: ["a>b.md"], expected: ["a>b.md"] },
    { input: "[x](<a%3Cb.md>)", obsidian: ["a<b.md"], expected: ["a<b.md"] },
    { input: "[x](a%2)", obsidian: [], expected: [] },
    { input: "[x](<a%2.md>)", obsidian: [], expected: [] },
    { input: "[x](a&amp;b.md)", obsidian: ["a&b.md"], expected: ["a&b.md"] },
    { input: "[x](a&#38;b.md)", obsidian: ["a&b.md"], expected: ["a&b.md"] },
    { input: "[x](<A &amp; B.md>)", obsidian: ["A & B.md"], expected: ["A & B.md"] },
    { input: "[x](<A & B.md>)", obsidian: ["A & B.md"], expected: ["A & B.md"] },
    { input: "[x](<A %26 B.md>)", obsidian: ["A %26 B.md"], expected: ["A %26 B.md"] },
    // Whitespace, URI, balance, used-up destination and escaped opener rows from review.
    { input: '[x](a(b "t")', obsidian: ["a(b"], expected: ["a(b"] },
    { input: "[x](a.md\u00a0)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](\u00a0a.md)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](<a\u00a0b.md>)", obsidian: ["a b.md"], expected: ["a b.md"] },
    { input: "[x](a.md\u3000)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](<a\u2028b.md>)", obsidian: ["a\u2028b.md"], expected: ["a\u2028b.md"] },
    { input: "[x](<a\rb.md>) [y](c.md)", obsidian: ["c.md"], expected: ["c.md"] },
    { input: "[x](%68ttps://example.com)", obsidian: [], expected: [] },
    { input: "[x](< https://example.com >)", obsidian: [], expected: [] },
    { input: "[x](a/b:c.md)", obsidian: [], expected: [] },
    { input: "[x](ab%3Ac.md)", obsidian: ["ab%3Ac.md"], expected: ["ab%3Ac.md"] },
    // A link starting with `./` or `../` keeps its `:`, tested before percent-decoding and trimming.
    {
      input: "[x](../Note.md#Step%201:%20Setup)",
      obsidian: ["../Note.md#Step 1: Setup"],
      expected: ["../Note.md"],
    },
    {
      input: "[x](<../My Note.md#Step 1: Setup>)",
      obsidian: ["../My Note.md#Step 1: Setup"],
      expected: ["../My Note.md"],
    },
    { input: "[x](./a:b.md)", obsidian: ["./a:b.md"], expected: ["./a:b.md"] },
    { input: "[x](&#46;/a:b.md)", obsidian: ["./a:b.md"], expected: ["./a:b.md"] },
    { input: "[x](.\\/a:b.md)", obsidian: ["./a:b.md"], expected: ["./a:b.md"] },
    { input: "[x](%2E%2E/a:b.md)", obsidian: [], expected: [] },
    { input: "[x](< ../a:b.md>)", obsidian: [], expected: [] },
    { input: "[x](/a:b.md)", obsidian: [], expected: [] },
    { input: "[x](.../a:b.md)", obsidian: [], expected: [] },
    { input: "[a](https://x.com/[b](c.md))", obsidian: [], expected: [] },
    { input: "\\[x](a.md)", obsidian: [], expected: [] },
    { input: "\\\\[x](a.md)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "![x](img.png)", obsidian: ["img.png"], expected: ["img.png"] },
    // Character references, entity-made headings and headings that drop the link.
    { input: "[x](a&notit;b.md)", obsidian: ["a\u00acit;b.md"], expected: ["a\u00acit;b.md"] },
    { input: "[x](a&amplt;b.md)", obsidian: ["a&lt;b.md"], expected: ["a&lt;b.md"] },
    { input: "[x](a&amp;amp;b.md)", obsidian: ["a&amp;b.md"], expected: ["a&amp;b.md"] },
    { input: "[x](a&amp;#35;b.md)", obsidian: ["a&#35;b.md"], expected: ["a&"] },
    { input: "[x](a&num;Heading)", obsidian: ["a#Heading"], expected: ["a"] },
    { input: "[x](a&#35;Heading)", obsidian: ["a#Heading"], expected: ["a"] },
    { input: "[x](a&#x23;Heading)", obsidian: ["a#Heading"], expected: ["a"] },
    { input: "[x](a.md#h:1)", obsidian: [], expected: [] },
    { input: "[x](<Note.md#Step 1: Setup>)", obsidian: [], expected: [] },
    { input: "[x](a.md#h\\:x)", obsidian: [], expected: [] },
    { input: "[x](a.md#h&colon;x)", obsidian: [], expected: [] },
    { input: "![x](img.png#h:1)", obsidian: [], expected: [] },
    { input: "[x](a.md#%2)", obsidian: [], expected: [] },
    { input: "[x](a.md#%zz)", obsidian: [], expected: [] },
    { input: "[x](Budget.md#100%)", obsidian: [], expected: [] },
    { input: "[x](a.md#h%3A1)", obsidian: ["a.md#h%3A1"], expected: ["a.md"] },
    { input: "[x](Budget.md#100%25)", obsidian: ["Budget.md#100%"], expected: ["Budget.md"] },
    // A malformed escape leaves an embed undecoded instead of dropping it.
    { input: "![i](100%.png)", obsidian: ["100%.png"], expected: ["100%.png"] },
    { input: "![](<100% done.png>)", obsidian: ["100% done.png"], expected: ["100% done.png"] },
    { input: "![i](a.png#h%2)", obsidian: ["a.png#h%2"], expected: ["a.png"] },
    { input: "![i](./a%2.png)", obsidian: ["./a%2.png"], expected: ["./a%2.png"] },
    { input: '![i](<a%2.png> "t")', obsidian: ["a%2.png"], expected: ["a%2.png"] },
    { input: "![i](a%26b%.png)", obsidian: ["a%26b%.png"], expected: ["a%26b%.png"] },
    { input: "![i](&amp;%.png)", obsidian: ["&%.png"], expected: ["&%.png"] },
    { input: "!![i](50%.png)", obsidian: ["50%.png"], expected: ["50%.png"] },
    { input: "\\![i](a%2.png)", obsidian: [], expected: [] },
    { input: "![i](a%zz:b.png)", obsidian: [], expected: [] },
    { input: "x ![a](b%.png) y [c](d%.md)", obsidian: ["b%.png"], expected: ["b%.png"] },
    { input: "[x](a&notes.md)", obsidian: ["a&notes.md"], expected: ["a&notes.md"] },
    { input: "[x](a&amp b.md)", obsidian: [], expected: [] },
    // Comments, long reference names, escapes and the rewriter's spellings.
    { input: "[x](<a.md #h>)", obsidian: ["a.md #h"], expected: ["a.md"] },
    { input: "%% [x](a.md) %%", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "x %%[x](a.md)%% y", obsidian: ["a.md"], expected: ["a.md"] },
    {
      input: "[x](a&bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;c.md)",
      obsidian: ["a&bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;c.md"],
      expected: ["a&bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;c.md"],
    },
    {
      input: "[x](a&notbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;c.md)",
      obsidian: ["a\u00acbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;c.md"],
      expected: ["a\u00acbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;c.md"],
    },
    {
      input: "[x](a&notbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc.md)",
      obsidian: ["a&notbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc.md"],
      expected: ["a&notbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc.md"],
    },
    {
      input: "[x](a&CounterClockwiseContourIntegralx;b.md)",
      obsidian: ["a&CounterClockwiseContourIntegralx;b.md"],
      expected: ["a&CounterClockwiseContourIntegralx;b.md"],
    },
    {
      input: "[x](a&CounterClockwiseContourIntegral;b.md)",
      obsidian: ["a∳b.md"],
      expected: ["a∳b.md"],
    },
    { input: "[x](a&#;b.md)", obsidian: ["a&#;b.md"], expected: ["a&"] },
    { input: "[x](a&\\#35;b.md)", obsidian: ["a#b.md"], expected: ["a"] },
    { input: "[x]()", obsidian: [], expected: [] },
    { input: "[x]( )", obsidian: [], expected: [] },
    { input: "[x](a.md 'ti\\'tle')", obsidian: ["a.md"], expected: ["a.md"] },
    { input: '[x](a.md "t" )', obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](a.md\u000b)", obsidian: ["a.md"], expected: ["a.md"] },
    { input: "[x](a\u00a0b.md)", obsidian: [], expected: [] },
    { input: "[x](a\\ b.md#h)", obsidian: ["a\\ b.md#h"], expected: ["a\\ b.md"] },
    { input: "[x](a%20b.md#Head%20ing)", obsidian: ["a b.md#Head ing"], expected: ["a b.md"] },
    { input: "[x](%41.md)", obsidian: ["A.md"], expected: ["A.md"] },
    { input: "[x](a.md#h&num;2)", obsidian: ["a.md#h#2"], expected: ["a.md"] },
    { input: "[x](A&amp;B.md#h)", obsidian: ["A&B.md#h"], expected: ["A&B.md"] },
    { input: "[x](a\\_b&amp;c\\_d.md#h)", obsidian: ["a_b&c_d.md#h"], expected: ["a_b&c_d.md"] },
    { input: "[x](\\[a\\].md)", obsidian: ["[a].md"], expected: ["[a].md"] },
    { input: "[x](a\\*b.md)", obsidian: ["a*b.md"], expected: ["a*b.md"] },
    { input: "[x](a\\$b.md)", obsidian: ["a$b.md"], expected: ["a$b.md"] },
    { input: "[x](a_b.md)", obsidian: ["a_b.md"], expected: ["a_b.md"] },
    { input: "[x](a\\_\\_b.md)", obsidian: ["a__b.md"], expected: ["a__b.md"] },
    { input: "[x](a%60b%60c.md)", obsidian: ["a`b`c.md"], expected: ["a`b`c.md"] },
    { input: "[x](<a%60b%60c.md>)", obsidian: ["a`b`c.md"], expected: ["a`b`c.md"] },
    { input: "[x](a\\<b\\>c.md)", obsidian: ["a<b>c.md"], expected: ["a<b>c.md"] },
    { input: "[x](R+D%20@%20Home.md)", obsidian: ["R+D @ Home.md"], expected: ["R+D @ Home.md"] },
    { input: "[x](A%20&%61mp;%20B.md)", obsidian: ["A &amp; B.md"], expected: ["A &amp; B.md"] },
    {
      input: "[x](A%20&%61mplt;%20B.md)",
      obsidian: ["A &amplt; B.md"],
      expected: ["A &amplt; B.md"],
    },
    { input: "[x](a&#%335;b.md)", obsidian: ["a&#35;b.md"], expected: ["a&"] },
    { input: "[x](<A &%61mp; B.md>)", obsidian: ["A &amp; B.md"], expected: ["A &amp; B.md"] },
    { input: "[x](Q%26A.md)", obsidian: ["Q%26A.md"], expected: ["Q%26A.md"] },
    { input: "[x](x$y.md)", obsidian: ["x$y.md"], expected: ["x$y.md"] },
    { input: "[x](x\\$y.md)", obsidian: ["x$y.md"], expected: ["x$y.md"] },
    { input: "[x](a\\~\\~b.md)", obsidian: ["a~~b.md"], expected: ["a~~b.md"] },
    { input: "[x](a~b.md)", obsidian: ["a~b.md"], expected: ["a~b.md"] },
    { input: "[x](a\\=\\=b.md)", obsidian: ["a==b.md"], expected: ["a==b.md"] },
    // A reference that decodes nothing after one that does.
    { input: "[x](&amp;&Note.md)", obsidian: ["&&Note.md"], expected: ["&&Note.md"] },
    { input: "[x](a&amp;&b.md)", obsidian: ["a&&b.md"], expected: ["a&&b.md"] },
    { input: "[x](&lt;&gt.md)", obsidian: ["<&gt.md"], expected: ["<&gt.md"] },
    { input: "[x](&amp;&amp.md)", obsidian: ["&&amp.md"], expected: ["&&amp.md"] },
    { input: "[x](<&amp;&Note.md>)", obsidian: ["&&Note.md"], expected: ["&&Note.md"] },
    { input: "x &amp;&Note y", obsidian: [], expected: [] },
    { input: "[x](&#38;&Note.md)", obsidian: ["&&Note.md"], expected: ["&&Note.md"] },
    // Nested openers, and a bare title that starts before a failed angle title.
    { input: '[a](< [b](x.md "t") > "x', obsidian: ["x.md"], expected: ["x.md"] },
    { input: "[a](h:[a](h:a))", obsidian: [], expected: [] },
    { input: "[a](#[b](c.md))", obsidian: ["#[b](c.md)"], expected: [] },
    // An escaped closer, a prose bracket, and the spellings a move writes.
    { input: "[a\\](b.md)", obsidian: [], expected: [] },
    {
      input: "Type [ to open, `]` to close, or read [the guide](Old.md).",
      obsidian: ["Old.md"],
      expected: ["Old.md"],
    },
    { input: "[x](R&D&amp;#35;)", obsidian: ["R&D&#35;"], expected: ["R&D&"] },
    { input: "[x](R&D&#35;)", obsidian: ["R&D#"], expected: ["R&D"] },
    { input: "[x](<A(B.md#h)c>)", obsidian: ["A(B.md#h)c"], expected: ["A(B.md"] },
    { input: "[x](A(B.md#h)c)", obsidian: ["A(B.md#h)c"], expected: ["A(B.md"] },
    {
      input: "![n](<New Plan.md#100%>)",
      obsidian: ["New Plan.md#100%"],
      expected: ["New Plan.md"],
    },
    {
      input: "[x](./Old.md#Step%201:%20Setup)",
      obsidian: ["./Old.md#Step 1: Setup"],
      expected: ["./Old.md"],
    },
    {
      input: "[x](a&notXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX.b;c.md)",
      obsidian: ["a&notXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX.b;c.md"],
      expected: ["a&notXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX.b;c.md"],
    },
  ]

  it.each(obsidianCases)("extracts $expected from $input", ({ input, expected }) => {
    expect(links.extractFromBody(input)).toEqual(expected)
  })

  // Each accepted link's parts rebuild its text, and its path and extension
  // spell the target Obsidian stores.
  it.each(obsidianCases.filter(({ expected }) => expected.length > 0))(
    "splits each link in $input into parts that rebuild it",
    ({ input, expected }) => {
      const markdownMatches = links
        .matchLinksInLine(input)
        .filter((linkMatch) => linkMatch.kind === "markdown")
      const splits = markdownMatches.map(({ text }) => {
        const parts = links.splitMarkdownLink(text)
        return {
          rebuilt: parts && `${parts.prefix}${parts.writtenTarget}${parts.heading}${parts.suffix}`,
          storedTarget: parts && `${parts.path}${parts.extension}`,
        }
      })
      expect(splits).toEqual(
        expected.map((storedTarget, index) => ({
          rebuilt: markdownMatches[index]?.text,
          storedTarget,
        })),
      )
    },
  )

  // Obsidian reads a wikilink inside a markdown link's destination or title
  // as part of that link, not as a link of its own.
  const wikilinkInDestinationCases = [
    { input: "[x](x.md#[[x]])", obsidian: ["x.md#[[x]]"], expected: ["x.md"] },
    { input: '[x](b.md "see [[Old]]")', obsidian: ["b.md"], expected: ["b.md"] },
    { input: "[x](b.md 'see [[Old]]')", obsidian: ["b.md"], expected: ["b.md"] },
    { input: "[x](b.md (see [[Old]]))", obsidian: ["b.md"], expected: ["b.md"] },
    { input: '![x](b.png "[[Old]]")', obsidian: ["b.png"], expected: ["b.png"] },
    {
      input: '[[Old]] and [x](b.md "[[Other]]")',
      obsidian: ["Old", "b.md"],
      expected: ["Old", "b.md"],
    },
  ]

  it.each(wikilinkInDestinationCases)("extracts $expected from $input", ({ input, expected }) => {
    expect(links.extractFromBody(input)).toEqual(expected)
  })
})

// ── Markdown link memory ─────────────────────────────────────────

/** What the memory worker reports: the line it built, then the length of the
 *  operation's result. */
type MemoryWorkerMessage =
  { status: "ready"; parenthesisCount: number } | { status: "done"; resultLength: number }

const isMemoryWorkerMessage = (message: unknown): message is MemoryWorkerMessage => {
  return typeof message === "object" && message !== null && "status" in message
}

/** The worker's peak heap growth while it scans or decodes its
 *  10,000,000-character line, over the heap it holds before the operation.
 *  getHeapStatistics reads a worker's heap while it runs one synchronous call,
 *  and its external memory counts typed arrays. */
const measureHeapGrowth = async (
  shape: "sparse" | "dense" | "ampersands",
): Promise<{ peakGrowth: number; parenthesisCount: number; resultLength: number }> => {
  const workerUrl = new URL("./helpers/link-memory-worker.ts", import.meta.url)
  const worker = new Worker(workerUrl, { workerData: shape, execArgv: ["--import", "tsx"] })
  onTestFinished(async () => {
    await worker.terminate()
  })

  const nextMessage = (): Promise<MemoryWorkerMessage> => {
    return new Promise((resolve, reject) => {
      worker.once("error", reject)
      worker.once("message", (message: unknown) => {
        if (isMemoryWorkerMessage(message)) resolve(message)
        else reject(new Error(`unexpected worker message: ${JSON.stringify(message)}`))
      })
    })
  }
  const sampleHeap = async (): Promise<number> => {
    const { used_heap_size, external_memory } = await worker.getHeapStatistics()
    return used_heap_size + external_memory
  }

  const ready = await nextMessage()

  if (ready.status !== "ready") throw new Error("the worker ran before it was ready")

  const baseline = await sampleHeap()
  const operated = nextMessage()
  // The sampling loop stops once the worker reports the operation's result.
  let operationFinished = false
  const finishedOperation = operated.finally(() => {
    operationFinished = true
  })
  const samples: number[] = []

  worker.postMessage("go")
  // Each sample leaves garbage in the worker's heap, and back-to-back
  // samples add up to about 1 MB of it to the peak.
  while (!operationFinished) {
    samples.push(await sampleHeap())
    await sleep(1)
  }

  const done = await finishedOperation

  if (done.status !== "done") throw new Error("the worker reported ready twice")
  return {
    peakGrowth: Math.max(baseline, ...samples) - baseline,
    parenthesisCount: ready.parenthesisCount,
    resultLength: done.resultLength,
  }
}

describe("markdown link scan memory", () => {
  /** Heap growth any scan may show, from V8's own bookkeeping. */
  const ONE_MEGABYTE = 1_000_000

  /** The record set keeps two 4-byte integers per parenthesis. */
  const BYTES_PER_PARENTHESIS = 8

  it("grows the heap less than 1 MB on a 10,000,000-character line with one parenthesis", async () => {
    const { peakGrowth, parenthesisCount, resultLength } = await measureHeapGrowth("sparse")

    expect({ parenthesisCount, resultLength }).toEqual({ parenthesisCount: 1, resultLength: 0 })
    expect(peakGrowth).toBeLessThan(ONE_MEGABYTE)
  }, 60_000)

  it("grows the heap at most 8 bytes per parenthesis and 1 MB on a parenthesis-dense line", async () => {
    const { peakGrowth, parenthesisCount, resultLength } = await measureHeapGrowth("dense")

    expect({ parenthesisCount, resultLength }).toEqual({
      parenthesisCount: 9_999_997,
      resultLength: 0,
    })
    expect(peakGrowth).toBeLessThan(BYTES_PER_PARENTHESIS * parenthesisCount + ONE_MEGABYTE)
  }, 60_000)
})

describe("link spelling decode memory", () => {
  const LINE_LENGTH = 10_000_000

  /** The decoder's joined batches, its output and the garbage its
   *  parse-entities calls leave before a collection come to about 5 bytes per
   *  character on this line. One string per decoded piece would cost about 90. */
  const BYTES_PER_CHARACTER = 8

  it("grows the heap at most 8 bytes per character decoding a 10,000,000-character run of &", async () => {
    const { peakGrowth, resultLength } = await measureHeapGrowth("ampersands")

    expect(resultLength).toBe(LINE_LENGTH)
    expect(peakGrowth).toBeLessThan(BYTES_PER_CHARACTER * LINE_LENGTH)
  }, 60_000)
})

// ── Markdown links against the remark oracle ─────────────────────

/** Whether a markdown link's bare destination ends at whitespace while a `(`
 *  in it is still open, which CommonMark's balance rule rejects and Obsidian
 *  accepts (`[x](a(b "t")` stores `a(b`). */
const endsAtWhitespaceUnbalanced = (linkText: string): boolean => {
  const destination = linkText.slice(linkText.indexOf("](") + "](".length).trimStart()

  if (destination.startsWith("<")) return false
  // The walk threads the open-parenthesis depth and skips each escaped character.
  let depth = 0

  for (let index = 0; index < destination.length; index++) {
    const character = destination.charAt(index)

    if (character === "\\") {
      index++
      continue
    }
    if (/\s/.test(character)) return depth > 0
    if (character === ")" && depth === 0) return false
    if (character === "(") depth++
    if (character === ")") depth--
  }
  return false
}

describe("markdown links against the remark oracle", () => {
  const tokenDocuments = createLinkTokenDocuments(10_000)
  const keptDocuments = tokenDocuments.filter((document) => !findExcludedConstruct(document))
  const keptWithLinks = keptDocuments.filter((document) => {
    return referenceMarkdownLinks(document).length > 0
  })

  const sortedUnique = (targets: readonly string[]): string[] => [...new Set(targets)].toSorted()

  it("leaves at most 15% of the 10,000 token documents out of the comparison", () => {
    expect(tokenDocuments.length - keptDocuments.length).toBeLessThanOrEqual(1_500)
  })

  it("keeps at least 1,000 token documents that hold a link", () => {
    expect(keptWithLinks.length).toBeGreaterThanOrEqual(1_000)
  })

  it("holds at least 100 kept documents that CommonMark's balance rule would read wrongly", () => {
    const unbalancedDocuments = keptWithLinks.filter((document) => {
      const masked = maskLikeExtraction(document)
      return referenceMarkdownLinks(document).some(({ start, end }) => {
        return endsAtWhitespaceUnbalanced(masked.slice(start, end))
      })
    })
    expect(unbalancedDocuments.length).toBeGreaterThanOrEqual(100)
  })

  it("extracts the oracle's targets from every kept token document", () => {
    const disagreements = keptDocuments.flatMap((document) => {
      const extracted = sortedUnique(links.extractFromBody(document))
      const oracle = sortedUnique(referenceMarkdownLinks(document).map(({ target }) => target))
      return JSON.stringify(extracted) === JSON.stringify(oracle)
        ? []
        : [{ document, extracted, oracle }]
    })
    expect(disagreements).toEqual([])
  })

  it("matches the oracle's span for every link in every kept token document", () => {
    const disagreements = keptDocuments.flatMap((document) => {
      const masked = maskLikeExtraction(document)
      const matched = links
        .matchLinksInLine(masked)
        .filter((linkMatch) => linkMatch.kind === "markdown")
        .map(({ start, end }) => ({ start, end }))
      const oracle = referenceMarkdownLinks(document).map(({ start, end }) => ({ start, end }))
      return JSON.stringify(matched) === JSON.stringify(oracle)
        ? []
        : [{ document, matched, oracle }]
    })
    expect(disagreements).toEqual([])
  })
})

// ── extractFromFrontmatter ───────────────────────────────────────

describe("extractFromFrontmatter", () => {
  it("extracts a wikilink from a string property value", () => {
    expect(links.extractFromFrontmatter({ up: "[[Parent Note]]" })).toEqual(["Parent Note"])
  })

  it("extracts wikilinks from an array property (e.g. related)", () => {
    expect(links.extractFromFrontmatter({ related: ["[[Note A]]", "[[Note B]]"] })).toEqual([
      "Note A",
      "Note B",
    ])
  })

  it("strips alias and heading from a frontmatter wikilink", () => {
    expect(links.extractFromFrontmatter({ related: ["[[Note A#Section|display]]"] })).toEqual([
      "Note A",
    ])
  })

  it("extracts a wikilink embedded in surrounding text", () => {
    expect(links.extractFromFrontmatter({ note: "see [[Note A]] for context" })).toEqual(["Note A"])
  })

  it("walks nested object property values", () => {
    expect(links.extractFromFrontmatter({ meta: { parent: "[[Note A]]" } })).toEqual(["Note A"])
  })

  it("returns empty for plain-string values with no wikilinks", () => {
    expect(links.extractFromFrontmatter({ related: ["Routines", "Career"] })).toEqual([])
  })

  it("ignores non-string scalar values", () => {
    expect(links.extractFromFrontmatter({ count: 3, draft: true, missing: null })).toEqual([])
  })

  it("deduplicates a target repeated across properties", () => {
    expect(
      links.extractFromFrontmatter({
        up: "[[Note A]]",
        related: ["[[Note A]]"],
      }),
    ).toEqual(["Note A"])
  })

  it("strips the escaped pipe backslash from frontmatter wikilinks", () => {
    expect(
      links.extractFromFrontmatter({
        related: ["[[sessions/log-a\\|log-a]]"],
      }),
    ).toEqual(["sessions/log-a"])
  })

  it("extracts wikilinks to non-markdown assets in frontmatter", () => {
    expect(
      links.extractFromFrontmatter({
        related: ["[[diagram.png]]", "[[Note A]]"],
      }),
    ).toEqual(["diagram.png", "Note A"])
  })
})

// ── resolve ──────────────────────────────────────────────────────

describe("resolve", () => {
  const allPaths = [
    "Projects/vault-cortex.md",
    "About Me/Principles.md",
    "notes/random.md",
    "deep/nested/note.md",
    "note.md",
  ]

  it("resolves exact path match", () => {
    expect(links.resolve({ target: "Projects/vault-cortex", allPaths })).toBe(
      "Projects/vault-cortex.md",
    )
  })

  it("resolves exact path with .md extension", () => {
    expect(links.resolve({ target: "Projects/vault-cortex.md", allPaths })).toBe(
      "Projects/vault-cortex.md",
    )
  })

  it("resolves basename match", () => {
    expect(links.resolve({ target: "Principles", allPaths })).toBe("About Me/Principles.md")
  })

  it("resolves to shortest path when multiple basename matches exist", () => {
    expect(links.resolve({ target: "note", allPaths })).toBe("note.md")
  })

  it("breaks an equal-length basename tie lexicographically, not by input order", () => {
    // zzz/Note.md first in the list — without the tie-break, input order
    // (an unordered SQL scan at the call sites) would decide the winner.
    const equalLengthPaths = ["zzz/Note.md", "aaa/Note.md"]
    expect(links.resolve({ target: "Note", allPaths: equalLengthPaths })).toBe("aaa/Note.md")
  })

  it("measures shortest by code points, so a non-BMP character counts as one", () => {
    // "📚/a.md" is 6 code points but 7 UTF-16 units — under a String.length
    // metric it ties with "ab/a.md" and loses the tie.
    const paths = ["ab/a.md", "📚/a.md"]
    expect(links.resolve({ target: "a", allPaths: paths })).toBe("📚/a.md")
  })

  it("breaks equal-length ties in UTF-8 byte order, not UTF-16 order", () => {
    // Both paths hold the same two characters in opposite order, so both
    // length metrics tie. UTF-16 code units put the emoji (surrogates,
    // 0xD83D…) before U+FFFD, but UTF-8 bytes put U+FFFD (0xEF…) before
    // the emoji (0xF0…).
    const paths = ["😀�/a.md", "�😀/a.md"]
    expect(links.resolve({ target: "a", allPaths: paths })).toBe("�😀/a.md")
  })

  it("returns null for unresolvable target", () => {
    expect(links.resolve({ target: "NonExistent", allPaths })).toBeNull()
  })

  it("resolves an upward relative path against the source note's directory", () => {
    const paths = ["A/C/target.md", "A/B/note.md"]
    expect(
      links.resolve({
        target: "../C/target",
        allPaths: paths,
        sourcePath: "A/B/note.md",
      }),
    ).toBe("A/C/target.md")
  })

  it("resolves a descending relative path to the source's own subfolder over a shorter same-named path elsewhere", () => {
    // "X/sub/target.md" is the shorter basename/suffix match, but the link is
    // relative to Areas/note.md, so it must resolve into Areas/sub/.
    const paths = ["Areas/sub/target.md", "X/sub/target.md", "Areas/note.md"]
    expect(
      links.resolve({
        target: "sub/target",
        allPaths: paths,
        sourcePath: "Areas/note.md",
      }),
    ).toBe("Areas/sub/target.md")
  })

  it("prefers an exact vault-absolute path over a relative-to-source match", () => {
    const paths = ["Projects/other.md", "A/B/Projects/other.md", "A/B/note.md"]
    expect(
      links.resolve({
        target: "Projects/other",
        allPaths: paths,
        sourcePath: "A/B/note.md",
      }),
    ).toBe("Projects/other.md")
  })

  it("cannot resolve an upward relative path without a source note", () => {
    expect(links.resolve({ target: "../C/target", allPaths: ["A/C/target.md"] })).toBeNull()
  })

  it("does not let an upward ../ path escape to a same-named vault-root note", () => {
    // "secret.md" exists at the vault root, but "../secret" from a root note
    // points above the vault — it must stay unresolved, not collapse onto it.
    expect(
      links.resolve({
        target: "../secret",
        allPaths: ["secret.md"],
        sourcePath: "note.md",
      }),
    ).toBeNull()
  })

  it.each([
    { label: "bare name in another case", target: "real" },
    { label: "folder path in another case", target: "folder/real" },
    { label: "folder path in the stored case", target: "Folder/Real" },
    { label: "name in upper case", target: "REAL" },
  ])("resolves a $label to the stored note path", ({ target }) => {
    expect(links.resolve({ target, allPaths: ["Folder/Real.md", "Other/Note.md"] })).toBe(
      "Folder/Real.md",
    )
  })

  it("resolves a link after its note's case-only rename to the new spelling", () => {
    expect(links.resolve({ target: "note", allPaths: ["Note.md", "Other/Real.md"] })).toBe(
      "Note.md",
    )
  })

  it("resolves a relative path in another letter case against the source note's folder", () => {
    expect(
      links.resolve({
        target: "../c/TARGET",
        allPaths: ["A/C/target.md", "A/B/note.md"],
        sourcePath: "A/B/note.md",
      }),
    ).toBe("A/C/target.md")
  })

  it("keeps a relative match in the link's own case over an exact path that matches only with case folded", () => {
    expect(
      links.resolve({
        target: "a",
        allPaths: ["A.md", "sub/a.md", "sub/src.md"],
        sourcePath: "sub/src.md",
      }),
    ).toBe("sub/a.md")
  })

  it("keeps a basename match in the link's own case over a shorter path that matches only with case folded", () => {
    expect(links.resolve({ target: "note", allPaths: ["Note.md", "deep/note.md"] })).toBe(
      "deep/note.md",
    )
  })

  it("resolves each spelling of two notes that differ only in case to its own note", () => {
    const allPaths = ["Real.md", "real.md"]

    expect(links.resolve({ target: "Real", allPaths })).toBe("Real.md")
    expect(links.resolve({ target: "real", allPaths })).toBe("real.md")
  })

  it("breaks a tie between two notes that differ only in case in byte order for a third spelling", () => {
    expect(links.resolve({ target: "REAL", allPaths: ["real.md", "Real.md"] })).toBe("Real.md")
  })

  it("folds non-ASCII letters in note links", () => {
    expect(links.resolve({ target: "éclair", allPaths: ["Recipes/Éclair.md"] })).toBe(
      "Recipes/Éclair.md",
    )
  })

  it("leaves a link unresolved when no note matches even with case folded", () => {
    expect(links.resolve({ target: "missing", allPaths: ["Folder/Real.md"] })).toBeNull()
  })

  it("folds a second path list of the same length afresh after resolving against a first", () => {
    expect(links.resolve({ target: "real", allPaths: ["Folder/Real.md"] })).toBe("Folder/Real.md")
    expect(links.resolve({ target: "real", allPaths: ["Others/Real.md"] })).toBe("Others/Real.md")
  })
})

// ── resolveInExactCase ───────────────────────────────────────────

describe("resolveInExactCase", () => {
  it("leaves a link unresolved when it reaches a note only with case folded", () => {
    const allPaths = ["Folder/Real.md", "Other/Note.md"]

    // The folded resolver reaches the note, so the miss comes from letter case.
    expect(links.resolve({ target: "real", allPaths })).toBe("Folder/Real.md")
    expect(links.resolveInExactCase({ target: "real", allPaths })).toBeNull()
  })

  it("resolves a link in its own letter case through the source-relative tier", () => {
    expect(
      links.resolveInExactCase({
        target: "../C/target",
        allPaths: ["A/C/target.md", "A/B/note.md", "C/target.md"],
        sourcePath: "A/B/note.md",
      }),
    ).toBe("A/C/target.md")
  })

  it("picks the exact-case note over a shorter note that differs only in letter case", () => {
    expect(
      links.resolveInExactCase({ target: "real", allPaths: ["Real.md", "deep/real.md"] }),
    ).toBe("deep/real.md")
  })
})

// ── stripExtension ───────────────────────────────────────────────

describe("stripExtension", () => {
  it("strips the extension after the last dot in the filename", () => {
    expect(links.stripExtension("boards/Trip Route.canvas")).toBe("boards/Trip Route")
  })

  it("keeps the inner dots of a multi-dot filename", () => {
    expect(links.stripExtension("assets/photo.png.canvas")).toBe("assets/photo.png")
  })

  it("returns the path unchanged when the filename has no dot", () => {
    expect(links.stripExtension("assets/LICENSE")).toBe("assets/LICENSE")
  })

  it("treats a leading-dot file as having no extension", () => {
    expect(links.stripExtension("config/.hidden")).toBe("config/.hidden")
  })

  it("ignores dots in folder names", () => {
    expect(links.stripExtension("v1.2/note")).toBe("v1.2/note")
  })
})

// ── pathToLinkName ───────────────────────────────────────────────

describe("pathToLinkName", () => {
  it("gives a link's text and its note's path one key", () => {
    expect([links.pathToLinkName("../Projects/Plan"), links.pathToLinkName("Plan.md")]).toEqual([
      "plan",
      "plan",
    ])
  })

  it("gives a capital Greek name with and without .md one key", () => {
    expect([links.pathToLinkName("ΟΔΟΣ"), links.pathToLinkName("ΟΔΟΣ.md")]).toEqual([
      "οδοσ",
      "οδοσ",
    ])
  })

  it("gives a name ending in a capital sigma and its lowercase spelling one key", () => {
    expect([links.pathToLinkName("ΟΔΟΣ"), links.pathToLinkName("οδοσ")]).toEqual(["οδοσ", "οδοσ"])
  })

  it("keeps an uppercase .MD, which resolve does not treat as the note extension", () => {
    expect(links.pathToLinkName("B.MD")).toBe("b.md")
  })

  it("strips only one trailing .md", () => {
    expect(links.pathToLinkName("folder/Notes.md.md")).toBe("notes.md")
  })

  it("keeps a non-note file's extension", () => {
    expect(links.pathToLinkName("assets/Photo.PNG")).toBe("photo.png")
  })
})

// ── resolveAsset ─────────────────────────────────────────────────

describe("resolveAsset", () => {
  const allAssetPaths = [
    "assets/photo.png",
    "boards/Trip Route.canvas",
    "deep/nested/assets/photo.png",
    "app/views/Inventory.base",
  ]

  it("folds ASCII case in the path-suffix tier's first pass", () => {
    expect(
      links.resolveAsset({
        target: "sunset.png",
        allAssetPaths: ["photos/Sunset.png"],
      }),
    ).toBe("photos/Sunset.png")
  })

  it("folds ASCII case in the folder-qualified stem tier's first pass", () => {
    expect(
      links.resolveAsset({
        target: "views/Inventory",
        allAssetPaths: ["app/Views/Inventory.base"],
      }),
    ).toBe("app/Views/Inventory.base")
  })

  it("resolves a full path in another letter case through the folded exact tier", () => {
    // The suffix tier's leading "/" can never match a path from the vault
    // root, so only the folded exact tier can resolve this link.
    expect(
      links.resolveAsset({
        target: "photos/sunset.png",
        allAssetPaths: ["photos/Sunset.png", "other/sunset.png"],
      }),
    ).toBe("photos/Sunset.png")
  })

  it("resolves a relative path in another letter case through the folded relative tier", () => {
    expect(
      links.resolveAsset({
        target: "../Assets/Photo.png",
        allAssetPaths: ["assets/photo.png", "Notes/assets/photo.png"],
        sourcePath: "Notes/N.md",
      }),
    ).toBe("assets/photo.png")
  })

  it("resolves an extensionless path in another letter case through the folded stem tier", () => {
    expect(
      links.resolveAsset({
        target: "Boards/trip route",
        allAssetPaths: ["boards/Trip Route.canvas", "boards/Trip Route Notes.canvas"],
      }),
    ).toBe("boards/Trip Route.canvas")
  })

  it("resolves an extensionless relative path in another letter case through the folded relative stem tier", () => {
    expect(
      links.resolveAsset({
        target: "../Boards/trip route",
        allAssetPaths: ["boards/Trip Route.canvas", "Notes/boards/Trip Route.canvas"],
        sourcePath: "Notes/N.md",
      }),
    ).toBe("boards/Trip Route.canvas")
  })

  it("resolves a bare name in another letter case through the folded basename stem tier", () => {
    expect(
      links.resolveAsset({
        target: "trip route",
        allAssetPaths: ["boards/Trip Route.canvas", "boards/Trip.canvas"],
      }),
    ).toBe("boards/Trip Route.canvas")
  })

  it("keeps an exact-case asset match over a shorter path that matches only with case folded", () => {
    expect(
      links.resolveAsset({
        target: "photos/sunset.png",
        allAssetPaths: ["Photos/Sunset.png", "more/photos/sunset.png"],
      }),
    ).toBe("more/photos/sunset.png")
  })

  it("folds a second path list of the same length afresh after resolving against a first", () => {
    const target = "photos/sunset.png"

    expect(links.resolveAsset({ target, allAssetPaths: ["Photos/Sunset.png"] })).toBe(
      "Photos/Sunset.png",
    )
    expect(links.resolveAsset({ target, allAssetPaths: ["PHOTOS/sunset.png"] })).toBe(
      "PHOTOS/sunset.png",
    )
  })

  it("breaks a tie between two assets that differ only in case in byte order for a third spelling", () => {
    expect(
      links.resolveAsset({
        target: "PHOTO.png",
        allAssetPaths: ["photo.png", "Photo.png"],
      }),
    ).toBe("Photo.png")
  })

  it("folds only ASCII letters in asset links", () => {
    expect(
      links.resolveAsset({
        target: "éclair.png",
        allAssetPaths: ["Éclair.png"],
      }),
    ).toBeNull()
  })

  it("resolves an exact path with extension", () => {
    expect(links.resolveAsset({ target: "assets/photo.png", allAssetPaths })).toBe(
      "assets/photo.png",
    )
  })

  it("resolves a path relative to the source note's directory", () => {
    expect(
      links.resolveAsset({
        target: "../assets/photo.png",
        allAssetPaths,
        sourcePath: "Notes/Note.md",
      }),
    ).toBe("assets/photo.png")
  })

  it("resolves a full-filename suffix to the shortest match", () => {
    expect(links.resolveAsset({ target: "photo.png", allAssetPaths })).toBe("assets/photo.png")
  })

  it("prefers the full-filename match over a stem match (family ordering)", () => {
    // "photo.png" stem-matches "b/photo.png.canvas", but the full-filename
    // family runs first and wins with "a/photo.png".
    const paths = ["b/photo.png.canvas", "a/photo.png"]
    expect(links.resolveAsset({ target: "photo.png", allAssetPaths: paths })).toBe("a/photo.png")
  })

  it("resolves an extensionless target by exact stem", () => {
    expect(links.resolveAsset({ target: "boards/Trip Route", allAssetPaths })).toBe(
      "boards/Trip Route.canvas",
    )
  })

  it("resolves an extensionless target relative to the source by stem", () => {
    expect(
      links.resolveAsset({
        target: "../boards/Trip Route",
        allAssetPaths,
        sourcePath: "Notes/N.md",
      }),
    ).toBe("boards/Trip Route.canvas")
  })

  it("resolves a bare-name stem to the shortest basename match", () => {
    const paths = ["deep/nested/photo.png", "a/photo.png"]
    expect(links.resolveAsset({ target: "photo", allAssetPaths: paths })).toBe("a/photo.png")
  })

  it("resolves a stem with folder segments as a suffix match", () => {
    expect(links.resolveAsset({ target: "views/Inventory", allAssetPaths })).toBe(
      "app/views/Inventory.base",
    )
  })

  it("resolves a multi-dot stem when no full-filename match exists", () => {
    expect(
      links.resolveAsset({
        target: "photo.png",
        allAssetPaths: ["assets/photo.png.canvas"],
      }),
    ).toBe("assets/photo.png.canvas")
  })

  it("breaks same-length stem ties lexicographically", () => {
    // Shortest first, then byte order, so the winner does not depend on the
    // array's order.
    const paths = ["a/photo.png", "a/photo.jpg"]
    expect(links.resolveAsset({ target: "photo", allAssetPaths: paths })).toBe("a/photo.jpg")
  })

  it("returns null when nothing matches", () => {
    expect(links.resolveAsset({ target: "missing.png", allAssetPaths })).toBeNull()
  })

  it("cannot resolve a relative target without a source path", () => {
    expect(links.resolveAsset({ target: "../assets/photo.png", allAssetPaths })).toBeNull()
  })
})

// ── resolveNoteOrAsset ───────────────────────────────────────────

describe("resolveNoteOrAsset", () => {
  const allAssetPaths = ["Trip Route.canvas", "assets/photo.png"]

  it("resolves to the note when a note and a file share the link's name", () => {
    expect(
      links.resolveNoteOrAsset({
        target: "Trip Route",
        allPaths: ["Trip Route.md"],
        allAssetPaths,
      }),
    ).toEqual({ kind: "note", path: "Trip Route.md" })
  })

  it("resolves to the file when no note matches", () => {
    expect(
      links.resolveNoteOrAsset({ target: "Trip Route", allPaths: ["Other.md"], allAssetPaths }),
    ).toEqual({ kind: "asset", path: "Trip Route.canvas" })
  })

  it("returns null when neither a note nor a file matches", () => {
    expect(
      links.resolveNoteOrAsset({ target: "missing", allPaths: ["Other.md"], allAssetPaths }),
    ).toBeNull()
  })

  it("resolves a relative link from the source note's folder in both tiers", () => {
    const resolveFromSubfolder = (target: string): ReturnType<typeof links.resolveNoteOrAsset> => {
      return links.resolveNoteOrAsset({
        target,
        allPaths: ["x.md"],
        allAssetPaths,
        sourcePath: "a/note.md",
      })
    }

    expect(resolveFromSubfolder("../x")).toEqual({ kind: "note", path: "x.md" })
    expect(resolveFromSubfolder("../assets/photo.png")).toEqual({
      kind: "asset",
      path: "assets/photo.png",
    })
  })
})

// ── Resolver oracle ──────────────────────────────────────────────

/** Mulberry32, a small seeded generator, so every run draws the same corpus. */
const createSeededRandom = (seed: number): (() => number) => {
  // The generator's state, advanced on every draw.
  let state = seed

  return () => {
    state = (state + 0x6d2b79f5) | 0
    const mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    const remixed = mixed ^ (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed))
    return ((remixed ^ (remixed >>> 14)) >>> 0) / 4294967296
  }
}

/** A small pool, so paths that differ only in letter case or depth, and
 *  targets that hit them, come up often. The emoji is one code point but two
 *  UTF-16 units, so a resolver that measured paths in UTF-16 units would pick
 *  a different shortest path. */
const SEGMENT_TOKENS = [
  "a",
  "A",
  "b",
  "É",
  "é",
  "ß",
  "SS",
  "ss",
  "x.y",
  "sub dir",
  "Photo",
  "photo",
  "😀",
]
const TARGET_ONLY_TOKENS = ["..", ".", ""]
const ASSET_EXTENSIONS = [".png", ".PNG", ".gif", ".canvas", ".md.png", ""]

const createCorpus = (seed: number) => {
  const random = createSeededRandom(seed)
  const pick = <Item>(items: readonly Item[]): Item => {
    const pickedItem = items[Math.floor(random() * items.length)]

    if (pickedItem === undefined) throw new Error("picked from an empty list")
    return pickedItem
  }
  const drawSegments = (tokens: readonly string[]): string[] => {
    return Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(tokens))
  }

  const notePaths = [
    ...new Set(Array.from({ length: 300 }, () => `${drawSegments(SEGMENT_TOKENS).join("/")}.md`)),
  ]
  const assetPaths = [
    ...new Set(
      Array.from({ length: 300 }, () => {
        return `${drawSegments(SEGMENT_TOKENS).join("/")}${pick(ASSET_EXTENSIONS)}`
      }),
    ),
  ]
  const targetTokens = [...SEGMENT_TOKENS, ...TARGET_ONLY_TOKENS]
  const sources: ReadonlyArray<{ sourcePath?: string }> = [
    {},
    { sourcePath: "note.md" },
    { sourcePath: "a/note.md" },
    { sourcePath: "A/b/note.md" },
    { sourcePath: "sub dir/x.y/note.md" },
  ]
  const lookups = Array.from({ length: 10_000 }, () => {
    const extension = random() < 0.5 ? pick(ASSET_EXTENSIONS) : pick(["", ".md", ".MD"])
    return { target: `${drawSegments(targetTokens).join("/")}${extension}`, ...pick(sources) }
  })
  return { notePaths, assetPaths, lookups }
}

/** The comparison takes about 2 s on an idle laptop and several times that
 *  while the full suite runs, which can exceed vitest's 5 s default. */
const ORACLE_TEST_TIMEOUT_MS = 30_000

describe("resolver oracle", () => {
  it(
    "resolve, resolveInExactCase and resolveAsset match the scanning resolvers on 10,000 seeded targets",
    () => {
      const { notePaths, assetPaths, lookups } = createCorpus(20261126)

      const disagreements = lookups.flatMap((lookup) => {
        const answers = {
          resolve: [
            links.resolve({ ...lookup, allPaths: notePaths }),
            linkResolverOracle.resolve({ ...lookup, allPaths: notePaths }),
          ],
          resolveInExactCase: [
            links.resolveInExactCase({ ...lookup, allPaths: notePaths }),
            linkResolverOracle.resolveInExactCase({ ...lookup, allPaths: notePaths }),
          ],
          resolveAsset: [
            links.resolveAsset({ ...lookup, allAssetPaths: assetPaths }),
            linkResolverOracle.resolveAsset({ ...lookup, allAssetPaths: assetPaths }),
          ],
        }
        return Object.entries(answers)
          .filter(([, [answer, oracleAnswer]]) => answer !== oracleAnswer)
          .map(([resolver, [answer, oracleAnswer]]) => {
            return { resolver, ...lookup, answer, oracleAnswer }
          })
      })

      expect(disagreements).toEqual([])
    },
    ORACLE_TEST_TIMEOUT_MS,
  )

  it("the seeded corpus resolves 1,000 to 9,000 of its targets in both note and asset modes", () => {
    const { notePaths, assetPaths, lookups } = createCorpus(20261126)

    const resolvedNoteCount = lookups.filter((lookup) => {
      return links.resolve({ ...lookup, allPaths: notePaths }) !== null
    }).length
    const resolvedAssetCount = lookups.filter((lookup) => {
      return links.resolveAsset({ ...lookup, allAssetPaths: assetPaths }) !== null
    }).length

    // Both resolved and unresolved targets are common, so the comparison
    // above checks hits and misses alike.
    expect(resolvedNoteCount).toBeGreaterThan(1_000)
    expect(resolvedNoteCount).toBeLessThan(9_000)
    expect(resolvedAssetCount).toBeGreaterThan(1_000)
    expect(resolvedAssetCount).toBeLessThan(9_000)
  })

  it.each([
    {
      label: "a full-name suffix skips a path equal to the target in another letter case",
      target: "photo.png",
      allAssetPaths: ["Photo.PNG", "a/photo.png"],
      expected: "a/photo.png",
    },
    {
      label: "a full-name suffix skips a shorter path equal to the target",
      target: "photo.png",
      allAssetPaths: ["Photo.png", "x/photo.png"],
      expected: "x/photo.png",
    },
    {
      label: "a stem suffix skips a path whose stem equals the target",
      target: "a/photo",
      allAssetPaths: ["A/Photo.png", "z/a/photo.gif"],
      expected: "z/a/photo.gif",
    },
  ])(
    "resolveAsset: $label, as the scanning resolver does",
    ({ target, allAssetPaths, expected }) => {
      expect(links.resolveAsset({ target, allAssetPaths })).toBe(expected)
      expect(linkResolverOracle.resolveAsset({ target, allAssetPaths })).toBe(expected)
    },
  )
})

// ── Resolution cost ──────────────────────────────────────────────

/** The helper's path list grows eightfold, so a resolver that scans the list
 *  grows about 8x and one that reads a lookup stays about flat. Four sits
 *  between the two with room for scheduling noise. */
const LOOKUP_GROWTH_LIMIT = 4

describe("resolution cost against the path list", () => {
  it.each([
    { label: "unresolved note targets", variant: "notes" },
    {
      label: "folder-qualified targets naming notes that all share one name",
      variant: "same-name",
    },
    { label: "unresolved file targets", variant: "files" },
  ])(
    "resolves 2,000 $label against eight times the paths in about the same time",
    ({ variant }) => {
      const helperPath = new URL("./helpers/link-resolution-growth.ts", import.meta.url)
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", helperPath.pathname, variant],
        { encoding: "utf8", timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" },
      )
      const { measurements } = JSON.parse(output)
      const [small, large] = measurements

      type Measurement = { pathCount: number; resolvedCount: number }

      expect(
        measurements.map(({ pathCount, resolvedCount }: Measurement) => {
          return { pathCount, resolvedCount }
        }),
      ).toEqual([
        { pathCount: 1_000, resolvedCount: 0 },
        { pathCount: 8_000, resolvedCount: 0 },
      ])
      expect(large.leastMs).toBeLessThanOrEqual(
        Math.max(TIMING_FLOOR_MS, small.leastMs) * LOOKUP_GROWTH_LIMIT,
      )
    },
    CHILD_TEST_TIMEOUT_MS,
  )
})

// ── Link-target limits ───────────────────────────────────────────

/** A target of exactly `bytes` bytes with a ".." after a name. */
const interleavedTarget = (bytes: number): string => {
  const body = `x${"/b/..".repeat(800)}/`
  return `${body}${"y".repeat(bytes - body.length)}`
}

/** A target of exactly `bytes` bytes whose ".." segments all lead. */
const leadingParentTarget = (bytes: number): string => {
  const parents = "../".repeat(2000)
  return `${parents}${"y".repeat(bytes - parents.length)}`
}

describe("link-target limits", () => {
  // A note 700 folders deep linking 1,050 folders down: a link Obsidian writes
  // from the current file, 4,204 bytes long.
  const deepSource = `${"s/".repeat(700)}source.md`
  const deepRelativeLink = `${"../".repeat(700)}${"a/".repeat(1050)}real`

  it("extracts a 4,095-byte target of any shape and skips a 4,096-byte one with a '..' after a name", () => {
    const kept = interleavedTarget(4095)

    expect(links.extractFromBody(`[[${kept}]] [[${interleavedTarget(4096)}]]`)).toEqual([kept])
  })

  it("extracts a 10,236-byte target whose '..' segments all lead and skips a 10,237-byte one", () => {
    const kept = leadingParentTarget(10_236)

    expect(links.extractFromBody(`[[${kept}]]\n[[${leadingParentTarget(10_237)}]]`)).toEqual([kept])
  })

  it("ignores '.' and empty segments when checking that a target's '..' segments all lead", () => {
    const kept = `.//${leadingParentTarget(8000)}`

    expect(links.extractFromBody(`[[${kept}]] [[${interleavedTarget(4096)}]]`)).toEqual([kept])
  })

  it("measures a target in UTF-8 bytes, so 2,052 UTF-16 units of 4,096 bytes are skipped", () => {
    const multiByteTarget = `xx/b/../${"é".repeat(2044)}`

    expect(multiByteTarget.length).toBe(2052)
    expect(Buffer.byteLength(multiByteTarget)).toBe(4096)
    expect(links.extractFromBody(`[[${multiByteTarget}]] [[kept]]`)).toEqual(["kept"])
  })

  it("measures a markdown link target after percent-decoding it", () => {
    const encodedTarget = `${"%41".repeat(1400)}/b/../x.md`

    expect(
      links.extractFromBody(`[a](${encodedTarget}) [b](${interleavedTarget(4096)}.md)`),
    ).toEqual([`${"A".repeat(1400)}/b/../x.md`])
  })

  it("skips a frontmatter wikilink over the limit", () => {
    const kept = interleavedTarget(4095)

    expect(
      links.extractFromFrontmatter({ related: [`[[${interleavedTarget(4096)}]]`, `[[${kept}]]`] }),
    ).toEqual([kept])
  })

  it("resolve finds a 4,204-byte link from a note 700 folders deep", () => {
    const deepNote = `${"a/".repeat(1050)}real.md`

    expect(Buffer.byteLength(deepRelativeLink)).toBe(4204)
    expect(
      links.resolve({ target: deepRelativeLink, allPaths: [deepNote], sourcePath: deepSource }),
    ).toBe(deepNote)
  })

  it("resolveInExactCase finds a 4,204-byte link from a note 700 folders deep", () => {
    const deepNote = `${"a/".repeat(1050)}real.md`

    expect(
      links.resolveInExactCase({
        target: deepRelativeLink,
        allPaths: [deepNote],
        sourcePath: deepSource,
      }),
    ).toBe(deepNote)
  })

  it("resolveAsset finds a 4,208-byte link to a file from a note 700 folders deep", () => {
    const deepFile = `${"a/".repeat(1050)}real.png`

    expect(
      links.resolveAsset({
        target: `${deepRelativeLink}.png`,
        allAssetPaths: [deepFile],
        sourcePath: deepSource,
      }),
    ).toBe(deepFile)
  })

  it("resolve finds no note for a 4,096-byte target with a '..' after a name, even at its exact path", () => {
    const allPaths = [`${interleavedTarget(4095)}.md`, `${interleavedTarget(4096)}.md`]

    expect(links.resolve({ target: interleavedTarget(4095), allPaths })).toBe(allPaths[0])
    expect(links.resolve({ target: interleavedTarget(4096), allPaths })).toBeNull()
  })

  it("resolveInExactCase finds no note for a 4,096-byte target with a '..' after a name, even at its exact path", () => {
    const allPaths = [`${interleavedTarget(4095)}.md`, `${interleavedTarget(4096)}.md`]

    expect(links.resolveInExactCase({ target: interleavedTarget(4095), allPaths })).toBe(
      allPaths[0],
    )
    expect(links.resolveInExactCase({ target: interleavedTarget(4096), allPaths })).toBeNull()
  })

  it("resolveAsset finds no file for a 4,096-byte target with a '..' after a name, even at its exact path", () => {
    const allAssetPaths = [interleavedTarget(4095), interleavedTarget(4096)]

    expect(links.resolveAsset({ target: interleavedTarget(4095), allAssetPaths })).toBe(
      allAssetPaths[0],
    )
    expect(links.resolveAsset({ target: interleavedTarget(4096), allAssetPaths })).toBeNull()
  })

  it("draws the any-shape limit where the tool path guard does, so the two path limits stay equal", () => {
    const fitsPathGuard = (path: string): boolean => {
      try {
        assertPathWithinMaxLength(path)
        return true
      } catch (error) {
        if (error instanceof PathTooLongError) return false
        throw error
      }
    }
    const boundaryTargets = [interleavedTarget(4095), interleavedTarget(4096)]

    expect(boundaryTargets.map(fitsPathGuard)).toEqual([true, false])
    expect(boundaryTargets.map(links.isWithinLinkTargetLimit)).toEqual([true, false])
  })

  it("resolve skips the join for a target that climbs above the vault root from a note at the root", () => {
    const joinSpy = vi.spyOn(posix, "join")
    onTestFinished(() => joinSpy.mockRestore())

    expect(links.resolve({ target: "../x", allPaths: ["x.md"], sourcePath: "note.md" })).toBeNull()
    expect(joinSpy).not.toHaveBeenCalled()
  })

  it("resolve joins a target with a '..' after a name from a note at the vault root", () => {
    const joinSpy = vi.spyOn(posix, "join")
    onTestFinished(() => joinSpy.mockRestore())

    expect(links.resolve({ target: "x/../y", allPaths: ["y.md"], sourcePath: "note.md" })).toBe(
      "y.md",
    )
    expect(joinSpy).toHaveBeenCalledTimes(1)
    expect(joinSpy).toHaveBeenCalledWith(".", "x/../y.md")
  })

  it("resolve skips the join for a target that climbs above the vault root", () => {
    const joinSpy = vi.spyOn(posix, "join")
    onTestFinished(() => joinSpy.mockRestore())

    expect(
      links.resolve({ target: ".././/../x", allPaths: ["x.md"], sourcePath: "a/note.md" }),
    ).toBeNull()
    expect(joinSpy).not.toHaveBeenCalled()
  })

  it("resolve joins a target that climbs exactly to the vault root", () => {
    const joinSpy = vi.spyOn(posix, "join")
    onTestFinished(() => joinSpy.mockRestore())

    expect(links.resolve({ target: "./../x", allPaths: ["x.md"], sourcePath: "a/note.md" })).toBe(
      "x.md",
    )
    expect(joinSpy).toHaveBeenCalledTimes(1)
    expect(joinSpy).toHaveBeenCalledWith("a", "./../x.md")
  })

  it("resolveAsset skips the join for a target that climbs above the vault root", () => {
    const joinSpy = vi.spyOn(posix, "join")
    onTestFinished(() => joinSpy.mockRestore())

    expect(
      links.resolveAsset({
        target: ".././/../x.png",
        allAssetPaths: ["x.png"],
        sourcePath: "a/note.md",
      }),
    ).toBeNull()
    expect(joinSpy).not.toHaveBeenCalled()
  })

  it("resolveAsset joins a target that climbs exactly to the vault root", () => {
    const joinSpy = vi.spyOn(posix, "join")
    onTestFinished(() => joinSpy.mockRestore())

    expect(
      links.resolveAsset({
        target: ".././/../x.png",
        allAssetPaths: ["x.png"],
        sourcePath: "a/b/note.md",
      }),
    ).toBe("x.png")
    expect(joinSpy).toHaveBeenCalledTimes(1)
    expect(joinSpy).toHaveBeenCalledWith("a/b", ".././/../x.png")
  })

  it(
    "skips 2,000 targets over the link-target limit in time linear in their count, keeping a short one",
    () => {
      const helperPath = new URL("./helpers/link-target-growth.ts", import.meta.url)
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", helperPath.pathname, "extract"],
        { encoding: "utf8", timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" },
      )
      const { measurements } = JSON.parse(output)
      const [small, large] = measurements

      expect(
        measurements.map(({ count, kept }: { count: number; kept: string[] }) => ({ count, kept })),
      ).toEqual([
        { count: 250, kept: ["kept.md"] },
        { count: 2_000, kept: ["kept.md"] },
      ])
      expect(large.leastMs).toBeLessThanOrEqual(
        Math.max(TIMING_FLOOR_MS, small.leastMs) * 8 * LINEAR_GROWTH_ALLOWANCE,
      )
    },
    CHILD_TEST_TIMEOUT_MS,
  )
})

// ── Destination encoder round trip ───────────────────────────────

/** Characters the destination encoder treats specially, between plain ones.
 *  `#`, `:` and a no-break space are left out, and so is whitespace at a
 *  name's edges: encodeMarkdownDestination's docstring lists them as having
 *  no spelling. */
const NAME_CHARACTERS = [
  "a",
  "B",
  "1",
  " ",
  "\t",
  "_",
  "~",
  "=",
  "&",
  '"',
  "'",
  "(",
  ")",
  "<",
  ">",
  "%",
  "\\",
  "[",
  "]",
  "*",
  "$",
  "`",
  "!",
  ".",
  "é",
  "😀",
]

/** How many names the round trip draws, enough to reach the neighbour rules
 *  (a `_` before punctuation, a letter after `&`, runs of `~` or `=`) often. */
const ROUND_TRIP_NAME_COUNT = 20_000

const drawName = (random: () => number): string => {
  const length = 1 + Math.floor(random() * 12)
  const characters = Array.from({ length }, () => {
    return NAME_CHARACTERS[Math.floor(random() * NAME_CHARACTERS.length)] ?? "a"
  })
  return `${characters.join("").trim() || "a"}.md`
}

describe("markdown destination encoder round trip", () => {
  it("writes 20,000 seeded names in both destination forms that extractFromBody reads back", () => {
    const random = createSeededRandom(845)
    const names = Array.from({ length: ROUND_TRIP_NAME_COUNT }, () => drawName(random))
    const destinationForms = ["bare", "angle"] as const
    const failures = names.flatMap((name) => {
      return destinationForms.flatMap((destinationForm) => {
        const encoded = links.encodeMarkdownDestination(name, destinationForm)
        // The encoder writes what goes between an angle destination's brackets.
        const written = destinationForm === "angle" ? `[x](<${encoded}>)` : `[x](${encoded})`
        const readBack = links.extractFromBody(written)
        return readBack.length === 1 && readBack[0] === name ? [] : [{ name, written, readBack }]
      })
    })

    expect(failures).toEqual([])
  })
})

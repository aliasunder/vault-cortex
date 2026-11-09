import { describe, it, expect, vi } from "vitest"
import { readParserComplexityReport } from "./helpers/frontmatter-canvas-adversary.js"
import {
  linearizeCanvas,
  extractCanvasFileLinks,
  extractCanvasCardTexts,
  rewriteCanvasLinks,
  canNestCanvasGroups,
} from "../canvas.js"

/** Minimal node factories — geometry defaults keep tests focused on the
 *  fields under test. */
const textNode = (
  overrides: Partial<{
    id: string
    x: number
    y: number
    width: number
    height: number
    text: string
  }>,
): Record<string, unknown> => ({
  id: "text-1",
  type: "text",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  text: "hello",
  ...overrides,
})

const canvasJson = (
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[] = [],
): string => JSON.stringify({ nodes, edges })

describe("linearizeCanvas", () => {
  it("renders ungrouped text, file, and link nodes with their content", () => {
    const json = canvasJson([
      textNode({ id: "a", text: "## Ideas\n- ship it" }),
      {
        id: "b",
        type: "file",
        x: 300,
        y: 0,
        width: 400,
        height: 400,
        file: "Diagrams/arch.png",
      },
      {
        id: "c",
        type: "link",
        x: 0,
        y: 200,
        width: 200,
        height: 100,
        url: "https://example.com",
      },
    ])
    expect(linearizeCanvas(json)).toBe(
      [
        "# Canvas: 3 nodes, 0 edges",
        "[text]\n## Ideas\n- ship it",
        "[file] → Diagrams/arch.png",
        "[link] → https://example.com",
      ].join("\n\n"),
    )
  })

  it("orders nodes top-to-bottom then left-to-right, not by JSON order", () => {
    const json = canvasJson([
      textNode({ id: "bottom", y: 500, text: "third" }),
      textNode({ id: "top-right", x: 300, y: 0, text: "second" }),
      textNode({ id: "top-left", x: 0, y: 0, text: "first" }),
    ])
    expect(linearizeCanvas(json)).toBe(
      ["# Canvas: 3 nodes, 0 edges", "[text]\nfirst", "[text]\nsecond", "[text]\nthird"].join(
        "\n\n",
      ),
    )
  })

  it("assigns a node to its smallest containing group and nests child groups", () => {
    const json = canvasJson([
      {
        id: "outer",
        type: "group",
        label: "Outer",
        x: 0,
        y: 0,
        width: 1000,
        height: 1000,
      },
      {
        id: "inner",
        type: "group",
        label: "Inner",
        x: 10,
        y: 10,
        width: 500,
        height: 500,
      },
      textNode({ id: "member", x: 20, y: 20, text: "in the inner group" }),
    ])
    expect(linearizeCanvas(json)).toBe(
      [
        "# Canvas: 3 nodes, 0 edges",
        "## Group: Outer",
        "### Group: Inner",
        "[text]\nin the inner group",
      ].join("\n\n"),
    )
  })

  it("renders a node overlapping but not contained by a group as ungrouped", () => {
    const json = canvasJson([
      {
        id: "group",
        type: "group",
        label: "Box",
        x: 0,
        y: 0,
        width: 300,
        height: 300,
      },
      // Straddles the group's right edge — overlap without containment.
      textNode({ id: "straddler", x: 250, y: 10, width: 200, text: "outside" }),
    ])
    expect(linearizeCanvas(json)).toBe(
      ["# Canvas: 2 nodes, 0 edges", "[text]\noutside", "## Group: Box"].join("\n\n"),
    )
  })

  it("resolves edge endpoints to display names with the edge label appended", () => {
    const json = canvasJson(
      [
        textNode({ id: "a", text: "## Ideas\n- ship it" }),
        {
          id: "b",
          type: "file",
          x: 300,
          y: 0,
          width: 400,
          height: 400,
          file: "Diagrams/arch.png",
        },
      ],
      [{ id: "e1", fromNode: "a", toNode: "b", label: "references" }],
    )
    expect(linearizeCanvas(json)).toBe(
      [
        "# Canvas: 2 nodes, 1 edge",
        "[text]\n## Ideas\n- ship it",
        "[file] → Diagrams/arch.png",
        "## Connections\n\nIdeas → arch.png (references)",
      ].join("\n\n"),
    )
  })

  it("marks a dangling edge endpoint instead of throwing", () => {
    const json = canvasJson(
      [textNode({ id: "a", text: "alone" })],
      [{ id: "e1", fromNode: "a", toNode: "ghost" }],
    )
    expect(linearizeCanvas(json)).toBe(
      [
        "# Canvas: 1 node, 1 edge",
        "[text]\nalone",
        '## Connections\n\nalone → (missing node "ghost")',
      ].join("\n\n"),
    )
  })

  it("appends a file node's subpath to its path", () => {
    const json = canvasJson([
      {
        id: "f",
        type: "file",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        file: "Notes/Plan.md",
        subpath: "#Goals",
      },
    ])
    expect(linearizeCanvas(json)).toBe(
      ["# Canvas: 1 node, 0 edges", "[file] → Notes/Plan.md#Goals"].join("\n\n"),
    )
  })

  it("skips entries missing required fields and ignores unknown properties", () => {
    const json = canvasJson(
      [
        { id: "no-geometry", type: "text", text: "dropped" },
        textNode({ id: "kept", text: "kept" }),
        {
          ...textNode({ id: "extras", x: 0, y: 200, text: "with extras" }),
          color: "1",
          zIndex: 5,
        },
      ],
      [{ id: "half-edge", fromNode: "kept" }],
    )
    expect(linearizeCanvas(json)).toBe(
      ["# Canvas: 2 nodes, 0 edges", "[text]\nkept", "[text]\nwith extras"].join("\n\n"),
    )
  })

  it("renders both groups when two groups share an identical rectangle", () => {
    // Identical rects contain each other; without a deterministic tiebreak
    // each would claim the other as parent and both would vanish from the
    // output (neither top-level). The higher id must contain the lower.
    const json = canvasJson([
      {
        id: "alpha",
        type: "group",
        label: "Alpha",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
      },
      {
        id: "beta",
        type: "group",
        label: "Beta",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
      },
      textNode({ id: "member", x: 10, y: 10, text: "inside both" }),
    ])
    expect(linearizeCanvas(json)).toBe(
      [
        "# Canvas: 3 nodes, 0 edges",
        "## Group: Beta",
        "### Group: Alpha",
        "[text]\ninside both",
      ].join("\n\n"),
    )
  })

  it("renders the same ownership when the identical-rect groups are declared in reverse order", () => {
    // Ownership must be a property of the canvas content (lower id wins
    // equal-area ties), not of JSON array order.
    const json = canvasJson([
      {
        id: "beta",
        type: "group",
        label: "Beta",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
      },
      {
        id: "alpha",
        type: "group",
        label: "Alpha",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
      },
      textNode({ id: "member", x: 10, y: 10, text: "inside both" }),
    ])
    expect(linearizeCanvas(json)).toBe(
      [
        "# Canvas: 3 nodes, 0 edges",
        "## Group: Beta",
        "### Group: Alpha",
        "[text]\ninside both",
      ].join("\n\n"),
    )
  })

  it("keeps an Obsidian tag's hash in edge display names", () => {
    // Only ATX headings (hashes followed by whitespace) lose their hashes;
    // "#project" is a tag, not a heading.
    const json = canvasJson(
      [
        textNode({ id: "a", text: "#project tracking" }),
        textNode({ id: "b", x: 300, text: "## Roadmap" }),
      ],
      [{ id: "e1", fromNode: "a", toNode: "b" }],
    )
    expect(linearizeCanvas(json)).toBe(
      [
        "# Canvas: 2 nodes, 1 edge",
        "[text]\n#project tracking",
        "[text]\n## Roadmap",
        "## Connections\n\n#project tracking → Roadmap",
      ].join("\n\n"),
    )
  })

  it("renders an empty canvas as the overview line alone", () => {
    expect(linearizeCanvas("{}")).toBe("# Canvas: 0 nodes, 0 edges")
  })

  it("throws on unparseable JSON", () => {
    expect(() => linearizeCanvas("{not json")).toThrow(/^invalid \.canvas JSON: /)
  })
})

describe("extractCanvasFileLinks", () => {
  it("extracts file paths from file-type nodes", () => {
    const json = canvasJson([
      {
        id: "f1",
        type: "file",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        file: "Notes/Plan.md",
      },
      {
        id: "f2",
        type: "file",
        x: 500,
        y: 0,
        width: 400,
        height: 300,
        file: "Diagrams/arch.png",
      },
    ])

    expect(extractCanvasFileLinks(json)).toEqual(["Notes/Plan.md", "Diagrams/arch.png"])
  })

  it("does NOT extract wikilinks from text-type nodes", () => {
    const json = canvasJson([
      textNode({
        id: "t1",
        text: "See [[Projects/Plan]] and [[Ideas/Backlog]]",
      }),
    ])

    expect(extractCanvasFileLinks(json)).toEqual([])
  })

  it("deduplicates file paths", () => {
    const json = canvasJson([
      {
        id: "f1",
        type: "file",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        file: "Notes/Plan.md",
      },
      {
        id: "f2",
        type: "file",
        x: 500,
        y: 0,
        width: 400,
        height: 300,
        file: "Notes/Plan.md",
      },
    ])

    expect(extractCanvasFileLinks(json)).toEqual(["Notes/Plan.md"])
  })

  it("returns empty array for an empty canvas", () => {
    expect(extractCanvasFileLinks("{}")).toEqual([])
  })

  it("returns empty array for a text-only canvas", () => {
    const json = canvasJson([
      textNode({ id: "t1", text: "just text" }),
      textNode({ id: "t2", text: "more text" }),
    ])

    expect(extractCanvasFileLinks(json)).toEqual([])
  })

  it("skips file nodes with missing file field", () => {
    const json = canvasJson([
      {
        id: "f1",
        type: "file",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      },
      {
        id: "f2",
        type: "file",
        x: 500,
        y: 0,
        width: 400,
        height: 300,
        file: "Diagrams/arch.png",
      },
    ])

    expect(extractCanvasFileLinks(json)).toEqual(["Diagrams/arch.png"])
  })

  it("skips entries missing required geometry fields", () => {
    const json = canvasJson([
      { id: "bad", type: "file", file: "Notes/missing-geom.md" },
      {
        id: "good",
        type: "file",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        file: "Notes/has-geom.md",
      },
    ])

    expect(extractCanvasFileLinks(json)).toEqual(["Notes/has-geom.md"])
  })

  it("ignores link-type and group-type nodes", () => {
    const json = canvasJson([
      {
        id: "l1",
        type: "link",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        url: "https://example.com",
      },
      {
        id: "g1",
        type: "group",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        label: "My Group",
      },
      {
        id: "f1",
        type: "file",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        file: "Notes/real.md",
      },
    ])

    expect(extractCanvasFileLinks(json)).toEqual(["Notes/real.md"])
  })

  it("throws on unparseable JSON", () => {
    expect(() => extractCanvasFileLinks("{not json")).toThrow(/^invalid \.canvas JSON: /)
  })
})

describe("extractCanvasCardTexts", () => {
  it("returns the text of each text card in JSON order, skipping other node types", () => {
    const json = canvasJson([
      textNode({ id: "t1", text: "See [[Plan]]" }),
      { id: "f1", type: "file", x: 0, y: 0, width: 400, height: 300, file: "Notes/Plan.md" },
      textNode({ id: "t2", text: "Second card" }),
    ])

    expect(extractCanvasCardTexts(json)).toEqual(["See [[Plan]]", "Second card"])
  })

  it("skips empty cards and cards missing geometry", () => {
    const json = canvasJson([
      textNode({ id: "t1", text: "" }),
      { id: "t2", type: "text", text: "[[No Geometry]]" },
      textNode({ id: "t3", text: "kept" }),
    ])

    expect(extractCanvasCardTexts(json)).toEqual(["kept"])
  })

  it.each([
    { label: "an object with no nodes key", canvas: "{}" },
    { label: "a nodes value that is not an array", canvas: '{"nodes":"[[Plan]]"}' },
    { label: "a top-level array", canvas: '[{"type":"text","text":"[[Plan]]"}]' },
    { label: "a top-level null", canvas: "null" },
  ])("returns no texts for $label", ({ canvas }) => {
    expect(extractCanvasCardTexts(canvas)).toEqual([])
  })

  it("throws on unparseable JSON", () => {
    expect(() => extractCanvasCardTexts("{not json")).toThrow(/^invalid \.canvas JSON: /)
  })
})

describe("rewriteCanvasLinks", () => {
  /** A canvas in the exact layout Obsidian saves, with no trailing newline. */
  const obsidianCanvas = [
    "{",
    '\t"nodes":[',
    '\t\t{"id":"f1","type":"file","file":"Inbox/Note.md","subpath":"#Goals","x":0,"y":0,"width":400,"height":400,"color":"4"},',
    '\t\t{"id":"t1","type":"text","text":"See [[Inbox/Note]]\\nand [[Other]]","x":500,"y":0,"width":250,"height":60},',
    '\t\t{"id":"f2","type":"file","file":"Other.md","x":0,"y":500,"width":400,"height":400},',
    '\t\t{"id":"t2","type":"text","text":"No links here","x":500,"y":500,"width":250,"height":60}',
    "\t],",
    '\t"edges":[',
    '\t\t{"id":"e1","fromNode":"f1","fromSide":"right","toNode":"t1","toSide":"left","label":"see"}',
    "\t]",
    "}",
  ].join("\n")

  /** Rewrites only "[[Inbox/Note]]" and "Inbox/Note.md", so every other card
   *  and path is a decoy that must come back unchanged. */
  const rewriteCardText = (text: string): { text: string; linksRewritten: number } => {
    const linksRewritten = text.split("[[Inbox/Note]]").length - 1
    return { text: text.replaceAll("[[Inbox/Note]]", "[[Projects/Note]]"), linksRewritten }
  }
  const rewriteFilePath = (filePath: string): string | null => {
    return filePath === "Inbox/Note.md" ? "Projects/Note.md" : null
  }

  it("rewrites the matching file card and text card and writes the canvas back in Obsidian's layout", () => {
    const result = rewriteCanvasLinks({
      canvasJson: obsidianCanvas,
      rewriteCardText,
      rewriteFilePath,
    })

    expect(result).toEqual({
      content: [
        "{",
        '\t"nodes":[',
        '\t\t{"id":"f1","type":"file","file":"Projects/Note.md","subpath":"#Goals","x":0,"y":0,"width":400,"height":400,"color":"4"},',
        '\t\t{"id":"t1","type":"text","text":"See [[Projects/Note]]\\nand [[Other]]","x":500,"y":0,"width":250,"height":60},',
        '\t\t{"id":"f2","type":"file","file":"Other.md","x":0,"y":500,"width":400,"height":400},',
        '\t\t{"id":"t2","type":"text","text":"No links here","x":500,"y":500,"width":250,"height":60}',
        "\t],",
        '\t"edges":[',
        '\t\t{"id":"e1","fromNode":"f1","fromSide":"right","toNode":"t1","toSide":"left","label":"see"}',
        "\t]",
        "}",
      ].join("\n"),
      linksRewritten: 2,
    })
  })

  it("returns null when no link changes, so the caller leaves the file alone", () => {
    const result = rewriteCanvasLinks({
      canvasJson: obsidianCanvas,
      rewriteCardText: (text) => ({ text: `${text} changed`, linksRewritten: 0 }),
      rewriteFilePath: () => null,
    })

    expect(result).toBeNull()
  })

  it("keeps a card's original text when its rewrite reports no changed link", () => {
    const result = rewriteCanvasLinks({
      canvasJson: canvasJson([
        textNode({ id: "t1", text: "untouched" }),
        { id: "f1", type: "file", x: 0, y: 0, width: 400, height: 300, file: "Inbox/Note.md" },
      ]),
      rewriteCardText: (text) => ({ text: `${text} changed`, linksRewritten: 0 }),
      rewriteFilePath,
    })

    expect(result).toEqual({
      content: [
        "{",
        '\t"nodes":[',
        '\t\t{"id":"t1","type":"text","x":0,"y":0,"width":200,"height":100,"text":"untouched"},',
        '\t\t{"id":"f1","type":"file","x":0,"y":0,"width":400,"height":300,"file":"Projects/Note.md"}',
        "\t],",
        '\t"edges":[]',
        "}",
      ].join("\n"),
      linksRewritten: 1,
    })
  })

  it("skips nodes missing geometry, matching the links the index records", () => {
    const result = rewriteCanvasLinks({
      canvasJson: canvasJson([
        { id: "f1", type: "file", file: "Inbox/Note.md" },
        { id: "t1", type: "text", text: "See [[Inbox/Note]]" },
      ]),
      rewriteCardText,
      rewriteFilePath,
    })

    expect(result).toBeNull()
  })

  it("keeps a trailing newline and any top-level property besides nodes and edges", () => {
    const canvas = `{"nodes":[{"id":"f1","type":"file","file":"Inbox/Note.md","x":0,"y":0,"width":1,"height":1}],"edges":[],"metadata":{"version":"1.0"}}\n`

    const result = rewriteCanvasLinks({ canvasJson: canvas, rewriteCardText, rewriteFilePath })

    expect(result).toEqual({
      content: [
        "{",
        '\t"nodes":[',
        '\t\t{"id":"f1","type":"file","file":"Projects/Note.md","x":0,"y":0,"width":1,"height":1}',
        "\t],",
        '\t"edges":[],',
        '\t"metadata":{"version":"1.0"}',
        "}\n",
      ].join("\n"),
      linksRewritten: 1,
    })
  })

  // Two cases hold Inbox/Note.md, which rewriteFilePath would change, so the
  // missing nodes list is the only reason nothing is rewritten.
  it.each([
    { label: "no nodes key", canvas: '{"edges":[]}' },
    { label: "a nodes value that is not an array", canvas: '{"nodes":"Inbox/Note.md"}' },
    {
      label: "a top-level array",
      canvas: '[{"id":"f1","type":"file","file":"Inbox/Note.md","x":0,"y":0,"width":1,"height":1}]',
    },
    { label: "a top-level null", canvas: "null" },
  ])("returns null for a canvas with $label", ({ canvas }) => {
    expect(rewriteCanvasLinks({ canvasJson: canvas, rewriteCardText, rewriteFilePath })).toBeNull()
  })

  it("throws on unparseable JSON", () => {
    const rewriteInvalidCanvas = (): void => {
      rewriteCanvasLinks({ canvasJson: "{not json", rewriteCardText, rewriteFilePath })
    }

    expect(rewriteInvalidCanvas).toThrow(/^invalid \.canvas JSON: /)
  })
})

const groupNode = (index: number): Record<string, unknown> => ({
  id: `g${String(index).padStart(5, "0")}`,
  type: "group",
  label: `Group ${index}`,
  x: index * 30,
  y: 0,
  width: 20,
  height: 20,
})

const separatedCanvas = (counts: {
  groups: number
  contentNodes: number
}): {
  json: string
  nested: string
  flat: string
} => {
  const groups = Array.from({ length: counts.groups }, (_, index) => groupNode(index))
  const contentNodes = Array.from({ length: counts.contentNodes }, (_, index) =>
    textNode({
      id: `n${index}`,
      text: `Text ${index}`,
      x: index * 30 + 1,
      y: 1,
      width: 1,
      height: 1,
    }),
  )
  const overview = `# Canvas: ${counts.groups + counts.contentNodes} nodes, 0 edges`
  const contentSections = contentNodes.map((_, index) => `[text]\nText ${index}`)
  const groupSections = groups.map((_, index) => `## Group: Group ${index}`)
  const nestedGroupSections = groupSections.flatMap((heading, index) => {
    const content = contentSections[index]
    return content ? [heading, content] : [heading]
  })
  return {
    json: canvasJson([...contentNodes, ...groups]),
    nested: [overview, ...contentSections.slice(counts.groups), ...nestedGroupSections].join(
      "\n\n",
    ),
    flat: [overview, ...groupSections, ...contentSections].join("\n\n"),
  }
}

describe("canvas ownership work and rendering depth", () => {
  it("renders nested duplicate IDs once in a parent-killed child", () => {
    expect(readParserComplexityReport("canvas-cycle")).toEqual({
      fixture: "canvas-cycle",
      node: process.version,
      semantics: "exact",
    })
  }, 35_000)

  it("renders each child only under its owning node when parent IDs repeat", () => {
    const nodes = [
      { ...groupNode(0), id: "a", label: "First" },
      { ...groupNode(0), id: "a", label: "Second", x: 100 },
      { ...groupNode(0), id: "b", label: "Child", x: 1, y: 1, width: 10, height: 10 },
      textNode({ id: "text", text: "Body", x: 2, y: 2, width: 1, height: 1 }),
    ]
    expect(linearizeCanvas(canvasJson(nodes))).toBe(
      [
        "# Canvas: 4 nodes, 0 edges",
        "## Group: First",
        "### Group: Child",
        "[text]\nBody",
        "## Group: Second",
      ].join("\n\n"),
    )
  })

  it("renders 28 duplicate-ID groups once within the parent watchdog", () => {
    expect(readParserComplexityReport("canvas-duplicate-ids")).toEqual({
      fixture: "canvas-duplicate-ids",
      node: process.version,
      inputBytes: 2590,
      nodeCount: 28,
      headingCount: 28,
      medianMs: expect.any(Number),
      semantics: "exact",
    })
  }, 35_000)

  it.each([
    { fixture: "canvas-cross", copies: 1 },
    { fixture: "canvas-multiple", copies: 5 },
  ])(
    "bounds $fixture at the ownership budget with complete output checks",
    ({ fixture, copies }) => {
      expect(readParserComplexityReport(fixture)).toEqual({
        fixture,
        node: process.version,
        checksPerCanvas: 16_000_000,
        copies,
        singleMedianMs: expect.any(Number),
        medianMs: expect.any(Number),
        semantics: "exact",
      })
    },
    35_000,
  )

  it.each([
    { label: "identical-rectangle depth", fixture: "canvas-depth" },
    { label: "content-count ownership", fixture: "canvas-flat" },
  ])(
    "bounds the $label adversary in a parent-killed child",
    ({ fixture }) => {
      expect(readParserComplexityReport(fixture)).toEqual({
        fixture,
        node: process.version,
        medianMs: expect.any(Number),
        semantics: "exact",
      })
    },
    35_000,
  )

  it.each([
    { label: "zero groups", groups: 0, contentNodes: 100_000, nested: true },
    { label: "one group at budget", groups: 1, contentNodes: 15_999_999, nested: true },
    {
      label: "one group one check above budget",
      groups: 1,
      contentNodes: 16_000_000,
      nested: false,
    },
    { label: "both axes at budget", groups: 2000, contentNodes: 6000, nested: true },
    { label: "both axes above budget", groups: 2000, contentNodes: 6001, nested: false },
    { label: "group axis at budget", groups: 4000, contentNodes: 0, nested: true },
    { label: "group axis above budget", groups: 4001, contentNodes: 0, nested: false },
  ])("uses both axes for $label without allocating nodes", ({ groups, contentNodes, nested }) => {
    expect(canNestCanvasGroups({ groups, contentNodes })).toBe(nested)
  })

  it.each([
    { groups: 2000, contentNodes: 2000, nested: true },
    { groups: 2000, contentNodes: 6000, nested: true },
    { groups: 2000, contentNodes: 6001, nested: false },
    { groups: 4000, contentNodes: 4000, nested: false },
    { groups: 8000, contentNodes: 8000, nested: false },
    { groups: 8000, contentNodes: 8001, nested: false },
    { groups: 2000, contentNodes: 100_000, nested: false },
    { groups: 4001, contentNodes: 1, nested: false },
    { groups: 0, contentNodes: 4, nested: true },
  ])(
    "renders every section with $groups groups and $contentNodes content nodes",
    ({ groups, contentNodes, nested }) => {
      const fixture = separatedCanvas({ groups, contentNodes })
      expect(linearizeCanvas(fixture.json)).toBe(nested ? fixture.nested : fixture.flat)
    },
  )

  it("skips every ownership scan above budget before constructing group maps", () => {
    const fixture = separatedCanvas({ groups: 2000, contentNodes: 6001 })
    const nativeFilter = Array.prototype.filter
    // Ownership filters scan the 2,000-group array; node parsing filters scan all 8,001 nodes.
    let ownershipScans = 0
    const filter = vi.spyOn(Array.prototype, "filter").mockImplementation(function (
      this: unknown[],
      predicate,
      thisArg,
    ) {
      if (this.length === 2000) ownershipScans++
      return nativeFilter.call(this, predicate, thisArg)
    })
    try {
      expect(linearizeCanvas(fixture.json)).toBe(fixture.flat)
      expect(ownershipScans).toBe(0)
    } finally {
      filter.mockRestore()
    }
  })

  it("renders a 2,000-group identical-rectangle chain once with H6 capping", () => {
    const groups = Array.from({ length: 2000 }, (_, index) => ({ ...groupNode(index), x: 0 }))
    const expectedGroups = groups
      .toReversed()
      .map((_, index) => `${"#".repeat(Math.min(2 + index, 6))} Group: Group ${1999 - index}`)
    expect(linearizeCanvas(canvasJson(groups))).toBe(
      ["# Canvas: 2000 nodes, 0 edges", ...expectedGroups].join("\n\n"),
    )
  })

  it("preserves flat labels, reading order and all connection names and labels", () => {
    const padding = Array.from({ length: 4001 }, (_, index) => ({
      ...groupNode(index),
      label: undefined,
      y: 10,
    }))
    const nodes = [
      { ...groupNode(0), id: "group", label: "Named", x: 0, y: -2 },
      textNode({ id: "text", x: 0, y: -1, text: "## Title\nBody" }),
      {
        id: "file",
        type: "file",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        file: "Folder/Note.md",
        subpath: "#Heading",
      },
      { id: "link", type: "link", x: 0, y: 1, width: 1, height: 1, url: "https://example.com" },
      { id: "unknown", type: "custom", x: 0, y: 2, width: 1, height: 1 },
      { id: "invalid", type: "text", text: "Dropped" },
      ...padding,
    ]
    const edges = [
      { fromNode: "group", toNode: "text", label: "names" },
      { fromNode: "file", toNode: "link", label: "" },
      { fromNode: "unknown", toNode: "absent", label: "missing" },
      { fromNode: "g00000", toNode: "group" },
      { fromNode: "invalid" },
    ]
    expect(linearizeCanvas(canvasJson(nodes, edges))).toBe(
      [
        "# Canvas: 4006 nodes, 4 edges",
        "## Group: Named",
        "[text]\n## Title\nBody",
        "[file] → Folder/Note.md#Heading",
        "[link] → https://example.com",
        "[custom]",
        ...padding.map(() => "## Group: (unlabeled)"),
        "## Connections",
        "Named → Title (names)",
        "Note.md → https://example.com",
        '(custom node) → (missing node "absent") (missing)',
        "(unlabeled group) → Named",
      ].join("\n\n"),
    )
  })
})

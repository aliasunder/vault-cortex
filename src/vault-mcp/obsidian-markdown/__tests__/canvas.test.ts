import { describe, it, expect } from "vitest"
import { linearizeCanvas } from "../canvas.js"

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
      [
        "# Canvas: 3 nodes, 0 edges",
        "[text]\nfirst",
        "[text]\nsecond",
        "[text]\nthird",
      ].join("\n\n"),
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
      ["# Canvas: 2 nodes, 0 edges", "[text]\noutside", "## Group: Box"].join(
        "\n\n",
      ),
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
      ["# Canvas: 1 node, 0 edges", "[file] → Notes/Plan.md#Goals"].join(
        "\n\n",
      ),
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
      [
        "# Canvas: 2 nodes, 0 edges",
        "[text]\nkept",
        "[text]\nwith extras",
      ].join("\n\n"),
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

  it("renders an empty canvas as the overview line alone", () => {
    expect(linearizeCanvas("{}")).toBe("# Canvas: 0 nodes, 0 edges")
  })

  it("throws on unparseable JSON", () => {
    expect(() => linearizeCanvas("{not json")).toThrow(
      /^invalid \.canvas JSON: /,
    )
  })
})

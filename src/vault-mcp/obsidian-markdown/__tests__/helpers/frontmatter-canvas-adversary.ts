import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { execFileSync } from "node:child_process"
import { linearizeCanvas } from "../../canvas.js"
import { parseNote, UnsupportedPropertiesBlockError } from "../../frontmatter.js"

const parserWorkerPath = fileURLToPath(import.meta.url)

export const readParserComplexityReport = (fixture: string): unknown => {
  // Node's parent watchdog kills and reaps a stuck synchronous parser before returning.
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", parserWorkerPath, fixture],
    {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  )
  return JSON.parse(output)
}

const yamlFixture = (size: number, duplicate: boolean): string => {
  const entries = Array.from({ length: size }, (_, index) => `k${index}: ${index}`)
  return ["---", ...entries, ...(duplicate ? ["k0: duplicate"] : []), "---", "body"].join("\n")
}

const canvasFixture = (counts: { groups: number; contentNodes: number; shape: string }): string => {
  const groups = Array.from({ length: counts.groups }, (_, index) => {
    const horizontal = index % 2 === 0
    const crossedGeometry = {
      x: horizontal ? -10 : 2,
      y: horizontal ? 2 : -10,
      width: horizontal ? 100 : 1,
      height: horizontal ? 1 : 100,
    }
    const geometry = (() => {
      if (counts.shape === "depth") return { x: 0, y: 0, width: 20, height: 20 }
      if (counts.shape === "separated") return { x: index * 30, y: 0, width: 20, height: 20 }
      return crossedGeometry
    })()
    return {
      id: `g${String(index).padStart(5, "0")}`,
      type: "group",
      label: `Group ${index}`,
      ...geometry,
    }
  })
  const nodes = Array.from({ length: counts.contentNodes }, (_, index) => ({
    id: `n${index}`,
    type: "text",
    text: `Text ${index}`,
    x: counts.shape === "separated" ? index * 30 + 1 : 0,
    y: counts.shape === "separated" ? 1 : 0,
    width: 1,
    height: 1,
  }))
  return JSON.stringify({ nodes: [...groups, ...nodes], edges: [] })
}

const measure = (run: () => void): number => {
  run()
  const samples = Array.from({ length: 5 }, () => {
    // Release prior documents before timing the next parse rather than charging their GC to it.
    global.gc?.()
    const start = performance.now()
    run()
    return performance.now() - start
  }).toSorted((a, b) => a - b)
  const median = samples[2]

  if (median === undefined) throw new Error("missing timing median")
  return median
}

const yamlCase = (size: number, duplicate: boolean): (() => void) => {
  const note = yamlFixture(size, duplicate)

  if (!duplicate) {
    const data = Object.fromEntries(
      Array.from({ length: size }, (_, index) => [`k${index}`, index]),
    )

    return () => {
      assert.deepEqual(parseNote(note), { data, content: "body" })
    }
  }
  return () => {
    try {
      parseNote(note)
    } catch (error) {
      const expected = `properties block is not valid YAML at line ${size + 2}, column 1: Map keys must be unique`

      if (
        error instanceof UnsupportedPropertiesBlockError &&
        error.kind === "invalid-yaml" &&
        error.message === expected
      )
        return
      throw error
    }
    throw new Error("late duplicate was accepted")
  }
}

const canvasCase = (counts: {
  groups: number
  contentNodes: number
  shape: string
}): (() => void) => {
  const json = canvasFixture(counts)
  const groups = Array.from({ length: counts.groups }, (_, index) => `## Group: Group ${index}`)
  const content = Array.from({ length: counts.contentNodes }, (_, index) => `[text]\nText ${index}`)
  const overview = `# Canvas: ${counts.groups + counts.contentNodes} nodes, 0 edges`
  const depthGroups = groups
    .toReversed()
    .map(
      (_, index) =>
        `${"#".repeat(Math.min(2 + index, 6))} Group: Group ${counts.groups - index - 1}`,
    )
  const chainHeadings = (parity: number): string[] => {
    return groups
      .flatMap((_, index) => (index % 2 === parity ? [index] : []))
      .toReversed()
      .map((index, depth) => `${"#".repeat(Math.min(2 + depth, 6))} Group: Group ${index}`)
  }
  const readingGroups = [...chainHeadings(1), ...chainHeadings(0)]
  const nested = [
    overview,
    ...content,
    ...(counts.shape === "depth" ? depthGroups : readingGroups),
  ].join("\n\n")
  const expected =
    counts.shape === "separated" ? [overview, ...groups, ...content].join("\n\n") : nested
  return () => {
    const actual = linearizeCanvas(json)

    if (actual !== expected)
      throw new Error("canvas rendition differs from the complete expected output")
  }
}

const runFixture = (fixture: string): unknown => {
  if (fixture === "canvas-cycle") {
    const nodes = [
      { id: "a", type: "group", label: "Outer A", x: 0, y: 0, width: 30, height: 30 },
      { id: "b", type: "group", label: "B", x: 1, y: 1, width: 20, height: 20 },
      { id: "a", type: "group", label: "Inner A", x: 2, y: 2, width: 10, height: 10 },
    ]
    assert.equal(
      linearizeCanvas(JSON.stringify({ nodes, edges: [] })),
      [
        "# Canvas: 3 nodes, 0 edges",
        "## Group: Outer A",
        "### Group: B",
        "#### Group: Inner A",
      ].join("\n\n"),
    )
    return { fixture, node: process.version, semantics: "exact" }
  }
  if (fixture === "canvas-duplicate-ids") {
    const levels = 14
    const nodes = Array.from({ length: levels }, (_, level) => {
      return [0, 1].map((copy) => ({
        id: `g${String(level).padStart(3, "0")}`,
        type: "group",
        label: `level-${level}-copy-${copy}`,
        x: -level,
        y: -level,
        width: 10 + level * 2,
        height: 10 + level * 2,
      }))
    }).flat()
    const json = JSON.stringify({ nodes, edges: [] })
    const firstCopies = Array.from({ length: levels }, (_, depth) => {
      return `${"#".repeat(Math.min(2 + depth, 6))} Group: level-${levels - depth - 1}-copy-0`
    })
    const secondCopies = Array.from({ length: levels }, (_, level) => {
      return `${"#".repeat(Math.min(2 + levels - level - 1, 6))} Group: level-${level}-copy-1`
    })
    const expected = ["# Canvas: 28 nodes, 0 edges", ...firstCopies, ...secondCopies].join("\n\n")
    const render = (): number => {
      const actual = linearizeCanvas(json)
      const headingCount = actual.split("\n").filter((line) => line.includes("Group:")).length
      assert.equal(headingCount, nodes.length)
      assert.equal(actual, expected)
      return headingCount
    }
    const headingCount = render()
    const medianMs = measure(() => {
      render()
    })
    return {
      fixture,
      node: process.version,
      inputBytes: Buffer.byteLength(json),
      nodeCount: nodes.length,
      headingCount,
      medianMs,
      semantics: "exact",
    }
  }
  if (fixture === "yaml-unique" || fixture === "yaml-duplicate") {
    const duplicate = fixture === "yaml-duplicate"
    const smallerMs = measure(yamlCase(50_000, duplicate))
    const largerMs = measure(yamlCase(100_000, duplicate))

    if (smallerMs > 10 && largerMs > smallerMs * 3)
      throw new Error(`YAML scaling exceeded 3x: ${smallerMs} -> ${largerMs}`)
    return {
      fixture,
      node: process.version,
      sizes: [50_000, 100_000],
      mediansMs: [smallerMs, largerMs],
      semantics: "exact",
    }
  }
  if (fixture === "canvas-depth") {
    const medianMs = measure(canvasCase({ groups: 2000, contentNodes: 0, shape: "depth" }))
    return { fixture, node: process.version, medianMs, semantics: "exact" }
  }
  if (fixture === "canvas-flat") {
    const medianMs = measure(
      canvasCase({ groups: 2000, contentNodes: 100_000, shape: "separated" }),
    )
    return { fixture, node: process.version, medianMs, semantics: "exact" }
  }
  if (fixture === "canvas-cross" || fixture === "canvas-multiple") {
    const run = canvasCase({ groups: 2000, contentNodes: 6000, shape: "cross" })
    const copies = fixture === "canvas-multiple" ? 5 : 1
    const medianMs = measure(() => {
      for (let index = 0; index < copies; index++) run()
    })
    return {
      fixture,
      node: process.version,
      checksPerCanvas: 16_000_000,
      copies,
      medianMs,
      semantics: "exact",
    }
  }
  throw new Error(`unknown adversarial fixture: ${fixture}`)
}

if (process.argv[1] === parserWorkerPath) {
  const fixture = process.argv[2]

  if (!fixture) throw new Error("missing adversarial fixture")
  process.stdout.write(`${JSON.stringify(runFixture(fixture))}\n`)
}

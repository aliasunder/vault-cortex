import { linearizeCanvas } from "../../canvas.js"

const variant = process.argv[2]

/** One character past the 16,383 beyond which V8 hashes a string by its length
 *  alone, so every id lands in one hash bucket. */
const LONG_ID_LENGTH = 16_384

const RUNS = 3

/** Ids that share a long prefix and differ only in a fixed-width numeric
 *  suffix, so a hash collision or a comparison reads the whole prefix, and
 *  string order is index order. */
const suffixDistinctId = (index: number, length: number): string => {
  const suffix = String(index).padStart(8, "0")
  return `${"a".repeat(length - suffix.length)}${suffix}`
}

/** Text cards stacked top to bottom, each linked to the next, so reading
 *  order is index order and every card is an edge endpoint. */
const textCardCanvas = (count: number): { json: string; expected: string } => {
  const ids = Array.from({ length: count }, (_, index) => suffixDistinctId(index, LONG_ID_LENGTH))
  const nodes = ids.map((id, index) => {
    return { id, type: "text", text: `card ${index}`, x: 0, y: index * 10, width: 1, height: 1 }
  })
  const edges = ids.map((id, index) => {
    return { fromNode: id, toNode: ids[(index + 1) % count] }
  })
  const expected = [
    `# Canvas: ${count} nodes, ${count} edges`,
    ...nodes.map((_, index) => `[text]\ncard ${index}`),
    [
      "## Connections",
      ...nodes.map((_, index) => `card ${index} → card ${(index + 1) % count}`),
    ].join("\n\n"),
  ].join("\n\n")
  return { json: JSON.stringify({ nodes, edges }), expected }
}

/** Groups with one rectangle. The later id contains the earlier, so they nest
 *  as one chain under the last id, with headings capped at H6. */
const identicalGroupCanvas = (
  count: number,
  idLength: number,
): { json: string; expected: string } => {
  const nodes = Array.from({ length: count }, (_, index) => {
    const id = suffixDistinctId(index, idLength)
    return { id, type: "group", label: `g${index}`, x: 0, y: 0, width: 10, height: 10 }
  })
  const headings = nodes.map((_, depth) => {
    return `${"#".repeat(Math.min(2 + depth, 6))} Group: g${count - 1 - depth}`
  })
  const expected = [`# Canvas: ${count} nodes, 0 edges`, ...headings].join("\n\n")
  return { json: JSON.stringify({ nodes, edges: [] }), expected }
}

const fixtures = (): { label: string; json: string; expected: string }[] => {
  if (variant === "text-cards") {
    return [250, 2_000].map((count) => ({ label: `${count}`, ...textCardCanvas(count) }))
  }
  return [16, 4_096].map((idLength) => ({
    label: `${idLength}`,
    ...identicalGroupCanvas(1_000, idLength),
  }))
}

const measurements = fixtures().map(({ label, json, expected }) => {
  const rendersExpected = linearizeCanvas(json) === expected
  const elapsedRuns = Array.from({ length: RUNS }, () => {
    const start = performance.now()
    linearizeCanvas(json)
    return performance.now() - start
  })
  return { label, rendersExpected, leastMs: Math.min(...elapsedRuns) }
})

process.stdout.write(JSON.stringify({ variant, measurements }))

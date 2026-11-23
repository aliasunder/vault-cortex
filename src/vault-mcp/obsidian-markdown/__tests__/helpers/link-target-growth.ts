import { links } from "../../links.js"
import { extractCanvasLinks } from "../../canvas.js"

const variant = process.argv[2]

/** Eight times the input, so linear work grows about 8x and a quadratic Set
 *  about 64x. */
const LINK_COUNTS = [250, 2_000]

/** One character past the 16,383 beyond which V8 hashes a string by its length
 *  alone, so every target lands in one hash bucket. */
const TARGET_LENGTH = 16_384

const RUNS = 3

/** Targets that differ only in a numeric suffix, so each hash collision
 *  compares two of them across their whole length. */
const suffixDistinctTargets = (count: number): string[] => {
  return Array.from({ length: count }, (_, index) => {
    const suffix = `-${index}`
    return `${"x".repeat(TARGET_LENGTH - suffix.length)}${suffix}`
  })
}

/** A target within the limit, listed after the long ones. Extraction keeps it,
 *  which shows the timed call reads past every long target. */
const KEPT_TARGET = "kept.md"

const buildInput = (targets: readonly string[]): string => {
  if (variant === "extract") return targets.map((target) => `[[${target}]]`).join("\n")

  const fileCards = targets.map((target, index) => {
    return { id: `n${index}`, type: "file", file: target, x: 0, y: 0, width: 1, height: 1 }
  })
  return JSON.stringify({ nodes: fileCards, edges: [] })
}

const extractTargets = (input: string): string[] => {
  if (variant === "extract") return links.extractAll(input, {})
  return extractCanvasLinks(input).fileCardPaths
}

const measurements = LINK_COUNTS.map((count) => {
  const input = buildInput([...suffixDistinctTargets(count), KEPT_TARGET])
  const kept = extractTargets(input)
  const elapsedRuns = Array.from({ length: RUNS }, () => {
    const start = performance.now()
    extractTargets(input)
    return performance.now() - start
  })
  return { count, kept, leastMs: Math.min(...elapsedRuns) }
})

process.stdout.write(JSON.stringify({ variant, measurements }))

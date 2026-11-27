import { links } from "../../links.js"

const variant = process.argv[2]

/** Eight times the paths, so a resolver that scans the list grows about 8x
 *  and one that reads a lookup stays flat. */
const PATH_COUNTS = [1_000, 8_000]

const TARGET_COUNT = 2_000

const RUNS = 3

const notePaths = (count: number): string[] => {
  return Array.from({ length: count }, (_, index) => `folder${index % 50}/note${index}.md`)
}

/** Every note is named same.md, each in its own folder. */
const sameNamePaths = (count: number): string[] => {
  return Array.from({ length: count }, (_, index) => `f${index}/same.md`)
}

const filePaths = (count: number): string[] => {
  return Array.from({ length: count }, (_, index) => `folder${index % 50}/file${index}.png`)
}

/** Distinct targets that match no path, so each runs every tier of both passes. */
const missingTargets = (): string[] => {
  return Array.from({ length: TARGET_COUNT }, (_, index) => `missing${index}`)
}

/** Distinct folder-qualified targets naming same.md in a folder no note is in. */
const missingSameNameTargets = (): string[] => {
  return Array.from({ length: TARGET_COUNT }, (_, index) => `q${index}/same`)
}

type Fixture = { targets: string[]; resolveTarget: (target: string) => string | null }

const createFixture = (pathCount: number): Fixture => {
  switch (variant) {
    case "notes": {
      const paths = notePaths(pathCount)
      return {
        targets: missingTargets(),
        resolveTarget: (target) => links.resolve({ target, allPaths: paths }),
      }
    }
    case "same-name": {
      const paths = sameNamePaths(pathCount)
      return {
        targets: missingSameNameTargets(),
        resolveTarget: (target) => links.resolve({ target, allPaths: paths }),
      }
    }
    case "files": {
      const paths = filePaths(pathCount)
      return {
        targets: missingTargets(),
        resolveTarget: (target) => links.resolveAsset({ target, allAssetPaths: paths }),
      }
    }
    default:
      throw new Error(`unknown variant: ${variant}`)
  }
}

const measurements = PATH_COUNTS.map((pathCount) => {
  const { targets, resolveTarget } = createFixture(pathCount)
  const resolvedCount = targets.filter((target) => resolveTarget(target) !== null).length
  // Counting the resolved targets builds the lookups over the list, so every
  // timed run resolves against lookups that already exist.
  const elapsedRuns = Array.from({ length: RUNS }, () => {
    const start = performance.now()
    for (const target of targets) resolveTarget(target)
    return performance.now() - start
  })
  return { pathCount, resolvedCount, leastMs: Math.min(...elapsedRuns) }
})

process.stdout.write(JSON.stringify({ variant, measurements }))

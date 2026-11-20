import { execFileSync } from "node:child_process"
import { describe, it, expect } from "vitest"
import { stripTrailingSlashes } from "../strip-trailing-slashes.js"

/** A quadratic scan of a run this long takes minutes; a linear one takes
 *  milliseconds. */
const LONG_RUN_LENGTH = 1_000_000

/** Leaves room for the child's tsx start-up on a loaded machine. */
const CHILD_DEADLINE_MS = 20_000

describe("stripTrailingSlashes", () => {
  it("strips a single trailing slash", () => {
    expect(stripTrailingSlashes("Projects/")).toBe("Projects")
  })

  it("strips multiple trailing slashes", () => {
    expect(stripTrailingSlashes("Projects///")).toBe("Projects")
  })

  it("leaves paths without trailing slashes unchanged", () => {
    expect(stripTrailingSlashes("Projects/Alpha")).toBe("Projects/Alpha")
  })

  it("preserves internal slashes", () => {
    expect(stripTrailingSlashes("Projects/Alpha/Beta/")).toBe("Projects/Alpha/Beta")
  })

  it("handles a bare folder name", () => {
    expect(stripTrailingSlashes("Projects")).toBe("Projects")
  })

  it("turns a path of slashes alone into an empty string", () => {
    expect(stripTrailingSlashes("///")).toBe("")
  })

  it(
    "returns a million-slash run followed by another character unchanged within a child deadline",
    () => {
      const stripTrailingSlashesUrl = new URL("../strip-trailing-slashes.ts", import.meta.url).href
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `
      import { stripTrailingSlashes } from ${JSON.stringify(stripTrailingSlashesUrl)};
      const path = '/'.repeat(${LONG_RUN_LENGTH}) + 'x';
      process.stdout.write(String(stripTrailingSlashes(path) === path));
    `,
        ],
        { encoding: "utf8", timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" },
      )

      expect(output).toBe("true")
    },
    CHILD_DEADLINE_MS + 5_000,
  )
})

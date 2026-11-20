import { execFileSync } from "node:child_process"

/** Leaves room for the child's tsx start-up on a loaded machine. */
export const CHILD_DEADLINE_MS = 20_000

/**
 * Runs an ES module script in a child Node process (through tsx) and returns
 * what it printed.
 * - A script that stalls is killed at the deadline, so the test fails instead
 *   of hanging the suite.
 * - The child logs only errors, so its output is the script's own.
 */
export const runScriptInChild = (script: string): string => {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      timeout: CHILD_DEADLINE_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, LOG_LEVEL: "error" },
    },
  )
}

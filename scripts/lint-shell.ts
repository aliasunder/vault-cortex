/**
 * Runs ShellCheck over the repo's shell scripts.
 * - With no arguments (`npm run lint:shell`, CI) it checks every script below.
 * - With file arguments (lint-staged passes every staged file) it checks only
 *   the ones that are shell scripts, so a commit that changes none never
 *   needs ShellCheck installed.
 */

import { spawnSync } from "node:child_process"
import { globSync } from "node:fs"
import { matchesGlob, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Every shell script in the repo, relative to its root. A new script
 *  outside these paths is added here. */
const SHELL_SCRIPT_GLOBS = [
  ".claude/hooks/*.sh",
  ".github/scripts/*.sh",
  "rootfs/etc/s6-overlay/scripts/*",
  "rootfs/etc/s6-overlay/s6-rc.d/*/run",
  "rootfs/etc/s6-overlay/s6-rc.d/*/finish",
  "rootfs/usr/local/bin/get-sync-token",
  "src/__tests__/docker/fixtures/ob",
  "cli/src/__tests__/integration/fixtures/docker",
]

const SHELLCHECK_START_FAILURE_MESSAGE =
  "✕ Could not start shellcheck. Is it installed?\n" +
  "   install via: brew bundle (macOS, reads the repo's Brewfile) or apt-get install shellcheck (Linux)"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const isShellScript = (repoRelativePath: string): boolean => {
  return SHELL_SCRIPT_GLOBS.some((shellScriptGlob) =>
    matchesGlob(repoRelativePath, shellScriptGlob),
  )
}

const listShellScripts = (requestedPaths: readonly string[]): string[] => {
  if (requestedPaths.length === 0) {
    return globSync(SHELL_SCRIPT_GLOBS, { cwd: repoRoot }).toSorted()
  }

  const repoRelativePaths = requestedPaths.map((requestedPath) => {
    return relative(repoRoot, resolve(requestedPath))
  })
  return repoRelativePaths.filter(isShellScript)
}

const lintShellScripts = (requestedPaths: readonly string[]): number => {
  const shellScripts = listShellScripts(requestedPaths)

  if (shellScripts.length === 0) return 0

  const result = spawnSync("shellcheck", shellScripts, { cwd: repoRoot, stdio: "inherit" })

  // spawnSync reports a command it could not start in result.error.
  if (result.error) {
    console.error(SHELLCHECK_START_FAILURE_MESSAGE)
    return 1
  }

  // status is null when a signal ended ShellCheck; report that as a failure.
  return result.status ?? 1
}

process.exitCode = lintShellScripts(process.argv.slice(2))

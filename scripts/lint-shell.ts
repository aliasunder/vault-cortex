/**
 * Runs ShellCheck over the repo's shell scripts.
 * - With no arguments (`npm run lint:shell`, CI) it checks every script below.
 * - With file arguments (lint-staged passes every staged file) it checks only
 *   the ones that are shell scripts, so a commit that changes none never
 *   needs ShellCheck.
 * - It runs the ShellCheck release pinned below, so every machine and CI
 *   check with the same version. The first run that needs it downloads the
 *   official build for this machine with curl and verifies its SHA-256.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, matchesGlob, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Every shell script in the repo, relative to its root. A new script
 *  outside these paths is added here. */
const SHELL_SCRIPT_GLOBS = [
  ".claude/hooks/*.sh",
  ".github/scripts/*.sh",
  // The s6 init scripts, plus print-derived-env, which init-derive-env runs
  "rootfs/etc/s6-overlay/scripts/*",
  "rootfs/etc/s6-overlay/s6-rc.d/*/run",
  "rootfs/etc/s6-overlay/s6-rc.d/*/finish",
  "rootfs/usr/local/bin/get-sync-token",
  // Stub of the obsidian-headless `ob` CLI for the remote-boot tests
  "src/__tests__/docker/fixtures/ob",
  // Stub `docker` CLI for the CLI PTY tests
  "cli/src/__tests__/integration/fixtures/docker",
]

const SHELLCHECK_VERSION = "0.11.0"

type ShellcheckBuild = {
  /** The platform as the release's archive names spell it (`linux.aarch64`). */
  archivePlatform: string
  sha256: string
}

/** The release's archive for each supported `${process.platform}-${process.arch}`.
 *  A version bump replaces every hash, computed from the new release's files. */
const SHELLCHECK_BUILDS = new Map<string, ShellcheckBuild>([
  [
    "darwin-arm64",
    {
      archivePlatform: "darwin.aarch64",
      sha256: "56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79",
    },
  ],
  [
    "darwin-x64",
    {
      archivePlatform: "darwin.x86_64",
      sha256: "3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6",
    },
  ],
  [
    "linux-arm64",
    {
      archivePlatform: "linux.aarch64",
      sha256: "12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588",
    },
  ],
  [
    "linux-x64",
    {
      archivePlatform: "linux.x86_64",
      sha256: "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
    },
  ],
])

type ShellcheckBinary =
  { status: "ready"; binaryPath: string } | { status: "unavailable"; reason: string }

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const isShellScript = (repoRelativePath: string): boolean => {
  return SHELL_SCRIPT_GLOBS.some((shellScriptGlob) =>
    matchesGlob(repoRelativePath, shellScriptGlob),
  )
}

/** Returns repo-relative paths. A requested path may be absolute, as
 *  lint-staged passes them, or relative to the current directory. */
const listShellScripts = (requestedPaths: readonly string[]): string[] => {
  if (requestedPaths.length === 0) {
    return globSync(SHELL_SCRIPT_GLOBS, { cwd: repoRoot }).toSorted()
  }

  const repoRelativePaths = requestedPaths.map((requestedPath) => {
    return relative(repoRoot, resolve(requestedPath))
  })
  // A path no glob matches is skipped: lint-staged passes every staged file,
  // and a new script is checked only once SHELL_SCRIPT_GLOBS lists it.
  return repoRelativePaths.filter(isShellScript)
}

/**
 * - Unpacks the binary next to its final path, then renames it into place, so
 *   a run interrupted mid-download never leaves a partial binary behind.
 * - A failed command or hash check returns `unavailable`; a filesystem error
 *   in the cache directory throws Node's own error, which names the path.
 */
const downloadShellcheck = ({
  build,
  binaryPath,
  cacheDirectory,
}: {
  build: ShellcheckBuild
  binaryPath: string
  cacheDirectory: string
}): ShellcheckBinary => {
  const archiveName = `shellcheck-v${SHELLCHECK_VERSION}.${build.archivePlatform}.tar.xz`
  const archiveUrl = `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/${archiveName}`
  mkdirSync(cacheDirectory, { recursive: true })
  const downloadDirectory = mkdtempSync(join(cacheDirectory, "download-"))

  try {
    const archivePath = join(downloadDirectory, archiveName)
    console.error(`Downloading ShellCheck ${SHELLCHECK_VERSION} into ${cacheDirectory}`)
    const download = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", archivePath, archiveUrl], {
      stdio: ["ignore", "ignore", "inherit"],
    })

    // spawnSync reports a command it could not start in .error.
    if (download.error) {
      return { status: "unavailable", reason: `could not run curl: ${download.error.message}` }
    }

    if (download.status !== 0) {
      return { status: "unavailable", reason: `could not download ${archiveUrl}` }
    }

    const archiveSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex")

    if (archiveSha256 !== build.sha256) {
      return {
        status: "unavailable",
        reason: `${archiveName} has SHA-256 ${archiveSha256}, not the pinned ${build.sha256}`,
      }
    }

    // --no-same-owner: as root, tar would keep the archive's owner, leaving
    // the binary writable by that unrelated user.
    const extraction = spawnSync(
      "tar",
      ["-xJf", archivePath, "-C", downloadDirectory, "--no-same-owner"],
      { stdio: ["ignore", "ignore", "inherit"] },
    )

    if (extraction.error) {
      return { status: "unavailable", reason: `could not run tar: ${extraction.error.message}` }
    }

    if (extraction.status !== 0) {
      return { status: "unavailable", reason: `could not unpack ${archiveName}` }
    }

    // The archive holds one folder, shellcheck-v<version>/, with the binary in it.
    renameSync(
      join(downloadDirectory, `shellcheck-v${SHELLCHECK_VERSION}`, "shellcheck"),
      binaryPath,
    )
    return { status: "ready", binaryPath }
  } finally {
    rmSync(downloadDirectory, { recursive: true, force: true })
  }
}

/** The pinned ShellCheck, from the user's cache directory when an earlier run
 *  downloaded it. */
const getShellcheckBinary = (): ShellcheckBinary => {
  const platform = `${process.platform}-${process.arch}`
  const build = SHELLCHECK_BUILDS.get(platform)

  if (!build) {
    return { status: "unavailable", reason: `no ShellCheck build is pinned for ${platform}` }
  }

  // XDG_CACHE_HOME is the standard override, and ~/.cache its documented
  // default. The spec says to ignore a relative value: ShellCheck runs from the
  // repo root, so a binary found relative to another directory would not start.
  const xdgCacheHome = process.env.XDG_CACHE_HOME
  const cacheRoot =
    xdgCacheHome && isAbsolute(xdgCacheHome) ? xdgCacheHome : join(homedir(), ".cache")
  const cacheDirectory = join(cacheRoot, "vault-cortex", `shellcheck-${SHELLCHECK_VERSION}`)
  const binaryPath = join(cacheDirectory, "shellcheck")

  if (existsSync(binaryPath)) return { status: "ready", binaryPath }
  return downloadShellcheck({ build, binaryPath, cacheDirectory })
}

/** Returns the process exit status: ShellCheck's own, or 1 when it can't run. */
const lintShellScripts = (requestedPaths: readonly string[]): number => {
  const shellScripts = listShellScripts(requestedPaths)

  if (shellScripts.length === 0) return 0

  const shellcheck = getShellcheckBinary()

  if (shellcheck.status === "unavailable") {
    console.error(`✕ Could not get ShellCheck: ${shellcheck.reason}`)
    return 1
  }

  // The paths are repo-relative, so ShellCheck runs from the repo root.
  const result = spawnSync(shellcheck.binaryPath, shellScripts, { cwd: repoRoot, stdio: "inherit" })

  // spawnSync reports a command it could not start in result.error.
  if (result.error) {
    console.error(`✕ Could not start ${shellcheck.binaryPath}: ${result.error.message}`)
    return 1
  }

  // status is null when a signal ended ShellCheck; report that as a failure.
  return result.status ?? 1
}

process.exitCode = lintShellScripts(process.argv.slice(2))

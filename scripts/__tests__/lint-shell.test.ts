import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it, onTestFinished } from "vitest"

/** Every shell script in the repo, sorted: what a run with no paths checks. */
const ALL_SHELL_SCRIPTS = [
  ".claude/hooks/install-deps.sh",
  ".claude/hooks/require-nonroot-tests.sh",
  ".github/scripts/generate-notes.sh",
  ".github/scripts/update-changelog.sh",
  "cli/src/__tests__/integration/fixtures/docker",
  "rootfs/etc/s6-overlay/s6-rc.d/svc-obsidian-sync/run",
  "rootfs/etc/s6-overlay/s6-rc.d/svc-vault-mcp/finish",
  "rootfs/etc/s6-overlay/s6-rc.d/svc-vault-mcp/run",
  "rootfs/etc/s6-overlay/scripts/init-check-auth",
  "rootfs/etc/s6-overlay/scripts/init-derive-env",
  "rootfs/etc/s6-overlay/scripts/init-first-sync",
  "rootfs/etc/s6-overlay/scripts/init-obsidian-login",
  "rootfs/etc/s6-overlay/scripts/init-setup-user",
  "rootfs/etc/s6-overlay/scripts/init-setup-vault",
  "rootfs/etc/s6-overlay/scripts/print-derived-env",
  "rootfs/usr/local/bin/get-sync-token",
  "src/__tests__/docker/fixtures/ob",
]

/** Where the script keeps the pinned ShellCheck under XDG_CACHE_HOME. */
const CACHED_SHELLCHECK_DIRECTORY = join("vault-cortex", "shellcheck-0.11.0")

const RELEASE_URL = "https://github.com/koalaman/shellcheck/releases/download/v0.11.0"

/** The pinned release archive for each `${process.platform}-${process.arch}`. */
const PINNED_ARCHIVES = new Map([
  [
    "darwin-arm64",
    {
      name: "shellcheck-v0.11.0.darwin.aarch64.tar.xz",
      sha256: "56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79",
    },
  ],
  [
    "darwin-x64",
    {
      name: "shellcheck-v0.11.0.darwin.x86_64.tar.xz",
      sha256: "3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6",
    },
  ],
  [
    "linux-arm64",
    {
      name: "shellcheck-v0.11.0.linux.aarch64.tar.xz",
      sha256: "12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588",
    },
  ],
  [
    "linux-x64",
    {
      name: "shellcheck-v0.11.0.linux.x86_64.tar.xz",
      sha256: "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
    },
  ],
])

const getPinnedArchiveForThisMachine = (): { name: string; sha256: string } => {
  const platform = `${process.platform}-${process.arch}`
  const pinnedArchive = PINNED_ARCHIVES.get(platform)

  if (!pinnedArchive) throw new Error(`no pinned ShellCheck archive for ${platform}`)
  return pinnedArchive
}

const createTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "vault-cortex-lint-shell-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/** Writes an executable sh script that records its arguments, one per line,
 *  to `callLog`, runs `body`, and exits with `exitStatus`. */
const writeRecordingCommand = ({
  commandPath,
  callLog,
  body,
  exitStatus,
}: {
  commandPath: string
  callLog: string
  body: string
  exitStatus: number
}): void => {
  writeFileSync(
    commandPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${callLog}'\n${body}\nexit ${exitStatus}\n`,
  )
  chmodSync(commandPath, 0o755)
}

type FakeShellcheck = {
  cacheHome: string
  /** Where the script looks for the cached ShellCheck under `cacheHome`. */
  binaryPath: string
  /** The paths the fake was given, one per line; absent until it runs. */
  callLog: string
}

/** A cache holding a `shellcheck` stand-in where a finished download leaves
 *  the real one. */
const createCachedFakeShellcheck = ({
  cacheHome = createTempDirectory(),
  exitStatus,
}: {
  cacheHome?: string
  exitStatus: number
}): FakeShellcheck => {
  const callLog = join(cacheHome, "shellcheck-calls.log")
  const shellcheckDirectory = join(cacheHome, CACHED_SHELLCHECK_DIRECTORY)
  const binaryPath = join(shellcheckDirectory, "shellcheck")
  mkdirSync(shellcheckDirectory, { recursive: true })
  writeRecordingCommand({ commandPath: binaryPath, callLog, body: "", exitStatus })
  return { cacheHome, binaryPath, callLog }
}

type FakeCurl = {
  binDirectory: string
  /** curl's arguments, one per line; absent unless curl ran. */
  callLog: string
}

/** A `curl` stand-in that writes `archiveContent` to the path after `-o`. */
const createFakeCurl = ({
  archiveContent,
  exitStatus,
}: {
  archiveContent: string
  exitStatus: number
}): FakeCurl => {
  const binDirectory = createTempDirectory()
  const callLog = join(binDirectory, "curl-calls.log")
  const writeArchiveAfterOutputFlag = [
    'while [ "$#" -gt 0 ]; do',
    `  if [ "$1" = "-o" ]; then printf '%s' '${archiveContent}' > "$2"; fi`,
    "  shift",
    "done",
  ].join("\n")
  writeRecordingCommand({
    commandPath: join(binDirectory, "curl"),
    callLog,
    body: writeArchiveAfterOutputFlag,
    exitStatus,
  })
  return { binDirectory, callLog }
}

const TSX_CLI = resolve("node_modules/tsx/dist/cli.mjs")

const LINT_SHELL_SCRIPT = resolve("scripts/lint-shell.ts")

/** `env` holds the variables a run sets over the test process's own; an
 *  `undefined` value unsets one. */
const runLintShell = ({
  paths,
  env,
  cwd,
}: {
  paths: readonly string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}): SpawnSyncReturns<string> => {
  return spawnSync(process.execPath, [TSX_CLI, LINT_SHELL_SCRIPT, ...paths], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

/** A PATH that finds the fake `curl` before any real one, so no run reaches
 *  the network. */
const putFakeCurlFirstOnPath = (fakeCurl: FakeCurl): string => {
  return `${fakeCurl.binDirectory}:${process.env.PATH ?? ""}`
}

const readCallLog = (callLog: string): string[] | null => {
  if (!existsSync(callLog)) return null
  return readFileSync(callLog, "utf8").trimEnd().split("\n")
}

describe("lint-shell script", () => {
  it("checks every shell script in the repo when given no paths", () => {
    const fakeShellcheck = createCachedFakeShellcheck({ exitStatus: 0 })
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: [],
      env: { XDG_CACHE_HOME: fakeShellcheck.cacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({ status: run.status, checked: readCallLog(fakeShellcheck.callLog) }).toEqual({
      status: 0,
      checked: ALL_SHELL_SCRIPTS,
    })
  })

  it("checks only the given files that are shell scripts", () => {
    const fakeShellcheck = createCachedFakeShellcheck({ exitStatus: 0 })
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: [
        resolve(".claude/hooks/install-deps.sh"),
        resolve("README.md"),
        resolve("rootfs/etc/s6-overlay/s6-rc.d/svc-vault-mcp/type"),
        resolve("rootfs/usr/local/bin/get-sync-token"),
      ],
      env: { XDG_CACHE_HOME: fakeShellcheck.cacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({ status: run.status, checked: readCallLog(fakeShellcheck.callLog) }).toEqual({
      status: 0,
      checked: [".claude/hooks/install-deps.sh", "rootfs/usr/local/bin/get-sync-token"],
    })
  })

  it("resolves a relative path from the current directory", () => {
    const fakeShellcheck = createCachedFakeShellcheck({ exitStatus: 0 })
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: ["scripts/init-check-auth", "s6-rc.d/svc-vault-mcp/type"],
      env: { XDG_CACHE_HOME: fakeShellcheck.cacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
      cwd: resolve("rootfs/etc/s6-overlay"),
    })

    expect({ status: run.status, checked: readCallLog(fakeShellcheck.callLog) }).toEqual({
      status: 0,
      checked: ["rootfs/etc/s6-overlay/scripts/init-check-auth"],
    })
  })

  it("uses the cached ShellCheck without downloading it again", () => {
    const fakeShellcheck = createCachedFakeShellcheck({ exitStatus: 0 })
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      env: { XDG_CACHE_HOME: fakeShellcheck.cacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({
      status: run.status,
      stderr: run.stderr,
      checked: readCallLog(fakeShellcheck.callLog),
      curlCalls: readCallLog(fakeCurl.callLog),
    }).toEqual({
      status: 0,
      stderr: "",
      checked: [".claude/hooks/install-deps.sh"],
      curlCalls: null,
    })
  })

  it.each([
    { label: "unset", xdgCacheHome: undefined },
    { label: "empty", xdgCacheHome: "" },
  ])(
    "looks for the cached ShellCheck under ~/.cache when XDG_CACHE_HOME is $label",
    ({ xdgCacheHome }) => {
      const home = createTempDirectory()
      const fakeShellcheck = createCachedFakeShellcheck({
        cacheHome: join(home, ".cache"),
        exitStatus: 0,
      })
      const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

      const run = runLintShell({
        paths: [resolve(".claude/hooks/install-deps.sh")],
        env: { XDG_CACHE_HOME: xdgCacheHome, HOME: home, PATH: putFakeCurlFirstOnPath(fakeCurl) },
      })

      expect({
        status: run.status,
        checked: readCallLog(fakeShellcheck.callLog),
        curlCalls: readCallLog(fakeCurl.callLog),
      }).toEqual({ status: 0, checked: [".claude/hooks/install-deps.sh"], curlCalls: null })
    },
  )

  it("exits 0 without downloading ShellCheck when no given file is a shell script", () => {
    const emptyCacheHome = createTempDirectory()
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: [resolve("README.md"), resolve("package.json")],
      env: { XDG_CACHE_HOME: emptyCacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({
      status: run.status,
      stderr: run.stderr,
      curlCalls: readCallLog(fakeCurl.callLog),
    }).toEqual({ status: 0, stderr: "", curlCalls: null })
  })

  it("rejects a downloaded archive whose SHA-256 is not the pinned one", () => {
    const pinnedArchive = getPinnedArchiveForThisMachine()
    const emptyCacheHome = createTempDirectory()
    const fakeCurl = createFakeCurl({ archiveContent: "not the release", exitStatus: 0 })
    const fakeArchiveSha256 = createHash("sha256").update("not the release").digest("hex")

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      env: { XDG_CACHE_HOME: emptyCacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({
      status: run.status,
      stderr: run.stderr,
      cacheContents: readdirSync(join(emptyCacheHome, CACHED_SHELLCHECK_DIRECTORY)),
    }).toEqual({
      status: 1,
      stderr:
        `Downloading ShellCheck 0.11.0 into ${join(emptyCacheHome, CACHED_SHELLCHECK_DIRECTORY)}\n` +
        `✕ Could not get ShellCheck: ${pinnedArchive.name} has SHA-256 ${fakeArchiveSha256}, ` +
        `not the pinned ${pinnedArchive.sha256}\n`,
      cacheContents: [],
    })
  })

  it("exits 1 naming the URL when the download fails", () => {
    const pinnedArchive = getPinnedArchiveForThisMachine()
    const emptyCacheHome = createTempDirectory()
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 22 })

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      env: { XDG_CACHE_HOME: emptyCacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({
      status: run.status,
      stderr: run.stderr,
      requestedUrl: readCallLog(fakeCurl.callLog)?.at(-1),
    }).toEqual({
      status: 1,
      stderr:
        `Downloading ShellCheck 0.11.0 into ${join(emptyCacheHome, CACHED_SHELLCHECK_DIRECTORY)}\n` +
        `✕ Could not get ShellCheck: could not download ${RELEASE_URL}/${pinnedArchive.name}\n`,
      requestedUrl: `${RELEASE_URL}/${pinnedArchive.name}`,
    })
  })

  it("exits 1 when curl cannot be run", () => {
    const emptyCacheHome = createTempDirectory()
    const binDirectoryWithoutCurl = createTempDirectory()

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      env: { XDG_CACHE_HOME: emptyCacheHome, PATH: binDirectoryWithoutCurl },
    })

    expect({
      status: run.status,
      stderr: run.stderr,
      cacheContents: readdirSync(join(emptyCacheHome, CACHED_SHELLCHECK_DIRECTORY)),
    }).toEqual({
      status: 1,
      stderr:
        `Downloading ShellCheck 0.11.0 into ${join(emptyCacheHome, CACHED_SHELLCHECK_DIRECTORY)}\n` +
        "✕ Could not get ShellCheck: could not run curl: spawnSync curl ENOENT\n",
      cacheContents: [],
    })
  })

  it("exits 1 naming the platform when no ShellCheck build is pinned for it", () => {
    const preloadDirectory = createTempDirectory()
    const fakeArchModule = join(preloadDirectory, "fake-arch.mjs")
    writeFileSync(fakeArchModule, 'Object.defineProperty(process, "arch", { value: "riscv64" })\n')
    const emptyCacheHome = createTempDirectory()
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    // The fake arch loads after tsx: tsx's esbuild picks its native binary by
    // the arch when it loads, and there is no riscv64 one installed.
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        pathToFileURL(fakeArchModule).href,
        LINT_SHELL_SCRIPT,
        resolve(".claude/hooks/install-deps.sh"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CACHE_HOME: emptyCacheHome,
          PATH: putFakeCurlFirstOnPath(fakeCurl),
        },
      },
    )

    expect({
      status: run.status,
      stderr: run.stderr,
      curlCalls: readCallLog(fakeCurl.callLog),
    }).toEqual({
      status: 1,
      stderr: `✕ Could not get ShellCheck: no ShellCheck build is pinned for ${process.platform}-riscv64\n`,
      curlCalls: null,
    })
  })

  it("exits with ShellCheck's own status", () => {
    // 2 is ShellCheck's "could not read a file" status; it differs from the 1 the
    // script exits with when ShellCheck cannot run, so only a passed-through status matches.
    const fakeShellcheck = createCachedFakeShellcheck({ exitStatus: 2 })
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      env: { XDG_CACHE_HOME: fakeShellcheck.cacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({ status: run.status, checked: readCallLog(fakeShellcheck.callLog) }).toEqual({
      status: 2,
      checked: [".claude/hooks/install-deps.sh"],
    })
  })

  it("exits 1 when a signal ends ShellCheck", () => {
    const fakeShellcheck = createCachedFakeShellcheck({ exitStatus: 0 })
    writeRecordingCommand({
      commandPath: fakeShellcheck.binaryPath,
      callLog: fakeShellcheck.callLog,
      body: "kill -KILL $$",
      exitStatus: 0,
    })
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      env: { XDG_CACHE_HOME: fakeShellcheck.cacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({
      status: run.status,
      stderr: run.stderr,
      checked: readCallLog(fakeShellcheck.callLog),
    }).toEqual({ status: 1, stderr: "", checked: [".claude/hooks/install-deps.sh"] })
  })

  it("exits 1 naming the binary when the cached ShellCheck cannot be started", () => {
    const fakeShellcheck = createCachedFakeShellcheck({ exitStatus: 0 })
    chmodSync(fakeShellcheck.binaryPath, 0o644)
    const fakeCurl = createFakeCurl({ archiveContent: "", exitStatus: 0 })

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      env: { XDG_CACHE_HOME: fakeShellcheck.cacheHome, PATH: putFakeCurlFirstOnPath(fakeCurl) },
    })

    expect({
      status: run.status,
      stderr: run.stderr,
      checked: readCallLog(fakeShellcheck.callLog),
    }).toEqual({
      status: 1,
      stderr:
        `✕ Could not start ${fakeShellcheck.binaryPath}: ` +
        `spawnSync ${fakeShellcheck.binaryPath} EACCES\n`,
      checked: null,
    })
  })
})

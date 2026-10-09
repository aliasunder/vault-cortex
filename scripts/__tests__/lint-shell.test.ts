import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

const createTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "vault-cortex-lint-shell-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

type FakeShellcheck = {
  binDirectory: string
  /** The paths the fake was given, one per line; absent until it runs. */
  callLog: string
}

/** A `shellcheck` stand-in that records its arguments and exits with the
 *  given status. */
const createFakeShellcheck = ({ exitStatus }: { exitStatus: number }): FakeShellcheck => {
  const binDirectory = createTempDirectory()
  const callLog = join(binDirectory, "calls.log")
  const fakePath = join(binDirectory, "shellcheck")
  writeFileSync(fakePath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${callLog}'\nexit ${exitStatus}\n`)
  chmodSync(fakePath, 0o755)
  return { binDirectory, callLog }
}

const runLintShell = ({
  paths,
  pathVariable,
}: {
  paths: readonly string[]
  pathVariable: string
}): SpawnSyncReturns<string> => {
  return spawnSync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/lint-shell.ts"), ...paths],
    { encoding: "utf8", env: { ...process.env, PATH: pathVariable } },
  )
}

const readCheckedPaths = (fakeShellcheck: FakeShellcheck): string[] | null => {
  if (!existsSync(fakeShellcheck.callLog)) return null
  return readFileSync(fakeShellcheck.callLog, "utf8").trimEnd().split("\n")
}

describe("lint-shell script", () => {
  it("resolves shellcheck to the fake through PATH", () => {
    const fakeShellcheck = createFakeShellcheck({ exitStatus: 0 })

    const lookup = spawnSync("sh", ["-c", "command -v shellcheck"], {
      encoding: "utf8",
      env: { PATH: `${fakeShellcheck.binDirectory}:/usr/bin:/bin` },
    })

    expect(lookup.stdout.trim()).toBe(join(fakeShellcheck.binDirectory, "shellcheck"))
  })

  it("checks every shell script in the repo when given no paths", () => {
    const fakeShellcheck = createFakeShellcheck({ exitStatus: 0 })

    const run = runLintShell({ paths: [], pathVariable: fakeShellcheck.binDirectory })

    expect({ status: run.status, checked: readCheckedPaths(fakeShellcheck) }).toEqual({
      status: 0,
      checked: ALL_SHELL_SCRIPTS,
    })
  })

  it("checks only the given files that are shell scripts", () => {
    const fakeShellcheck = createFakeShellcheck({ exitStatus: 0 })

    const run = runLintShell({
      paths: [
        resolve(".claude/hooks/install-deps.sh"),
        resolve("README.md"),
        resolve("rootfs/etc/s6-overlay/s6-rc.d/svc-vault-mcp/up"),
        resolve("rootfs/usr/local/bin/get-sync-token"),
      ],
      pathVariable: fakeShellcheck.binDirectory,
    })

    expect({ status: run.status, checked: readCheckedPaths(fakeShellcheck) }).toEqual({
      status: 0,
      checked: [".claude/hooks/install-deps.sh", "rootfs/usr/local/bin/get-sync-token"],
    })
  })

  it("exits 0 without needing shellcheck when no given file is a shell script", () => {
    const emptyBinDirectory = createTempDirectory()

    const run = runLintShell({
      paths: [resolve("README.md"), resolve("package.json")],
      pathVariable: emptyBinDirectory,
    })

    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" })
  })

  it("exits 1 with the install hint when shellcheck cannot start", () => {
    const emptyBinDirectory = createTempDirectory()

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      pathVariable: emptyBinDirectory,
    })

    expect({ status: run.status, stderr: run.stderr }).toEqual({
      status: 1,
      stderr:
        "✕ Could not start shellcheck. Is it installed?\n" +
        "   install via: brew bundle (macOS, reads the repo's Brewfile) or apt-get install shellcheck (Linux)\n",
    })
  })

  it("exits with ShellCheck's status when it reports findings", () => {
    const fakeShellcheck = createFakeShellcheck({ exitStatus: 1 })

    const run = runLintShell({
      paths: [resolve(".claude/hooks/install-deps.sh")],
      pathVariable: fakeShellcheck.binDirectory,
    })

    expect({ status: run.status, checked: readCheckedPaths(fakeShellcheck) }).toEqual({
      status: 1,
      checked: [".claude/hooks/install-deps.sh"],
    })
  })
})

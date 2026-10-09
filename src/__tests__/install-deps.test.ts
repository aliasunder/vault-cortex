import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Behavioral spec for the dependency installer hook
 * (.claude/hooks/install-deps.sh): what it does with the marker an
 * interrupted install leaves behind. The real hook runs under `bash` with
 * real node, git and perl, and with stub `npm` and `npx` executables first on
 * PATH, so no install ever runs.
 */

const HOOK_PATH = resolve(import.meta.dirname, "../../.claude/hooks/install-deps.sh")

/** Stub `npm`: appends its arguments to STUB_NPM_LOG, one call per line. An
 *  `ls` call exits with STUB_NPM_LS_STATUS; every other call succeeds. */
const NPM_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_NPM_LOG"
case "$*" in
  "ls "*|*" ls "*) exit "\${STUB_NPM_LS_STATUS:-0}" ;;
esac
exit 0
`

/** Stub `npx`: appends its arguments to STUB_NPM_LOG and succeeds. */
const NPX_STUB = `#!/bin/sh
printf 'npx %s\\n' "$*" >> "$STUB_NPM_LOG"
exit 0
`

/** Every tool the hook runs on the marker-recovery path except perl, which
 *  takes the install lock. */
const HOOK_TOOLS_BESIDES_PERL = ["bash", "node", "git", "cat", "rm", "npm", "npx"]

type HookFixture = {
  /** A fresh git checkout with a lockfile, a node_modules folder and the SST
   *  platform types, symlinks resolved the way git reports it. */
  checkout: string
  /** The checkout's git directory, where the hook keeps its marker and stamp. */
  stateDir: string
  /** A folder in no checkout: the hook's working directory and HOME. */
  outsideDir: string
  stubBinDir: string
  npmLog: string
  /** The hash of the fixture's package-lock.json, as git reports it. */
  lockfileHash: string
}

type HookRun = {
  status: number | null
  stdout: string
  stderr: string
}

type HookRunOptions = {
  fixture: HookFixture
  /** What the stub `npm ls` exits with. Defaults to 0, a complete tree. */
  npmLsStatus?: number
  /** The hook's PATH. Defaults to the stubs ahead of the runner's PATH. */
  path?: string
}

/** The runner's own PATH, which the hook's real tools are found on. */
const runnerPath = (): string => {
  const path = process.env.PATH

  if (!path) throw new Error("the hook tests need a PATH")
  return path
}

/** PATH lookup skips a file without the executable bit, and would run the
 *  real binary instead. */
const writeExecutable = (path: string, script: string): void => {
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

const createHookFixture = (): HookFixture => {
  // realpath: git reports the checkout with symlinks resolved, and macOS's
  // tmpdir is a symlink.
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "install-deps-")))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const stubBinDir = join(tempDir, "bin")
  const checkout = join(tempDir, "checkout")
  const outsideDir = join(tempDir, "outside")
  for (const folder of [stubBinDir, outsideDir]) {
    mkdirSync(folder)
  }

  writeExecutable(join(stubBinDir, "npm"), NPM_STUB)
  writeExecutable(join(stubBinDir, "npx"), NPX_STUB)

  const gitEnv = { PATH: runnerPath(), HOME: outsideDir }
  execFileSync("git", ["init", "--quiet", checkout], { env: gitEnv, stdio: "pipe" })
  writeFileSync(join(checkout, "package.json"), '{"name":"fixture","version":"1.0.0"}\n')
  writeFileSync(join(checkout, "package-lock.json"), '{"name":"fixture","lockfileVersion":3}\n')
  mkdirSync(join(checkout, "node_modules"))
  // Present, so the hook never reaches for sst install.
  mkdirSync(join(checkout, ".sst", "platform"), { recursive: true })
  writeFileSync(join(checkout, ".sst", "platform", "config.d.ts"), "")
  const lockfileHash = execFileSync("git", ["-C", checkout, "hash-object", "package-lock.json"], {
    env: gitEnv,
    encoding: "utf8",
  }).trimEnd()

  return {
    checkout,
    stateDir: join(checkout, ".git"),
    outsideDir,
    stubBinDir,
    npmLog: join(tempDir, "npm.log"),
    lockfileHash,
  }
}

/** A PATH folder linking the stubs and the real tools, without perl. With
 *  the tools present, only the missing perl changes the hook's path: it
 *  installs without the lock. */
const createBinDirWithoutPerl = (fixture: HookFixture): string => {
  const binDir = join(fixture.outsideDir, "bin-without-perl")
  mkdirSync(binDir)
  const toolPaths = execFileSync(
    "bash",
    ["-c", 'command -v "$@"', "bash", ...HOOK_TOOLS_BESIDES_PERL],
    { encoding: "utf8", env: { PATH: `${fixture.stubBinDir}:${runnerPath()}` } },
  )
    .trimEnd()
    .split("\n")
  for (const toolPath of toolPaths) {
    symlinkSync(toolPath, join(binDir, basename(toolPath)))
  }
  return binDir
}

/** The marker's modification time, in seconds since the epoch. Fixed, so the
 *  hidden lockfile's age relative to it never depends on the clock. */
const MARKER_MTIME = 1_700_000_000

/** Leaves the marker an interrupted install of the current lockfile would. */
const leaveMarker = (fixture: HookFixture): void => {
  const markerPath = join(fixture.stateDir, "install-deps-incomplete")
  writeFileSync(markerPath, `${fixture.lockfileHash}\n`)
  utimesSync(markerPath, MARKER_MTIME, MARKER_MTIME)
}

/** Writes the node_modules/.package-lock.json that npm leaves when an install
 *  finishes, dated relative to the marker (negative: before it). */
const writeHiddenLockfile = (
  fixture: HookFixture,
  { secondsAfterMarker }: { secondsAfterMarker: number },
): void => {
  const hiddenLockfilePath = join(fixture.checkout, "node_modules", ".package-lock.json")
  writeFileSync(hiddenLockfilePath, '{"name":"fixture","lockfileVersion":3}\n')
  const hiddenLockfileMtime = MARKER_MTIME + secondsAfterMarker
  utimesSync(hiddenLockfilePath, hiddenLockfileMtime, hiddenLockfileMtime)
}

const runHook = (options: HookRunOptions): HookRun => {
  const { fixture } = options
  const result = spawnSync("bash", [HOOK_PATH], {
    cwd: fixture.outsideDir,
    // A worktree entry: the hook then never touches CLAUDE_ENV_FILE.
    input: JSON.stringify({ cwd: fixture.checkout, hook_event_name: "PostToolUse" }),
    encoding: "utf8",
    // Built from scratch, so no nvm, CLAUDE_PROJECT_DIR or GIT_DIR from the
    // runner's own environment reaches the hook.
    env: {
      PATH: options.path ?? `${fixture.stubBinDir}:${runnerPath()}`,
      HOME: fixture.outsideDir,
      STUB_NPM_LOG: fixture.npmLog,
      STUB_NPM_LS_STATUS: String(options.npmLsStatus ?? 0),
    },
  })

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The npm and npx calls the hook made, each as its space-joined arguments. */
const recordedNpmCalls = (fixture: HookFixture): string[] => {
  if (!existsSync(fixture.npmLog)) return []
  return readFileSync(fixture.npmLog, "utf8").trimEnd().split("\n")
}

/** The hook's marker and stamp after a run: whether the marker is still
 *  there, and what the stamp holds (null when unwritten). */
const installState = (fixture: HookFixture): { markerLeft: boolean; stamp: string | null } => {
  const stampPath = join(fixture.stateDir, "install-deps-lockhash")

  return {
    markerLeft: existsSync(join(fixture.stateDir, "install-deps-incomplete")),
    stamp: existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null,
  }
}

describe("install-deps hook", () => {
  it("resolves npm and npx to the stubs ahead of the real binaries", () => {
    const fixture = createHookFixture()

    const lookup = spawnSync("bash", ["-c", "command -v npm; command -v npx"], {
      cwd: fixture.outsideDir,
      encoding: "utf8",
      env: { PATH: `${fixture.stubBinDir}:${runnerPath()}` },
    })

    expect(lookup.stdout).toBe(`${fixture.stubBinDir}/npm\n${fixture.stubBinDir}/npx\n`)
  })

  describe("with a marker left by an interrupted install", () => {
    it("clears the marker and stamps the tree when it holds the lock, the install finished after the marker, and every depth of the tree resolves", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)
      writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })

      const run = runHook({ fixture })

      expect({
        status: run.status,
        stdout: run.stdout,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        npmCalls: [`--prefix ${fixture.checkout} ls --all`],
        markerLeft: false,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })

    it("reinstalls instead of trusting the tree when it could not take the lock", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)
      writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })

      const run = runHook({ fixture, path: createBinDirWithoutPerl(fixture) })

      expect({
        status: run.status,
        stdout: run.stdout,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        npmCalls: ["ci"],
        markerLeft: false,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })

    it("reinstalls when a dependency at any depth is missing", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)
      writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })

      const run = runHook({ fixture, npmLsStatus: 1 })

      expect({
        status: run.status,
        stdout: run.stdout,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        npmCalls: [`--prefix ${fixture.checkout} ls --all`, "ci"],
        markerLeft: false,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })

    it("reinstalls without consulting npm ls when the tree's hidden lockfile predates the marker", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)
      writeHiddenLockfile(fixture, { secondsAfterMarker: -60 })

      const run = runHook({ fixture })

      expect({
        status: run.status,
        stdout: run.stdout,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        npmCalls: ["ci"],
        markerLeft: false,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })

    it("reinstalls without consulting npm ls when the tree has no hidden lockfile", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)

      const run = runHook({ fixture })

      expect({
        status: run.status,
        stdout: run.stdout,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        npmCalls: ["ci"],
        markerLeft: false,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })
  })
})

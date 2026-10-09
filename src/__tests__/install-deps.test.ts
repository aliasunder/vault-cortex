import { execFileSync, spawn, spawnSync } from "node:child_process"
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
 *  `ls` call exits with STUB_NPM_LS_STATUS and a `ci` call with
 *  STUB_NPM_CI_STATUS; every other call succeeds. A `ci` call writes
 *  node_modules/.package-lock.json first when STUB_NPM_CI_WRITES_HIDDEN_LOCKFILE
 *  is 1, as npm does before the project's own lifecycle scripts run. */
const NPM_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_NPM_LOG"
case "$*" in
  "ls "*|*" ls "*) exit "\${STUB_NPM_LS_STATUS:-0}" ;;
  ci)
    if [ "\${STUB_NPM_CI_WRITES_HIDDEN_LOCKFILE:-0}" = 1 ]; then
      printf '{}\\n' > node_modules/.package-lock.json
    fi
    exit "\${STUB_NPM_CI_STATUS:-0}"
    ;;
esac
exit 0
`

/** Stub `npx`: appends its arguments to STUB_NPM_LOG and succeeds. */
const NPX_STUB = `#!/bin/sh
printf 'npx %s\\n' "$*" >> "$STUB_NPM_LOG"
exit 0
`

/** Stub nvm.sh for the fixture's HOME. The hook loads the first non-empty
 *  nvm.sh among $HOME/.nvm and /root/.nvm, so this file keeps a root run from
 *  loading the runner's own nvm, which would put a real npm ahead of the
 *  stubs. It defines no nvm command, so the hook's nvm steps are skipped. */
const NVM_STUB = `# nvm stand-in: defines nothing and leaves PATH as it is
`

/** The hash of a package-lock.json other than the fixture's: the lockfile an
 *  earlier install used. */
const OLDER_LOCKFILE_HASH = "1111111111111111111111111111111111111111"

/** Every tool the hook runs on the marker-recovery path except the two that
 *  take the install lock, perl and flock. */
const HOOK_TOOLS_BESIDES_PERL = ["bash", "node", "git", "cat", "rm", "npm", "npx"]

type HookFixture = {
  /** A fresh git checkout with a lockfile, a node_modules folder and the SST
   *  platform types, symlinks resolved the way git reports it. */
  checkout: string
  /** The checkout's git directory, where the hook keeps its marker and stamp. */
  stateDir: string
  /** A folder in no checkout: the hook's working directory and HOME, with
   *  the stub nvm.sh in .nvm/. */
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
  /** What the stub `npm ci` exits with. Defaults to 0, a finished install. */
  npmCiStatus?: number
  /** Whether the stub `npm ci` writes node_modules/.package-lock.json.
   *  Defaults to false. */
  npmCiWritesHiddenLockfile?: boolean
  /** The hook's PATH. Defaults to the stubs ahead of the runner's PATH. */
  path?: string
}

/** The runner's own PATH, which the hook's real tools are found on. */
const runnerPath = (): string => {
  const path = process.env.PATH

  if (!path) throw new Error("the hook tests need a PATH")
  return path
}

/** Has another process hold the install lock for a few seconds, the way a
 *  concurrent session's install would, and returns once it holds it. */
const holdInstallLock = (fixture: HookFixture, { seconds }: { seconds: number }): void => {
  const readyFile = join(fixture.outsideDir, "lock-held")
  const holder = spawn(
    "bash",
    [
      "-c",
      'exec 9>>"$1"; flock 9; : > "$2"; sleep "$3"',
      "bash",
      join(fixture.stateDir, "install-deps.lock"),
      readyFile,
      String(seconds),
    ],
    { env: { PATH: runnerPath() }, stdio: "ignore" },
  )
  onTestFinished(() => {
    holder.kill()
  })

  // A synchronous wait: runHook blocks the event loop, so the holder must
  // hold the lock before the hook starts.
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 250 && !existsSync(readyFile); attempt++) {
    Atomics.wait(pause, 0, 0, 20)
  }
  if (!existsSync(readyFile)) throw new Error("the lock holder never took the lock")
}

const flockCommandAvailable = (): boolean =>
  spawnSync("bash", ["-c", "command -v flock"], { env: { PATH: runnerPath() } }).status === 0

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
  mkdirSync(join(outsideDir, ".nvm"))
  writeFileSync(join(outsideDir, ".nvm", "nvm.sh"), NVM_STUB)

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

/** A PATH folder linking the stubs and the real tools, without perl, plus
 *  any extra tools named. With the other tools present, only the lock tools
 *  on it decide whether the hook can take the install lock. */
const createBinDirWithoutPerl = (
  fixture: HookFixture,
  { extraTools = [] }: { extraTools?: ReadonlyArray<string> } = {},
): string => {
  const binDir = join(fixture.outsideDir, "bin-without-perl")
  mkdirSync(binDir)
  const toolPaths = execFileSync(
    "bash",
    ["-c", 'command -v "$@"', "bash", ...HOOK_TOOLS_BESIDES_PERL, ...extraTools],
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

/** Leaves the marker an interrupted install would: of the current lockfile
 *  unless another lockfile hash is given. */
const leaveMarker = (
  fixture: HookFixture,
  { lockfileHash = fixture.lockfileHash }: { lockfileHash?: string } = {},
): void => {
  const markerPath = join(fixture.stateDir, "install-deps-incomplete")
  writeFileSync(markerPath, `${lockfileHash}\n`)
  utimesSync(markerPath, MARKER_MTIME, MARKER_MTIME)
}

/** Stamps the checkout as the hook's own install of another lockfile. */
const leaveOlderStamp = (fixture: HookFixture): void => {
  writeFileSync(join(fixture.stateDir, "install-deps-lockhash"), `${OLDER_LOCKFILE_HASH}\n`)
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
      STUB_NPM_CI_STATUS: String(options.npmCiStatus ?? 0),
      STUB_NPM_CI_WRITES_HIDDEN_LOCKFILE: options.npmCiWritesHiddenLockfile ? "1" : "0",
    },
  })

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The npm and npx calls the hook made, each as its space-joined arguments. */
const recordedNpmCalls = (fixture: HookFixture): string[] => {
  if (!existsSync(fixture.npmLog)) return []
  return readFileSync(fixture.npmLog, "utf8").trimEnd().split("\n")
}

const readFileIfPresent = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null

/** What the hook's marker and stamp hold after a run (null when absent). */
const installState = (fixture: HookFixture): { marker: string | null; stamp: string | null } => {
  return {
    marker: readFileIfPresent(join(fixture.stateDir, "install-deps-incomplete")),
    stamp: readFileIfPresent(join(fixture.stateDir, "install-deps-lockhash")),
  }
}

describe("install-deps hook", () => {
  it("resolves npm and npx to the stubs, with no nvm command, after loading the HOME nvm.sh the way the hook does", () => {
    const fixture = createHookFixture()
    // The hook's own condition: it loads $HOME/.nvm/nvm.sh only when the file
    // is non-empty, and otherwise falls through to /root/.nvm.
    const lookupScript = [
      'if [[ -s "$HOME/.nvm/nvm.sh" ]]; then . "$HOME/.nvm/nvm.sh"; echo "loaded $HOME/.nvm/nvm.sh"; fi',
      "command -v npm",
      "command -v npx",
      'command -v nvm || echo "no nvm command"',
    ].join("\n")

    const lookup = spawnSync("bash", ["-c", lookupScript], {
      cwd: fixture.outsideDir,
      encoding: "utf8",
      env: { PATH: `${fixture.stubBinDir}:${runnerPath()}`, HOME: fixture.outsideDir },
    })

    expect(lookup.stdout).toBe(
      [
        `loaded ${fixture.outsideDir}/.nvm/nvm.sh`,
        `${fixture.stubBinDir}/npm`,
        `${fixture.stubBinDir}/npx`,
        "no nvm command",
        "",
      ].join("\n"),
    )
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
        marker: null,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })

    it("reinstalls instead of trusting the tree when neither perl nor flock can take the lock", () => {
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
        marker: null,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })

    // flock(1) ships with util-linux on Linux and is missing on stock macOS.
    it.skipIf(!flockCommandAvailable())(
      "takes the lock with the flock command when perl is missing, so it recovers the tree",
      () => {
        const fixture = createHookFixture()
        leaveMarker(fixture)
        writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })

        const run = runHook({
          fixture,
          path: createBinDirWithoutPerl(fixture, { extraTools: ["flock"] }),
        })

        expect({
          status: run.status,
          stdout: run.stdout,
          npmCalls: recordedNpmCalls(fixture),
          ...installState(fixture),
        }).toEqual({
          status: 0,
          stdout: "",
          npmCalls: [`--prefix ${fixture.checkout} ls --all`],
          marker: null,
          stamp: `${fixture.lockfileHash}\n`,
        })
      },
    )

    it.skipIf(!flockCommandAvailable())(
      "waits with the flock command while another session holds the lock, then recovers the tree",
      () => {
        const fixture = createHookFixture()
        leaveMarker(fixture)
        writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })
        holdInstallLock(fixture, { seconds: 2 })

        const run = runHook({
          fixture,
          path: createBinDirWithoutPerl(fixture, { extraTools: ["flock"] }),
        })

        expect({
          status: run.status,
          waited: run.stderr
            .split("\n")
            .includes(
              `[install-deps] another session is installing in ${fixture.checkout} — waiting for it`,
            ),
          npmCalls: recordedNpmCalls(fixture),
          ...installState(fixture),
        }).toEqual({
          status: 0,
          waited: true,
          npmCalls: [`--prefix ${fixture.checkout} ls --all`],
          marker: null,
          stamp: `${fixture.lockfileHash}\n`,
        })
      },
    )

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
        marker: null,
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
        marker: null,
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
        marker: null,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })

    it("reinstalls without consulting npm ls when the marker names an older lockfile", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture, { lockfileHash: OLDER_LOCKFILE_HASH })
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
        npmCalls: ["ci"],
        marker: null,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })
  })

  describe("with no marker", () => {
    // Without a package-lock.json the lockfile hash is empty, and so is the
    // hash read from a missing marker, so only the marker's absence keeps
    // this tree from being taken for an interrupted install.
    it("reinstalls without consulting npm ls when a stamped checkout has lost its package-lock.json", () => {
      const fixture = createHookFixture()
      rmSync(join(fixture.checkout, "package-lock.json"))
      leaveOlderStamp(fixture)
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
        npmCalls: ["ci"],
        marker: null,
        stamp: `${OLDER_LOCKFILE_HASH}\n`,
      })
    })

    it("leaves a marker holding the current lockfile's hash, and the old stamp, when npm ci fails", () => {
      const fixture = createHookFixture()
      leaveOlderStamp(fixture)

      const run = runHook({ fixture, npmCiStatus: 1 })

      expect({
        status: run.status,
        stdout: run.stdout,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        npmCalls: ["ci"],
        marker: `${fixture.lockfileHash}\n`,
        stamp: `${OLDER_LOCKFILE_HASH}\n`,
      })
    })

    // npm ci writes the hidden lockfile before the project's own lifecycle
    // scripts run, so a failure in one of them leaves a hidden lockfile newer
    // than the marker the hook wrote before npm ci started.
    it("reinstalls on the next run, without consulting npm ls, when the failed npm ci wrote a hidden lockfile", () => {
      const fixture = createHookFixture()
      leaveOlderStamp(fixture)
      const failedRun = runHook({ fixture, npmCiStatus: 1, npmCiWritesHiddenLockfile: true })

      const nextRun = runHook({ fixture })

      expect({
        statuses: [failedRun.status, nextRun.status],
        hiddenLockfileWritten: existsSync(
          join(fixture.checkout, "node_modules", ".package-lock.json"),
        ),
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        statuses: [0, 0],
        hiddenLockfileWritten: true,
        npmCalls: ["ci", "ci"],
        marker: null,
        stamp: `${fixture.lockfileHash}\n`,
      })
    })
  })
})

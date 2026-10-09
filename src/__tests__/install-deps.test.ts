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

/** How the hook names the runner's Node in its stamp and marker, in runs
 *  whose PATH puts no stub Node folder (createNodeBinDir) first. */
const RUNNER_NODE_ABI = `node-abi-${process.versions.modules}`

/** The stamp of an earlier install of another lockfile under the same Node. */
const OLDER_INSTALL_IDENTITY = `${OLDER_LOCKFILE_HASH} ${RUNNER_NODE_ABI}`

/** An ABI no Node in use reports: a tree built under another Node. */
const OTHER_NODE_ABI = "node-abi-1"

/** Every tool the hook runs on the marker-recovery path except perl, which
 *  takes the install lock. */
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
  /** What the hook's stamp and marker hold for the fixture's lockfile
   *  installed under the runner's Node. */
  installIdentity: string
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
  /** The session event the hook runs for. Defaults to a worktree entry
   *  (PostToolUse), which never touches CLAUDE_ENV_FILE. */
  hookEventName?: "SessionStart" | "PostToolUse"
  /** CLAUDE_ENV_FILE for a SessionStart run. Unset by default. */
  claudeEnvFile?: string
  /** What the nvm stand-in from writeNvmStandIn answers. */
  nvmAnswers?: NvmAnswers
}

/** The node paths the nvm stand-in prints: for `nvm which --silent` (the
 *  .nvmrc version; null when nvm lacks it) and for `nvm which default`. */
type NvmAnswers = {
  nvmrcNode: string | null
  defaultNode: string
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
    installIdentity: `${lockfileHash} ${RUNNER_NODE_ABI}`,
  }
}

/** A PATH folder linking the stubs and the real tools, without perl. With
 *  the tools present, only the missing perl changes the hook's path: it
 *  cannot take the install lock. */
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

/** Leaves the marker an interrupted install would: of the current lockfile
 *  unless another lockfile hash is given. */
const leaveMarker = (
  fixture: HookFixture,
  { installIdentity = fixture.installIdentity }: { installIdentity?: string } = {},
): void => {
  const markerPath = join(fixture.stateDir, "install-deps-incomplete")
  writeFileSync(markerPath, `${installIdentity}\n`)
  utimesSync(markerPath, MARKER_MTIME, MARKER_MTIME)
}

/** Stamps the checkout as the hook's own install of another lockfile. */
const leaveOlderStamp = (fixture: HookFixture): void => {
  writeFileSync(join(fixture.stateDir, "install-deps-lockhash"), `${OLDER_INSTALL_IDENTITY}\n`)
}

/** Stamps the checkout as the hook's own install of its current lockfile. */
const stampCurrentLockfile = (fixture: HookFixture): void => {
  writeFileSync(join(fixture.stateDir, "install-deps-lockhash"), `${fixture.installIdentity}\n`)
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
    input: JSON.stringify({
      cwd: fixture.checkout,
      hook_event_name: options.hookEventName ?? "PostToolUse",
    }),
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
      ...(options.claudeEnvFile ? { CLAUDE_ENV_FILE: options.claudeEnvFile } : {}),
      STUB_NVM_NVMRC_NODE: options.nvmAnswers?.nvmrcNode ?? "",
      STUB_NVM_DEFAULT_NODE: options.nvmAnswers?.defaultNode ?? "",
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

/** nvm.sh stand-in defining an `nvm` command that answers the two lookups the
 *  hook makes. Like nvm, `nvm which --silent` reads .nvmrc from the current
 *  directory, so it fails unless the hook ran it inside the checkout, and
 *  without an .nvmrc it reads the unset VERSION, which ends a set -u shell. */
const NVM_STAND_IN = `nvm() {
  case "$*" in
    "which --silent")
      [ -f .nvmrc ] || { : "$VERSION"; return 1; }
      [ -n "$STUB_NVM_NVMRC_NODE" ] || return 1
      echo "$STUB_NVM_NVMRC_NODE"
      ;;
    "which default") echo "$STUB_NVM_DEFAULT_NODE" ;;
    *) return 1 ;;
  esac
}
`

const writeNvmStandIn = (fixture: HookFixture): void => {
  writeFileSync(join(fixture.outsideDir, ".nvm", "nvm.sh"), NVM_STAND_IN)
}

/** The ABI (process.versions.modules) each stub Node reports, as the real
 *  releases do, so a test can tell which Node's ABI the hook recorded. */
const STUB_NODE_ABIS = { v20: "115", v22: "127", v24: "137" } as const

/** A Node installation's bin folder, named by version. Its `node` reports the
 *  version's ABI and otherwise runs the runner's node (the hook parses its
 *  payload with whichever node comes first), and its `npm` logs each call
 *  prefixed with the version, so the log shows which Node's npm the hook ran. */
const createNodeBinDir = (fixture: HookFixture, version: keyof typeof STUB_NODE_ABIS): string => {
  const binDir = join(fixture.outsideDir, "node-versions", version, "bin")
  mkdirSync(binDir, { recursive: true })
  writeExecutable(
    join(binDir, "node"),
    [
      "#!/bin/sh",
      'if [ "$1" = "-p" ] && [ "$2" = "process.versions.modules" ]; then',
      `  echo ${STUB_NODE_ABIS[version]}`,
      "  exit 0",
      "fi",
      `exec "${process.execPath}" "$@"`,
      "",
    ].join("\n"),
  )
  writeExecutable(
    join(binDir, "npm"),
    `#!/bin/sh\nprintf '${version} %s\\n' "$*" >> "$STUB_NPM_LOG"\nexit 0\n`,
  )
  return binDir
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
        stamp: `${fixture.installIdentity}\n`,
      })
    })

    it("skips the install, keeping the marker, when perl is missing", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)
      writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })

      const run = runHook({ fixture, path: createBinDirWithoutPerl(fixture) })

      expect({
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        stderr: `[install-deps] perl not found, so the install lock cannot be taken — skipping the install in ${fixture.checkout}; run npm ci and npx sst install yourself\n`,
        npmCalls: [],
        marker: `${fixture.installIdentity}\n`,
        stamp: null,
      })
    })

    it("skips the install, keeping the marker, when perl cannot take the lock", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)
      writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })
      const binDir = createBinDirWithoutPerl(fixture)
      // Exit 2 is the hook's perl script failing to open or lock fd 9.
      writeExecutable(join(binDir, "perl"), "#!/bin/sh\nexit 2\n")

      const run = runHook({ fixture, path: binDir })

      expect({
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        stderr: `[install-deps] could not take the install lock in ${fixture.checkout} (perl exit 2) — skipping the install; run npm ci and npx sst install yourself\n`,
        npmCalls: [],
        marker: `${fixture.installIdentity}\n`,
        stamp: null,
      })
    })

    it("skips the install, keeping the marker, when the wait for another session's lock times out", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture)
      writeHiddenLockfile(fixture, { secondsAfterMarker: 60 })
      const binDir = createBinDirWithoutPerl(fixture)
      // Exit 75 is the hook's perl script giving up after the lock wait.
      writeExecutable(join(binDir, "perl"), "#!/bin/sh\nexit 75\n")

      const run = runHook({ fixture, path: binDir })

      expect({
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        stderr: `[install-deps] concurrent install still running after 480s in ${fixture.checkout} — skipping\n`,
        npmCalls: [],
        marker: `${fixture.installIdentity}\n`,
        stamp: null,
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
        marker: null,
        stamp: `${fixture.installIdentity}\n`,
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
        stamp: `${fixture.installIdentity}\n`,
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
        stamp: `${fixture.installIdentity}\n`,
      })
    })

    it("reinstalls without consulting npm ls when the marker names another Node", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture, { installIdentity: `${fixture.lockfileHash} ${OTHER_NODE_ABI}` })
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
        stamp: `${fixture.installIdentity}\n`,
      })
    })

    it("reinstalls without consulting npm ls when the marker names an older lockfile", () => {
      const fixture = createHookFixture()
      leaveMarker(fixture, { installIdentity: OLDER_INSTALL_IDENTITY })
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
        stamp: `${fixture.installIdentity}\n`,
      })
    })
  })

  describe("with dependencies already current", () => {
    it.each([
      { label: "the stamp matches the lockfile", stamp: true },
      { label: "the developer installed node_modules (no stamp)", stamp: false },
    ])("does nothing before taking the lock when $label", ({ stamp }) => {
      const fixture = createHookFixture()

      if (stamp) stampCurrentLockfile(fixture)

      const run = runHook({ fixture })

      expect({
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        npmCalls: recordedNpmCalls(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        stderr: `[install-deps] node_modules current in ${fixture.checkout} — nothing to do\n`,
        npmCalls: [],
      })
    })

    it("reinstalls a stamped checkout whose node_modules was deleted", () => {
      const fixture = createHookFixture()
      stampCurrentLockfile(fixture)
      rmSync(join(fixture.checkout, "node_modules"), { recursive: true })

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
        stamp: `${fixture.installIdentity}\n`,
      })
    })

    it("reinstalls a stamped checkout built under another Node, though its lockfile is unchanged", () => {
      const fixture = createHookFixture()
      writeFileSync(
        join(fixture.stateDir, "install-deps-lockhash"),
        `${fixture.lockfileHash} ${OTHER_NODE_ABI}\n`,
      )

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
        stamp: `${fixture.installIdentity}\n`,
      })
    })

    // The fast path needs the SST types too, so the hook takes the lock, finds
    // the dependencies current on the re-check, and installs only the types.
    it("installs only the SST platform types under the lock when they are missing", () => {
      const fixture = createHookFixture()
      stampCurrentLockfile(fixture)
      rmSync(join(fixture.checkout, ".sst", "platform", "config.d.ts"))

      const run = runHook({ fixture })

      expect({
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        npmCalls: recordedNpmCalls(fixture),
        ...installState(fixture),
      }).toEqual({
        status: 0,
        stdout: "",
        stderr: [
          `[install-deps] node_modules current in ${fixture.checkout}`,
          `[install-deps] installing SST platform types in ${fixture.checkout}`,
          "",
        ].join("\n"),
        npmCalls: ["npx sst install"],
        marker: null,
        stamp: `${fixture.installIdentity}\n`,
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
        stamp: `${OLDER_INSTALL_IDENTITY}\n`,
      })
    })

    it("leaves a marker naming the current lockfile and Node, and the old stamp, when npm ci fails", () => {
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
        marker: `${fixture.installIdentity}\n`,
        stamp: `${OLDER_INSTALL_IDENTITY}\n`,
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
        stamp: `${fixture.installIdentity}\n`,
      })
    })
  })

  describe("at session start", () => {
    it("writes the .nvmrc Node's folder into the session's PATH line", () => {
      const fixture = createHookFixture()
      writeFileSync(join(fixture.checkout, ".nvmrc"), "24\n")
      writeNvmStandIn(fixture)
      const nvmrcBin = createNodeBinDir(fixture, "v24")
      const defaultBin = createNodeBinDir(fixture, "v20")
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")

      const run = runHook({
        fixture,
        hookEventName: "SessionStart",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: join(nvmrcBin, "node"), defaultNode: join(defaultBin, "node") },
      })

      expect({ status: run.status, envFile: readFileIfPresent(claudeEnvFile) }).toEqual({
        status: 0,
        envFile: `export PATH="${nvmrcBin}:$PATH"\n`,
      })
    })

    it("adds the PATH line only once when a resumed session runs the hook again", () => {
      const fixture = createHookFixture()
      writeFileSync(join(fixture.checkout, ".nvmrc"), "24\n")
      writeNvmStandIn(fixture)
      const nvmrcBin = createNodeBinDir(fixture, "v24")
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")
      const sessionStartRun = {
        fixture,
        hookEventName: "SessionStart",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: join(nvmrcBin, "node"), defaultNode: join(nvmrcBin, "node") },
      } as const

      const firstRun = runHook(sessionStartRun)
      const resumedRun = runHook(sessionStartRun)

      expect({
        statuses: [firstRun.status, resumedRun.status],
        envFile: readFileIfPresent(claudeEnvFile),
      }).toEqual({
        statuses: [0, 0],
        envFile: `export PATH="${nvmrcBin}:$PATH"\n`,
      })
    })

    it("adds the PATH line again when the session's file ends on another Node's line", () => {
      const fixture = createHookFixture()
      writeFileSync(join(fixture.checkout, ".nvmrc"), "24\n")
      writeNvmStandIn(fixture)
      const nvmrcBin = createNodeBinDir(fixture, "v24")
      const otherBin = createNodeBinDir(fixture, "v20")
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")
      const earlierLines = `export PATH="${nvmrcBin}:$PATH"\nexport PATH="${otherBin}:$PATH"\n`
      writeFileSync(claudeEnvFile, earlierLines)

      const run = runHook({
        fixture,
        hookEventName: "SessionStart",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: join(nvmrcBin, "node"), defaultNode: join(otherBin, "node") },
      })

      expect({
        status: run.status,
        envFile: readFileIfPresent(claudeEnvFile),
      }).toEqual({
        status: 0,
        envFile: `${earlierLines}export PATH="${nvmrcBin}:$PATH"\n`,
      })
    })

    // Without an .nvmrc, nvm which reads an unset variable, so this passes only
    // while the hook turns set -u off for the lookup.
    it("writes nvm's default Node into the PATH line when the checkout has no .nvmrc", () => {
      const fixture = createHookFixture()
      writeNvmStandIn(fixture)
      const defaultBin = createNodeBinDir(fixture, "v20")
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")

      const run = runHook({
        fixture,
        hookEventName: "SessionStart",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: null, defaultNode: join(defaultBin, "node") },
      })

      expect({ status: run.status, envFile: readFileIfPresent(claudeEnvFile) }).toEqual({
        status: 0,
        envFile: `export PATH="${defaultBin}:$PATH"\n`,
      })
    })

    it("leaves the session's PATH alone, and says so, when nvm finds no Node", () => {
      const fixture = createHookFixture()
      writeNvmStandIn(fixture)
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")

      const run = runHook({
        fixture,
        hookEventName: "SessionStart",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: null, defaultNode: "" },
      })

      expect({
        status: run.status,
        stderr: run.stderr,
        envFile: readFileIfPresent(claudeEnvFile),
      }).toEqual({
        status: 0,
        stderr: [
          `[install-deps] no nvm Node found for ${fixture.checkout} — later commands keep the session's PATH`,
          `[install-deps] node_modules current in ${fixture.checkout} — nothing to do`,
          "",
        ].join("\n"),
        envFile: null,
      })
    })
  })

  describe("choosing the Node", () => {
    // Native modules are built for the Node that installs them, so the
    // install and the session's later commands must use the same one.
    it("installs with, and puts on later commands' PATH, the .nvmrc Node rather than the one the launching shell put first", () => {
      const fixture = createHookFixture()
      writeFileSync(join(fixture.checkout, ".nvmrc"), "24\n")
      leaveOlderStamp(fixture)
      writeNvmStandIn(fixture)
      const launchingShellBin = createNodeBinDir(fixture, "v22")
      const nvmrcBin = createNodeBinDir(fixture, "v24")
      const defaultBin = createNodeBinDir(fixture, "v20")
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")

      const run = runHook({
        fixture,
        path: `${launchingShellBin}:${fixture.stubBinDir}:${runnerPath()}`,
        hookEventName: "SessionStart",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: join(nvmrcBin, "node"), defaultNode: join(defaultBin, "node") },
      })

      expect({
        status: run.status,
        npmCalls: recordedNpmCalls(fixture),
        envFile: readFileIfPresent(claudeEnvFile),
        stamp: installState(fixture).stamp,
      }).toEqual({
        status: 0,
        npmCalls: ["v24 ci"],
        envFile: `export PATH="${nvmrcBin}:$PATH"\n`,
        stamp: `${fixture.lockfileHash} node-abi-137\n`,
      })
    })

    it("installs with, and puts on later commands' PATH, nvm's default Node when nvm lacks the .nvmrc version", () => {
      const fixture = createHookFixture()
      writeFileSync(join(fixture.checkout, ".nvmrc"), "24\n")
      leaveOlderStamp(fixture)
      writeNvmStandIn(fixture)
      const launchingShellBin = createNodeBinDir(fixture, "v22")
      const defaultBin = createNodeBinDir(fixture, "v20")
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")

      const run = runHook({
        fixture,
        path: `${launchingShellBin}:${fixture.stubBinDir}:${runnerPath()}`,
        hookEventName: "SessionStart",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: null, defaultNode: join(defaultBin, "node") },
      })

      expect({
        status: run.status,
        npmCalls: recordedNpmCalls(fixture),
        envFile: readFileIfPresent(claudeEnvFile),
        stamp: installState(fixture).stamp,
      }).toEqual({
        status: 0,
        npmCalls: ["v20 ci"],
        envFile: `export PATH="${defaultBin}:$PATH"\n`,
        stamp: `${fixture.lockfileHash} node-abi-115\n`,
      })
    })

    it("installs with the .nvmrc Node on a worktree entry too, without writing a PATH line", () => {
      const fixture = createHookFixture()
      writeFileSync(join(fixture.checkout, ".nvmrc"), "24\n")
      leaveOlderStamp(fixture)
      writeNvmStandIn(fixture)
      const launchingShellBin = createNodeBinDir(fixture, "v22")
      const nvmrcBin = createNodeBinDir(fixture, "v24")
      const defaultBin = createNodeBinDir(fixture, "v20")
      const claudeEnvFile = join(fixture.outsideDir, "claude-env")

      const run = runHook({
        fixture,
        path: `${launchingShellBin}:${fixture.stubBinDir}:${runnerPath()}`,
        hookEventName: "PostToolUse",
        claudeEnvFile,
        nvmAnswers: { nvmrcNode: join(nvmrcBin, "node"), defaultNode: join(defaultBin, "node") },
      })

      expect({
        status: run.status,
        npmCalls: recordedNpmCalls(fixture),
        envFile: readFileIfPresent(claudeEnvFile),
        stamp: installState(fixture).stamp,
      }).toEqual({
        status: 0,
        npmCalls: ["v24 ci"],
        envFile: null,
        stamp: `${fixture.lockfileHash} node-abi-137\n`,
      })
    })
  })
})

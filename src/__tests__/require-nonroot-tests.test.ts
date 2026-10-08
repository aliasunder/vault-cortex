import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Behavioral spec for the Claude Code hook that stops test runs in a root
 * session (.claude/hooks/require-nonroot-tests.sh): which commands it stops,
 * which checkout's folders it prepares, and the reply it gives. The real hook
 * runs under `bash` with real node and git, and with stub `id`, `setpriv` and
 * `chown` executables first on PATH. The stub `id` poses as root and reports
 * the test runner's own ids for nobody, so the hook's chown needs no
 * privileges.
 */

const HOOK_PATH = resolve(import.meta.dirname, "../../.claude/hooks/require-nonroot-tests.sh")

/** Stub `id`: `-u` prints STUB_SESSION_UID (0 poses as root), `nobody`
 *  succeeds only when STUB_NOBODY_EXISTS is 1, and `-u nobody` / `-g nobody`
 *  print STUB_NOBODY_UID / STUB_NOBODY_GID. Any other call fails loudly. */
const ID_STUB = `#!/bin/sh
case "$*" in
  "-u") echo "$STUB_SESSION_UID" ;;
  "nobody")
    if [ "$STUB_NOBODY_EXISTS" = "1" ]; then
      echo "uid=$STUB_NOBODY_UID(nobody) gid=$STUB_NOBODY_GID(nogroup)"
    else
      echo "id: 'nobody': no such user" >&2
      exit 1
    fi
    ;;
  "-u nobody") echo "$STUB_NOBODY_UID" ;;
  "-g nobody") echo "$STUB_NOBODY_GID" ;;
  *)
    echo "stub id: unexpected arguments: $*" >&2
    exit 64
    ;;
esac
`

/** Stub `setpriv`: drops its own options and runs the rest of the command
 *  with STUB_NOBODY_PATH as PATH, standing in for the PATH entries nobody
 *  can read. */
const SETPRIV_STUB = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --*) shift ;;
    *) break ;;
  esac
done
PATH="$STUB_NOBODY_PATH"
export PATH
exec "$@"
`

/** Stub `chown`: appends its arguments to STUB_CHOWN_LOG, one call per line,
 *  then runs the real chown. */
const CHOWN_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_CHOWN_LOG"
exec "$(command -p -v chown)" "$@"
`

/** The node nobody finds: prints STUB_NOBODY_NODE_VERSION. */
const NOBODY_NODE_STUB = `#!/bin/sh
echo "$STUB_NOBODY_NODE_VERSION"
`

/** The fixture checkout's .nvmrc, and a nobody node version that matches it. */
const NVMRC_VERSION = "24"
const MATCHING_NODE_VERSION = "v24.11.0"

const SNAPSHOTS_FOLDER = "src/vault-mcp/mcp-core/__tests__/__snapshots__"

type HookFixture = {
  /** A fresh git checkout with a node_modules folder and an .nvmrc, symlinks
   *  resolved the way `git rev-parse --show-toplevel` reports it. */
  checkout: string
  /** A folder in no checkout: the hook's working directory and HOME. */
  outsideDir: string
  stubBinDir: string
  /** nobody's PATH when it has a node: holds only the node stub. */
  nobodyBinDir: string
  /** nobody's PATH when it has no node. */
  emptyBinDir: string
  chownLog: string
}

type HookRun = {
  status: number | null
  stdout: string
  stderr: string
}

type HookRunOptions = {
  fixture: HookFixture
  /** The hook's stdin, usually built by payloadFor. */
  stdin: string
  /** What the stub `id -u` prints. Defaults to 0, posing as root. */
  sessionUid?: number
  /** Whether the stub `id nobody` succeeds. Defaults to true. */
  nobodyExists?: boolean
  /** Whether nobody finds a node on PATH. Defaults to true. */
  nobodyHasNode?: boolean
  /** What nobody's node prints for --version. Defaults to a version that
   *  matches the fixture's .nvmrc. */
  nobodyNodeVersion?: string
  claudeProjectDir?: string
}

/** The test runner's own ids, which the stub reports for nobody: chown to
 *  your own uid and primary group needs no privileges. */
const runnerIds = (): { uid: number; gid: number } => {
  const uid = process.geteuid?.()
  const gid = process.getegid?.()

  if (uid === undefined || gid === undefined) throw new Error("the hook tests need POSIX ids")
  return { uid, gid }
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
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "require-nonroot-tests-")))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const stubBinDir = join(tempDir, "bin")
  const nobodyBinDir = join(tempDir, "nobody-bin")
  const emptyBinDir = join(tempDir, "empty-bin")
  const checkout = join(tempDir, "checkout")
  const outsideDir = join(tempDir, "outside")
  for (const folder of [stubBinDir, nobodyBinDir, emptyBinDir, outsideDir]) {
    mkdirSync(folder)
  }

  writeExecutable(join(stubBinDir, "id"), ID_STUB)
  writeExecutable(join(stubBinDir, "setpriv"), SETPRIV_STUB)
  writeExecutable(join(stubBinDir, "chown"), CHOWN_STUB)
  writeExecutable(join(nobodyBinDir, "node"), NOBODY_NODE_STUB)

  execFileSync("git", ["init", "--quiet", checkout], {
    env: { PATH: process.env.PATH ?? "", HOME: outsideDir },
    stdio: "pipe",
  })
  mkdirSync(join(checkout, "node_modules"))
  writeFileSync(join(checkout, ".nvmrc"), `${NVMRC_VERSION}\n`)
  return {
    checkout,
    outsideDir,
    stubBinDir,
    nobodyBinDir,
    emptyBinDir,
    chownLog: join(tempDir, "chown.log"),
  }
}

const hookEnv = (options: Omit<HookRunOptions, "stdin">): Record<string, string> => {
  const { uid, gid } = runnerIds()
  const { fixture } = options

  // Built from scratch, so a CLAUDE_PROJECT_DIR or GIT_DIR in the runner's
  // own environment never reaches the hook.
  return {
    PATH: `${fixture.stubBinDir}:${process.env.PATH ?? ""}`,
    HOME: fixture.outsideDir,
    STUB_SESSION_UID: String(options.sessionUid ?? 0),
    STUB_NOBODY_EXISTS: options.nobodyExists === false ? "0" : "1",
    STUB_NOBODY_UID: String(uid),
    STUB_NOBODY_GID: String(gid),
    STUB_NOBODY_PATH: options.nobodyHasNode === false ? fixture.emptyBinDir : fixture.nobodyBinDir,
    STUB_NOBODY_NODE_VERSION: options.nobodyNodeVersion ?? MATCHING_NODE_VERSION,
    STUB_CHOWN_LOG: fixture.chownLog,
    ...(options.claudeProjectDir ? { CLAUDE_PROJECT_DIR: options.claudeProjectDir } : {}),
  }
}

const runHook = (options: HookRunOptions): HookRun => {
  const result = spawnSync("bash", [HOOK_PATH], {
    // Outside any checkout, so the hook's "." fallback can never reach the
    // repo running these tests.
    cwd: options.fixture.outsideDir,
    input: options.stdin,
    encoding: "utf8",
    env: hookEnv(options),
  })

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const payloadFor = ({ command, cwd }: { command: string; cwd?: string }): string =>
  JSON.stringify({ tool_input: { command }, ...(cwd ? { cwd } : {}) })

/** Runs the hook on a command issued from the fixture's checkout. */
const runCommandThroughHook = (fixture: HookFixture, command: string): HookRun =>
  runHook({ fixture, stdin: payloadFor({ command, cwd: fixture.checkout }) })

/** The hook's reply to a stopped run, test-owned so a change to the prefix
 *  or the wording shows up here. */
const expectedRefusal = (checkout: string): string => {
  const { uid, gid } = runnerIds()

  return [
    "Tests do not run as root in this repo: root reads the files the permission tests make unreadable, so those tests fail here but pass in CI.",
    "Run the same test command as the nobody user, with this prefix in front of the test command itself (after any cd):",
    `  setpriv --reuid=${uid} --regid=${gid} --clear-groups env HOME=${checkout}/node_modules/.nobody-home`,
    `The folders nobody needs to write in ${checkout} are ready.`,
    "",
  ].join("\n")
}

const scratchFolders = (checkout: string): string[] => [
  join(checkout, "node_modules", ".vite-temp"),
  join(checkout, "node_modules", ".vitest"),
  join(checkout, "node_modules", ".nobody-home"),
  join(checkout, "coverage"),
]

const permissionBits = (path: string): number => statSync(path).mode & 0o777

/** The chown calls the hook made, each as its space-joined arguments. */
const recordedChownCalls = (fixture: HookFixture): string[] => {
  if (!existsSync(fixture.chownLog)) return []
  return readFileSync(fixture.chownLog, "utf8").trimEnd().split("\n")
}

const LET_THROUGH: HookRun = { status: 0, stdout: "", stderr: "" }

describe("require-nonroot-tests hook", () => {
  it("resolves id, setpriv and chown to the stubs ahead of the real binaries", () => {
    const fixture = createHookFixture()

    const lookup = spawnSync(
      "bash",
      ["-c", "command -v id; command -v setpriv; command -v chown"],
      { cwd: fixture.outsideDir, encoding: "utf8", env: hookEnv({ fixture }) },
    )

    expect(lookup.stdout).toBe(
      `${fixture.stubBinDir}/id\n${fixture.stubBinDir}/setpriv\n${fixture.stubBinDir}/chown\n`,
    )
  })

  describe("in a root session", () => {
    it.each([
      { label: "npm test", command: "npm test" },
      { label: "a test command on a second line", command: "git status\nnpm test" },
      { label: "a test command after cd and &&", command: "cd / && npm test" },
      { label: "npx vitest", command: "npx vitest run x" },
      {
        label: "vitest by its path under node_modules/.bin",
        command: "node_modules/.bin/vitest run",
      },
      { label: "node running vitest.mjs", command: "node node_modules/vitest/vitest.mjs run" },
      { label: "npm run snapshot:update", command: "npm run snapshot:update" },
      { label: "a subshell", command: "(cd sub; npm test)" },
      { label: "a subshell inside command substitution", command: "out=$( (npm test) )" },
      { label: "a backtick substitution", command: "out=`npm test 2>&1`" },
      { label: "a variable setting before npx", command: "CI=1 npx vitest run" },
      { label: "env with a variable setting", command: "env CI=1 npm test" },
      { label: "env with a flag", command: "env -i npm test" },
      { label: "a double-quoted value with a space", command: 'FOO="a b" npm test' },
      { label: "time", command: "time npm test" },
      { label: "time with a flag", command: "time -p npm test" },
      {
        label: "timeout with a flag argument and a duration",
        command: "timeout -k 5 600 npm test",
      },
      { label: "timeout with a named signal", command: "timeout -s KILL 600 npm test" },
      { label: "an if condition", command: "if npm test; then :; fi" },
      { label: "a while condition", command: "while npm test; do :; done" },
      { label: "an until condition", command: "until npm test; do sleep 1; done" },
      { label: "a brace group", command: "{ npm test; }" },
      {
        label: "a test run after an exempt suite's npm script",
        command: "npm run test:cli-pty && npm test",
      },
      {
        label: "a vitest run whose test filter names an exempt suite",
        command: "npm run test:remote-boot; npx vitest run -t cli-pty",
      },
      {
        label: "a test run after a command that mentions setpriv",
        command: "grep setpriv notes; npm test",
      },
      {
        label: "a test run after a run through setpriv",
        command:
          "setpriv --reuid=65534 --regid=65534 --clear-groups env HOME=/repo/node_modules/.nobody-home npm test; npm test",
      },
    ])("stops $label and replies with the nobody prefix", ({ command }) => {
      const fixture = createHookFixture()

      const run = runCommandThroughHook(fixture, command)

      expect(run).toEqual({ status: 2, stdout: "", stderr: expectedRefusal(fixture.checkout) })
    })

    // Each case also stops `npm test` in the same fixture, so the pass-through
    // comes from the command itself, not from a fixture the hook bails on.
    it.each([
      { label: "git status", command: "git status" },
      { label: "a mention of vitest as an argument", command: "grep vitest package.json" },
      { label: "a lookup of vitest with command -v", command: "command -v vitest" },
      { label: "a quoted mention of npm test", command: 'echo "npm test"' },
      { label: "a script whose name only starts with test", command: "npm run testx" },
      { label: "npm run test:remote-boot", command: "npm run test:remote-boot" },
      { label: "npm run test:cli-pty", command: "npm run test:cli-pty" },
      {
        label: "vitest with the cli-pty config",
        command: "npx vitest run --config vitest.cli-pty.config.ts",
      },
      {
        label: "vitest with the remote-boot config, given with = and a path",
        command: "npx vitest run --config=./vitest.remote-boot.config.ts",
      },
      { label: "a variable setting as an argument", command: "echo CI=1 npm test" },
      { label: "a variable setting before another command", command: "FOO=1 echo npm test" },
      { label: "env with a flag running another command", command: "env -i echo npm test" },
      { label: "timeout running another command", command: "timeout 600 echo npm test" },
      {
        label: "a command already run through setpriv",
        command:
          "setpriv --reuid=65534 --regid=65534 --clear-groups env HOME=/repo/node_modules/.nobody-home npm test",
      },
    ])("lets $label through without preparing folders", ({ command }) => {
      const fixture = createHookFixture()

      const run = runCommandThroughHook(fixture, command)
      const foldersMade = scratchFolders(fixture.checkout).filter((folder) => existsSync(folder))
      const controlRun = runCommandThroughHook(fixture, "npm test")

      expect({ run, foldersMade, controlStatus: controlRun.status }).toEqual({
        run: LET_THROUGH,
        foldersMade: [],
        controlStatus: 2,
      })
    })

    it("lets a payload that is not JSON through", () => {
      const fixture = createHookFixture()

      const run = runHook({ fixture, stdin: "{not json" })
      const controlRun = runCommandThroughHook(fixture, "npm test")

      expect({ run, controlStatus: controlRun.status }).toEqual({
        run: LET_THROUGH,
        controlStatus: 2,
      })
    })

    it.each([
      { label: "npm run test:coverage", command: "npm run test:coverage" },
      { label: "vitest --coverage", command: "npx vitest run --coverage" },
    ])("adds the coverage hint to the reply for $label", ({ command }) => {
      const coverageHint =
        "For a coverage run, also pass --coverage.clean=false (after -- for npm run): vitest otherwise deletes coverage/ first, which nobody cannot do in a root-owned checkout.\n"
      const fixture = createHookFixture()

      const run = runCommandThroughHook(fixture, command)

      expect(run).toEqual({
        status: 2,
        stdout: "",
        stderr: `${expectedRefusal(fixture.checkout)}${coverageHint}`,
      })
    })

    it("leaves the coverage hint out when only an exempt suite's run asks for coverage", () => {
      const fixture = createHookFixture()

      const run = runCommandThroughHook(
        fixture,
        "npx vitest run --config vitest.cli-pty.config.ts --coverage; npm test",
      )

      expect(run).toEqual({ status: 2, stdout: "", stderr: expectedRefusal(fixture.checkout) })
    })

    it("adds a line to the reply when nobody's node is another major version than .nvmrc", () => {
      const fixture = createHookFixture()

      const run = runHook({
        fixture,
        stdin: payloadFor({ command: "npm test", cwd: fixture.checkout }),
        nobodyNodeVersion: "v22.22.0",
      })

      expect(run).toEqual({
        status: 2,
        stdout: "",
        stderr: `${expectedRefusal(fixture.checkout)}nobody's node is v22.22.0, not the 24 that .nvmrc names and CI runs, so a result can differ from CI's.\n`,
      })
    })

    it("adds a line to the reply when nobody finds no node", () => {
      const fixture = createHookFixture()

      const run = runHook({
        fixture,
        stdin: payloadFor({ command: "npm test", cwd: fixture.checkout }),
        nobodyHasNode: false,
      })

      expect(run).toEqual({
        status: 2,
        stdout: "",
        stderr: `${expectedRefusal(fixture.checkout)}nobody finds no node on PATH, so the prefixed command fails until a Node outside root's home is on PATH.\n`,
      })
    })

    it("leaves the version line out when .nvmrc names an alias rather than a version", () => {
      const fixture = createHookFixture()
      writeFileSync(join(fixture.checkout, ".nvmrc"), "lts/*\n")

      const run = runHook({
        fixture,
        stdin: payloadFor({ command: "npm test", cwd: fixture.checkout }),
        nobodyNodeVersion: "v22.22.0",
      })

      expect(run).toEqual({ status: 2, stdout: "", stderr: expectedRefusal(fixture.checkout) })
    })

    it("creates the four scratch folders a test run writes", () => {
      const fixture = createHookFixture()

      const run = runCommandThroughHook(fixture, "npm test")
      const missingFolders = scratchFolders(fixture.checkout).filter(
        (folder) => !existsSync(folder),
      )

      expect({ status: run.status, missingFolders }).toEqual({ status: 2, missingFolders: [] })
    })

    it("gives the scratch folders to nobody", () => {
      const fixture = createHookFixture()
      const { uid, gid } = runnerIds()

      const run = runCommandThroughHook(fixture, "npm test")

      expect({ status: run.status, chownCalls: recordedChownCalls(fixture) }).toEqual({
        status: 2,
        chownCalls: [`-R ${uid}:${gid} ${scratchFolders(fixture.checkout).join(" ")}`],
      })
    })

    it("gives the tool-surface snapshot folder to nobody along with the scratch folders", () => {
      const fixture = createHookFixture()
      const { uid, gid } = runnerIds()
      const snapshotsFolder = join(fixture.checkout, SNAPSHOTS_FOLDER)
      mkdirSync(join(snapshotsFolder, "tool-surface"), { recursive: true })

      const run = runCommandThroughHook(fixture, "npm test")
      const nobodyOwnedFolders = [...scratchFolders(fixture.checkout), snapshotsFolder]

      expect({ status: run.status, chownCalls: recordedChownCalls(fixture) }).toEqual({
        status: 2,
        chownCalls: [`-R ${uid}:${gid} ${nobodyOwnedFolders.join(" ")}`],
      })
    })

    it("closes the scratch folders, and files left inside them, to group and other writes", () => {
      const fixture = createHookFixture()
      const folders = scratchFolders(fixture.checkout)
      for (const folder of folders) {
        mkdirSync(folder, { recursive: true })
        chmodSync(folder, 0o777)
      }
      // A file an earlier root run left behind.
      const leftoverFile = join(fixture.checkout, "node_modules", ".vitest", "results.json")
      writeFileSync(leftoverFile, "{}")
      chmodSync(leftoverFile, 0o666)

      const run = runCommandThroughHook(fixture, "npm test")

      expect({
        status: run.status,
        folderModes: folders.map(permissionBits),
        leftoverFileMode: permissionBits(leftoverFile),
      }).toEqual({
        status: 2,
        folderModes: [0o755, 0o755, 0o755, 0o755],
        leftoverFileMode: 0o644,
      })
    })

    it("closes the tool-surface snapshot folder, and the files in it, to group and other writes", () => {
      const fixture = createHookFixture()
      const snapshotFolder = join(fixture.checkout, SNAPSHOTS_FOLDER, "tool-surface")
      const snapshotFile = join(snapshotFolder, "default.json")
      mkdirSync(snapshotFolder, { recursive: true })
      chmodSync(snapshotFolder, 0o777)
      writeFileSync(snapshotFile, "{}")
      chmodSync(snapshotFile, 0o666)

      const run = runCommandThroughHook(fixture, "npm test")

      expect({
        status: run.status,
        folderMode: permissionBits(snapshotFolder),
        fileMode: permissionBits(snapshotFile),
      }).toEqual({ status: 2, folderMode: 0o755, fileMode: 0o644 })
    })

    it("prepares the checkout a leading cd names, not the session's folder", () => {
      const fixture = createHookFixture()

      const run = runHook({
        fixture,
        stdin: payloadFor({
          command: `cd ${fixture.checkout} && npm test`,
          cwd: fixture.outsideDir,
        }),
      })
      // Without the cd, the session's folder is in no checkout.
      const controlRun = runHook({
        fixture,
        stdin: payloadFor({ command: "npm test", cwd: fixture.outsideDir }),
      })

      expect({ run, controlStatus: controlRun.status }).toEqual({
        run: { status: 2, stdout: "", stderr: expectedRefusal(fixture.checkout) },
        controlStatus: 0,
      })
    })

    it("uses CLAUDE_PROJECT_DIR when the payload has no cwd", () => {
      const fixture = createHookFixture()
      const stdin = payloadFor({ command: "npm test" })

      const run = runHook({ fixture, stdin, claudeProjectDir: fixture.checkout })
      // Without it, the hook falls back to its own working directory, which is
      // in no checkout.
      const controlRun = runHook({ fixture, stdin })

      expect({ run, controlStatus: controlRun.status }).toEqual({
        run: { status: 2, stdout: "", stderr: expectedRefusal(fixture.checkout) },
        controlStatus: 0,
      })
    })

    it("lets a test run through, creating nothing, in a checkout without node_modules", () => {
      const fixture = createHookFixture()
      const nodeModules = join(fixture.checkout, "node_modules")
      rmSync(nodeModules, { recursive: true })

      const run = runCommandThroughHook(fixture, "npm test")
      const nodeModulesCreated = existsSync(nodeModules)
      mkdirSync(nodeModules)
      const controlRun = runCommandThroughHook(fixture, "npm test")

      expect({ run, nodeModulesCreated, controlStatus: controlRun.status }).toEqual({
        run: LET_THROUGH,
        nodeModulesCreated: false,
        controlStatus: 2,
      })
    })

    it("lets a test run through when there is no nobody user", () => {
      const fixture = createHookFixture()
      const stdin = payloadFor({ command: "npm test", cwd: fixture.checkout })

      const run = runHook({ fixture, stdin, nobodyExists: false })
      const controlRun = runHook({ fixture, stdin })

      expect({ run, controlStatus: controlRun.status }).toEqual({
        run: LET_THROUGH,
        controlStatus: 2,
      })
    })
  })

  it("lets a test run through in a non-root session without preparing folders", () => {
    const fixture = createHookFixture()
    const stdin = payloadFor({ command: "npm test", cwd: fixture.checkout })

    const run = runHook({ fixture, stdin, sessionUid: 1000 })
    const foldersMade = scratchFolders(fixture.checkout).filter((folder) => existsSync(folder))
    const controlRun = runHook({ fixture, stdin, sessionUid: 0 })

    expect({ run, foldersMade, controlStatus: controlRun.status }).toEqual({
      run: LET_THROUGH,
      foldersMade: [],
      controlStatus: 2,
    })
  })
})

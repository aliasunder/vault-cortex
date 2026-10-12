/**
 * Reruns a root vitest run as a user the permission tests can rely on.
 * Root ignores file permissions, so tests that chmod a file or folder to deny
 * access, then expect the access to fail, fail as root and pass in CI.
 * - vitest.config.ts calls `rerunRootTestRun` while vitest loads it, before
 *   any test file, the coverage provider or the watcher starts.
 * - The rerun runs as nobody when root owns the checkout (a cloud or agent
 *   container's clone), and as the checkout's owner otherwise (a contributor's
 *   checkout mounted into a root container).
 * - When no rerun is possible, it prints one warning and the run continues as
 *   root, so a root run is never worse than it was without this guard.
 */

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { parseCLI } from "vitest/node"

/** The rerun's HOME under node_modules, where npm keeps its cache and logs. */
const TEST_HOME_FOLDER = ".test-home"

/** Folders under node_modules the rerun writes in: vite's config bundle,
 *  vitest's results cache, and the rerun's HOME. */
const NODE_MODULES_SCRATCH_FOLDERS = [".vite-temp", ".vite/vitest", TEST_HOME_FOLDER]

/** The only folder inside the checkout that tests write (`snapshot:update`
 *  rewrites it). A test that writes another folder needs it handed over too,
 *  or the rerun cannot write there. */
const SNAPSHOT_FOLDER = "src/vault-mcp/mcp-core/__tests__/__snapshots__"

/** A plain shell word that needs no quoting when the command is printed. */
const SHELL_SAFE_WORD = /^[\w@%+=:,./-]+$/

/** The leading major number of a Node version (`24`, `v24.1.0`), ending at a
 *  dot, whitespace or the end of the text. */
const NODE_MAJOR_VERSION = /^v?(\d+)(?:[.\s]|$)/

/** Write access for group and other, removed from every handed-over path. */
const GROUP_AND_OTHER_WRITE = 0o022

/** rwxr-xr-x: the Node copy and its folders stay root-owned and unwritable by
 *  the target, but the target can run the copy. */
const EXECUTABLE_BY_ALL_MODE = 0o755

type RerunTarget = {
  /** nobody for a root-owned checkout; the checkout's owner otherwise. */
  kind: "nobody" | "owner"
  /** How messages name the target: a user name, or a phrase for an owner. */
  label: string
  uid: number
  gid: number
}

/** Why a rerun can't happen, named in the warning. */
type WarningCause =
  | { kind: "no-setpriv" }
  | { kind: "no-nobody-user" }
  | { kind: "setpriv-fails"; targetLabel: string }
  | { kind: "config-unreadable"; targetLabel: string }
  | { kind: "node-unrunnable"; targetLabel: string }
  | { kind: "prepare-failed"; reason: string }
  | { kind: "spawn-failed"; reason: string }

/** The user the rerun runs as, or why there is none. */
type TargetLookup = { kind: "found"; target: RerunTarget } | { kind: "none"; cause: WarningCause }

/** What the target can do, each probed by running a command as the target. */
type TargetProbes = {
  setprivWorks: boolean
  /** The config file stands in for the checkout: vitest must read it first. */
  canReadConfig: boolean
  canRunNode: boolean
  /** True when NODE_EXTRA_CA_CERTS is unset; probed only when it is set. */
  canReadExtraCaCerts: boolean
}

type NodeChoice =
  { kind: "as-is"; nodePath: string } | { kind: "copy"; sourcePath: string; nodePath: string }

type RerunPlan = {
  kind: "rerun"
  target: RerunTarget
  /** Handed to the target and left with it after the run: the scratch
   *  folders under node_modules, the snapshot folder, and coverage/ on a
   *  coverage run. */
  foldersToHandOver: readonly string[]
  coverageFolderToEmpty: string | null
  node: NodeChoice
  setprivArguments: readonly string[]
  announcement: string
}

type GuardPlan = { kind: "warn"; message: string } | RerunPlan

const describeWarningCause = (cause: WarningCause): string => {
  switch (cause.kind) {
    case "no-setpriv":
      return "setpriv is not installed"
    case "no-nobody-user":
      return "this system has no nobody user"
    case "setpriv-fails":
      return `setpriv cannot switch to ${cause.targetLabel}`
    case "config-unreadable":
      return `${cause.targetLabel} cannot read the checkout`
    case "node-unrunnable":
      return `${cause.targetLabel} cannot run this Node binary`
    case "prepare-failed":
      return `preparing the rerun failed (${cause.reason})`
    case "spawn-failed":
      return `starting the rerun failed (${cause.reason})`
  }
}

const formatWarning = (cause: WarningCause): string => {
  return `vitest is running as root, which ignores the file permissions some tests check, so those tests will fail. It cannot rerun them as another user: ${describeWarningCause(cause)}.`
}

/** The major version a Node version or .nvmrc names, or null for an alias
 *  such as lts/*. */
export const readNodeMajor = (versionText: string): number | null => {
  const majorText = NODE_MAJOR_VERSION.exec(versionText.trimStart())?.[1]

  if (!majorText) return null
  return Number(majorText)
}

/** setpriv's flags that switch to the target's uid and gid and drop root's
 *  supplementary groups. */
const buildSwitchArguments = (target: RerunTarget): string[] => {
  return [`--reuid=${target.uid}`, `--regid=${target.gid}`, "--clear-groups"]
}

/** Quotes a word for a POSIX shell only when it needs it. */
const quoteForShell = (word: string): string => {
  if (SHELL_SAFE_WORD.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * Appends the flags a non-root coverage run needs. vitest cleans by deleting
 * coverage/ itself, which needs write access to the checkout folder, and root
 * owns that folder in a container's clone. So the guard empties coverage/ as
 * root and vitest must not clean it. vitest ignores flags after a lone `--`,
 * so they go before one.
 */
export const addCoverageFlags = (vitestArguments: readonly string[]): string[] => {
  const coverageFlags = ["--coverage.clean=false", "--coverage.cleanOnRerun=false"]
  const doubleDashIndex = vitestArguments.indexOf("--")

  if (doubleDashIndex === -1) return [...vitestArguments, ...coverageFlags]
  return [
    ...vitestArguments.slice(0, doubleDashIndex),
    ...coverageFlags,
    ...vitestArguments.slice(doubleDashIndex),
  ]
}

/** Whether the vitest command line turns coverage on, read the way vitest
 *  reads it. parseCLI wants "vitest" first and rewrites the array it gets. */
export const isCoverageRun = (vitestArguments: readonly string[]): boolean => {
  const { options } = parseCLI(["vitest", ...vitestArguments])
  return options.coverage?.enabled === true
}

/** The Node binary the rerun starts, or null when the target has none it can
 *  run. */
const chooseNode = ({
  canRunNode,
  target,
  execPath,
  nodeCopyPath,
}: {
  canRunNode: boolean
  target: RerunTarget
  execPath: string
  nodeCopyPath: string
}): NodeChoice | null => {
  if (canRunNode) return { kind: "as-is", nodePath: execPath }
  // The target cannot run root's Node when it sits under /root, as nvm's
  // does: /root is mode 700, so no other user can enter it. A copy in the
  // checkout fixes that, but in an owner's checkout it would leave a large
  // root-owned file the owner cannot delete, so an owner gets the warning.
  if (target.kind === "owner") return null
  // nobody can already read the checkout (the config probe passed), and the
  // copy's folders are created mode 755, so nobody can reach and run it.
  return { kind: "copy", sourcePath: execPath, nodePath: nodeCopyPath }
}

/** Plans the guard's response for a root run whose target is known. */
export const planRootRun = ({
  checkoutRoot,
  target,
  probes,
  execPath,
  nodeVersion,
  nvmrcText,
  execArguments,
  vitestEntry,
  vitestArguments,
  extraCaCertsSet,
  pathEnvironment,
}: {
  checkoutRoot: string
  target: RerunTarget
  probes: TargetProbes
  execPath: string
  nodeVersion: string
  nvmrcText: string | null
  execArguments: readonly string[]
  vitestEntry: string
  vitestArguments: readonly string[]
  extraCaCertsSet: boolean
  pathEnvironment: string
}): GuardPlan => {
  if (!probes.setprivWorks) {
    return {
      kind: "warn",
      message: formatWarning({ kind: "setpriv-fails", targetLabel: target.label }),
    }
  }
  if (!probes.canReadConfig) {
    return {
      kind: "warn",
      message: formatWarning({ kind: "config-unreadable", targetLabel: target.label }),
    }
  }

  const nodeCopyPath = join(
    checkoutRoot,
    "node_modules",
    ".nobody-node",
    `node-${nodeVersion}`,
    "node",
  )
  const node = chooseNode({ canRunNode: probes.canRunNode, target, execPath, nodeCopyPath })

  if (!node) {
    return {
      kind: "warn",
      message: formatWarning({ kind: "node-unrunnable", targetLabel: target.label }),
    }
  }

  const nodeModules = join(checkoutRoot, "node_modules")
  const coverageFolder = join(checkoutRoot, "coverage")
  const coverageRun = isCoverageRun(vitestArguments)
  const foldersToHandOver = [
    ...NODE_MODULES_SCRATCH_FOLDERS.map((folderName) => join(nodeModules, folderName)),
    join(checkoutRoot, SNAPSHOT_FOLDER),
    // Only a coverage run writes in coverage/.
    ...(coverageRun ? [coverageFolder] : []),
  ]

  const rerunArguments = coverageRun ? addCoverageFlags(vitestArguments) : [...vitestArguments]
  // Node warns on stderr at every start when it cannot read this file, and
  // tests that assert a child's exact stderr then fail.
  const unsetsExtraCaCerts = extraCaCertsSet && !probes.canReadExtraCaCerts
  const environmentArguments = [
    ...(unsetsExtraCaCerts ? ["-u", "NODE_EXTRA_CA_CERTS"] : []),
    `HOME=${join(nodeModules, TEST_HOME_FOLDER)}`,
  ]
  const commandAfterPath = [node.nodePath, ...execArguments, vitestEntry, ...rerunArguments]
  const switchArguments = buildSwitchArguments(target)
  // The Node folder goes first on PATH so that a test starting a bare `node`
  // child process gets the same binary as the rerun.
  const nodeFolder = dirname(node.nodePath)
  const setprivArguments = [
    ...switchArguments,
    "/usr/bin/env",
    ...environmentArguments,
    `PATH=${nodeFolder}:${pathEnvironment}`,
    ...commandAfterPath,
  ]

  // The guard runs the command itself; it is printed so the reader sees what
  // runs as whom. Rerunning it by hand works once the guard has prepared the
  // folders, as it has by the time the line prints. $PATH stays literal, so
  // the line stays short and still runs as written in a shell.
  const printedCommand = [
    "setpriv",
    ...switchArguments,
    "/usr/bin/env",
    ...environmentArguments.map(quoteForShell),
    `PATH=${quoteForShell(nodeFolder)}:"$PATH"`,
    ...commandAfterPath.map(quoteForShell),
  ].join(" ")

  // The rerun uses the Node that started vitest, whatever its major. CI runs
  // the .nvmrc major, and a different one can pass or fail tests CI doesn't.
  const nvmrcMajor = nvmrcText === null ? null : readNodeMajor(nvmrcText)
  const nodeMajor = readNodeMajor(nodeVersion)
  const versionNote =
    nvmrcMajor !== null && nvmrcMajor !== nodeMajor
      ? ` .nvmrc names Node ${nvmrcMajor}, which CI runs, so a result can differ from CI's.`
      : ""

  return {
    kind: "rerun",
    target,
    foldersToHandOver,
    coverageFolderToEmpty: coverageRun ? coverageFolder : null,
    node,
    setprivArguments,
    announcement: `Root ignores the file permissions some tests check, so the tests rerun as ${target.label} (uid ${target.uid}) on Node ${nodeVersion}.${versionNote}\n  ${printedCommand}`,
  }
}

/** Changes the owner of a path without following a symlink. */
type ChangeOwner = (params: { path: string; uid: number; gid: number }) => void

/** Hands a folder and everything inside it to the target, and removes group
 *  and other write access, because vitest runs code from its caches. */
const handOverFolder = ({
  folder,
  target,
  changeOwner,
}: {
  folder: string
  target: RerunTarget
  changeOwner: ChangeOwner
}): void => {
  const entries = readdirSync(folder, { recursive: true, encoding: "utf8" })
  const paths = [folder, ...entries.map((entry) => join(folder, entry))]

  for (const path of paths) {
    changeOwner({ path, uid: target.uid, gid: target.gid })
    const stats = lstatSync(path)

    // chmod would follow a symlink to its target.
    if (stats.isSymbolicLink()) continue
    chmodSync(path, stats.mode & ~GROUP_AND_OTHER_WRITE)
  }
}

/** Copies the Node binary for nobody, root-owned and readable by all, under a
 *  temp name first so a half-written copy never sits at the path a later run
 *  reuses. */
const copyNodeBinary = ({
  sourcePath,
  nodePath,
}: {
  sourcePath: string
  nodePath: string
}): void => {
  if (existsSync(nodePath)) return

  const temporaryPath = `${nodePath}.${process.pid}`

  mkdirSync(dirname(nodePath), { recursive: true, mode: EXECUTABLE_BY_ALL_MODE })
  try {
    copyFileSync(sourcePath, temporaryPath)
    chmodSync(temporaryPath, EXECUTABLE_BY_ALL_MODE)
    renameSync(temporaryPath, nodePath)
  } finally {
    // Removes a half-written copy when the copy or chmod threw; after a
    // successful rename the temp name no longer exists.
    rmSync(temporaryPath, { force: true })
  }
}

/** Prepares the folders and Node binary a rerun plan needs. */
export const prepareRerun = ({
  plan,
  changeOwner,
}: {
  plan: RerunPlan
  changeOwner: ChangeOwner
}): void => {
  if (plan.coverageFolderToEmpty && existsSync(plan.coverageFolderToEmpty)) {
    for (const entry of readdirSync(plan.coverageFolderToEmpty)) {
      rmSync(join(plan.coverageFolderToEmpty, entry), { recursive: true, force: true })
    }
  }

  for (const folder of plan.foldersToHandOver) {
    mkdirSync(folder, { recursive: true })
    handOverFolder({ folder, target: plan.target, changeOwner })
  }

  if (plan.node.kind === "copy") copyNodeBinary(plan.node)
}

/** Runs a command as the target and reports whether it exited 0. */
const runsAsTarget = ({
  target,
  command,
}: {
  target: RerunTarget
  command: readonly string[]
}): boolean => {
  const result = spawnSync("setpriv", [...buildSwitchArguments(target), ...command], {
    stdio: "ignore",
  })
  return result.status === 0
}

/** The id `id` prints for a user, or null when there is no such user. */
const readUserId = ({ flag, user }: { flag: "-u" | "-g"; user: string }): number | null => {
  const result = spawnSync("id", [flag, user], { encoding: "utf8" })

  if (result.status !== 0) return null
  return Number(result.stdout.trim())
}

const findRerunTarget = (checkoutRoot: string): TargetLookup => {
  const setprivCheck = spawnSync("setpriv", ["--version"], { stdio: "ignore" })

  if (setprivCheck.error) return { kind: "none", cause: { kind: "no-setpriv" } }

  const checkoutStats = statSync(checkoutRoot)

  if (checkoutStats.uid !== 0) {
    const owner: RerunTarget = {
      kind: "owner",
      label: "the checkout's owner",
      uid: checkoutStats.uid,
      gid: checkoutStats.gid,
    }

    return { kind: "found", target: owner }
  }

  const nobodyUid = readUserId({ flag: "-u", user: "nobody" })
  const nobodyGid = readUserId({ flag: "-g", user: "nobody" })

  if (nobodyUid === null || nobodyGid === null) {
    return { kind: "none", cause: { kind: "no-nobody-user" } }
  }
  return {
    kind: "found",
    target: { kind: "nobody", label: "nobody", uid: nobodyUid, gid: nobodyGid },
  }
}

const probeTarget = ({
  target,
  configPath,
  execPath,
  extraCaCerts,
}: {
  target: RerunTarget
  configPath: string
  execPath: string
  extraCaCerts: string | undefined
}): TargetProbes => {
  const passesFileTest = (testFlag: "-r" | "-x", path: string): boolean => {
    // The path goes in as "$1", never inside the script, so the shell does
    // not parse it; "sh" fills $0, the slot before $1.
    const command = ["/bin/sh", "-c", `test ${testFlag} "$1"`, "sh", path]

    return runsAsTarget({ target, command })
  }

  return {
    setprivWorks: runsAsTarget({ target, command: ["true"] }),
    canReadConfig: passesFileTest("-r", configPath),
    canRunNode: passesFileTest("-x", execPath),
    canReadExtraCaCerts: extraCaCerts ? passesFileTest("-r", extraCaCerts) : true,
  }
}

/**
 * Called by vitest.config.ts while vitest loads it. Does nothing unless the
 * process is root. Otherwise reruns the same vitest command as another user
 * and exits with its status, or prints a warning and returns so the run
 * continues as root.
 */
export const rerunRootTestRun = ({
  checkoutRoot,
  configPath,
}: {
  checkoutRoot: string
  configPath: string
}): void => {
  // The rerun loads this config again as its own user, so this check is what
  // keeps the rerun from rerunning itself.
  if (process.getuid?.() !== 0) return

  const warn = (cause: WarningCause): void => {
    process.stderr.write(`${formatWarning(cause)}\n`)
  }
  const targetLookup = findRerunTarget(checkoutRoot)

  if (targetLookup.kind === "none") {
    warn(targetLookup.cause)
    return
  }

  const { target } = targetLookup

  const extraCaCerts = process.env.NODE_EXTRA_CA_CERTS
  const nvmrcPath = join(checkoutRoot, ".nvmrc")
  const [, vitestEntry, ...vitestArguments] = process.argv

  // Node always puts the script it runs (vitest's entry) in argv[1].
  if (!vitestEntry) throw new Error("vitest's entry file is missing from process.argv")

  const plan = planRootRun({
    checkoutRoot,
    target,
    probes: probeTarget({
      target,
      configPath,
      execPath: process.execPath,
      extraCaCerts,
    }),
    execPath: process.execPath,
    nodeVersion: process.version,
    nvmrcText: existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf8") : null,
    execArguments: process.execArgv,
    vitestEntry,
    vitestArguments,
    extraCaCertsSet: Boolean(extraCaCerts),
    pathEnvironment: process.env.PATH ?? "",
  })

  if (plan.kind === "warn") {
    process.stderr.write(`${plan.message}\n`)
    return
  }

  try {
    prepareRerun({
      plan,
      changeOwner: ({ path, uid, gid }) => lchownSync(path, uid, gid),
    })
  } catch (error) {
    warn({ kind: "prepare-failed", reason: error instanceof Error ? error.message : String(error) })
    return
  }

  process.stderr.write(`${plan.announcement}\n`)

  const rerun = spawnSync("setpriv", [...plan.setprivArguments], { stdio: "inherit" })

  if (rerun.error) {
    warn({ kind: "spawn-failed", reason: rerun.error.message })
    return
  }
  // status is null when a signal ended the rerun; that run failed too.
  process.exit(rerun.status ?? 1)
}

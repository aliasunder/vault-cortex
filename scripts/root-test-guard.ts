/**
 * Reruns a root vitest run as a user the permission tests can rely on.
 * Root ignores file permissions, so tests that chmod a file or folder to deny
 * access, then expect the access to fail, fail as root and pass in CI.
 * - vitest.config.ts calls `stopRootTestRun` while vitest loads it, before any
 *   test file, the coverage provider or the watcher starts.
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

/** Folder names under node_modules the rerun writes in: vite's config
 *  bundle, vitest's cache, and the rerun's HOME (npm's cache and logs). */
const NODE_MODULES_SCRATCH_FOLDERS = [".vite-temp", ".vitest", ".test-home"]

/** The one snapshot folder in the repo; `snapshot:update` rewrites it. */
const SNAPSHOT_FOLDER = "src/vault-mcp/mcp-core/__tests__/__snapshots__"

/** A plain shell word that needs no quoting when the command is printed. */
const SHELL_SAFE_WORD = /^[\w@%+=:,./-]+$/

type RerunTarget = {
  /** nobody for a root-owned checkout; the checkout's owner otherwise. */
  kind: "nobody" | "owner"
  name: string
  uid: number
  gid: number
}

/** Why a rerun can't happen, named in the warning. */
type WarningCause =
  | { kind: "no-setpriv" }
  | { kind: "no-nobody-user" }
  | { kind: "setpriv-fails"; targetName: string }
  | { kind: "config-unreadable"; targetName: string }
  | { kind: "node-unrunnable"; targetName: string }
  | { kind: "prepare-failed"; reason: string }
  | { kind: "spawn-failed"; reason: string }

/** What the target can do, each probed by running a command as the target. */
type TargetProbes = {
  setprivWorks: boolean
  canReadConfig: boolean
  canRunNode: boolean
  /** Only probed when NODE_EXTRA_CA_CERTS is set. */
  canReadExtraCaCerts: boolean
}

type NodeChoice =
  { kind: "as-is"; nodePath: string } | { kind: "copy"; sourcePath: string; nodePath: string }

type RerunPlan = {
  kind: "rerun"
  target: RerunTarget
  scratchFolders: readonly string[]
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
      return `setpriv cannot switch to ${cause.targetName}`
    case "config-unreadable":
      return `${cause.targetName} cannot read the checkout`
    case "node-unrunnable":
      return `${cause.targetName} cannot run this Node binary`
    case "prepare-failed":
      return `preparing the rerun failed (${cause.reason})`
    case "spawn-failed":
      return `starting the rerun failed (${cause.reason})`
  }
}

const formatWarning = (cause: WarningCause): string => {
  return `vitest is running as root, which ignores the file permissions some tests check, so those tests will fail. It cannot rerun them as another user: ${describeWarningCause(cause)}.`
}

/** The major version .nvmrc names, or null for an alias such as lts/*. */
export const readNvmrcMajor = (nvmrcText: string): number | null => {
  const firstWord = nvmrcText.trimStart().split(/\s/)[0] ?? ""
  const majorText = firstWord.replace(/^v/, "").split(".")[0] ?? ""

  if (!/^\d+$/.test(majorText)) return null
  return Number(majorText)
}

/** Quotes a word for a POSIX shell only when it needs it. */
const quoteForShell = (word: string): string => {
  if (SHELL_SAFE_WORD.test(word)) return word
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * Appends the flags a non-root coverage run needs: it cannot delete
 * coverage/ from a root-owned checkout, so the guard empties the folder as
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
  // An owner's checkout never gets a root-owned binary copied into it.
  if (target.kind === "owner") return null
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
  coverageRun,
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
  coverageRun: boolean
  extraCaCertsSet: boolean
  pathEnvironment: string
}): GuardPlan => {
  if (!probes.setprivWorks) {
    return {
      kind: "warn",
      message: formatWarning({ kind: "setpriv-fails", targetName: target.name }),
    }
  }
  if (!probes.canReadConfig) {
    return {
      kind: "warn",
      message: formatWarning({ kind: "config-unreadable", targetName: target.name }),
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
      message: formatWarning({ kind: "node-unrunnable", targetName: target.name }),
    }
  }

  const nodeModules = join(checkoutRoot, "node_modules")
  const home = join(nodeModules, ".test-home")
  const coverageFolder = join(checkoutRoot, "coverage")
  const scratchFolders = [
    ...NODE_MODULES_SCRATCH_FOLDERS.map((folderName) => join(nodeModules, folderName)),
    coverageFolder,
    join(checkoutRoot, SNAPSHOT_FOLDER),
  ]
  const unsetsExtraCaCerts = extraCaCertsSet && !probes.canReadExtraCaCerts
  const rerunArguments = coverageRun ? addCoverageFlags(vitestArguments) : [...vitestArguments]
  const environmentArguments = [
    ...(unsetsExtraCaCerts ? ["-u", "NODE_EXTRA_CA_CERTS"] : []),
    `HOME=${home}`,
  ]
  const commandAfterPath = [node.nodePath, ...execArguments, vitestEntry, ...rerunArguments]
  const switchArguments = [`--reuid=${target.uid}`, `--regid=${target.gid}`, "--clear-groups"]
  const nodeFolder = dirname(node.nodePath)
  const setprivArguments = [
    ...switchArguments,
    "/usr/bin/env",
    ...environmentArguments,
    `PATH=${nodeFolder}:${pathEnvironment}`,
    ...commandAfterPath,
  ]
  // The printed command keeps $PATH literal, so it stays short and still
  // runs as written in a shell.
  const printedCommand = [
    "setpriv",
    ...switchArguments,
    "/usr/bin/env",
    ...environmentArguments.map(quoteForShell),
    `PATH=${quoteForShell(nodeFolder)}:"$PATH"`,
    ...commandAfterPath.map(quoteForShell),
  ].join(" ")
  const nvmrcMajor = nvmrcText === null ? null : readNvmrcMajor(nvmrcText)
  const nodeMajor = Number(nodeVersion.replace(/^v/, "").split(".")[0])
  const versionNote =
    nvmrcMajor !== null && nvmrcMajor !== nodeMajor
      ? ` .nvmrc names Node ${nvmrcMajor}, which CI runs, so a result can differ from CI's.`
      : ""

  return {
    kind: "rerun",
    target,
    scratchFolders,
    coverageFolderToEmpty: coverageRun ? coverageFolder : null,
    node,
    setprivArguments,
    announcement: `Root ignores the file permissions some tests check, so the tests rerun as ${target.name} (uid ${target.uid}) on Node ${nodeVersion}.${versionNote}\n  ${printedCommand}`,
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
    chmodSync(path, stats.mode & ~0o022)
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

  mkdirSync(dirname(nodePath), { recursive: true, mode: 0o755 })
  try {
    copyFileSync(sourcePath, temporaryPath)
    chmodSync(temporaryPath, 0o755)
    renameSync(temporaryPath, nodePath)
  } finally {
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
  for (const folder of plan.scratchFolders) {
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
  const result = spawnSync(
    "setpriv",
    [`--reuid=${target.uid}`, `--regid=${target.gid}`, "--clear-groups", ...command],
    { stdio: "ignore" },
  )
  return result.status === 0
}

/** The id `id` prints for a user, or null when there is no such user. */
const readUserId = ({ flag, user }: { flag: "-u" | "-g"; user: string }): number | null => {
  const result = spawnSync("id", [flag, user], { encoding: "utf8" })

  if (result.status !== 0) return null
  return Number(result.stdout.trim())
}

/** The user the rerun runs as, or the reason there is none. */
const findRerunTarget = (checkoutRoot: string): RerunTarget | WarningCause => {
  const setprivCheck = spawnSync("setpriv", ["--version"], { stdio: "ignore" })

  if (setprivCheck.error) return { kind: "no-setpriv" }

  const checkoutStats = statSync(checkoutRoot)

  if (checkoutStats.uid !== 0) {
    return {
      kind: "owner",
      name: "the checkout's owner",
      uid: checkoutStats.uid,
      gid: checkoutStats.gid,
    }
  }

  const nobodyUid = readUserId({ flag: "-u", user: "nobody" })
  const nobodyGid = readUserId({ flag: "-g", user: "nobody" })

  if (nobodyUid === null || nobodyGid === null) return { kind: "no-nobody-user" }
  return { kind: "nobody", name: "nobody", uid: nobodyUid, gid: nobodyGid }
}

const isRerunTarget = (value: RerunTarget | WarningCause): value is RerunTarget => {
  return value.kind === "nobody" || value.kind === "owner"
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
  const testsFile = (testFlag: "-r" | "-x", path: string): boolean => {
    return runsAsTarget({ target, command: ["/bin/sh", "-c", `test ${testFlag} "$1"`, "sh", path] })
  }

  return {
    setprivWorks: runsAsTarget({ target, command: ["true"] }),
    canReadConfig: testsFile("-r", configPath),
    canRunNode: testsFile("-x", execPath),
    canReadExtraCaCerts: extraCaCerts ? testsFile("-r", extraCaCerts) : true,
  }
}

/**
 * Called by vitest.config.ts while vitest loads it. Does nothing unless the
 * process is root. Otherwise reruns the same vitest command as another user
 * and exits with its status, or prints a warning and returns so the run
 * continues as root.
 */
export const stopRootTestRun = ({
  checkoutRoot,
  configPath,
}: {
  checkoutRoot: string
  configPath: string
}): void => {
  if (process.getuid?.() !== 0) return

  const warn = (cause: WarningCause): void => {
    process.stderr.write(`${formatWarning(cause)}\n`)
  }
  const targetOrCause = findRerunTarget(checkoutRoot)

  if (!isRerunTarget(targetOrCause)) {
    warn(targetOrCause)
    return
  }

  const extraCaCerts = process.env.NODE_EXTRA_CA_CERTS
  const nvmrcPath = join(checkoutRoot, ".nvmrc")
  const [, vitestEntry, ...vitestArguments] = process.argv

  // Node always puts the script it runs (vitest's entry) in argv[1].
  if (!vitestEntry) throw new Error("vitest's entry file is missing from process.argv")

  const plan = planRootRun({
    checkoutRoot,
    target: targetOrCause,
    probes: probeTarget({
      target: targetOrCause,
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
    coverageRun: isCoverageRun(vitestArguments),
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
  process.exit(rerun.status ?? 1)
}

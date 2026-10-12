import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  addCoverageFlags,
  isCoverageRun,
  planRootRun,
  prepareRerun,
  readNodeMajor,
  removeLeftoverConfigBundles,
  rerunRootTestRun,
} from "../root-test-guard.js"

vi.mock("node:child_process", { spy: true })
vi.mock("node:fs", { spy: true })

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs")

const CHECKOUT = "/repo"
const ROOT_NODE = "/root/.nvm/versions/node/v24.21.0/bin/node"
const VITEST_ENTRY = "/repo/node_modules/.bin/vitest"
const NOBODY = { kind: "nobody", label: "nobody", uid: 65534, gid: 65534 } as const
const OWNER = { kind: "owner", label: "the checkout's owner", uid: 1000, gid: 1000 } as const
const ALL_PROBES_PASS = {
  setprivWorks: true,
  canReadConfig: true,
  canRunNode: true,
  canReadExtraCaCerts: true,
}

/** planRootRun's inputs for a plain `vitest run` as nobody, with every probe
 *  passing; each test overrides what it varies. */
const rootRun = (overrides: Partial<Parameters<typeof planRootRun>[0]> = {}) => {
  return planRootRun({
    checkoutRoot: CHECKOUT,
    target: NOBODY,
    probes: ALL_PROBES_PASS,
    execPath: ROOT_NODE,
    nodeVersion: "v24.21.0",
    nvmrcText: "24\n",
    execArguments: [],
    vitestEntry: VITEST_ENTRY,
    vitestArguments: ["run"],
    extraCaCertsSet: false,
    pathEnvironment: "/usr/bin:/bin",
    ...overrides,
  })
}

/** rootRun's plan, narrowed to a rerun; any other plan fails the test. */
const rootRerun = (overrides: Partial<Parameters<typeof planRootRun>[0]> = {}) => {
  const plan = rootRun(overrides)

  if (plan.kind !== "rerun") throw new Error(`expected a rerun plan, got ${plan.message}`)
  return plan
}

/** A changeOwner stub typed as prepareRerun's, so its calls read back typed. */
const createChangeOwner = () => vi.fn<Parameters<typeof prepareRerun>[0]["changeOwner"]>()

const FOLDERS_TO_HAND_OVER = [
  "/repo/node_modules/.vite-temp",
  "/repo/node_modules/.vite/vitest",
  "/repo/node_modules/.test-home",
  "/repo/src/vault-mcp/mcp-core/__tests__/__snapshots__",
]

const createCheckout = (): string => {
  const checkout = mkdtempSync(join(tmpdir(), "vault-cortex-root-test-guard-"))

  onTestFinished(() => rmSync(checkout, { recursive: true, force: true }))
  return checkout
}

describe("readNodeMajor", () => {
  it.each([
    { label: "a bare major", nvmrcText: "24\n", major: 24 },
    { label: "a full version with v", nvmrcText: "v24.1.0\n", major: 24 },
    { label: "a leading space", nvmrcText: " 24\n", major: 24 },
    { label: "a trailing comment", nvmrcText: "24 # CI runs this\n", major: 24 },
    { label: "a CRLF line end", nvmrcText: "24\r\n", major: 24 },
    { label: "an alias", nvmrcText: "lts/*\n", major: null },
    { label: "an empty file", nvmrcText: "", major: null },
  ])("reads $label", ({ nvmrcText, major }) => {
    expect(readNodeMajor(nvmrcText)).toBe(major)
  })
})

describe("addCoverageFlags", () => {
  it("appends the flags when the arguments hold no lone --", () => {
    expect(addCoverageFlags(["run", "--coverage"])).toEqual([
      "run",
      "--coverage",
      "--coverage.clean=false",
      "--coverage.cleanOnRerun=false",
    ])
  })

  it("puts the flags before a lone --, after which vitest ignores flags", () => {
    expect(addCoverageFlags(["run", "--coverage", "--", "--other"])).toEqual([
      "run",
      "--coverage",
      "--coverage.clean=false",
      "--coverage.cleanOnRerun=false",
      "--",
      "--other",
    ])
  })
})

describe("isCoverageRun", () => {
  it.each([
    { label: "--coverage", vitestArguments: ["run", "--coverage"], coverageRun: true },
    {
      label: "--coverage.enabled",
      vitestArguments: ["run", "--coverage.enabled"],
      coverageRun: true,
    },
    { label: "--coverage=true", vitestArguments: ["run", "--coverage=true"], coverageRun: true },
    { label: "no coverage flag", vitestArguments: ["run"], coverageRun: false },
    {
      label: "--coverage.enabled=false",
      vitestArguments: ["run", "--coverage.enabled=false"],
      coverageRun: false,
    },
  ])("reads $label the way vitest does", ({ vitestArguments, coverageRun }) => {
    expect(isCoverageRun(vitestArguments)).toBe(coverageRun)
  })
})

describe("planRootRun", () => {
  it("reruns as nobody with a copy of a Node binary nobody cannot run", () => {
    const plan = rootRun({ probes: { ...ALL_PROBES_PASS, canRunNode: false } })

    expect(plan).toEqual({
      kind: "rerun",
      target: NOBODY,
      foldersToHandOver: FOLDERS_TO_HAND_OVER,
      coverageFolderToEmpty: null,
      node: {
        kind: "copy",
        sourcePath: ROOT_NODE,
        nodePath: "/repo/node_modules/.nobody-node/node-v24.21.0/node",
      },
      setprivArguments: [
        "--reuid=65534",
        "--regid=65534",
        "--clear-groups",
        "/usr/bin/env",
        "HOME=/repo/node_modules/.test-home",
        "PATH=/repo/node_modules/.nobody-node/node-v24.21.0:/usr/bin:/bin",
        "/repo/node_modules/.nobody-node/node-v24.21.0/node",
        VITEST_ENTRY,
        "run",
      ],
      announcement:
        "Root ignores the file permissions some tests check, so the tests rerun as nobody (uid 65534) on Node v24.21.0.\n" +
        '  setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/env HOME=/repo/node_modules/.test-home PATH=/repo/node_modules/.nobody-node/node-v24.21.0:"$PATH" /repo/node_modules/.nobody-node/node-v24.21.0/node /repo/node_modules/.bin/vitest run',
    })
  })

  it("reruns as the checkout's owner on the Node binary as it is, when the owner can run it", () => {
    const plan = rootRun({ target: OWNER, execPath: "/usr/local/bin/node" })

    expect(plan).toEqual({
      kind: "rerun",
      target: OWNER,
      foldersToHandOver: FOLDERS_TO_HAND_OVER,
      coverageFolderToEmpty: null,
      node: { kind: "as-is", nodePath: "/usr/local/bin/node" },
      setprivArguments: [
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        "/usr/bin/env",
        "HOME=/repo/node_modules/.test-home",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "/usr/local/bin/node",
        VITEST_ENTRY,
        "run",
      ],
      announcement:
        "Root ignores the file permissions some tests check, so the tests rerun as the checkout's owner (uid 1000) on Node v24.21.0.\n" +
        '  setpriv --reuid=1000 --regid=1000 --clear-groups /usr/bin/env HOME=/repo/node_modules/.test-home PATH=/usr/local/bin:"$PATH" /usr/local/bin/node /repo/node_modules/.bin/vitest run',
    })
  })

  it("warns instead of copying a Node binary into an owner's checkout", () => {
    const plan = rootRun({ target: OWNER, probes: { ...ALL_PROBES_PASS, canRunNode: false } })

    expect(plan).toEqual({
      kind: "warn",
      message:
        "vitest is running as root, which ignores the file permissions some tests check, so those tests will fail. It cannot rerun them as another user: the checkout's owner cannot run this Node binary.",
    })
  })

  it("warns when setpriv cannot switch to the target", () => {
    const plan = rootRun({ probes: { ...ALL_PROBES_PASS, setprivWorks: false } })

    expect(plan).toEqual({
      kind: "warn",
      message:
        "vitest is running as root, which ignores the file permissions some tests check, so those tests will fail. It cannot rerun them as another user: setpriv cannot switch to nobody.",
    })
  })

  it("warns when the target cannot read the checkout", () => {
    const plan = rootRun({ probes: { ...ALL_PROBES_PASS, canReadConfig: false } })

    expect(plan).toEqual({
      kind: "warn",
      message:
        "vitest is running as root, which ignores the file permissions some tests check, so those tests will fail. It cannot rerun them as another user: nobody cannot read the checkout.",
    })
  })

  it("unsets NODE_EXTRA_CA_CERTS when the target cannot read its file", () => {
    const plan = rootRerun({
      extraCaCertsSet: true,
      probes: { ...ALL_PROBES_PASS, canReadExtraCaCerts: false },
    })

    expect(plan.setprivArguments).toEqual([
      "--reuid=65534",
      "--regid=65534",
      "--clear-groups",
      "/usr/bin/env",
      "-u",
      "NODE_EXTRA_CA_CERTS",
      "HOME=/repo/node_modules/.test-home",
      "PATH=/root/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin",
      ROOT_NODE,
      VITEST_ENTRY,
      "run",
    ])
  })

  it("keeps NODE_EXTRA_CA_CERTS when the target can read its file", () => {
    const plan = rootRerun({ extraCaCertsSet: true })

    expect(plan.setprivArguments).toEqual([
      "--reuid=65534",
      "--regid=65534",
      "--clear-groups",
      "/usr/bin/env",
      "HOME=/repo/node_modules/.test-home",
      "PATH=/root/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin",
      ROOT_NODE,
      VITEST_ENTRY,
      "run",
    ])
  })

  it("empties coverage/ and tells vitest not to clean it on a coverage run", () => {
    const plan = rootRerun({ vitestArguments: ["run", "--coverage"] })

    expect({
      foldersToHandOver: plan.foldersToHandOver,
      coverageFolderToEmpty: plan.coverageFolderToEmpty,
      rerunArguments: plan.setprivArguments.slice(-4),
    }).toEqual({
      foldersToHandOver: [...FOLDERS_TO_HAND_OVER, "/repo/coverage"],
      coverageFolderToEmpty: "/repo/coverage",
      rerunArguments: [
        "run",
        "--coverage",
        "--coverage.clean=false",
        "--coverage.cleanOnRerun=false",
      ],
    })
  })

  it("passes Node's own flags through ahead of vitest's entry", () => {
    const plan = rootRerun({ execArguments: ["--inspect-brk"] })

    expect(plan.setprivArguments.slice(-4)).toEqual([
      ROOT_NODE,
      "--inspect-brk",
      VITEST_ENTRY,
      "run",
    ])
  })

  it("notes a Node major that differs from the one .nvmrc names", () => {
    const plan = rootRerun({ nodeVersion: "v22.22.0" })

    expect(plan.announcement.split("\n")[0]).toBe(
      "Root ignores the file permissions some tests check, so the tests rerun as nobody (uid 65534) on Node v22.22.0. .nvmrc names Node 24, which CI runs, so a result can differ from CI's.",
    )
  })

  it("adds no version note when .nvmrc names an alias", () => {
    const plan = rootRerun({ nodeVersion: "v22.22.0", nvmrcText: "lts/*\n" })

    expect(plan.announcement.split("\n")[0]).toBe(
      "Root ignores the file permissions some tests check, so the tests rerun as nobody (uid 65534) on Node v22.22.0.",
    )
  })

  it("quotes a path with a space in the printed command", () => {
    const plan = rootRerun({
      checkoutRoot: "/my repo",
      vitestEntry: "/my repo/node_modules/.bin/vitest",
    })

    expect(plan.announcement.split("\n")[1]).toBe(
      `  setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/env 'HOME=/my repo/node_modules/.test-home' PATH=/root/.nvm/versions/node/v24.21.0/bin:"$PATH" /root/.nvm/versions/node/v24.21.0/bin/node '/my repo/node_modules/.bin/vitest' run`,
    )
  })

  it("escapes a single quote in a quoted path in the printed command", () => {
    const plan = rootRerun({
      checkoutRoot: "/dev's repo",
      vitestEntry: "/dev's repo/node_modules/.bin/vitest",
    })

    expect(plan.announcement.split("\n")[1]).toBe(
      `  setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/env 'HOME=/dev'\\''s repo/node_modules/.test-home' PATH=/root/.nvm/versions/node/v24.21.0/bin:"$PATH" /root/.nvm/versions/node/v24.21.0/bin/node '/dev'\\''s repo/node_modules/.bin/vitest' run`,
    )
  })
})

describe("prepareRerun", () => {
  const nobodyPlanFor = (
    checkout: string,
    overrides: Partial<Parameters<typeof planRootRun>[0]> = {},
  ) => {
    return rootRerun({ checkoutRoot: checkout, ...overrides })
  }

  it("creates every folder to hand over and hands it, and everything in it, to the target", () => {
    const checkout = createCheckout()
    const cacheFile = join(checkout, "node_modules", ".vite", "vitest", "results.json")
    mkdirSync(join(checkout, "node_modules", ".vite", "vitest"), { recursive: true })
    writeFileSync(cacheFile, "{}\n")
    // chmod, because the umask cuts the mode writeFileSync is given.
    chmodSync(cacheFile, 0o666)
    const changeOwner = createChangeOwner()

    prepareRerun({ plan: nobodyPlanFor(checkout), changeOwner })

    const handedOver = changeOwner.mock.calls.map(([{ path }]) => path)
    expect({
      foldersExist: [
        "node_modules/.vite-temp",
        "node_modules/.vite/vitest",
        "node_modules/.test-home",
        "src/vault-mcp/mcp-core/__tests__/__snapshots__",
      ].map((folder) => existsSync(join(checkout, folder))),
      // A run without coverage leaves coverage/ alone.
      coverageFolderExists: existsSync(join(checkout, "coverage")),
      handedOver: handedOver.toSorted(),
      cacheFileMode: lstatSync(cacheFile).mode & 0o777,
    }).toEqual({
      foldersExist: [true, true, true, true],
      coverageFolderExists: false,
      handedOver: [
        join(checkout, "node_modules", ".test-home"),
        join(checkout, "node_modules", ".vite-temp"),
        join(checkout, "node_modules", ".vite", "vitest"),
        cacheFile,
        join(checkout, "src/vault-mcp/mcp-core/__tests__/__snapshots__"),
      ].toSorted(),
      cacheFileMode: 0o644,
    })
    expect(changeOwner).toHaveBeenCalledWith({ path: cacheFile, uid: 65534, gid: 65534 })
  })

  it("hands over a symlink without changing the mode of what it points to", () => {
    const checkout = createCheckout()
    const symlinkTarget = join(checkout, "symlink-target.txt")
    writeFileSync(symlinkTarget, "keep\n")
    chmodSync(symlinkTarget, 0o666)
    mkdirSync(join(checkout, "node_modules", ".vite", "vitest"), { recursive: true })
    const link = join(checkout, "node_modules", ".vite", "vitest", "link")
    symlinkSync(symlinkTarget, link)
    const changeOwner = createChangeOwner()

    prepareRerun({ plan: nobodyPlanFor(checkout), changeOwner })

    expect(lstatSync(symlinkTarget).mode & 0o777).toBe(0o666)
    expect(changeOwner).toHaveBeenCalledWith({ path: link, uid: 65534, gid: 65534 })
  })

  it("empties coverage/ on a coverage run but keeps the folder", () => {
    const checkout = createCheckout()
    mkdirSync(join(checkout, "coverage", "html"), { recursive: true })
    writeFileSync(join(checkout, "coverage", "coverage-final.json"), "{}\n")

    prepareRerun({
      plan: nobodyPlanFor(checkout, { vitestArguments: ["run", "--coverage"] }),
      changeOwner: vi.fn(),
    })

    expect(readdirSync(join(checkout, "coverage"))).toEqual([])
  })

  it("creates coverage/ and hands it over on a coverage run in a checkout without one", () => {
    const checkout = createCheckout()
    const changeOwner = createChangeOwner()

    prepareRerun({
      plan: nobodyPlanFor(checkout, { vitestArguments: ["run", "--coverage"] }),
      changeOwner,
    })

    expect(readdirSync(join(checkout, "coverage"))).toEqual([])
    expect(changeOwner).toHaveBeenCalledWith({
      path: join(checkout, "coverage"),
      uid: 65534,
      gid: 65534,
    })
  })

  it("leaves coverage/ alone on a run without coverage", () => {
    const checkout = createCheckout()
    mkdirSync(join(checkout, "coverage"), { recursive: true })
    writeFileSync(join(checkout, "coverage", "coverage-final.json"), "{}\n")

    prepareRerun({ plan: nobodyPlanFor(checkout), changeOwner: vi.fn() })

    expect({
      coverageEntries: readdirSync(join(checkout, "coverage")),
      // Proves prepareRerun ran: it creates the rerun's HOME.
      testHomeExists: existsSync(join(checkout, "node_modules", ".test-home")),
    }).toEqual({ coverageEntries: ["coverage-final.json"], testHomeExists: true })
  })

  it("copies the Node binary for nobody, mode 755, when the plan calls for a copy", () => {
    const checkout = createCheckout()
    const sourceNode = join(checkout, "source-node")
    writeFileSync(sourceNode, "#!/bin/sh\n# node v24.21.0\n", { mode: 0o700 })
    const plan = nobodyPlanFor(checkout, {
      execPath: sourceNode,
      probes: { ...ALL_PROBES_PASS, canRunNode: false },
    })

    prepareRerun({ plan, changeOwner: vi.fn() })

    const nodeCopy = join(checkout, "node_modules", ".nobody-node", "node-v24.21.0", "node")
    expect({
      content: readFileSync(nodeCopy, "utf8"),
      mode: lstatSync(nodeCopy).mode & 0o777,
      folderEntries: readdirSync(join(checkout, "node_modules", ".nobody-node", "node-v24.21.0")),
    }).toEqual({ content: "#!/bin/sh\n# node v24.21.0\n", mode: 0o755, folderEntries: ["node"] })
  })

  it("reuses an existing copy instead of copying again", () => {
    const checkout = createCheckout()
    const sourceNode = join(checkout, "source-node")
    writeFileSync(sourceNode, "new\n", { mode: 0o755 })
    const nodeCopy = join(checkout, "node_modules", ".nobody-node", "node-v24.21.0", "node")
    mkdirSync(join(checkout, "node_modules", ".nobody-node", "node-v24.21.0"), { recursive: true })
    writeFileSync(nodeCopy, "existing\n", { mode: 0o755 })
    const plan = nobodyPlanFor(checkout, {
      execPath: sourceNode,
      probes: { ...ALL_PROBES_PASS, canRunNode: false },
    })

    prepareRerun({ plan, changeOwner: vi.fn() })

    expect({
      nodeCopyContent: readFileSync(nodeCopy, "utf8"),
      // Proves prepareRerun ran: it creates the rerun's HOME.
      testHomeExists: existsSync(join(checkout, "node_modules", ".test-home")),
    }).toEqual({ nodeCopyContent: "existing\n", testHomeExists: true })
  })

  it("never hands the Node copy's folder to the target", () => {
    const checkout = createCheckout()
    const sourceNode = join(checkout, "source-node")
    writeFileSync(sourceNode, "node\n", { mode: 0o755 })
    const changeOwner = createChangeOwner()
    const plan = nobodyPlanFor(checkout, {
      execPath: sourceNode,
      probes: { ...ALL_PROBES_PASS, canRunNode: false },
    })

    prepareRerun({ plan, changeOwner })

    const handedOver = changeOwner.mock.calls.map(([{ path }]) => path)
    const nodeCopy = join(checkout, "node_modules", ".nobody-node", "node-v24.21.0", "node")
    expect({ handedOver: handedOver.toSorted(), nodeCopyExists: existsSync(nodeCopy) }).toEqual({
      handedOver: [
        join(checkout, "node_modules", ".test-home"),
        join(checkout, "node_modules", ".vite-temp"),
        join(checkout, "node_modules", ".vite", "vitest"),
        join(checkout, "src/vault-mcp/mcp-core/__tests__/__snapshots__"),
      ].toSorted(),
      nodeCopyExists: true,
    })
  })

  it("leaves no Node copy behind when the copy fails part way", () => {
    const checkout = createCheckout()
    const sourceNode = join(checkout, "source-node")
    writeFileSync(sourceNode, "node\n", { mode: 0o755 })
    const copyFailure = new Error("ENOSPC: no space left on device")
    const chmodSpy = vi.mocked(chmodSync).mockImplementation((path, mode) => {
      // Fails the chmod on the temp copy, after its bytes are written.
      if (String(path).endsWith(`node.${process.pid}`)) throw copyFailure
      realFs.chmodSync(path, mode)
    })
    onTestFinished(() => chmodSpy.mockRestore())
    const plan = nobodyPlanFor(checkout, {
      execPath: sourceNode,
      probes: { ...ALL_PROBES_PASS, canRunNode: false },
    })

    expect(() => prepareRerun({ plan, changeOwner: vi.fn() })).toThrow(copyFailure)
    expect(readdirSync(join(checkout, "node_modules", ".nobody-node", "node-v24.21.0"))).toEqual([])
  })
})

describe("removeLeftoverConfigBundles", () => {
  /** Writes a file in `folder` with its modification time set to `mtimeMs`. */
  const writeFileModifiedAt = ({
    folder,
    name,
    mtimeMs,
  }: {
    folder: string
    name: string
    mtimeMs: number
  }): void => {
    const path = join(folder, name)

    writeFileSync(path, "")
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  }

  const CUTOFF_MS = 1_800_000_000_000

  it("removes this config's bundles written before the cutoff and keeps every other file", () => {
    const bundleFolder = createCheckout()
    writeFileModifiedAt({
      folder: bundleFolder,
      name: "vitest.config.ts.timestamp-1-a.mjs",
      mtimeMs: CUTOFF_MS - 60_000,
    })
    writeFileModifiedAt({
      folder: bundleFolder,
      name: "vitest.config.ts.timestamp-2-b.mjs",
      mtimeMs: CUTOFF_MS + 1_000,
    })
    writeFileModifiedAt({
      folder: bundleFolder,
      name: "vitest.cli-pty.config.ts.timestamp-3-c.mjs",
      mtimeMs: CUTOFF_MS - 60_000,
    })
    writeFileModifiedAt({ folder: bundleFolder, name: "other.mjs", mtimeMs: CUTOFF_MS - 60_000 })

    removeLeftoverConfigBundles({
      bundleFolder,
      configName: "vitest.config.ts",
      writtenBeforeMs: CUTOFF_MS,
    })

    expect(readdirSync(bundleFolder).sort()).toEqual([
      "other.mjs",
      "vitest.cli-pty.config.ts.timestamp-3-c.mjs",
      "vitest.config.ts.timestamp-2-b.mjs",
    ])
  })
})

describe("rerunRootTestRun", () => {
  /** A spawnSync result: an exit status, what the command printed, and the
   *  error spawnSync reports when the command could not start. */
  const spawnResult = ({
    status,
    stdout = "",
    error,
  }: {
    status: number | null
    stdout?: string
    error?: Error
  }): SpawnSyncReturns<string> => {
    return {
      pid: 0,
      output: [],
      stdout,
      stderr: "",
      status,
      signal: null,
      ...(error ? { error } : {}),
    }
  }

  /** A file named like vitest's command-line entry, in a temp folder. */
  const createVitestEntry = (): string => {
    const entryPath = join(createCheckout(), "vitest.mjs")

    writeFileSync(entryPath, "")
    return entryPath
  }

  /** Runs the guard as uid `uid` with spawnSync answering each command the way
   *  `answerCommand` says. process.exit throws instead of ending the worker. */
  const runGuard = ({
    uid,
    checkoutRoot,
    answerCommand,
    entryPath = createVitestEntry(),
  }: {
    uid: number
    checkoutRoot: string
    answerCommand: (
      command: string,
      commandArguments: readonly string[],
    ) => SpawnSyncReturns<string>
    /** The script in process.argv[1]; vitest's entry unless a test varies it. */
    entryPath?: string
  }) => {
    const originalArgv = process.argv
    process.argv = [process.execPath, entryPath, "run"]
    onTestFinished(() => {
      process.argv = originalArgv
    })
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(uid)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`)
    })
    const spawnSpy = vi
      .mocked(spawnSync)
      .mockImplementation((command: string, commandArguments?: readonly string[]) => {
        return answerCommand(command, commandArguments ?? [])
      })
    onTestFinished(() => {
      getuidSpy.mockRestore()
      stderrSpy.mockRestore()
      exitSpy.mockRestore()
      spawnSpy.mockRestore()
    })

    const runOnce = (): void => {
      rerunRootTestRun({ checkoutRoot, configPath: join(checkoutRoot, "vitest.config.ts") })
    }
    return { runOnce, stderrSpy, spawnSpy }
  }

  /** Answers setpriv --version and id for nobody; every other setpriv call
   *  (the probes) fails, so the guard stops at the setpriv warning. */
  const answerWithFailingProbes = (command: string, commandArguments: readonly string[]) => {
    if (command === "id") {
      return spawnResult({
        status: 0,
        stdout: commandArguments[0] === "-u" ? "65534\n" : "65533\n",
      })
    }
    if (commandArguments[0] === "--version") return spawnResult({ status: 0 })
    return spawnResult({ status: 1 })
  }

  const WARNING_PREFIX =
    "vitest is running as root, which ignores the file permissions some tests check, so those tests will fail. It cannot rerun them as another user: "

  it("does nothing when the process is not root", () => {
    const { runOnce, stderrSpy, spawnSpy } = runGuard({
      uid: 1000,
      checkoutRoot: "/",
      answerCommand: answerWithFailingProbes,
    })

    runOnce()

    expect(spawnSpy).not.toHaveBeenCalled()
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it("warns and continues as root when another program started vitest", () => {
    const programScript = join(createCheckout(), "worker.js")
    writeFileSync(programScript, "")
    const { runOnce, stderrSpy, spawnSpy } = runGuard({
      uid: 0,
      checkoutRoot: "/",
      answerCommand: answerWithFailingProbes,
      entryPath: programScript,
    })

    runOnce()

    expect(spawnSpy).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(
      `${WARNING_PREFIX}vitest was started by another program, not by its own command.\n`,
    )
  })

  it("accepts vitest's entry through node_modules/.bin's symlink", () => {
    const binFolder = createCheckout()
    const binLink = join(binFolder, "vitest")
    symlinkSync(createVitestEntry(), binLink)
    const { runOnce, stderrSpy } = runGuard({
      uid: 0,
      checkoutRoot: "/",
      answerCommand: answerWithFailingProbes,
      entryPath: binLink,
    })

    runOnce()

    // Reaching the probes shows the entry check passed.
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(`${WARNING_PREFIX}setpriv cannot switch to nobody.\n`)
  })

  it("warns and continues as root when setpriv is not installed", () => {
    const { runOnce, stderrSpy } = runGuard({
      uid: 0,
      checkoutRoot: "/",
      answerCommand: () =>
        spawnResult({ status: null, error: new Error("spawnSync setpriv ENOENT") }),
    })

    runOnce()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(`${WARNING_PREFIX}setpriv is not installed.\n`)
  })

  it("warns and continues as root when the system has no nobody user", () => {
    const { runOnce, stderrSpy } = runGuard({
      uid: 0,
      checkoutRoot: "/",
      answerCommand: (command, commandArguments) => {
        if (command === "id") return spawnResult({ status: 1 })
        return answerWithFailingProbes(command, commandArguments)
      },
    })

    runOnce()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(`${WARNING_PREFIX}this system has no nobody user.\n`)
  })

  it("targets nobody's uid and gid when root owns the checkout", () => {
    // Root owns / on every Linux system.
    const { runOnce, stderrSpy, spawnSpy } = runGuard({
      uid: 0,
      checkoutRoot: "/",
      answerCommand: answerWithFailingProbes,
    })

    runOnce()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(`${WARNING_PREFIX}setpriv cannot switch to nobody.\n`)
    expect(spawnSpy).toHaveBeenCalledWith(
      "setpriv",
      ["--reuid=65534", "--regid=65533", "--clear-groups", "true"],
      { stdio: "ignore" },
    )
  })

  it("targets the checkout owner's uid and gid when root does not own the checkout", () => {
    // The test runs as a non-root user, so it owns the checkout it creates.
    const checkout = createCheckout()
    const checkoutStats = statSync(checkout)
    const { runOnce, stderrSpy, spawnSpy } = runGuard({
      uid: 0,
      checkoutRoot: checkout,
      answerCommand: answerWithFailingProbes,
    })

    runOnce()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(
      `${WARNING_PREFIX}setpriv cannot switch to the checkout's owner.\n`,
    )
    expect(spawnSpy).toHaveBeenCalledWith(
      "setpriv",
      [`--reuid=${checkoutStats.uid}`, `--regid=${checkoutStats.gid}`, "--clear-groups", "true"],
      { stdio: "ignore" },
    )
  })

  it("warns and continues as root when preparing the rerun fails", () => {
    const checkout = createCheckout()
    // A file where a scratch folder goes makes creating that folder fail.
    mkdirSync(join(checkout, "node_modules"))
    writeFileSync(join(checkout, "node_modules", ".vite-temp"), "")
    const { runOnce, stderrSpy } = runGuard({
      uid: 0,
      checkoutRoot: checkout,
      answerCommand: () => spawnResult({ status: 0 }),
    })

    runOnce()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledWith(
      `${WARNING_PREFIX}preparing the rerun failed (EEXIST: file already exists, mkdir '${join(checkout, "node_modules", ".vite-temp")}').\n`,
    )
  })

  it("exits with the rerun's exit status", () => {
    const checkout = createCheckout()
    const { runOnce } = runGuard({
      uid: 0,
      checkoutRoot: checkout,
      answerCommand: (_command, commandArguments) => {
        const isRerun = commandArguments.includes("/usr/bin/env")
        return spawnResult({ status: isRerun ? 3 : 0 })
      },
    })

    expect(runOnce).toThrow(new Error("process.exit(3)"))
  })

  it("removes the config bundle vite left behind for the root run once the rerun ends", () => {
    const checkout = createCheckout()
    const bundleFolder = join(checkout, "node_modules", ".vite-temp")
    const bundlePath = join(bundleFolder, "vitest.config.ts.timestamp-1-a.mjs")
    mkdirSync(bundleFolder, { recursive: true })
    writeFileSync(bundlePath, "")
    // vite wrote the root run's bundle before the config, and so the guard, ran.
    const writtenSeconds = Date.now() / 1000 - 60
    utimesSync(bundlePath, writtenSeconds, writtenSeconds)
    const { runOnce, spawnSpy } = runGuard({
      uid: 0,
      checkoutRoot: checkout,
      answerCommand: () => spawnResult({ status: 0 }),
    })

    expect(runOnce).toThrow(new Error("process.exit(0)"))
    expect(spawnSpy).toHaveBeenCalledWith("setpriv", expect.arrayContaining(["/usr/bin/env"]), {
      stdio: "inherit",
    })
    expect(existsSync(bundlePath)).toBe(false)
  })

  it("exits with status 1 when a signal ended the rerun", () => {
    const checkout = createCheckout()
    const { runOnce } = runGuard({
      uid: 0,
      checkoutRoot: checkout,
      answerCommand: (_command, commandArguments) => {
        const isRerun = commandArguments.includes("/usr/bin/env")
        return spawnResult({ status: isRerun ? null : 0 })
      },
    })

    expect(runOnce).toThrow(new Error("process.exit(1)"))
  })
})

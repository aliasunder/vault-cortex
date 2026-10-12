import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  readNvmrcMajor,
} from "../root-test-guard.js"

const CHECKOUT = "/repo"
const ROOT_NODE = "/root/.nvm/versions/node/v24.21.0/bin/node"
const VITEST_ENTRY = "/repo/node_modules/.bin/vitest"
const NOBODY = { kind: "nobody", name: "nobody", uid: 65534, gid: 65534 } as const
const OWNER = { kind: "owner", name: "the checkout's owner", uid: 1000, gid: 1000 } as const
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
    coverageRun: false,
    extraCaCertsSet: false,
    pathEnvironment: "/usr/bin:/bin",
    ...overrides,
  })
}

const SCRATCH_FOLDERS = [
  "/repo/node_modules/.vite-temp",
  "/repo/node_modules/.vite/vitest",
  "/repo/node_modules/.test-home",
  "/repo/coverage",
  "/repo/src/vault-mcp/mcp-core/__tests__/__snapshots__",
]

const createCheckout = (): string => {
  const checkout = mkdtempSync(join(tmpdir(), "vault-cortex-root-test-guard-"))

  onTestFinished(() => rmSync(checkout, { recursive: true, force: true }))
  return checkout
}

describe("readNvmrcMajor", () => {
  it.each([
    { label: "a bare major", nvmrcText: "24\n", major: 24 },
    { label: "a full version with v", nvmrcText: "v24.1.0\n", major: 24 },
    { label: "a leading space", nvmrcText: " 24\n", major: 24 },
    { label: "a trailing comment", nvmrcText: "24 # CI runs this\n", major: 24 },
    { label: "a CRLF line end", nvmrcText: "24\r\n", major: 24 },
    { label: "an alias", nvmrcText: "lts/*\n", major: null },
    { label: "an empty file", nvmrcText: "", major: null },
  ])("reads $label", ({ nvmrcText, major }) => {
    expect(readNvmrcMajor(nvmrcText)).toBe(major)
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
      scratchFolders: SCRATCH_FOLDERS,
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
      scratchFolders: SCRATCH_FOLDERS,
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
    const plan = rootRun({
      extraCaCertsSet: true,
      probes: { ...ALL_PROBES_PASS, canReadExtraCaCerts: false },
    })

    expect(plan.kind === "rerun" ? plan.setprivArguments.slice(3, 7) : plan).toEqual([
      "/usr/bin/env",
      "-u",
      "NODE_EXTRA_CA_CERTS",
      "HOME=/repo/node_modules/.test-home",
    ])
  })

  it("keeps NODE_EXTRA_CA_CERTS when the target can read its file", () => {
    const plan = rootRun({ extraCaCertsSet: true })

    expect(plan.kind === "rerun" ? plan.setprivArguments.slice(3, 5) : plan).toEqual([
      "/usr/bin/env",
      "HOME=/repo/node_modules/.test-home",
    ])
  })

  it("empties coverage/ and tells vitest not to clean it on a coverage run", () => {
    const plan = rootRun({ vitestArguments: ["run", "--coverage"], coverageRun: true })

    expect(
      plan.kind === "rerun"
        ? {
            coverageFolderToEmpty: plan.coverageFolderToEmpty,
            rerunArguments: plan.setprivArguments.slice(-4),
          }
        : plan,
    ).toEqual({
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
    const plan = rootRun({ execArguments: ["--inspect-brk"] })

    expect(plan.kind === "rerun" ? plan.setprivArguments.slice(-4) : plan).toEqual([
      ROOT_NODE,
      "--inspect-brk",
      VITEST_ENTRY,
      "run",
    ])
  })

  it("notes a Node major that differs from the one .nvmrc names", () => {
    const plan = rootRun({ nodeVersion: "v22.22.0" })

    expect(plan.kind === "rerun" ? plan.announcement.split("\n")[0] : plan).toBe(
      "Root ignores the file permissions some tests check, so the tests rerun as nobody (uid 65534) on Node v22.22.0. .nvmrc names Node 24, which CI runs, so a result can differ from CI's.",
    )
  })

  it("adds no version note when .nvmrc names an alias", () => {
    const plan = rootRun({ nodeVersion: "v22.22.0", nvmrcText: "lts/*\n" })

    expect(plan.kind === "rerun" ? plan.announcement.split("\n")[0] : plan).toBe(
      "Root ignores the file permissions some tests check, so the tests rerun as nobody (uid 65534) on Node v22.22.0.",
    )
  })

  it("quotes a path with a space in the printed command", () => {
    const plan = rootRun({
      checkoutRoot: "/my repo",
      vitestEntry: "/my repo/node_modules/.bin/vitest",
    })

    expect(plan.kind === "rerun" ? plan.announcement.split("\n")[1] : plan).toBe(
      `  setpriv --reuid=65534 --regid=65534 --clear-groups /usr/bin/env 'HOME=/my repo/node_modules/.test-home' PATH=/root/.nvm/versions/node/v24.21.0/bin:"$PATH" /root/.nvm/versions/node/v24.21.0/bin/node '/my repo/node_modules/.bin/vitest' run`,
    )
  })
})

describe("prepareRerun", () => {
  const nobodyPlanFor = (
    checkout: string,
    overrides: Partial<Parameters<typeof planRootRun>[0]> = {},
  ) => {
    const plan = rootRun({ checkoutRoot: checkout, ...overrides })

    if (plan.kind !== "rerun") throw new Error(`expected a rerun plan, got ${plan.message}`)
    return plan
  }

  it("creates every scratch folder and hands it, and everything in it, to the target", () => {
    const checkout = createCheckout()
    const cacheFile = join(checkout, "node_modules", ".vite", "vitest", "results.json")
    mkdirSync(join(checkout, "node_modules", ".vite", "vitest"), { recursive: true })
    writeFileSync(cacheFile, "{}\n")
    // chmod, because the umask cuts the mode writeFileSync is given.
    chmodSync(cacheFile, 0o666)
    const changeOwner = vi.fn()

    prepareRerun({ plan: nobodyPlanFor(checkout), changeOwner })

    const handedOver = changeOwner.mock.calls.map(([{ path }]) => path)
    expect({
      foldersExist: [".vite-temp", ".vite/vitest", ".test-home"].map((folder) =>
        existsSync(join(checkout, "node_modules", folder)),
      ),
      handedOver: handedOver.toSorted(),
      cacheFileMode: lstatSync(cacheFile).mode & 0o777,
    }).toEqual({
      foldersExist: [true, true, true],
      handedOver: [
        join(checkout, "coverage"),
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
    const outsideFile = join(checkout, "outside.txt")
    writeFileSync(outsideFile, "keep\n")
    chmodSync(outsideFile, 0o666)
    mkdirSync(join(checkout, "node_modules", ".vite", "vitest"), { recursive: true })
    const link = join(checkout, "node_modules", ".vite", "vitest", "link")
    symlinkSync(outsideFile, link)
    const changeOwner = vi.fn()

    prepareRerun({ plan: nobodyPlanFor(checkout), changeOwner })

    expect(lstatSync(outsideFile).mode & 0o777).toBe(0o666)
    expect(changeOwner).toHaveBeenCalledWith({ path: link, uid: 65534, gid: 65534 })
  })

  it("empties coverage/ on a coverage run but keeps the folder", () => {
    const checkout = createCheckout()
    mkdirSync(join(checkout, "coverage", "html"), { recursive: true })
    writeFileSync(join(checkout, "coverage", "coverage-final.json"), "{}\n")

    prepareRerun({
      plan: nobodyPlanFor(checkout, { vitestArguments: ["run", "--coverage"], coverageRun: true }),
      changeOwner: vi.fn(),
    })

    expect(readdirSync(join(checkout, "coverage"))).toEqual([])
  })

  it("leaves coverage/ alone on a run without coverage", () => {
    const checkout = createCheckout()
    mkdirSync(join(checkout, "coverage"), { recursive: true })
    writeFileSync(join(checkout, "coverage", "coverage-final.json"), "{}\n")

    prepareRerun({ plan: nobodyPlanFor(checkout), changeOwner: vi.fn() })

    expect(readdirSync(join(checkout, "coverage"))).toEqual(["coverage-final.json"])
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

    expect(readFileSync(nodeCopy, "utf8")).toBe("existing\n")
  })

  it("never hands the Node copy's folder to the target", () => {
    const checkout = createCheckout()
    const sourceNode = join(checkout, "source-node")
    writeFileSync(sourceNode, "node\n", { mode: 0o755 })
    const changeOwner = vi.fn()
    const plan = nobodyPlanFor(checkout, {
      execPath: sourceNode,
      probes: { ...ALL_PROBES_PASS, canRunNode: false },
    })

    prepareRerun({ plan, changeOwner })

    const handedOver = changeOwner.mock.calls.map(([{ path }]) => String(path))
    expect(handedOver.filter((path) => path.includes(".nobody-node"))).toEqual([])
  })
})

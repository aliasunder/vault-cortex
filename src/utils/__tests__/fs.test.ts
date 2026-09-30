import { describe, it, expect, onTestFinished, vi } from "vitest"
import { chmod, mkdtemp, readdir, realpath, rm, symlink, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Every node:fs/promises export becomes a pass-through spy, so the real
// filesystem answers every call except the one a test overrides.
vi.mock("node:fs/promises", { spy: true })
import {
  readFileOrNull,
  readdirOrNull,
  realpathOrNull,
  fileExists,
  lstatOrNull,
  statOrNull,
} from "../fs.js"

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "utils-fs-test-"))
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** A folder nobody can enter, so any access through it fails with EACCES —
 *  the error class the helpers must still propagate. Permissions are restored
 *  before the temp dir is removed. */
const makeUnreadableDir = async (parent: string): Promise<string> => {
  const dir = join(parent, "locked")
  await mkdir(dir)
  await writeFile(join(dir, "inner.md"), "x", "utf8")
  await chmod(dir, 0o000)
  onTestFinished(async () => {
    await chmod(dir, 0o700)
  })
  return dir
}

describe("readFileOrNull", () => {
  it("returns the file contents when the file exists", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "note.md")
    await writeFile(path, "hello", "utf8")
    expect(await readFileOrNull(path)).toBe("hello")
  })

  it("returns null when the file does not exist", async () => {
    const dir = await makeTempDir()
    expect(await readFileOrNull(join(dir, "missing.md"))).toBeNull()
  })

  it("returns null when a parent of the path is a file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "note.md")
    await writeFile(filePath, "x", "utf8")
    expect(await readFileOrNull(join(filePath, "child.md"))).toBeNull()
  })

  it("returns null when the path is a folder", async () => {
    const dir = await makeTempDir()
    expect(await readFileOrNull(dir)).toBeNull()
  })

  it("rethrows a permission error rather than swallowing it as missing", async () => {
    const dir = await makeTempDir()
    const lockedDir = await makeUnreadableDir(dir)
    await expect(readFileOrNull(join(lockedDir, "inner.md"))).rejects.toThrow(/EACCES/)
  })
})

describe("readdirOrNull", () => {
  it("returns recursive directory entries when the directory exists", async () => {
    const dir = await makeTempDir()
    await mkdir(join(dir, "sub"))
    await writeFile(join(dir, "sub", "a.md"), "x", "utf8")
    const entries = await readdirOrNull(dir)
    const names = entries?.map((entry) => entry.name).sort()
    expect(names).toEqual(["a.md", "sub"])
  })

  it("returns null when the directory does not exist", async () => {
    const dir = await makeTempDir()
    expect(await readdirOrNull(join(dir, "nope"))).toBeNull()
  })

  it("returns null when the path names a file, not a directory", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "note.md")
    await writeFile(filePath, "x", "utf8")
    expect(await readdirOrNull(filePath)).toBeNull()
  })

  it("returns null when a parent of the path is a file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "note.md")
    await writeFile(filePath, "x", "utf8")
    expect(await readdirOrNull(join(filePath, "child"))).toBeNull()
  })

  it("rethrows ENOTDIR raised from inside a folder that still exists", async () => {
    const dir = await makeTempDir()
    // What the walk raises when a folder inside it becomes a file mid-walk,
    // while the listed folder itself is still there.
    const midWalkError = Object.assign(new Error("ENOTDIR: not a directory, scandir"), {
      code: "ENOTDIR",
    })
    vi.mocked(readdir).mockRejectedValueOnce(midWalkError)
    await expect(readdirOrNull(dir)).rejects.toBe(midWalkError)
  })
})

describe("statOrNull", () => {
  it("returns Stats when the path exists", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "file.txt")
    await writeFile(path, "12345", "utf8")
    const stats = await statOrNull(path)
    expect(stats?.isFile()).toBe(true)
    expect(stats?.size).toBe(5)
  })

  it("returns null when the path does not exist", async () => {
    const dir = await makeTempDir()
    expect(await statOrNull(join(dir, "ghost.txt"))).toBeNull()
  })

  it("returns null when a parent of the path is a file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "file.txt")
    await writeFile(filePath, "x", "utf8")
    expect(await statOrNull(join(filePath, "child"))).toBeNull()
  })

  it("rethrows a permission error rather than swallowing it", async () => {
    const dir = await makeTempDir()
    const lockedDir = await makeUnreadableDir(dir)
    await expect(statOrNull(join(lockedDir, "inner.md"))).rejects.toThrow(/EACCES/)
  })
})

describe("lstatOrNull", () => {
  it("returns Stats when the path exists", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "file.txt")
    await writeFile(path, "12345", "utf8")
    const stats = await lstatOrNull(path)
    expect(stats?.isFile()).toBe(true)
    expect(stats?.size).toBe(5)
  })

  it("returns Stats for a dangling symlink instead of following it", async () => {
    const dir = await makeTempDir()
    const link = join(dir, "dangling")
    await symlink(join(dir, "nonexistent-target"), link)
    const stats = await lstatOrNull(link)
    expect(stats?.isSymbolicLink()).toBe(true)
  })

  it("returns null when the path does not exist", async () => {
    const dir = await makeTempDir()
    expect(await lstatOrNull(join(dir, "ghost.txt"))).toBeNull()
  })

  it("returns null when a parent of the path is a file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "file.txt")
    await writeFile(filePath, "x", "utf8")
    expect(await lstatOrNull(join(filePath, "child"))).toBeNull()
  })

  it("rethrows a permission error rather than swallowing it", async () => {
    const dir = await makeTempDir()
    const lockedDir = await makeUnreadableDir(dir)
    await expect(lstatOrNull(join(lockedDir, "inner.md"))).rejects.toThrow(/EACCES/)
  })
})

describe("realpathOrNull", () => {
  it("returns the canonical path when the path exists", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "note.md")
    await writeFile(path, "x", "utf8")
    const resolved = await realpathOrNull(path)
    // macOS: /var → /private/var symlink makes mkdtemp's path differ from
    // the canonical form; compare against the stdlib realpath as the oracle.
    expect(resolved).toBe(await realpath(path))
  })

  it("returns null when the path does not exist", async () => {
    const dir = await makeTempDir()
    expect(await realpathOrNull(join(dir, "missing.md"))).toBeNull()
  })

  it("returns null when a parent of the path is a file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "file.txt")
    await writeFile(filePath, "x", "utf8")
    expect(await realpathOrNull(join(filePath, "child"))).toBeNull()
  })

  it("rethrows a permission error rather than swallowing it", async () => {
    const dir = await makeTempDir()
    const lockedDir = await makeUnreadableDir(dir)
    await expect(realpathOrNull(join(lockedDir, "inner.md"))).rejects.toThrow(/EACCES/)
  })
})

describe("fileExists", () => {
  it("returns true when the path exists", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "note.md")
    await writeFile(path, "x", "utf8")
    expect(await fileExists(path)).toBe(true)
  })

  it("returns false when the path does not exist", async () => {
    const dir = await makeTempDir()
    expect(await fileExists(join(dir, "missing.md"))).toBe(false)
  })

  it("returns false when a parent of the path is a file", async () => {
    const dir = await makeTempDir()
    const filePath = join(dir, "note.md")
    await writeFile(filePath, "x", "utf8")
    expect(await fileExists(join(filePath, "child.md"))).toBe(false)
  })

  it("rethrows a permission error rather than reporting the path missing", async () => {
    const dir = await makeTempDir()
    const lockedDir = await makeUnreadableDir(dir)
    await expect(fileExists(join(lockedDir, "inner.md"))).rejects.toThrow(/EACCES/)
  })
})

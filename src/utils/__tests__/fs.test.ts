import { describe, it, expect, onTestFinished, vi } from "vitest"
import { chmod, mkdtemp, readdir, realpath, rm, symlink, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Every node:fs/promises export becomes a pass-through spy, so the real
// filesystem answers every call except the one a test overrides.
vi.mock("node:fs/promises", { spy: true })
import {
  readFileOrNull,
  readFileTextPrefix,
  readdirOrNull,
  realpathOrNull,
  fileExists,
  lstatOrNull,
  statOrNull,
} from "../fs.js"
import { runsAsRoot } from "../../__tests__/runs-as-root.js"

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

  it.skipIf(runsAsRoot)(
    "rethrows a permission error rather than swallowing it as missing",
    async () => {
      const dir = await makeTempDir()
      const lockedDir = await makeUnreadableDir(dir)
      await expect(readFileOrNull(join(lockedDir, "inner.md"))).rejects.toThrow(/EACCES/)
    },
  )
})

describe("readFileTextPrefix", () => {
  it("returns the whole text of a file shorter than maxBytes", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "short.log")
    await writeFile(path, "short line\n", "utf8")

    expect(await readFileTextPrefix({ path, maxBytes: 100 })).toBe("short line\n")
  })

  it("returns only the first maxBytes of a longer file", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "long.log")
    await writeFile(path, "0123456789abcdef", "utf8")

    expect(await readFileTextPrefix({ path, maxBytes: 10 })).toBe("0123456789")
  })

  it("leaves out a character the cut splits instead of ending in a replacement character", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "accent.log")
    // "é" is the two bytes 0xC3 0xA9, so a 3-byte cut keeps only its first byte
    await writeFile(path, "abé", "utf8")

    expect(await readFileTextPrefix({ path, maxBytes: 3 })).toBe("ab")
  })

  it("keeps a byte-order mark and replaces an invalid byte, as readFile does", async () => {
    const dir = await makeTempDir()
    const path = join(dir, "latin1.log")
    // 0xEF 0xBB 0xBF is the UTF-8 byte-order mark; 0xE9 alone is never valid UTF-8
    await writeFile(path, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xe9, 0x62]))

    expect(await readFileTextPrefix({ path, maxBytes: 100 })).toBe("﻿a�b")
  })

  it("rejects when no file exists at the path", async () => {
    const dir = await makeTempDir()
    const missingPath = join(dir, "missing.log")

    // Node reports ENOENT as errno -2 on both Linux and macOS
    const missingFileError = Object.assign(
      new Error(`ENOENT: no such file or directory, open '${missingPath}'`),
      { errno: -2, code: "ENOENT", syscall: "open", path: missingPath },
    )

    await expect(readFileTextPrefix({ path: missingPath, maxBytes: 100 })).rejects.toThrow(
      missingFileError,
    )
  })
})

describe("readdirOrNull", () => {
  it("returns recursive directory entries when the directory exists", async () => {
    const dir = await makeTempDir()
    await mkdir(join(dir, "sub"))
    await writeFile(join(dir, "sub", "a.md"), "x", "utf8")
    const entries = await readdirOrNull(dir)
    const names = entries?.map((entry) => entry.name).toSorted()
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

  it.skipIf(runsAsRoot)("rethrows a permission error rather than swallowing it", async () => {
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

  it.skipIf(runsAsRoot)("rethrows a permission error rather than swallowing it", async () => {
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

  it.skipIf(runsAsRoot)("rethrows a permission error rather than swallowing it", async () => {
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

  it.skipIf(runsAsRoot)(
    "rethrows a permission error rather than reporting the path missing",
    async () => {
      const dir = await makeTempDir()
      const lockedDir = await makeUnreadableDir(dir)
      await expect(fileExists(join(lockedDir, "inner.md"))).rejects.toThrow(/EACCES/)
    },
  )
})

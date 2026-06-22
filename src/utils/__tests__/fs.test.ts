import { describe, it, expect, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readFileOrNull, readdirOrNull, fileExists } from "../fs.js"

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "utils-fs-test-"))
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true })
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

  it("rethrows a non-ENOENT error rather than swallowing it as missing", async () => {
    const dir = await makeTempDir()
    // Reading a directory as a file fails with EISDIR, not ENOENT — it must
    // propagate, not be masked as null.
    await expect(readFileOrNull(dir)).rejects.toThrow(/EISDIR/)
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
})

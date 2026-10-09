import { describe, it, expect } from "vitest"
import { readdir, readFile, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeError, describeErrorRelativeTo } from "../describe-error.js"

describe("describeError", () => {
  const scenarios = [
    {
      name: "returns an Error's name and message",
      input: new Error("boom"),
      expected: "[Error]: boom",
    },
    {
      name: "returns the name and message of an Error subclass",
      input: new TypeError("bad type"),
      expected: "[TypeError]: bad type",
    },
    {
      name: "stringifies a non-Error string",
      input: "plain string",
      expected: "plain string",
    },
    {
      name: "stringifies a non-Error number",
      input: 42,
      expected: "42",
    },
    { name: "stringifies null", input: null, expected: "null" },
    {
      name: "stringifies undefined",
      input: undefined,
      expected: "undefined",
    },
  ]

  it.each(scenarios)("$name", ({ input, expected }) => {
    expect(describeError(input)).toBe(expected)
  })
})

describe("describeErrorRelativeTo", () => {
  // Never created, so every filesystem call under it fails with a real Node error
  const directory = join(tmpdir(), "describe-error-relative-to-missing-vault")

  const captureRejection = async (operation: Promise<unknown>): Promise<unknown> => {
    try {
      await operation
    } catch (error) {
      return error
    }
    throw new Error("expected the operation to reject")
  }

  it("makes the path of a filesystem error relative to the directory", async () => {
    const error = await captureRejection(readFile(join(directory, "Notes/plan.md")))

    expect(describeErrorRelativeTo({ error, directory })).toBe(
      "[Error]: ENOENT: no such file or directory, open 'Notes/plan.md'",
    )
  })

  it("makes both paths of a rename relative to the directory", async () => {
    const error = await captureRejection(
      rename(join(directory, "old.md"), join(directory, "Archive/new.md")),
    )

    expect(describeErrorRelativeTo({ error, directory })).toBe(
      "[Error]: ENOENT: no such file or directory, rename 'old.md' -> 'Archive/new.md'",
    )
  })

  it("names the directory itself as .", async () => {
    const error = await captureRejection(readdir(directory))

    expect(describeErrorRelativeTo({ error, directory })).toBe(
      "[Error]: ENOENT: no such file or directory, scandir '.'",
    )
  })

  it("makes the path in Node's invalid-argument error relative to the directory", async () => {
    const error = await captureRejection(readFile(join(directory, "Bad\u0000Name.md")))

    expect(describeErrorRelativeTo({ error, directory })).toBe(
      "[TypeError]: The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received 'Bad\\x00Name.md'",
    )
  })

  it("keeps a folder deeper in the path that repeats the directory's own path", async () => {
    // join() appends an absolute second part, so this is <directory>/<directory>/note.md
    const error = await captureRejection(readFile(join(directory, directory, "note.md")))

    expect(describeErrorRelativeTo({ error, directory })).toBe(
      `[Error]: ENOENT: no such file or directory, open '${join(directory.slice(1), "note.md")}'`,
    )
  })

  it("keeps the path of a sibling whose name starts with the directory's name", async () => {
    const siblingPath = `${directory}-backup/note.md`
    const error = await captureRejection(readFile(siblingPath))

    expect(describeErrorRelativeTo({ error, directory })).toBe(
      `[Error]: ENOENT: no such file or directory, open '${siblingPath}'`,
    )
  })

  it("keeps the text of an error the application threw, even when it quotes a path under the directory", () => {
    const error = new Error(`absolute path blocked: "${directory}/a.md" must be vault-relative`)

    expect(describeErrorRelativeTo({ error, directory })).toBe(
      `[Error]: absolute path blocked: "${directory}/a.md" must be vault-relative`,
    )
  })

  it("stringifies a thrown value that is not an Error", () => {
    expect(describeErrorRelativeTo({ error: `${directory}/a.md`, directory })).toBe(
      `${directory}/a.md`,
    )
  })
})

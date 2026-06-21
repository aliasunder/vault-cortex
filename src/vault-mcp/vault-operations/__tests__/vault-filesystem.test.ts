import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  onTestFinished,
} from "vitest"
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  readdir,
  stat,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  vaultFs,
  atomicWriteFile,
  atomicWriteFileExclusive,
  fileExists,
  pruneEmptyParents,
} from "../vault-filesystem.js"
import { parseNote } from "../frontmatter.js"
import { logger } from "../../../logger.js"

const {
  readNote,
  readNoteOutline,
  readNoteSection,
  readNoteProperties,
  writeNote,
  updateProperties,
  deleteNote,
  listNotes,
} = vaultFs

let vault: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "vault-test-"))
})

afterEach(async () => {
  await rm(vault, { recursive: true })
})

describe("atomicWriteFile", () => {
  it("writes the exact content to the target path", async () => {
    const target = join(vault, "atomic.md")
    await atomicWriteFile(target, "exact content\n")
    expect(await readFile(target, "utf8")).toBe("exact content\n")
  })

  it("leaves no .tmp staging file behind on success", async () => {
    await atomicWriteFile(join(vault, "clean.md"), "body\n")
    const entries = await readdir(vault)
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("cleans up the staging file and rethrows when the rename fails", async () => {
    // A directory sitting at the target path makes the final rename fail with
    // EISDIR — after the temp file has already been staged — so this exercises
    // the catch-and-cleanup branch, not the initial writeFile.
    const target = join(vault, "occupied")
    await mkdir(target)
    await expect(atomicWriteFile(target, "body\n")).rejects.toThrow()
    const entries = await readdir(vault)
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})

describe("atomicWriteFileExclusive", () => {
  it("writes the exact content to a new target path", async () => {
    const target = join(vault, "created.md")
    await atomicWriteFileExclusive(target, "fresh content\n")
    expect(await readFile(target, "utf8")).toBe("fresh content\n")
  })

  it("throws EEXIST and leaves existing content untouched when the target exists", async () => {
    const target = join(vault, "taken.md")
    await atomicWriteFile(target, "original\n")

    await expect(
      atomicWriteFileExclusive(target, "overwrite\n"),
    ).rejects.toMatchObject({ code: "EEXIST" })
    // The no-clobber guard must not have modified the existing file.
    expect(await readFile(target, "utf8")).toBe("original\n")
  })

  it("leaves no .tmp staging file behind on success", async () => {
    await atomicWriteFileExclusive(join(vault, "clean.md"), "body\n")
    const entries = await readdir(vault)
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("leaves no .tmp staging file behind when the target already exists", async () => {
    const target = join(vault, "exists.md")
    await atomicWriteFile(target, "original\n")
    await expect(atomicWriteFileExclusive(target, "body\n")).rejects.toThrow()
    const entries = await readdir(vault)
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  // The rename fallback path taken on filesystems without hard-link support
  // (e.g. a Windows-drive Docker bind mount).
  describe("hardLinksUnsupported (rename strategy)", () => {
    it("writes the exact content to a new target path via rename", async () => {
      const target = join(vault, "created.md")
      await atomicWriteFileExclusive(target, "fresh content\n", {
        hardLinksUnsupported: true,
      })
      expect(await readFile(target, "utf8")).toBe("fresh content\n")
    })

    it("throws EEXIST and leaves existing content untouched when the target exists", async () => {
      const target = join(vault, "taken.md")
      await atomicWriteFile(target, "original\n")

      await expect(
        atomicWriteFileExclusive(target, "overwrite\n", {
          hardLinksUnsupported: true,
        }),
      ).rejects.toMatchObject({ code: "EEXIST" })
      // The no-clobber guard must not have modified the existing file.
      expect(await readFile(target, "utf8")).toBe("original\n")
    })

    it("leaves no .tmp staging file behind on success", async () => {
      await atomicWriteFileExclusive(join(vault, "clean.md"), "body\n", {
        hardLinksUnsupported: true,
      })
      const entries = await readdir(vault)
      expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
  })
})

describe("fileExists", () => {
  it("resolves true for an existing file", async () => {
    const target = join(vault, "here.md")
    await atomicWriteFile(target, "body\n")
    expect(await fileExists(target)).toBe(true)
  })

  it("resolves false for a missing file", async () => {
    expect(await fileExists(join(vault, "nope.md"))).toBe(false)
  })
})

describe("path traversal", () => {
  it.each(["../escape", "../../etc/passwd", "foo/../../escape"])(
    "readNote rejects %s",
    async (path) => {
      await expect(
        readNote({ vaultPath: vault, path }, logger),
      ).rejects.toThrow("path traversal blocked")
    },
  )

  it.each(["../escape", "../../etc/passwd", "foo/../../escape"])(
    "deleteNote rejects %s",
    async (path) => {
      await expect(
        deleteNote(
          {
            vaultPath: vault,
            path,
            protectedPaths: [],
            pruneEmptyFolders: false,
          },
          logger,
        ),
      ).rejects.toThrow("path traversal blocked")
    },
  )
})

describe("readNote", () => {
  it("reads an existing file", async () => {
    await writeFile(join(vault, "test.md"), "hello world", "utf8")
    const content = await readNote(
      { vaultPath: vault, path: "test.md" },
      logger,
    )
    expect(content).toBe("hello world")
  })

  it("reads a file with frontmatter", async () => {
    const raw = "---\ntitle: Test\ntags: [a, b]\n---\n\n# Hello\n"
    await writeFile(join(vault, "note.md"), raw, "utf8")
    const content = await readNote(
      { vaultPath: vault, path: "note.md" },
      logger,
    )
    expect(content).toBe(raw)
  })

  it("throws on non-existent file", async () => {
    await expect(
      readNote({ vaultPath: vault, path: "missing.md" }, logger),
    ).rejects.toThrow('note not found: "missing.md"')
  })
})

describe("writeNote", () => {
  it("creates a new file with frontmatter", async () => {
    await writeNote(
      {
        vaultPath: vault,
        path: "new.md",
        body: "# New\n",
        properties: { title: "New" },
      },
      logger,
    )
    const content = await readFile(join(vault, "new.md"), "utf8")
    expect(content).toContain("title: New")
    expect(content).toContain("# New")
  })

  it("creates a new file without frontmatter", async () => {
    await writeNote(
      { vaultPath: vault, path: "bare.md", body: "Just body\n" },
      logger,
    )
    const content = await readFile(join(vault, "bare.md"), "utf8")
    expect(content).toContain("Just body")
  })

  it("creates parent directories", async () => {
    await writeNote(
      { vaultPath: vault, path: "deep/nested/note.md", body: "body\n" },
      logger,
    )
    const content = await readFile(join(vault, "deep/nested/note.md"), "utf8")
    expect(content).toContain("body")
  })

  it("preserves existing frontmatter when updating body only", async () => {
    await writeFile(
      join(vault, "existing.md"),
      "---\ntitle: Original\ndate: 2025-01-01\ncreated: 2026-05-13T20:00:00-04:00\n---\nold body\n",
      "utf8",
    )
    await writeNote(
      { vaultPath: vault, path: "existing.md", body: "new body\n" },
      logger,
    )
    const content = await readFile(join(vault, "existing.md"), "utf8")
    expect(content).toBe(
      "---\ntitle: Original\ndate: 2025-01-01\ncreated: 2026-05-13T20:00:00-04:00\n---\nnew body\n",
    )
  })

  it("merges new frontmatter keys without destroying existing", async () => {
    await writeFile(
      join(vault, "merge.md"),
      "---\ntitle: Keep\ntags: [a]\n---\nbody\n",
      "utf8",
    )
    await writeNote(
      {
        vaultPath: vault,
        path: "merge.md",
        body: "body\n",
        properties: { status: "active" },
      },
      logger,
    )
    const content = await readFile(join(vault, "merge.md"), "utf8")
    expect(content).toContain("title: Keep")
    expect(content).toContain("status: active")
  })

  it("removes keys set to null when merging into an existing note", async () => {
    await writeFile(
      join(vault, "merge.md"),
      "---\ntitle: Keep\ndraft: true\n---\nold body\n",
      "utf8",
    )
    await writeNote(
      {
        vaultPath: vault,
        path: "merge.md",
        body: "new body\n",
        properties: { draft: null },
      },
      logger,
    )
    const content = await readFile(join(vault, "merge.md"), "utf8")
    expect(content).toBe("---\ntitle: Keep\n---\nnew body\n")
  })

  it("does not serialize null properties when creating a new file", async () => {
    await writeNote(
      {
        vaultPath: vault,
        path: "fresh.md",
        body: "body\n",
        properties: { title: "Fresh", draft: null },
      },
      logger,
    )
    const content = await readFile(join(vault, "fresh.md"), "utf8")
    expect(content).toBe("---\ntitle: Fresh\n---\nbody\n")
  })
})

const DEFAULT_PROTECTED = ["About Me", "Daily Notes"]

describe("deleteNote", () => {
  it("deletes an existing file", async () => {
    await writeFile(join(vault, "delete-me.md"), "bye", "utf8")
    await deleteNote(
      {
        vaultPath: vault,
        path: "delete-me.md",
        protectedPaths: DEFAULT_PROTECTED,
        pruneEmptyFolders: false,
      },
      logger,
    )
    await expect(readFile(join(vault, "delete-me.md"))).rejects.toThrow()
  })

  it.each(["About Me/Principles.md", "Daily Notes/2025-01-01.md"])(
    "rejects protected path %s",
    async (path) => {
      await expect(
        deleteNote(
          {
            vaultPath: vault,
            path,
            protectedPaths: DEFAULT_PROTECTED,
            pruneEmptyFolders: false,
          },
          logger,
        ),
      ).rejects.toThrow("cannot delete protected path")
    },
  )

  it("rejects custom protected paths", async () => {
    await expect(
      deleteNote(
        {
          vaultPath: vault,
          path: "Secrets/keys.md",
          protectedPaths: ["Secrets"],
          pruneEmptyFolders: false,
        },
        logger,
      ),
    ).rejects.toThrow("cannot delete protected path")
  })

  it("allows deletion when path is not in protected list", async () => {
    await writeFile(join(vault, "ok.md"), "ok", "utf8")
    await deleteNote(
      {
        vaultPath: vault,
        path: "ok.md",
        protectedPaths: ["Locked"],
        pruneEmptyFolders: false,
      },
      logger,
    )
    await expect(readFile(join(vault, "ok.md"))).rejects.toThrow()
  })

  it("throws on non-existent file", async () => {
    await expect(
      deleteNote(
        {
          vaultPath: vault,
          path: "ghost.md",
          protectedPaths: DEFAULT_PROTECTED,
          pruneEmptyFolders: false,
        },
        logger,
      ),
    ).rejects.toThrow()
  })

  it("rejects a traversal path that resolves into a protected folder", async () => {
    // "decoy/../About Me/..." does not literally start with "About Me/" but
    // resolves into it — the guard must normalize before the prefix check.
    await mkdir(join(vault, "About Me"), { recursive: true })
    await writeFile(join(vault, "About Me/Principles.md"), "protected", "utf8")

    await expect(
      deleteNote(
        {
          vaultPath: vault,
          path: "decoy/../About Me/Principles.md",
          protectedPaths: DEFAULT_PROTECTED,
          pruneEmptyFolders: false,
        },
        logger,
      ),
    ).rejects.toThrow("cannot delete protected path")
    // The protected file must survive — the guard prevented its deletion.
    expect(await readFile(join(vault, "About Me/Principles.md"), "utf8")).toBe(
      "protected",
    )
  })

  it("rejects a backslash-separated path that resolves into a protected folder", async () => {
    // A Windows-style separator must not evade the protected-path check — the
    // guard normalizes "\\" to "/" before the prefix comparison.
    await mkdir(join(vault, "About Me"), { recursive: true })
    await writeFile(join(vault, "About Me/Principles.md"), "protected", "utf8")

    await expect(
      deleteNote(
        {
          vaultPath: vault,
          path: "About Me\\Principles.md",
          protectedPaths: DEFAULT_PROTECTED,
          pruneEmptyFolders: false,
        },
        logger,
      ),
    ).rejects.toThrow("cannot delete protected path")
    expect(await readFile(join(vault, "About Me/Principles.md"), "utf8")).toBe(
      "protected",
    )
  })

  describe("empty-folder prune", () => {
    /** True when a folder still exists in the vault — used to assert pruning. */
    const folderExists = async (path: string): Promise<boolean> => {
      try {
        await stat(join(vault, path))
        return true
      } catch {
        return false
      }
    }

    const deleteWithPrune = (path: string) =>
      deleteNote(
        {
          vaultPath: vault,
          path,
          protectedPaths: DEFAULT_PROTECTED,
          pruneEmptyFolders: true,
        },
        logger,
      )

    it("leaves the parent folder in place when prune is off (Obsidian default)", async () => {
      await mkdir(join(vault, "Folder"))
      await writeFile(join(vault, "Folder/only.md"), "body", "utf8")

      const pruned = await deleteNote(
        {
          vaultPath: vault,
          path: "Folder/only.md",
          protectedPaths: DEFAULT_PROTECTED,
          pruneEmptyFolders: false,
        },
        logger,
      )

      expect(await folderExists("Folder")).toBe(true)
      expect(await folderExists("Folder/only.md")).toBe(false)
      expect(pruned.prunedEmptyFolders).toBe(0)
    })

    it("removes the now-empty parent folder when prune is enabled", async () => {
      await mkdir(join(vault, "Folder"))
      await writeFile(join(vault, "Folder/only.md"), "body", "utf8")

      const pruned = await deleteWithPrune("Folder/only.md")

      expect(await folderExists("Folder")).toBe(false)
      expect(pruned.prunedEmptyFolders).toBe(1)
    })

    it("walks up removing multiple empty parents when prune is enabled", async () => {
      await mkdir(join(vault, "A/B/C"), { recursive: true })
      await writeFile(join(vault, "A/B/C/note.md"), "body", "utf8")

      const pruned = await deleteWithPrune("A/B/C/note.md")

      expect(await folderExists("A/B/C")).toBe(false)
      expect(await folderExists("A/B")).toBe(false)
      expect(await folderExists("A")).toBe(false)
      expect(pruned.prunedEmptyFolders).toBe(3)
    })

    it("stops at the first non-empty parent", async () => {
      await mkdir(join(vault, "A/B"), { recursive: true })
      await writeFile(join(vault, "A/keep.md"), "keep", "utf8")
      await writeFile(join(vault, "A/B/note.md"), "body", "utf8")

      const pruned = await deleteWithPrune("A/B/note.md")

      expect(await folderExists("A/B")).toBe(false)
      expect(await folderExists("A")).toBe(true)
      expect(await folderExists("A/keep.md")).toBe(true)
      expect(pruned.prunedEmptyFolders).toBe(1)
    })

    it("never removes the vault root", async () => {
      await writeFile(join(vault, "root-note.md"), "body", "utf8")

      const pruned = await deleteWithPrune("root-note.md")

      expect(await folderExists("root-note.md")).toBe(false)
      expect(await folderExists("")).toBe(true)
      expect(pruned.prunedEmptyFolders).toBe(0)
    })

    it("leaves a folder that still contains a hidden file", async () => {
      await mkdir(join(vault, "Folder"))
      await writeFile(join(vault, "Folder/note.md"), "body", "utf8")
      await writeFile(join(vault, "Folder/.DS_Store"), "junk", "utf8")

      const pruned = await deleteWithPrune("Folder/note.md")

      // The note must actually be gone, so the folder survives only because of
      // the hidden file — not because the delete silently no-op'd.
      expect(await folderExists("Folder/note.md")).toBe(false)
      expect(await folderExists("Folder")).toBe(true)
      expect(await folderExists("Folder/.DS_Store")).toBe(true)
      expect(pruned.prunedEmptyFolders).toBe(0)
    })

    it("logs a warning and returns 0 without throwing when a folder cannot be removed", async () => {
      // A plain file where a parent folder is expected makes readdir throw
      // ENOTDIR — a real filesystem failure (no mocking), exercising the catch.
      await writeFile(join(vault, "NotADir"), "i am a file", "utf8")
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const pruned = await pruneEmptyParents(
        { vaultPath: vault, path: "NotADir/note.md" },
        logger,
      )

      expect(pruned).toBe(0)
      expect(warnSpy).toHaveBeenCalledWith(
        "could not remove empty folder",
        expect.objectContaining({ folder: "NotADir" }),
      )
    })
  })
})

describe("listNotes", () => {
  beforeEach(async () => {
    await mkdir(join(vault, "notes"), { recursive: true })
    await mkdir(join(vault, ".obsidian"), { recursive: true })
    await mkdir(join(vault, "notes/.hidden"), { recursive: true })
    await writeFile(join(vault, "root.md"), "r", "utf8")
    await writeFile(join(vault, "notes/a.md"), "a", "utf8")
    await writeFile(join(vault, "notes/b.md"), "b", "utf8")
    await writeFile(join(vault, "notes/data.json"), "{}", "utf8")
    await writeFile(join(vault, ".obsidian/config.md"), "x", "utf8")
    await writeFile(join(vault, "notes/.hidden/secret.md"), "s", "utf8")
  })

  it("lists all visible .md files recursively", async () => {
    const files = await listNotes({ vaultPath: vault }, logger)
    expect(files).toEqual(["notes/a.md", "notes/b.md", "root.md"])
  })

  it("lists files under a specific folder", async () => {
    const files = await listNotes({ vaultPath: vault, folder: "notes" }, logger)
    expect(files).toEqual(["notes/a.md", "notes/b.md"])
  })

  it("skips hidden directories", async () => {
    const files = await listNotes({ vaultPath: vault }, logger)
    expect(files).not.toContain(".obsidian/config.md")
    expect(files).not.toContain("notes/.hidden/secret.md")
  })

  it("skips non-.md files", async () => {
    const files = await listNotes({ vaultPath: vault }, logger)
    expect(files).not.toContain("notes/data.json")
  })

  it("applies glob filter", async () => {
    const files = await listNotes(
      { vaultPath: vault, glob: "notes/a*" },
      logger,
    )
    expect(files).toEqual(["notes/a.md"])
  })

  it("returns empty array for non-existent folder", async () => {
    const files = await listNotes({ vaultPath: vault, folder: "nope" }, logger)
    expect(files).toEqual([])
  })

  it("returns sorted results", async () => {
    await writeFile(join(vault, "notes/z.md"), "z", "utf8")
    const files = await listNotes({ vaultPath: vault, folder: "notes" }, logger)
    expect(files).toEqual(["notes/a.md", "notes/b.md", "notes/z.md"])
  })
})

describe("readNoteProperties", () => {
  it("returns parsed frontmatter as an object", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\ntitle: Test\ntags: [a, b]\nstatus: active\n---\n\n# Body\n",
      "utf8",
    )
    const properties = await readNoteProperties(
      { vaultPath: vault, path: "test.md" },
      logger,
    )
    expect(properties).toEqual({
      title: "Test",
      tags: ["a", "b"],
      status: "active",
    })
  })

  it("throws on non-existent file", async () => {
    await expect(
      readNoteProperties({ vaultPath: vault, path: "missing.md" }, logger),
    ).rejects.toThrow("note not found")
  })

  it("returns empty object for file with no frontmatter", async () => {
    await writeFile(join(vault, "plain.md"), "# No frontmatter\n", "utf8")
    const properties = await readNoteProperties(
      { vaultPath: vault, path: "plain.md" },
      logger,
    )
    expect(properties).toEqual({})
  })

  it("returns datetime properties as their original strings, not Dates", async () => {
    await writeFile(
      join(vault, "stamped.md"),
      "---\ndate: 2026-05-13\ncreated: 2026-05-13T20:00:00-04:00\n---\nbody\n",
      "utf8",
    )
    const properties = await readNoteProperties(
      { vaultPath: vault, path: "stamped.md" },
      logger,
    )
    expect(properties.created).toBe("2026-05-13T20:00:00-04:00")
    expect(properties.date).toBe("2026-05-13")
  })

  it("parses YAML arrays and nested values", async () => {
    await writeFile(
      join(vault, "nested.md"),
      '---\ntags:\n  - one\n  - two\nrelated:\n  - "[[Note A]]"\n---\nbody\n',
      "utf8",
    )
    const properties = await readNoteProperties(
      { vaultPath: vault, path: "nested.md" },
      logger,
    )
    expect(properties.tags).toEqual(["one", "two"])
    expect(properties.related).toEqual(["[[Note A]]"])
  })
})

describe("updateProperties", () => {
  it("merges new keys without changing body", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\ntitle: Original\n---\nBody content\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { status: "active" },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    const parsed = parseNote(content)
    expect(parsed.content.trim()).toBe("Body content")
    expect(parsed.data.status).toBe("active")
    expect(parsed.data.title).toBe("Original")
  })

  it("overwrites existing key values", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\nstatus: draft\n---\nbody\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { status: "published" },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    expect(content).toContain("status: published")
    expect(content).not.toContain("status: draft")
  })

  it("preserves unmentioned keys", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\ntitle: Keep\ntags: [a, b]\n---\nbody\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { status: "active" },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    const parsed = parseNote(content)
    expect(parsed.data.title).toBe("Keep")
    expect(parsed.data.tags).toEqual(["a", "b"])
    expect(parsed.data.status).toBe("active")
  })

  it("keeps an untouched local-offset created datetime byte-identical", async () => {
    await writeFile(
      join(vault, "stamped.md"),
      "---\ntitle: Stamped\ncreated: 2026-05-13T20:00:00-04:00\n---\nbody\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "stamped.md",
        properties: { status: "active" },
      },
      logger,
    )
    const content = await readFile(join(vault, "stamped.md"), "utf8")
    expect(content).toBe(
      "---\ntitle: Stamped\ncreated: 2026-05-13T20:00:00-04:00\nstatus: active\n---\nbody\n",
    )
  })

  it("deletes a key set to null", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\ntitle: Keep\nstatus: draft\n---\nbody\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { status: null },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    expect(content).toBe("---\ntitle: Keep\n---\nbody\n")
  })

  it("treats null for a non-existent key as a no-op", async () => {
    const original = "---\ntitle: Keep\n---\nbody\n"
    await writeFile(join(vault, "test.md"), original, "utf8")
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { ghost: null },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    expect(content).toBe(original)
  })

  it("deletes and sets keys in the same call", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\nstatus: draft\ntitle: Keep\n---\nbody\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { status: null, priority: 1 },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    expect(content).toBe("---\ntitle: Keep\npriority: 1\n---\nbody\n")
  })

  it("removes the frontmatter block entirely when the last key is deleted", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\nstatus: draft\n---\nbody\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { status: null },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    expect(content).toBe("body\n")
  })

  it("preserves an unmentioned pre-existing empty property", async () => {
    await writeFile(
      join(vault, "test.md"),
      "---\ndue:\ntitle: Keep\n---\nbody\n",
      "utf8",
    )
    await updateProperties(
      {
        vaultPath: vault,
        path: "test.md",
        properties: { status: "active" },
      },
      logger,
    )
    const content = await readFile(join(vault, "test.md"), "utf8")
    expect(content).toBe("---\ndue:\ntitle: Keep\nstatus: active\n---\nbody\n")
  })

  it("throws on non-existent file", async () => {
    await expect(
      updateProperties(
        {
          vaultPath: vault,
          path: "missing.md",
          properties: { key: "val" },
        },
        logger,
      ),
    ).rejects.toThrow("note not found")
  })

  it("adds frontmatter block to file with no existing frontmatter", async () => {
    await writeFile(join(vault, "plain.md"), "# Just a body\n", "utf8")
    await updateProperties(
      {
        vaultPath: vault,
        path: "plain.md",
        properties: { status: "active" },
      },
      logger,
    )
    const content = await readFile(join(vault, "plain.md"), "utf8")
    expect(content).toContain("status: active")
    expect(content).toContain("Just a body")
  })

  it("blocks path traversal", async () => {
    await expect(
      updateProperties(
        {
          vaultPath: vault,
          path: "../escape.md",
          properties: { key: "val" },
        },
        logger,
      ),
    ).rejects.toThrow("path traversal blocked")
  })
})

describe("write size logging", () => {
  it("writeNote logs beforeBytes 0 and afterBytes for a new file", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
    onTestFinished(() => infoSpy.mockRestore())

    await writeNote({ vaultPath: vault, path: "n.md", body: "hello\n" }, logger)
    const written = await readFile(join(vault, "n.md"), "utf8")

    expect(infoSpy).toHaveBeenCalledWith("wrote note", {
      path: "n.md",
      beforeBytes: 0,
      afterBytes: Buffer.byteLength(written, "utf8"),
    })
  })

  it("writeNote logs the prior file size as beforeBytes when overwriting", async () => {
    const original = "---\ntitle: T\n---\nold body\n"
    await writeFile(join(vault, "e.md"), original, "utf8")
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
    onTestFinished(() => infoSpy.mockRestore())

    await writeNote({ vaultPath: vault, path: "e.md", body: "new\n" }, logger)
    const written = await readFile(join(vault, "e.md"), "utf8")

    expect(infoSpy).toHaveBeenCalledWith("wrote note", {
      path: "e.md",
      beforeBytes: Buffer.byteLength(original, "utf8"),
      afterBytes: Buffer.byteLength(written, "utf8"),
    })
  })

  it("updateProperties logs before/after byte counts", async () => {
    const original = "---\ntitle: Original\n---\nBody content\n"
    await writeFile(join(vault, "p.md"), original, "utf8")
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
    onTestFinished(() => infoSpy.mockRestore())

    await updateProperties(
      { vaultPath: vault, path: "p.md", properties: { status: "active" } },
      logger,
    )
    const written = await readFile(join(vault, "p.md"), "utf8")

    expect(infoSpy).toHaveBeenCalledWith("updated properties", {
      path: "p.md",
      beforeBytes: Buffer.byteLength(original, "utf8"),
      afterBytes: Buffer.byteLength(written, "utf8"),
    })
  })
})

describe("readNoteOutline", () => {
  it("returns each heading's level, text, and section byte size", async () => {
    const body = "# Title\n\nIntro line.\n\n## Active\n\n- one\n- two\n"
    await writeFile(join(vault, "outline.md"), body, "utf8")

    const outline = await readNoteOutline(
      { vaultPath: vault, path: "outline.md" },
      logger,
    )

    // "# Title" (H1) has no later H1, so its span includes the nested "## Active"
    // child — its byte size is the whole body. "## Active" is just its own span.
    // No leading callout, so `leading_callout` is omitted from the outline object.
    expect(outline).toEqual({
      headings: [
        { level: 1, text: "Title", bytes: Buffer.byteLength(body, "utf8") },
        {
          level: 2,
          text: "Active",
          bytes: Buffer.byteLength("## Active\n\n- one\n- two\n", "utf8"),
        },
      ],
    })
  })

  it("returns an empty headings array for a note with no headings", async () => {
    await writeFile(join(vault, "flat.md"), "just prose, no headings\n", "utf8")
    expect(
      await readNoteOutline({ vaultPath: vault, path: "flat.md" }, logger),
    ).toEqual({ headings: [] })
  })

  it("surfaces a leading callout below the H1 alongside the headings", async () => {
    const body =
      "# Me\n\n> [!info] Scope of this file\n> **Contains:** identity facts.\n> **Convention:** append newest first.\n\n## Identity\n\n- a\n"
    await writeFile(join(vault, "scoped.md"), body, "utf8")

    const outline = await readNoteOutline(
      { vaultPath: vault, path: "scoped.md" },
      logger,
    )

    expect(outline.leading_callout).toEqual({
      type: "info",
      title: "Scope of this file",
      body: "**Contains:** identity facts.\n**Convention:** append newest first.",
    })
    expect(outline.headings.map((heading) => heading.text)).toEqual([
      "Me",
      "Identity",
    ])
  })

  it("omits callout when the first body content is not a callout", async () => {
    const body = "# Title\n\nIntro prose, not a callout.\n\n## Section\n"
    await writeFile(join(vault, "nocallout.md"), body, "utf8")
    const outline = await readNoteOutline(
      { vaultPath: vault, path: "nocallout.md" },
      logger,
    )
    expect(outline.leading_callout).toBeUndefined()
    expect("leading_callout" in outline).toBe(false)
  })

  it("excludes frontmatter from section line ranges", async () => {
    // The heading sits after a multi-line frontmatter block; bytes must be
    // computed on the body only, so a longer frontmatter doesn't change them.
    const body = "## Only\n\nbody\n"
    await writeFile(
      join(vault, "fm.md"),
      `---\ntitle: A\ntags:\n  - x\n  - y\n---\n${body}`,
      "utf8",
    )
    const outline = await readNoteOutline(
      { vaultPath: vault, path: "fm.md" },
      logger,
    )
    expect(outline).toEqual({
      headings: [
        { level: 2, text: "Only", bytes: Buffer.byteLength(body, "utf8") },
      ],
    })
  })

  it("throws note not found for a missing path", async () => {
    await expect(
      readNoteOutline({ vaultPath: vault, path: "missing.md" }, logger),
    ).rejects.toThrow('note not found: "missing.md"')
  })
})

describe("readNoteSection", () => {
  const board =
    "# Board\n\n## Active\n\n- [ ] task A\n\n## Done\n\n- [x] task B\n"

  beforeEach(async () => {
    await writeFile(join(vault, "board.md"), board, "utf8")
  })

  it("returns the heading line plus its body, stopping at the next same-level heading", async () => {
    const section = await readNoteSection(
      { vaultPath: vault, path: "board.md", heading: "Active" },
      logger,
    )
    expect(section).toBe("## Active\n\n- [ ] task A\n")
  })

  it("includes child headings in a parent section", async () => {
    const body =
      "## Parent\n\nintro\n\n### Child\n\nchild body\n\n## Sibling\n\nx\n"
    await writeFile(join(vault, "nested.md"), body, "utf8")
    const section = await readNoteSection(
      { vaultPath: vault, path: "nested.md", heading: "Parent" },
      logger,
    )
    expect(section).toBe("## Parent\n\nintro\n\n### Child\n\nchild body\n")
  })

  it("disambiguates duplicate headings via heading_level", async () => {
    // "Notes" appears as both an H2 and an H3; heading_level picks the H3.
    const body = "## Notes\n\ntop notes\n\n## Other\n\n### Notes\n\nsub notes\n"
    await writeFile(join(vault, "dup.md"), body, "utf8")
    const section = await readNoteSection(
      { vaultPath: vault, path: "dup.md", heading: "Notes", headingLevel: 3 },
      logger,
    )
    expect(section).toBe("### Notes\n\nsub notes\n")
  })

  it("excludes a trailing Kanban %% settings block from the last section", async () => {
    const withSettings =
      "## Active\n\n- [ ] task\n\n%% kanban:settings\n```\n{}\n```\n%%\n"
    await writeFile(join(vault, "kanban.md"), withSettings, "utf8")
    const section = await readNoteSection(
      { vaultPath: vault, path: "kanban.md", heading: "Active" },
      logger,
    )
    // The blank line before the %% block is absorbed too — no dangling blank.
    expect(section).toBe("## Active\n\n- [ ] task")
  })

  it("throws and lists available headings when the heading is not found", async () => {
    await expect(
      readNoteSection(
        { vaultPath: vault, path: "board.md", heading: "Missing" },
        logger,
      ),
    ).rejects.toThrow(
      'heading not found: "Missing". Available headings: # Board, ## Active, ## Done',
    )
  })

  it("throws ambiguous when two headings share text and level", async () => {
    const body = "## Dup\n\na\n\n## Dup\n\nb\n"
    await writeFile(join(vault, "amb.md"), body, "utf8")
    await expect(
      readNoteSection(
        { vaultPath: vault, path: "amb.md", heading: "Dup" },
        logger,
      ),
    ).rejects.toThrow('ambiguous heading: "Dup"')
  })

  it("throws note not found for a missing path", async () => {
    await expect(
      readNoteSection(
        { vaultPath: vault, path: "missing.md", heading: "Active" },
        logger,
      ),
    ).rejects.toThrow('note not found: "missing.md"')
  })

  it("throws heading cannot be empty for an empty heading", async () => {
    await expect(
      readNoteSection(
        { vaultPath: vault, path: "board.md", heading: "" },
        logger,
      ),
    ).rejects.toThrow("heading cannot be empty")
  })
})

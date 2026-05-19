import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import matter from "gray-matter"
import { vaultFs } from "../vault-filesystem.js"
import { logger } from "../../../logger.js"

const {
  readNote,
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
        deleteNote({ vaultPath: vault, path, protectedPaths: [] }, logger),
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
      "---\ntitle: Original\ncreated: 2025-01-01\n---\nold body\n",
      "utf8",
    )
    await writeNote(
      { vaultPath: vault, path: "existing.md", body: "new body\n" },
      logger,
    )
    const content = await readFile(join(vault, "existing.md"), "utf8")
    expect(content).toContain("title: Original")
    expect(content).toContain("created: 2025-01-01")
    expect(content).toContain("new body")
    expect(content).not.toContain("old body")
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
          { vaultPath: vault, path, protectedPaths: DEFAULT_PROTECTED },
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
        },
        logger,
      ),
    ).rejects.toThrow("cannot delete protected path")
  })

  it("allows deletion when path is not in protected list", async () => {
    await writeFile(join(vault, "ok.md"), "ok", "utf8")
    await deleteNote(
      { vaultPath: vault, path: "ok.md", protectedPaths: ["Locked"] },
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
        },
        logger,
      ),
    ).rejects.toThrow()
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
    const parsed = matter(content)
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
    const parsed = matter(content)
    expect(parsed.data.title).toBe("Keep")
    expect(parsed.data.tags).toEqual(["a", "b"])
    expect(parsed.data.status).toBe("active")
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

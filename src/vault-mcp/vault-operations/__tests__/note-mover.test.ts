import { describe, it, expect, vi, onTestFinished } from "vitest"
import { rm, writeFile, mkdir, readFile, stat } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { noteMover } from "../note-mover.js"
import { vaultFs } from "../vault-filesystem.js"
import type { Logger } from "../../../logger.js"

const PROTECTED = ["About Me", "Daily Notes"] as const

/** A Logger whose methods are spies, so a test can assert on its log calls
 *  (vi.mocked(logger.info)…) without touching the shared logger singleton.
 *  child() returns the same mock so any childed logger is asserted on too. */
const createLoggerMock = (): Logger => {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  vi.mocked(mock.child).mockReturnValue(mock)
  return mock
}

/** Creates an isolated temp vault for a single test — removed automatically when
 *  the test finishes — plus a per-test logger mock and helpers bound to them. Each
 *  test calls this for its own vault, so there is no shared mutable state. */
const setupVault = () => {
  const vault = mkdtempSync(join(tmpdir(), "note-mover-test-"))
  onTestFinished(() => rm(vault, { recursive: true, force: true }))
  const logger = createLoggerMock()

  const writeFixture = async (path: string, content: string): Promise<void> => {
    const fullPath = join(vault, path)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, "utf8")
  }

  const readNote = (path: string): Promise<string> =>
    readFile(join(vault, path), "utf8")

  const noteExists = async (path: string): Promise<boolean> => {
    try {
      await stat(join(vault, path))
      return true
    } catch {
      return false
    }
  }

  /** True when a folder still exists in the vault — used to assert pruning. */
  const folderExists = (path: string): Promise<boolean> => noteExists(path)

  /** Moves a note, snapshotting the pre-move path list the way the tool does. */
  const moveNote = async (
    oldPath: string,
    newPath: string,
    backlinkSources: string[] = [],
    pruneEmptyFolders = false,
  ) =>
    noteMover.moveNote(
      {
        vaultPath: vault,
        oldPath,
        newPath,
        protectedPaths: PROTECTED,
        backlinkSources,
        allNotePaths: await vaultFs.listNotes({ vaultPath: vault }, logger),
        pruneEmptyFolders,
      },
      logger,
    )

  return {
    vault,
    logger,
    writeFixture,
    readNote,
    noteExists,
    folderExists,
    moveNote,
  }
}

describe("moveNote — file relocation", () => {
  it("writes the note at the new path and removes the old one", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Inbox/Draft.md", "Just a body.\n")

    await moveNote("Inbox/Draft.md", "Inbox/Spec.md")

    expect(await noteExists("Inbox/Draft.md")).toBe(false)
    expect(await readNote("Inbox/Spec.md")).toBe("Just a body.\n")
  })

  it("creates destination parent folders that do not yet exist", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Inbox/Draft.md", "Body.\n")

    await moveNote("Inbox/Draft.md", "Projects/Specs/Draft.md")

    expect(await readNote("Projects/Specs/Draft.md")).toBe("Body.\n")
  })

  it("returns the full move summary for a move with no backlinks", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Inbox/Draft.md", "Body.\n")

    const result = await moveNote("Inbox/Draft.md", "Done/Draft.md")

    expect(result).toEqual({
      moved_to: "Done/Draft.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
  })
})

describe("moveNote — link rewriting forms", () => {
  it("rewrites a bare wikilink on rename", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "See [[Foo]] for details.\n")

    const result = await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe("See [[Bar]] for details.\n")
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Hub.md"],
      pruned_empty_folders: 0,
    })
  })

  it("leaves a bare wikilink untouched on a folder move when the short name stays unambiguous", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "See [[Foo]] for details.\n")

    const result = await moveNote("Foo.md", "Archive/Foo.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe("See [[Foo]] for details.\n")
    expect(result).toEqual({
      moved_to: "Archive/Foo.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
  })

  it("rewrites a full vault-path wikilink to the new path", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Projects/Foo.md", "content\n")
    await writeFixture("Hub.md", "See [[Projects/Foo]] here.\n")

    await moveNote("Projects/Foo.md", "Archive/Foo.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe("See [[Archive/Foo]] here.\n")
  })

  it("preserves an alias when rewriting a wikilink", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "See [[Foo|the foo note]].\n")

    await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe("See [[Bar|the foo note]].\n")
  })

  it("preserves a heading anchor when rewriting a wikilink", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Jump to [[Foo#Setup]].\n")

    await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe("Jump to [[Bar#Setup]].\n")
  })

  it("preserves the embed marker when rewriting an embed", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "![[Foo]]\n")

    await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe("![[Bar]]\n")
  })

  it("rewrites a markdown link, preserving its text and re-encoding spaces", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Old Note.md", "content\n")
    await writeFixture("Hub.md", "Read the [summary](Old%20Note.md) now.\n")

    await moveNote("Old Note.md", "New Note.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe(
      "Read the [summary](New%20Note.md) now.\n",
    )
  })

  it("percent-encodes reserved characters in a rewritten markdown link", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Old.md", "content\n")
    await writeFixture("Hub.md", "Read the [summary](Old.md) now.\n")

    // Reserved characters in the new name (space, parens) must be encoded so the
    // markdown link can't be broken by a literal ")".
    await moveNote("Old.md", "New (Draft).md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe(
      "Read the [summary](New%20%28Draft%29.md) now.\n",
    )
  })

  it("rewrites a wikilink stored in a frontmatter property", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", '---\nrelated:\n  - "[[Foo]]"\n---\nBody\n')

    const result = await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe(
      '---\nrelated:\n  - "[[Bar]]"\n---\nBody\n',
    )
    expect(result.links_updated).toBe(1)
  })

  it("rewrites a source-relative wikilink in another folder", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("B/Target.md", "content\n")
    await writeFixture("A/Note.md", "Up and over to [[../B/Target]].\n")

    await moveNote("B/Target.md", "B/Renamed.md", ["A/Note.md"])

    expect(await readNote("A/Note.md")).toBe(
      "Up and over to [[../B/Renamed]].\n",
    )
  })

  it("rewrites the moved note's own relative link so it still resolves from the new folder", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("A/Sibling.md", "sibling\n")
    await writeFixture("B/Target.md", "Points to [[../A/Sibling]].\n")

    const result = await moveNote("B/Target.md", "C/Deep/Target.md")

    expect(await noteExists("B/Target.md")).toBe(false)
    expect(await readNote("C/Deep/Target.md")).toBe(
      "Points to [[../../A/Sibling]].\n",
    )
    expect(result).toEqual({
      moved_to: "C/Deep/Target.md",
      links_updated: 1,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
  })

  it("upgrades a bare wikilink to a full path when the new basename is no longer unique", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Common.md", "the other common\n")
    await writeFixture("Inbox/Special.md", "content\n")
    await writeFixture("Hub.md", "See [[Special]].\n")

    await moveNote("Inbox/Special.md", "Archive/Common.md", ["Hub.md"])

    // A bare [[Common]] would resolve to the root Common.md, so the rewrite must
    // use the full path to keep pointing at the moved note.
    expect(await readNote("Hub.md")).toBe("See [[Archive/Common]].\n")
  })
})

describe("moveNote — selectivity (must-not-rewrite cases)", () => {
  it("rewrites only the link to the moved note, leaving unrelated links intact", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Keep.md", "keep\n")
    await writeFixture("Hub.md", "Both [[Foo]] and [[Keep]] matter.\n")

    const result = await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe("Both [[Bar]] and [[Keep]] matter.\n")
    expect(result.links_updated).toBe(1)
  })

  it("does not rewrite a link inside a fenced code block", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const body = "Real link [[Foo]].\n\n```\nExample: [[Foo]] in code\n```\n"
    await writeFixture("Hub.md", body)

    const result = await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe(
      "Real link [[Bar]].\n\n```\nExample: [[Foo]] in code\n```\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("does not rewrite a link inside an inline code span", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Use `[[Foo]]` syntax to link [[Foo]].\n")

    await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(await readNote("Hub.md")).toBe(
      "Use `[[Foo]]` syntax to link [[Bar]].\n",
    )
  })

  it("does not rewrite a same-named link that resolves to a different note, even when passed as a candidate", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Deep/Foo.md", "the moved note\n")
    await writeFixture("Near/Foo.md", "a different foo\n")
    // [[Foo]] here resolves to Near/Foo.md (same folder), not the moved Deep/Foo.md.
    await writeFixture("Near/Note.md", "Local [[Foo]].\n")

    const result = await moveNote("Deep/Foo.md", "Deep/Bar.md", [
      "Near/Note.md",
    ])

    expect(await readNote("Near/Note.md")).toBe("Local [[Foo]].\n")
    expect(result).toEqual({
      moved_to: "Deep/Bar.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
  })
})

describe("moveNote — counts and summary", () => {
  it("counts every rewritten occurrence and lists changed notes sorted", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Beta.md", "[[Foo]] and again [[Foo|alias]].\n")
    await writeFixture("Alpha.md", "Single [[Foo]].\n")

    const result = await moveNote("Foo.md", "Bar.md", ["Beta.md", "Alpha.md"])

    expect(await readNote("Beta.md")).toBe("[[Bar]] and again [[Bar|alias]].\n")
    expect(await readNote("Alpha.md")).toBe("Single [[Bar]].\n")
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 3,
      updated_notes: ["Alpha.md", "Beta.md"],
      pruned_empty_folders: 0,
    })
  })

  it("rewrites every source when there are more than one batch of them", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    // 25 sources spans three batches of 10 — exercises the batch-boundary logic.
    const sources = Array.from({ length: 25 }, (_unused, index) => {
      const padded = String(index).padStart(2, "0")
      return `src-${padded}.md`
    })
    await Promise.all(
      sources.map((source) => writeFixture(source, "Link to [[Foo]].\n")),
    )

    const result = await moveNote("Foo.md", "Bar.md", sources)

    const allRewritten = await Promise.all(
      sources.map((source) => readNote(source)),
    )
    expect(allRewritten).toEqual(
      Array.from({ length: sources.length }, () => "Link to [[Bar]].\n"),
    )
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 25,
      updated_notes: [...sources].sort(),
      pruned_empty_folders: 0,
    })
  })
})

describe("moveNote — guards", () => {
  it("throws when the destination already exists", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Bar.md", "occupied\n")

    await expect(moveNote("Foo.md", "Bar.md")).rejects.toThrow(
      'destination exists: "Bar.md"',
    )
    // The existing destination is left untouched.
    expect(await readNote("Bar.md")).toBe("occupied\n")
    expect(await readNote("Foo.md")).toBe("content\n")
  })

  it("throws when the source note does not exist", async () => {
    const { moveNote } = setupVault()
    await expect(moveNote("Missing.md", "Bar.md")).rejects.toThrow(
      'note not found: "Missing.md"',
    )
  })

  it("throws when the source is under a protected path", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("About Me/Me.md", "memory\n")

    await expect(moveNote("About Me/Me.md", "Bar.md")).rejects.toThrow(
      'cannot move protected path "About Me/Me.md"',
    )
    expect(await noteExists("About Me/Me.md")).toBe(true)
  })

  it("throws when the destination is under a protected path", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote("Foo.md", "About Me/Foo.md")).rejects.toThrow(
      'cannot move into protected path "About Me/Foo.md"',
    )
    expect(await noteExists("Foo.md")).toBe(true)
  })

  it("refuses a destination that reaches a protected path through .. segments", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")

    // Normalizes to "Daily Notes/Foo.md", which must not slip past the guard.
    await expect(
      moveNote("Foo.md", "Inbox/../Daily Notes/Foo.md"),
    ).rejects.toThrow('cannot move into protected path "Daily Notes/Foo.md"')
    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Daily Notes/Foo.md")).toBe(false)
  })

  it("throws when source and destination are identical", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote("Foo.md", "Foo.md")).rejects.toThrow(
      "source and destination are the same path",
    )
  })

  it("throws when a path does not end in .md", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote("Foo.md", "Bar.txt")).rejects.toThrow(
      "vault_move_note only moves .md notes (paths must end in .md)",
    )
  })

  it("throws when a path escapes the vault root", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote("Foo.md", "../escape.md")).rejects.toThrow(
      "path traversal blocked",
    )
  })
})

describe("moveNote — failure safety", () => {
  it("aborts without writing anything when a backlink source cannot be read", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    // "Ghost.md" is listed as a backlink source (as a stale index row might be)
    // but has no file on disk, so its preflight read fails. The preflight must
    // fail before any write so the vault is left untouched.
    await expect(
      moveNote("Foo.md", "Bar.md", ["Hub.md", "Ghost.md"]),
    ).rejects.toThrow()

    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Bar.md")).toBe(false)
    expect(await readNote("Hub.md")).toBe("Links [[Foo]].\n")
  })

  it("logs the offending source and destination when a rewrite aborts the move", async () => {
    const { writeFixture, moveNote, logger } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    await expect(
      moveNote("Foo.md", "Bar.md", ["Hub.md", "Ghost.md"]),
    ).rejects.toThrow()

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "note move aborted: could not read/plan a backlink source",
      expect.objectContaining({
        source: "Ghost.md",
        from: "Foo.md",
        to: "Bar.md",
      }),
    )
  })

  it("logs a completion summary with the success and failure counts", async () => {
    const { writeFixture, moveNote, logger } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    await moveNote("Foo.md", "Bar.md", ["Hub.md"])

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith("note move complete", {
      from: "Foo.md",
      to: "Bar.md",
      links_updated: 1,
      sources_updated: 1,
      sources_failed: 0,
      pruned_empty_folders: 0,
    })
  })
})

describe("moveNote — empty-folder prune", () => {
  it("leaves the source folder in place when prune is off (Obsidian default)", async () => {
    const { writeFixture, moveNote, folderExists } = setupVault()
    await writeFixture("Inbox/draft.md", "body\n")

    const result = await moveNote("Inbox/draft.md", "Projects/draft.md")

    expect(await folderExists("Inbox")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })

  it("removes the source folder when its last note is moved out and prune is on", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Inbox/draft.md", "body\n")

    const result = await moveNote(
      "Inbox/draft.md",
      "Projects/draft.md",
      [],
      true,
    )

    expect(await folderExists("Inbox")).toBe(false)
    expect(await noteExists("Projects/draft.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(1)
  })

  it("walks up removing nested empty source parents", async () => {
    const { writeFixture, moveNote, folderExists } = setupVault()
    await writeFixture("A/B/note.md", "body\n")

    const result = await moveNote("A/B/note.md", "Dest/note.md", [], true)

    expect(await folderExists("A/B")).toBe(false)
    expect(await folderExists("A")).toBe(false)
    expect(result.pruned_empty_folders).toBe(2)
  })

  it("leaves the source folder when another note remains", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Inbox/keep.md", "keep\n")
    await writeFixture("Inbox/move.md", "move\n")

    const result = await moveNote("Inbox/move.md", "Projects/move.md", [], true)

    expect(await folderExists("Inbox")).toBe(true)
    expect(await noteExists("Inbox/keep.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })

  it("does not prune on an in-place rename within the same folder", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Notes/old.md", "body\n")

    const result = await moveNote("Notes/old.md", "Notes/new.md", [], true)

    expect(await folderExists("Notes")).toBe(true)
    expect(await noteExists("Notes/new.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })

  it("does not prune when moving into a subfolder of the source", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Parent/note.md", "body\n")

    const result = await moveNote(
      "Parent/note.md",
      "Parent/Sub/note.md",
      [],
      true,
    )

    expect(await folderExists("Parent")).toBe(true)
    expect(await noteExists("Parent/Sub/note.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })
})

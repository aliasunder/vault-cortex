import { describe, it, expect, vi, onTestFinished } from "vitest"
import { rm, writeFile, mkdir, readFile, stat } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { noteMover } from "../note-mover.js"
import { vaultFs } from "../vault-filesystem.js"
import { vaultPatcher } from "../vault-patcher.js"
import { withExclusiveFileLock } from "../../../utils/file-write-lock.js"
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

  /** Moves a note, snapshotting the pre-move path lists the way the tool does.
   *  Named params mirror noteMover.moveNote so call sites are self-describing;
   *  vault plumbing and the defaults (no backlink sources, no pruning, no
   *  Windows mode) are filled in here. */
  const moveNote = async (params: {
    oldPath: string
    newPath: string
    backlinkSources?: string[]
    pruneEmptyFolders?: boolean
    windowsBindMount?: boolean
  }) =>
    noteMover.moveNote(
      {
        vaultPath: vault,
        oldPath: params.oldPath,
        newPath: params.newPath,
        protectedPaths: PROTECTED,
        backlinkSources: params.backlinkSources ?? [],
        allNotePaths: await vaultFs.listNotes({ vaultPath: vault }, logger),
        allAssetPaths: await vaultFs.listAssets({ vaultPath: vault }, logger),
        pruneEmptyFolders: params.pruneEmptyFolders ?? false,
        windowsBindMount: params.windowsBindMount ?? false,
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

    await moveNote({ oldPath: "Inbox/Draft.md", newPath: "Inbox/Spec.md" })

    expect(await noteExists("Inbox/Draft.md")).toBe(false)
    expect(await readNote("Inbox/Spec.md")).toBe("Just a body.\n")
  })

  it("creates destination parent folders that do not yet exist", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Inbox/Draft.md", "Body.\n")

    await moveNote({
      oldPath: "Inbox/Draft.md",
      newPath: "Projects/Specs/Draft.md",
    })

    expect(await readNote("Projects/Specs/Draft.md")).toBe("Body.\n")
  })

  it("returns the full move summary for a move with no backlinks", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Inbox/Draft.md", "Body.\n")

    const result = await moveNote({
      oldPath: "Inbox/Draft.md",
      newPath: "Done/Draft.md",
    })

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

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

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

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Archive/Foo.md",
      backlinkSources: ["Hub.md"],
    })

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

    await moveNote({
      oldPath: "Projects/Foo.md",
      newPath: "Archive/Foo.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("See [[Archive/Foo]] here.\n")
  })

  it("preserves an alias when rewriting a wikilink", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "See [[Foo|the foo note]].\n")

    await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("See [[Bar|the foo note]].\n")
  })

  it("preserves a heading anchor when rewriting a wikilink", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Jump to [[Foo#Setup]].\n")

    await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("Jump to [[Bar#Setup]].\n")
  })

  it("preserves the embed marker when rewriting an embed", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "![[Foo]]\n")

    await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("![[Bar]]\n")
  })

  it("rewrites a markdown link, preserving its text and re-encoding spaces", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Old Note.md", "content\n")
    await writeFixture("Hub.md", "Read the [summary](Old%20Note.md) now.\n")

    await moveNote({
      oldPath: "Old Note.md",
      newPath: "New Note.md",
      backlinkSources: ["Hub.md"],
    })

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
    await moveNote({
      oldPath: "Old.md",
      newPath: "New (Draft).md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe(
      "Read the [summary](New%20%28Draft%29.md) now.\n",
    )
  })

  it("leaves a markdown asset link untouched while rewriting a note link beside it", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Old.md", "content\n")
    await writeFixture(
      "Hub.md",
      "See [doc](report.pdf) and [summary](Old.md).\n",
    )

    const result = await moveNote({
      oldPath: "Old.md",
      newPath: "New.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe(
      "See [doc](report.pdf) and [summary](New.md).\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("leaves the moved note's own relative markdown asset link untouched while rewriting its relative note link", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("A/Sibling.md", "sibling\n")
    await writeFixture(
      "B/Draft.md",
      "![img](../assets/photo.png) and [sib](../A/Sibling.md).\n",
    )

    const result = await moveNote({
      oldPath: "B/Draft.md",
      newPath: "C/Deep/Draft.md",
    })

    // The relative note link is rewritten to keep resolving from the new
    // folder; the relative asset link passes through byte-identical even
    // though its resolution changed — moveNote resolves targets against note
    // paths only, so asset links are never rewritten (known Obsidian-parity
    // gap, tracked as its own card).
    expect(await readNote("C/Deep/Draft.md")).toBe(
      "![img](../assets/photo.png) and [sib](../../A/Sibling.md).\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("rewrites a wikilink stored in a frontmatter property", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", '---\nrelated:\n  - "[[Foo]]"\n---\nBody\n')

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe(
      '---\nrelated:\n  - "[[Bar]]"\n---\nBody\n',
    )
    expect(result.links_updated).toBe(1)
  })

  it("rewrites a wikilink with an escaped pipe in a table cell", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const table = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Foo\\|display]] | A topic |",
    ].join("\n")
    await writeFixture("Hub.md", `${table}\n`)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    const expected = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Bar\\|display]] | A topic |",
    ].join("\n")
    expect(await readNote("Hub.md")).toBe(`${expected}\n`)
    expect(result.links_updated).toBe(1)
  })

  it("rewrites multiple escaped pipe wikilinks in a single table", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const table = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Foo\\|first]] | Row 1 |",
      "| [[Foo\\|second]] | Row 2 |",
    ].join("\n")
    await writeFixture("Hub.md", `${table}\n`)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    const expected = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Bar\\|first]] | Row 1 |",
      "| [[Bar\\|second]] | Row 2 |",
    ].join("\n")
    expect(await readNote("Hub.md")).toBe(`${expected}\n`)
    expect(result.links_updated).toBe(2)
  })

  it("preserves an escaped pipe in a non-table context", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "See [[Foo\\|display text]].\n")

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("See [[Bar\\|display text]].\n")
    expect(result.links_updated).toBe(1)
  })

  it("preserves a heading anchor adjacent to an escaped pipe during rewrite", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const table = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Foo#Setup\\|link]] | A topic |",
    ].join("\n")
    await writeFixture("Hub.md", `${table}\n`)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    const expected = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Bar#Setup\\|link]] | A topic |",
    ].join("\n")
    expect(await readNote("Hub.md")).toBe(`${expected}\n`)
    expect(result.links_updated).toBe(1)
  })

  it("rewrites a source-relative wikilink in another folder", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("B/Target.md", "content\n")
    await writeFixture("A/Note.md", "Up and over to [[../B/Target]].\n")

    await moveNote({
      oldPath: "B/Target.md",
      newPath: "B/Renamed.md",
      backlinkSources: ["A/Note.md"],
    })

    expect(await readNote("A/Note.md")).toBe(
      "Up and over to [[../B/Renamed]].\n",
    )
  })

  it("rewrites the moved note's own relative link so it still resolves from the new folder", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("A/Sibling.md", "sibling\n")
    await writeFixture("B/Target.md", "Points to [[../A/Sibling]].\n")

    const result = await moveNote({
      oldPath: "B/Target.md",
      newPath: "C/Deep/Target.md",
    })

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

    await moveNote({
      oldPath: "Inbox/Special.md",
      newPath: "Archive/Common.md",
      backlinkSources: ["Hub.md"],
    })

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

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("Both [[Bar]] and [[Keep]] matter.\n")
    expect(result.links_updated).toBe(1)
  })

  it("does not rewrite a link inside a fenced code block", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const body = "Real link [[Foo]].\n\n```\nExample: [[Foo]] in code\n```\n"
    await writeFixture("Hub.md", body)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe(
      "Real link [[Bar]].\n\n```\nExample: [[Foo]] in code\n```\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("does not rewrite a link inside an inline code span", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Use `[[Foo]]` syntax to link [[Foo]].\n")

    await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe(
      "Use `[[Foo]]` syntax to link [[Bar]].\n",
    )
  })

  it("rewrites only the moved note's escaped pipe link, leaving other escaped pipe links intact", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Other.md", "other\n")
    const table = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Foo\\|display]] | Moved |",
      "| [[Other\\|label]] | Stays |",
    ].join("\n")
    await writeFixture("Hub.md", `${table}\n`)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    const expected = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[Bar\\|display]] | Moved |",
      "| [[Other\\|label]] | Stays |",
    ].join("\n")
    expect(await readNote("Hub.md")).toBe(`${expected}\n`)
    expect(result.links_updated).toBe(1)
  })

  it("does not touch a backlink source whose only escaped pipe link points elsewhere", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("NotMoved.md", "other\n")
    const table = [
      "| Link | Topic |",
      "| --- | --- |",
      "| [[NotMoved\\|alias]] | A topic |",
    ].join("\n")
    const original = `${table}\n`
    await writeFixture("Hub.md", original)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe(original)
    expect(result.links_updated).toBe(0)
    expect(result.updated_notes).toEqual([])
  })

  it("does not rewrite a same-named link that resolves to a different note, even when passed as a candidate", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Deep/Foo.md", "the moved note\n")
    await writeFixture("Near/Foo.md", "a different foo\n")
    // [[Foo]] here resolves to Near/Foo.md (same folder), not the moved Deep/Foo.md.
    await writeFixture("Near/Note.md", "Local [[Foo]].\n")

    const result = await moveNote({
      oldPath: "Deep/Foo.md",
      newPath: "Deep/Bar.md",
      backlinkSources: ["Near/Note.md"],
    })

    expect(await readNote("Near/Note.md")).toBe("Local [[Foo]].\n")
    expect(result).toEqual({
      moved_to: "Deep/Bar.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
  })
})

describe("moveNote — asset link rewriting", () => {
  it("rewrites a relative wikilink embed to an asset when the note moves deeper", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("assets/photo.png", "img")
    await writeFixture("Notes/Note.md", "Image: ![[../assets/photo.png]]\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Notes/Sub/Note.md",
    })

    expect(await readNote("Notes/Sub/Note.md")).toBe(
      "Image: ![[../../assets/photo.png]]\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("rewrites a relative markdown link to an asset when the note moves deeper", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("assets/photo.png", "img")
    await writeFixture("Notes/Note.md", "![img](../assets/photo.png)\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Notes/Sub/Note.md",
    })

    expect(await readNote("Notes/Sub/Note.md")).toBe(
      "![img](../../assets/photo.png)\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("leaves a basename-form asset embed untouched — it still resolves after the move", async () => {
    const { writeFixture, moveNote, readNote, noteExists } = setupVault()
    await writeFixture("assets/photo.png", "img")
    await writeFixture("Notes/Note.md", "Image: ![[photo.png]]\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Archive/Deep/Note.md",
    })

    // The note provably moved, so the unchanged content is a deliberate
    // leave-alone, not a silent no-op.
    expect(await noteExists("Notes/Note.md")).toBe(false)
    expect(await readNote("Archive/Deep/Note.md")).toBe(
      "Image: ![[photo.png]]\n",
    )
    expect(result.links_updated).toBe(0)
  })

  it("leaves a vault-absolute asset link untouched", async () => {
    const { writeFixture, moveNote, readNote, noteExists } = setupVault()
    await writeFixture("assets/photo.png", "img")
    await writeFixture("Notes/Note.md", "Image: ![[assets/photo.png]]\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Archive/Deep/Note.md",
    })

    expect(await noteExists("Notes/Note.md")).toBe(false)
    expect(await readNote("Archive/Deep/Note.md")).toBe(
      "Image: ![[assets/photo.png]]\n",
    )
    expect(result.links_updated).toBe(0)
  })

  it("rewrites a backlink source's note links but leaves its asset links byte-identical", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("assets/photo.png", "img")
    await writeFixture("Foo.md", "content\n")
    await writeFixture(
      "Docs/Hub.md",
      "Links [[Foo]].\nImage: ![[../assets/photo.png]]\n",
    )

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Docs/Hub.md"],
    })

    // The source note itself didn't move, so its relative asset link still
    // resolves — only the link to the moved note is rewritten.
    expect(await readNote("Docs/Hub.md")).toBe(
      "Links [[Bar]].\nImage: ![[../assets/photo.png]]\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("rewrites a stem-form asset embed, preserving the extensionless form", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("boards/Trip Route.canvas", "{}")
    await writeFixture("Notes/Note.md", "Route: ![[../boards/Trip Route]]\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Notes/Sub/Note.md",
    })

    expect(await readNote("Notes/Sub/Note.md")).toBe(
      "Route: ![[../../boards/Trip Route]]\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("resolves a multi-dot asset target to its full-filename file via the stem family", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    // Only photo.png.canvas exists — ![[../assets/photo.png]] has no
    // full-filename match, so the stem family resolves it (mirroring the
    // indexer's resolveNonMarkdownFile).
    await writeFixture("assets/photo.png.canvas", "{}")
    await writeFixture("Notes/Note.md", "Image: ![[../assets/photo.png]]\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Notes/Sub/Note.md",
    })

    expect(await readNote("Notes/Sub/Note.md")).toBe(
      "Image: ![[../../assets/photo.png]]\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("rewrites an extensionless markdown link to a note, preserving the extensionless form", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    // "a/Target.md" defeats the basename fallback (shorter than
    // deep/x/Target.md), so the link must be rewritten to keep pointing at
    // the deep note — before this fix it was left to break.
    await writeFixture("a/Target.md", "decoy\n")
    await writeFixture("deep/x/Target.md", "content\n")
    await writeFixture("deep/x/Note.md", "See [text](Target).\n")

    const result = await moveNote({
      oldPath: "deep/x/Note.md",
      newPath: "deep/y/Note.md",
    })

    expect(await readNote("deep/y/Note.md")).toBe("See [text](../x/Target).\n")
    expect(result.links_updated).toBe(1)
  })

  it("resolves a bare target to the note over a same-named asset", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("assets/icon.md", "note\n")
    await writeFixture("assets/icon.png", "img")
    // "other/icon.md" defeats the basename fallback, forcing a rewrite — had
    // [[../assets/icon]] stem-matched the asset instead, it would still
    // resolve after the move and stay byte-identical.
    await writeFixture("other/icon.md", "decoy\n")
    await writeFixture("Notes/Note.md", "Link: [[../assets/icon]]\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Notes/Sub/Note.md",
    })

    expect(await readNote("Notes/Sub/Note.md")).toBe(
      "Link: [[../../assets/icon]]\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("resolves an explicit-extension target to the asset over a same-named note", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("assets/icon.md", "note\n")
    await writeFixture("assets/icon.png", "img")
    await writeFixture("Notes/Note.md", "Asset: ![[../assets/icon.png]]\n")

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Notes/Sub/Note.md",
    })

    expect(await readNote("Notes/Sub/Note.md")).toBe(
      "Asset: ![[../../assets/icon.png]]\n",
    )
    expect(result.links_updated).toBe(1)
  })

  it("keeps a basename asset embed pointing at the same file when a shorter same-named asset exists elsewhere", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    // "a/photo.png" is the shorter suffix match, but the link resolved via
    // the relative tier to "other/photo.png" — the rewrite must not switch
    // files.
    await writeFixture("a/photo.png", "img-a")
    await writeFixture("other/photo.png", "img-other")
    await writeFixture("other/Note.md", "Image: ![[photo.png]]\n")

    const result = await moveNote({
      oldPath: "other/Note.md",
      newPath: "z/Note.md",
    })

    expect(await readNote("z/Note.md")).toBe("Image: ![[../other/photo.png]]\n")
    expect(result.links_updated).toBe(1)
  })

  it("rewrites an asset embed stored in a frontmatter property", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("assets/photo.png", "img")
    await writeFixture(
      "Notes/Note.md",
      '---\nbanner: "![[../assets/photo.png]]"\n---\nBody\n',
    )

    const result = await moveNote({
      oldPath: "Notes/Note.md",
      newPath: "Notes/Sub/Note.md",
    })

    expect(await readNote("Notes/Sub/Note.md")).toBe(
      '---\nbanner: "![[../../assets/photo.png]]"\n---\nBody\n',
    )
    expect(result.links_updated).toBe(1)
  })
})

describe("moveNote — counts and summary", () => {
  it("counts every rewritten occurrence and lists changed notes sorted", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Beta.md", "[[Foo]] and again [[Foo|alias]].\n")
    await writeFixture("Alpha.md", "Single [[Foo]].\n")

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Beta.md", "Alpha.md"],
    })

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

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: sources,
    })

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

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "Bar.md" }),
    ).rejects.toThrow('destination exists: "Bar.md"')
    // The existing destination is left untouched.
    expect(await readNote("Bar.md")).toBe("occupied\n")
    expect(await readNote("Foo.md")).toBe("content\n")
  })

  it("throws when the source note does not exist", async () => {
    const { moveNote } = setupVault()
    await expect(
      moveNote({ oldPath: "Missing.md", newPath: "Bar.md" }),
    ).rejects.toThrow('note not found: "Missing.md"')
  })

  it("throws when the source is under a protected path", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("About Me/Me.md", "memory\n")

    await expect(
      moveNote({ oldPath: "About Me/Me.md", newPath: "Bar.md" }),
    ).rejects.toThrow('cannot move protected path "About Me/Me.md"')
    expect(await noteExists("About Me/Me.md")).toBe(true)
  })

  it("throws when the destination is under a protected path", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "About Me/Foo.md" }),
    ).rejects.toThrow('cannot move into protected path "About Me/Foo.md"')
    expect(await noteExists("Foo.md")).toBe(true)
  })

  it("refuses a destination that reaches a protected path through .. segments", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")

    // Normalizes to "Daily Notes/Foo.md", which must not slip past the guard.
    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "Inbox/../Daily Notes/Foo.md" }),
    ).rejects.toThrow('cannot move into protected path "Daily Notes/Foo.md"')
    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Daily Notes/Foo.md")).toBe(false)
  })

  it("throws when source and destination are identical", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "Foo.md" }),
    ).rejects.toThrow("source and destination are the same path")
  })

  it("throws when a path does not end in .md", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "Bar.txt" }),
    ).rejects.toThrow('path must end in ".md" (received "Bar.txt")')
  })

  it("throws when a path escapes the vault root", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "../escape.md" }),
    ).rejects.toThrow("path traversal blocked")
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
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Hub.md", "Ghost.md"],
      }),
    ).rejects.toThrow(
      'move aborted: could not read backlink source "Ghost.md". Nothing was written.',
    )

    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Bar.md")).toBe(false)
    expect(await readNote("Hub.md")).toBe("Links [[Foo]].\n")
  })

  it("aborts without writing anything when a backlink source path cannot be resolved", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    // "../escape.md" fails path resolution (traversal out of the vault), which
    // the move checks upfront while building its lock set — a resolve-specific
    // abort, distinct from the read failure of a missing source file.
    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Hub.md", "../escape.md"],
      }),
    ).rejects.toThrow(
      'move aborted: could not resolve backlink source "../escape.md". Nothing was written.',
    )

    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Bar.md")).toBe(false)
    expect(await readNote("Hub.md")).toBe("Links [[Foo]].\n")
  })

  it("logs the resolution failure distinctly from a read failure", async () => {
    const { writeFixture, moveNote, logger } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["../escape.md"],
      }),
    ).rejects.toThrow(
      'move aborted: could not resolve backlink source "../escape.md". Nothing was written.',
    )

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "note move aborted: could not resolve a backlink source path",
      expect.objectContaining({
        source: "../escape.md",
        from: "Foo.md",
        to: "Bar.md",
      }),
    )
  })

  it("logs the offending source and destination when a rewrite aborts the move", async () => {
    const { writeFixture, moveNote, logger } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Hub.md", "Ghost.md"],
      }),
    ).rejects.toThrow(
      'move aborted: could not read backlink source "Ghost.md". Nothing was written.',
    )

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

    await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

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
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Inbox/draft.md", "body\n")

    const result = await moveNote({
      oldPath: "Inbox/draft.md",
      newPath: "Projects/draft.md",
    })

    expect(await noteExists("Inbox/draft.md")).toBe(false)
    expect(await noteExists("Projects/draft.md")).toBe(true)
    expect(await folderExists("Inbox")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })

  it("removes the source folder when its last note is moved out and prune is on", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Inbox/draft.md", "body\n")

    const result = await moveNote({
      oldPath: "Inbox/draft.md",
      newPath: "Projects/draft.md",
      pruneEmptyFolders: true,
    })

    expect(await folderExists("Inbox")).toBe(false)
    expect(await noteExists("Projects/draft.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(1)
  })

  it("walks up removing nested empty source parents", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("A/B/note.md", "body\n")

    const result = await moveNote({
      oldPath: "A/B/note.md",
      newPath: "Dest/note.md",
      pruneEmptyFolders: true,
    })

    expect(await noteExists("A/B/note.md")).toBe(false)
    expect(await noteExists("Dest/note.md")).toBe(true)
    expect(await folderExists("A/B")).toBe(false)
    expect(await folderExists("A")).toBe(false)
    expect(result.pruned_empty_folders).toBe(2)
  })

  it("leaves the source folder when another note remains", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Inbox/keep.md", "keep\n")
    await writeFixture("Inbox/move.md", "move\n")

    const result = await moveNote({
      oldPath: "Inbox/move.md",
      newPath: "Projects/move.md",
      pruneEmptyFolders: true,
    })

    // The move must actually happen, so Inbox survives only because keep.md
    // remains — not because the move silently no-op'd.
    expect(await noteExists("Inbox/move.md")).toBe(false)
    expect(await noteExists("Projects/move.md")).toBe(true)
    expect(await folderExists("Inbox")).toBe(true)
    expect(await noteExists("Inbox/keep.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })

  it("does not prune on an in-place rename within the same folder", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Notes/old.md", "body\n")

    const result = await moveNote({
      oldPath: "Notes/old.md",
      newPath: "Notes/new.md",
      pruneEmptyFolders: true,
    })

    expect(await noteExists("Notes/old.md")).toBe(false)
    expect(await folderExists("Notes")).toBe(true)
    expect(await noteExists("Notes/new.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })

  it("does not prune when moving into a subfolder of the source", async () => {
    const { writeFixture, moveNote, folderExists, noteExists } = setupVault()
    await writeFixture("Parent/note.md", "body\n")

    const result = await moveNote({
      oldPath: "Parent/note.md",
      newPath: "Parent/Sub/note.md",
      pruneEmptyFolders: true,
    })

    expect(await noteExists("Parent/note.md")).toBe(false)
    expect(await folderExists("Parent")).toBe(true)
    expect(await noteExists("Parent/Sub/note.md")).toBe(true)
    expect(result.pruned_empty_folders).toBe(0)
  })
})

// windowsBindMount routes the destination write through rename instead of a
// hard link (unsupported on a Windows-drive Docker bind mount). These cover the
// end-to-end Windows-mode move behavior; the rename-path O_EXCL/wx no-clobber
// guard itself is unit-tested in vault-filesystem.test.ts.
describe("moveNote — Windows mode (rename-based exclusive write)", () => {
  it("moves the note and rewrites backlinks in Windows mode", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "See [[Foo]] for details.\n")

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
      windowsBindMount: true,
    })

    // Assert the move actually happened — not a silent no-op — on both ends.
    expect(await noteExists("Foo.md")).toBe(false)
    expect(await readNote("Bar.md")).toBe("content\n")
    expect(await readNote("Hub.md")).toBe("See [[Bar]] for details.\n")
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Hub.md"],
      pruned_empty_folders: 0,
    })
  })

  it("refuses an existing destination in Windows mode", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Bar.md", "occupied\n")

    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        windowsBindMount: true,
      }),
    ).rejects.toThrow('destination exists: "Bar.md"')
    // Both notes untouched — the failed move wrote nothing.
    expect(await readNote("Bar.md")).toBe("occupied\n")
    expect(await readNote("Foo.md")).toBe("content\n")
  })
})

describe("moveNote — concurrent write locking", () => {
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

  /** Invokes moveNote WITHOUT awaiting it. The multi-file lock is acquired
   *  synchronously before moveNote's first await, so the locks are already
   *  held when this returns. Callers pass a pre-fetched path list so nothing
   *  yields the event loop before acquisition — deliberately a plain (not
   *  async) function: an async wrapper would flatten the returned promise. */
  const startMove = (params: {
    vault: string
    logger: Logger
    oldPath: string
    newPath: string
    backlinkSources: string[]
    allNotePaths: string[]
    allAssetPaths?: string[]
  }): ReturnType<typeof noteMover.moveNote> => {
    const movePromise = noteMover.moveNote(
      {
        vaultPath: params.vault,
        oldPath: params.oldPath,
        newPath: params.newPath,
        protectedPaths: PROTECTED,
        backlinkSources: params.backlinkSources,
        allNotePaths: params.allNotePaths,
        allAssetPaths: params.allAssetPaths ?? [],
        pruneEmptyFolders: false,
        windowsBindMount: false,
      },
      params.logger,
    )
    // Settle the move during cleanup so an assertion failing between start
    // and await can't leave an unhandled rejection or an in-flight move
    // behind the test.
    onTestFinished(async () => {
      await movePromise.catch(() => {})
    })
    return movePromise
  }

  it("rejects a concurrent patch to a backlink source while a move is in flight", async () => {
    const { vault, logger, writeFixture, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")
    const allNotePaths = await vaultFs.listNotes({ vaultPath: vault }, logger)

    const movePromise = startMove({
      vault,
      logger,
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
      allNotePaths,
    })

    // The move already holds Hub.md's lock, so the patch must fail fast
    // instead of racing the move's read-then-write and losing its edit.
    await expect(
      vaultPatcher.patchNote(
        {
          vaultPath: vault,
          path: "Hub.md",
          operation: "append",
          content: "A racing appended line.",
        },
        logger,
      ),
    ).rejects.toThrow("concurrent write in progress")

    // The move itself completes untouched by the rejected patch.
    const result = await movePromise
    expect(result.moved_to).toBe("Bar.md")
    expect(await readNote("Hub.md")).toBe("Links [[Bar]].\n")
  })

  it("rejects a concurrent write to the destination while a move is in flight", async () => {
    const { vault, logger, writeFixture, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const allNotePaths = await vaultFs.listNotes({ vaultPath: vault }, logger)

    const movePromise = startMove({
      vault,
      logger,
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: [],
      allNotePaths,
    })

    await expect(
      vaultFs.writeNote(
        { vaultPath: vault, path: "Bar.md", body: "squatter" },
        logger,
      ),
    ).rejects.toThrow("concurrent write in progress")

    await movePromise
    expect(await readNote("Bar.md")).toBe("content\n")
  })

  it("rejects a concurrent delete of the note being moved", async () => {
    const { vault, logger, writeFixture, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const allNotePaths = await vaultFs.listNotes({ vaultPath: vault }, logger)

    const movePromise = startMove({
      vault,
      logger,
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: [],
      allNotePaths,
    })

    await expect(
      vaultFs.deleteNote(
        {
          vaultPath: vault,
          path: "Foo.md",
          protectedPaths: PROTECTED,
          pruneEmptyFolders: false,
        },
        logger,
      ),
    ).rejects.toThrow("concurrent write in progress")

    await movePromise
    expect(await noteExists("Bar.md")).toBe(true)
  })

  it("rejects a second move of the same note while one is in flight", async () => {
    const { vault, logger, writeFixture, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const allNotePaths = await vaultFs.listNotes({ vaultPath: vault }, logger)

    const firstMove = startMove({
      vault,
      logger,
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: [],
      allNotePaths,
    })
    const secondMove = startMove({
      vault,
      logger,
      oldPath: "Foo.md",
      newPath: "Baz.md",
      backlinkSources: [],
      allNotePaths,
    })

    await expect(secondMove).rejects.toThrow("concurrent write in progress")

    await firstMove
    expect(await noteExists("Bar.md")).toBe(true)
    expect(await noteExists("Baz.md")).toBe(false)
  })

  it("rejects the move when a write is already in flight on a backlink source", async () => {
    const { vault, logger, writeFixture, noteExists, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")
    const allNotePaths = await vaultFs.listNotes({ vaultPath: vault }, logger)

    // Simulate an in-flight single-file write on the backlink source.
    const holdHubLock = withExclusiveFileLock(
      join(vault, "Hub.md"),
      async () => {
        await delay(50)
      },
    )

    const movePromise = startMove({
      vault,
      logger,
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
      allNotePaths,
    })
    await expect(movePromise).rejects.toThrow("concurrent write in progress")

    // Fail-fast means fail-clean: nothing was moved or rewritten.
    await holdHubLock
    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Bar.md")).toBe(false)
    expect(await readNote("Hub.md")).toBe("Links [[Foo]].\n")
  })

  it("releases every lock when the move completes", async () => {
    const { vault, logger, writeFixture, moveNote, noteExists, readNote } =
      setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })
    // The move actually ran — the release assertions below aren't passing
    // because nothing was ever locked.
    expect(await noteExists("Foo.md")).toBe(false)

    // Every path the move locked (old path, destination, backlink source)
    // accepts writes again.
    await vaultFs.writeNote(
      { vaultPath: vault, path: "Foo.md", body: "recreated after move" },
      logger,
    )
    await vaultFs.writeNote(
      {
        vaultPath: vault,
        path: "Hub.md",
        body: "rewritten after move",
        overwrite: true,
      },
      logger,
    )
    await vaultFs.writeNote(
      {
        vaultPath: vault,
        path: "Bar.md",
        body: "updated after move",
        overwrite: true,
      },
      logger,
    )
    expect(await readNote("Foo.md")).toBe("recreated after move\n")
    expect(await readNote("Hub.md")).toBe("rewritten after move\n")
    expect(await readNote("Bar.md")).toBe("updated after move\n")
  })

  it("releases every lock when the move fails", async () => {
    const { vault, logger, writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Bar.md", "occupied\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    // Fails inside the lock, after acquisition — the existence check runs
    // within the locked span.
    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Hub.md"],
      }),
    ).rejects.toThrow('destination exists: "Bar.md"')

    // Every path the failed move locked (old path, destination, backlink
    // source) accepts writes again.
    await vaultFs.writeNote(
      {
        vaultPath: vault,
        path: "Foo.md",
        body: "written after failed move",
        overwrite: true,
      },
      logger,
    )
    await vaultFs.writeNote(
      {
        vaultPath: vault,
        path: "Bar.md",
        body: "destination writable",
        overwrite: true,
      },
      logger,
    )
    await vaultFs.writeNote(
      {
        vaultPath: vault,
        path: "Hub.md",
        body: "also writable",
        overwrite: true,
      },
      logger,
    )
    expect(await readNote("Foo.md")).toBe("written after failed move\n")
    expect(await readNote("Bar.md")).toBe("destination writable\n")
    expect(await readNote("Hub.md")).toBe("also writable\n")
  })
})

describe("moveNote — backlink source hygiene", () => {
  it("rewrites a backlink source once when it is listed under duplicate and alias spellings", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    // "Hub.md", "./Hub.md", and a second "Hub.md" all resolve to one file —
    // it must get exactly one rewrite plan, not three.
    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md", "./Hub.md", "Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("Links [[Bar]].\n")
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Hub.md"],
      pruned_empty_folders: 0,
    })
  })

  it("excludes an alias spelling of the moved note from the backlink sources", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    // A self-link makes the difference observable: as the moved note it is
    // rewritten once (counted in links_updated); if "./Foo.md" slipped past
    // the old-path filter it would also get a backlink-source rewrite plan,
    // inflating links_updated to 2 and listing "./Foo.md" in updated_notes.
    await writeFixture("Foo.md", "See [[Foo]].\n")

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["./Foo.md"],
    })

    expect(await readNote("Bar.md")).toBe("See [[Bar]].\n")
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
  })
})

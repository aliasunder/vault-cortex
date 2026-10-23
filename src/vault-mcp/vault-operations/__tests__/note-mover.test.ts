import { describe, it, expect, vi, onTestFinished } from "vitest"
import { rm, writeFile, mkdir, readFile, stat, rename, unlink } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { basename, join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { noteMover } from "../note-mover.js"
import { vaultFs, atomicWriteFile } from "../vault-filesystem.js"
import { vaultPatcher } from "../vault-patcher.js"
import {
  parseNoteForRewrite,
  UnkeepableOpeningBlockError,
  UnsupportedPropertiesBlockError,
} from "../../obsidian-markdown/frontmatter.js"
import { withExclusiveFileLock } from "../../../utils/file-write-lock.js"
import { fileExists, statOrNull } from "../../../utils/fs.js"
import type { Logger } from "../../../logger.js"

// The modules are spy-wrapped so single tests can shape the aliased-path
// disk probes and fail specific rename/write calls while every other call
// keeps the real implementation.
vi.mock("../../../utils/fs.js", { spy: true })
vi.mock("node:fs/promises", { spy: true })
vi.mock("../vault-filesystem.js", { spy: true })

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

  const readNote = (path: string): Promise<string> => readFile(join(vault, path), "utf8")

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

    expect(await readNote("Hub.md")).toBe("Read the [summary](New%20Note.md) now.\n")
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

    expect(await readNote("Hub.md")).toBe("Read the [summary](New%20%28Draft%29.md) now.\n")
  })

  it("leaves a markdown asset link untouched while rewriting a note link beside it", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Old.md", "content\n")
    await writeFixture("Hub.md", "See [doc](report.pdf) and [summary](Old.md).\n")

    const result = await moveNote({
      oldPath: "Old.md",
      newPath: "New.md",
      backlinkSources: ["Hub.md"],
    })

    expect(await readNote("Hub.md")).toBe("See [doc](report.pdf) and [summary](New.md).\n")
    expect(result.links_updated).toBe(1)
  })

  it("leaves the moved note's own relative markdown asset link untouched while rewriting its relative note link", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("A/Sibling.md", "sibling\n")
    await writeFixture("B/Draft.md", "![img](../assets/photo.png) and [sib](../A/Sibling.md).\n")

    const result = await moveNote({
      oldPath: "B/Draft.md",
      newPath: "C/Deep/Draft.md",
    })

    // The relative note link is rewritten to keep resolving from the new
    // folder; the relative asset link stays unchanged because no asset file
    // exists in this fixture — the link is unresolved, so moveNote leaves
    // it alone.
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

    expect(await readNote("Hub.md")).toBe('---\nrelated:\n  - "[[Bar]]"\n---\nBody\n')
    expect(result.links_updated).toBe(1)
  })

  it("rewrites a wikilink with an escaped pipe in a table cell", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    const table = ["| Link | Topic |", "| --- | --- |", "| [[Foo\\|display]] | A topic |"].join(
      "\n",
    )
    await writeFixture("Hub.md", `${table}\n`)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
    })

    const expected = ["| Link | Topic |", "| --- | --- |", "| [[Bar\\|display]] | A topic |"].join(
      "\n",
    )
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
    const table = ["| Link | Topic |", "| --- | --- |", "| [[Foo#Setup\\|link]] | A topic |"].join(
      "\n",
    )
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

    expect(await readNote("A/Note.md")).toBe("Up and over to [[../B/Renamed]].\n")
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
    expect(await readNote("C/Deep/Target.md")).toBe("Points to [[../../A/Sibling]].\n")
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

    expect(await readNote("Hub.md")).toBe("Use `[[Foo]]` syntax to link [[Bar]].\n")
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
    const table = ["| Link | Topic |", "| --- | --- |", "| [[NotMoved\\|alias]] | A topic |"].join(
      "\n",
    )
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

    expect(await readNote("Notes/Sub/Note.md")).toBe("Image: ![[../../assets/photo.png]]\n")
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

    expect(await readNote("Notes/Sub/Note.md")).toBe("![img](../../assets/photo.png)\n")
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
    expect(await readNote("Archive/Deep/Note.md")).toBe("Image: ![[photo.png]]\n")
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
    expect(await readNote("Archive/Deep/Note.md")).toBe("Image: ![[assets/photo.png]]\n")
    expect(result.links_updated).toBe(0)
  })

  it("rewrites a backlink source's note links but leaves its asset links byte-identical", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("assets/photo.png", "img")
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Docs/Hub.md", "Links [[Foo]].\nImage: ![[../assets/photo.png]]\n")

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Docs/Hub.md"],
    })

    // The source note itself didn't move, so its relative asset link still
    // resolves — only the link to the moved note is rewritten.
    expect(await readNote("Docs/Hub.md")).toBe("Links [[Bar]].\nImage: ![[../assets/photo.png]]\n")
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

    expect(await readNote("Notes/Sub/Note.md")).toBe("Route: ![[../../boards/Trip Route]]\n")
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

    expect(await readNote("Notes/Sub/Note.md")).toBe("Image: ![[../../assets/photo.png]]\n")
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

    expect(await readNote("Notes/Sub/Note.md")).toBe("Link: [[../../assets/icon]]\n")
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

    expect(await readNote("Notes/Sub/Note.md")).toBe("Asset: ![[../../assets/icon.png]]\n")
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
    await writeFixture("Notes/Note.md", '---\nbanner: "![[../assets/photo.png]]"\n---\nBody\n')

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

/** A canvas in the layout Obsidian saves: one node per line, no edges, no
 *  trailing newline. Each entry is a node's literal JSON. */
const obsidianCanvas = (nodeLines: readonly string[]): string => {
  return `{\n\t"nodes":[\n\t\t${nodeLines.join(",\n\t\t")}\n\t],\n\t"edges":[]\n}`
}

describe("moveNote — Canvas sources", () => {
  it("points a Canvas file card at the moved note's new path and rewrites its text-card link", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Inbox/Note.md", "# Note\n")
    await writeFixture("Other.md", "# Other\n")
    await writeFixture("Hub.md", "See [[Inbox/Note]].\n")
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Inbox/Note.md","subpath":"#Goals","x":0,"y":0,"width":400,"height":400}',
        '{"id":"t1","type":"text","text":"See [[Inbox/Note]] and [[Other]]","x":500,"y":0,"width":250,"height":60}',
        '{"id":"f2","type":"file","file":"Other.md","x":0,"y":500,"width":400,"height":400}',
      ]),
    )

    const result = await moveNote({
      oldPath: "Inbox/Note.md",
      newPath: "Projects/Note.md",
      backlinkSources: ["Board.canvas", "Hub.md"],
    })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Projects/Note.md","subpath":"#Goals","x":0,"y":0,"width":400,"height":400}',
        '{"id":"t1","type":"text","text":"See [[Projects/Note]] and [[Other]]","x":500,"y":0,"width":250,"height":60}',
        '{"id":"f2","type":"file","file":"Other.md","x":0,"y":500,"width":400,"height":400}',
      ]),
    )
    expect(await readNote("Hub.md")).toBe("See [[Projects/Note]].\n")
    expect(result).toEqual({
      moved_to: "Projects/Note.md",
      links_updated: 3,
      updated_notes: ["Board.canvas", "Hub.md"],
      pruned_empty_folders: 0,
    })
  })

  it("points a file card at the new path on a rename, where the card's path is the only link", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Plan.md", "# Plan\n")
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Plan.md","x":0,"y":0,"width":400,"height":400}',
      ]),
    )

    const result = await moveNote({
      oldPath: "Plan.md",
      newPath: "Roadmap.md",
      backlinkSources: ["Board.canvas"],
    })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Roadmap.md","x":0,"y":0,"width":400,"height":400}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Roadmap.md",
      links_updated: 1,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
  })

  it("leaves a link inside a text card's code block unchanged", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    // In the JSON, \n is an escaped newline, so the card text holds a fence.
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"[[Foo]]\\n```\\n[[Foo]]\\n```\\n`[[Foo]]`","x":0,"y":0,"width":250,"height":60}',
      ]),
    )

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Board.canvas"],
    })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"[[Bar]]\\n```\\n[[Foo]]\\n```\\n`[[Foo]]`","x":0,"y":0,"width":250,"height":60}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
  })

  it("keeps a text card's CRLF line endings and leaves its CRLF code block unchanged", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    // In the JSON, \r\n is an escaped CRLF, as in a card pasted from Windows.
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"[[Foo]]\\r\\n```\\r\\n[[Foo]]\\r\\n```\\r\\nthen [[Foo]]","x":0,"y":0,"width":250,"height":60}',
      ]),
    )

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Board.canvas"],
    })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"[[Bar]]\\r\\n```\\r\\n[[Foo]]\\r\\n```\\r\\nthen [[Bar]]","x":0,"y":0,"width":250,"height":60}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 2,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
  })

  /** Holds "Note" in a card and in an exact path, but nothing in it resolves
   *  to Inbox/Note.md: both cards open the same-named Archive/Note.md. */
  const sameNameDecoyCanvas = obsidianCanvas([
    '{"id":"f1","type":"file","file":"Archive/Note.md","x":0,"y":0,"width":400,"height":400}',
    '{"id":"t1","type":"text","text":"Note to self: [[Archive/Note]]","x":500,"y":0,"width":250,"height":60}',
  ])

  it("leaves a backlink-source Canvas whose cards open a same-named note elsewhere byte-identical", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Inbox/Note.md", "# Note\n")
    await writeFixture("Archive/Note.md", "# Archived note\n")
    await writeFixture("Decoy.canvas", sameNameDecoyCanvas)

    const result = await moveNote({
      oldPath: "Inbox/Note.md",
      newPath: "Projects/Note.md",
      backlinkSources: ["Decoy.canvas"],
    })

    expect(result).toEqual({
      moved_to: "Projects/Note.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Decoy.canvas")).toBe(sameNameDecoyCanvas)
    expect(await readNote("Projects/Note.md")).toBe("# Note\n")
  })

  it("does not report a Canvas whose cards open a same-named note elsewhere as a missed backlink", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("Inbox/Note.md", "# Note\n")
    await writeFixture("Archive/Note.md", "# Archived note\n")
    // Not a backlink source, so the scan reads it: it passes the substring
    // pre-filter, and only link resolution can rule it out.
    await writeFixture("Decoy.canvas", sameNameDecoyCanvas)

    const result = await moveNote({ oldPath: "Inbox/Note.md", newPath: "Projects/Note.md" })

    expect(result).toEqual({
      moved_to: "Projects/Note.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Decoy.canvas")).toBe(sameNameDecoyCanvas)
    // A rewrite of the decoy would change nothing, so only this log shows a
    // false match. No file links Inbox/Note.md, so it must never fire,
    // whatever its context.
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      expect.anything(),
    )
  })

  it("finds and rewrites a Canvas that links the note only from a text card", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    // The index records only file cards, so this Canvas never arrives as a
    // backlink source; the move's own scan has to find it.
    await writeFixture(
      "Ideas.canvas",
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"Start from [[Foo]]","x":0,"y":0,"width":250,"height":60}',
      ]),
    )

    const result = await moveNote({ oldPath: "Foo.md", newPath: "Bar.md" })

    expect(await readNote("Ideas.canvas")).toBe(
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"Start from [[Bar]]","x":0,"y":0,"width":250,"height":60}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Ideas.canvas"],
      pruned_empty_folders: 0,
    })
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      { from: "Foo.md", to: "Bar.md", additionalSources: ["Ideas.canvas"], attempt: 0 },
    )
  })

  it("finds a Canvas file card the index has not recorded yet", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Foo.md","x":0,"y":0,"width":400,"height":400}',
      ]),
    )

    const result = await moveNote({ oldPath: "Foo.md", newPath: "Bar.md" })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Bar.md","x":0,"y":0,"width":400,"height":400}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
  })

  it("gives a file card written as a bare name or a relative path the full new path", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Inbox/Note.md", "# Note\n")
    await writeFixture(
      "Boards/Board.canvas",
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Note.md","x":0,"y":0,"width":400,"height":400}',
        '{"id":"f2","type":"file","file":"../Inbox/Note.md","x":500,"y":0,"width":400,"height":400}',
      ]),
    )

    const result = await moveNote({
      oldPath: "Inbox/Note.md",
      newPath: "Projects/Plan.md",
      backlinkSources: ["Boards/Board.canvas"],
    })

    expect(await readNote("Boards/Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Projects/Plan.md","x":0,"y":0,"width":400,"height":400}',
        '{"id":"f2","type":"file","file":"Projects/Plan.md","x":500,"y":0,"width":400,"height":400}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Projects/Plan.md",
      links_updated: 2,
      updated_notes: ["Boards/Board.canvas"],
      pruned_empty_folders: 0,
    })
  })

  it("leaves a file card alone when it already holds the moved note's new path", async () => {
    const { writeFixture, moveNote, readNote, noteExists } = setupVault()
    await writeFixture("Inbox/Note.md", "# Note\n")
    // The bare name resolves to Inbox/Note.md now and is the exact new path
    // once the note moves to the vault root.
    const boardCanvas = obsidianCanvas([
      '{"id":"f1","type":"file","file":"Note.md","x":0,"y":0,"width":400,"height":400}',
    ])
    await writeFixture("Boards/Board.canvas", boardCanvas)

    const result = await moveNote({
      oldPath: "Inbox/Note.md",
      newPath: "Note.md",
      backlinkSources: ["Boards/Board.canvas"],
    })

    expect(await noteExists("Inbox/Note.md")).toBe(false)
    expect(await readNote("Note.md")).toBe("# Note\n")
    expect(await readNote("Boards/Board.canvas")).toBe(boardCanvas)
    expect(result).toEqual({
      moved_to: "Note.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
  })

  it("finds a Canvas linking a note whose name holds a double quote, which the JSON escapes", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture('Say "Hi".md', "# Hi\n")
    // The file holds only the escaped form, Say \"Hi\", so of the scan's
    // substring checks only the JSON-escaped one can match it.
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Say \\"Hi\\".md","x":0,"y":0,"width":400,"height":400}',
        '{"id":"t1","type":"text","text":"See [[Say \\"Hi\\"]]","x":500,"y":0,"width":250,"height":60}',
      ]),
    )

    const result = await moveNote({ oldPath: 'Say "Hi".md', newPath: "Greeting.md" })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Greeting.md","x":0,"y":0,"width":400,"height":400}',
        '{"id":"t1","type":"text","text":"See [[Greeting]]","x":500,"y":0,"width":250,"height":60}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Greeting.md",
      links_updated: 2,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      { from: 'Say "Hi".md', to: "Greeting.md", additionalSources: ["Board.canvas"], attempt: 0 },
    )
  })

  it("finds a Canvas whose JSON escapes the accented letters in the note's name", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("École.md", "# École\n")
    // The file holds only the escape for É, as JSON writers that escape every
    // non-ASCII character store it, so of the scan's substring checks only the
    // escaped one can match it. A capital É also needs the stem escaped before
    // it is lowercased.
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"See [[\\u00C9cole]]","x":0,"y":0,"width":250,"height":60}',
      ]),
    )

    const result = await moveNote({ oldPath: "École.md", newPath: "School.md" })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"t1","type":"text","text":"See [[School]]","x":0,"y":0,"width":250,"height":60}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "School.md",
      links_updated: 1,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      { from: "École.md", to: "School.md", additionalSources: ["Board.canvas"], attempt: 0 },
    )
  })

  it("leaves a file card that opens a PDF alone when the moved note is named after it", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Plan.pdf", "%PDF-1.4\n")
    await writeFixture("Plan.pdf.md", "# Notes on the plan\n")
    // The resolver's ".md" fallback matches f1's Plan.pdf to the moved note,
    // but Obsidian opens f1 by its exact path, the PDF. f2 opens the note.
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Plan.pdf","x":0,"y":0,"width":400,"height":400}',
        '{"id":"f2","type":"file","file":"Plan.pdf.md","x":500,"y":0,"width":400,"height":400}',
      ]),
    )

    const result = await moveNote({
      oldPath: "Plan.pdf.md",
      newPath: "Archive/Plan.pdf.md",
      backlinkSources: ["Board.canvas"],
    })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Plan.pdf","x":0,"y":0,"width":400,"height":400}',
        '{"id":"f2","type":"file","file":"Archive/Plan.pdf.md","x":500,"y":0,"width":400,"height":400}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "Archive/Plan.pdf.md",
      links_updated: 1,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
  })

  it("does not report a Canvas whose only matching card opens a PDF as a missed backlink", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("Plan.pdf", "%PDF-1.4\n")
    await writeFixture("Plan.pdf.md", "# Notes on the plan\n")
    const pdfCardCanvas = obsidianCanvas([
      '{"id":"f1","type":"file","file":"Plan.pdf","x":0,"y":0,"width":400,"height":400}',
    ])
    // Not a backlink source, so the scan reads it and must rule it out.
    await writeFixture("Board.canvas", pdfCardCanvas)

    const result = await moveNote({ oldPath: "Plan.pdf.md", newPath: "Archive/Plan.pdf.md" })

    expect(result).toEqual({
      moved_to: "Archive/Plan.pdf.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Board.canvas")).toBe(pdfCardCanvas)
    // The rewrite leaves the card alone either way, so only this log shows
    // the scan matching the PDF card to the moved note. It must never fire,
    // whatever its context.
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      expect.anything(),
    )
  })

  it("leaves a backlink-source Canvas with no nodes list byte-identical and completes the move", async () => {
    const { writeFixture, moveNote, readNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    // Each names Foo, but neither has a nodes list for a card to sit in.
    const topLevelArrayCanvas = '[{"id":"f1","type":"file","file":"Foo.md"}]'
    const nodesStringCanvas = '{"nodes":"[[Foo]]"}'
    await writeFixture("List.canvas", topLevelArrayCanvas)
    await writeFixture("Odd.canvas", nodesStringCanvas)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["List.canvas", "Odd.canvas"],
    })

    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    expect(await noteExists("Foo.md")).toBe(false)
    expect(await readNote("List.canvas")).toBe(topLevelArrayCanvas)
    expect(await readNote("Odd.canvas")).toBe(nodesStringCanvas)
  })

  it("scans past a Canvas with no nodes list without logging it as unreadable", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    // Names Foo, so it passes the substring pre-filter and is parsed.
    const nodesStringCanvas = '{"nodes":"[[Foo]]"}'
    await writeFixture("Odd.canvas", nodesStringCanvas)

    const result = await moveNote({ oldPath: "Foo.md", newPath: "Bar.md" })

    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Odd.canvas")).toBe(nodesStringCanvas)
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })

  it("treats only a lowercase .canvas extension as a Canvas", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    const upperCaseCanvas = obsidianCanvas([
      '{"id":"t1","type":"text","text":"Start from [[Foo]]","x":0,"y":0,"width":250,"height":60}',
    ])
    await writeFixture("Board.CANVAS", upperCaseCanvas)

    const result = await moveNote({ oldPath: "Foo.md", newPath: "Bar.md" })

    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Board.CANVAS")).toBe(upperCaseCanvas)
    // The scan skips Board.CANVAS and no other file links Foo.md, so the log
    // must never fire, whatever its context.
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      expect.anything(),
    )
  })

  it("aborts without writing when a Canvas backlink source is not valid JSON", async () => {
    const { writeFixture, moveNote, readNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    await writeFixture("Hub.md", "See [[Foo]].\n")
    const brokenCanvas = '{"nodes":[{"id":"f1","type":"file","file":"Foo.md"'
    await writeFixture("Broken.canvas", brokenCanvas)

    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Broken.canvas", "Hub.md"],
      }),
    ).rejects.toThrow(
      new Error(
        'move aborted: could not read backlink source "Broken.canvas". Nothing was written.',
      ),
    )
    expect(await readNote("Foo.md")).toBe("# Foo\n")
    expect(await noteExists("Bar.md")).toBe(false)
    expect(await readNote("Hub.md")).toBe("See [[Foo]].\n")
    expect(await readNote("Broken.canvas")).toBe(brokenCanvas)
  })

  it("skips a Canvas that is not valid JSON during the scan and still completes the move", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    const brokenCanvas = '{"nodes":[{"id":"f1","type":"file","file":"Foo.md"'
    await writeFixture("Broken.canvas", brokenCanvas)

    const result = await moveNote({ oldPath: "Foo.md", newPath: "Bar.md" })

    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Broken.canvas")).toBe(brokenCanvas)
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "backlink scan: skipping a file that could not be read or parsed",
      {
        path: "Broken.canvas",
        // The text after the prefix is the JavaScript engine's own parse message.
        error: expect.stringMatching(/^\[Error\]: invalid \.canvas JSON: /),
      },
    )
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
    // 25 sources span three batches of 10, exercising the batch-boundary
    // logic.
    const sources = Array.from({ length: 25 }, (_unused, index) => {
      const padded = String(index).padStart(2, "0")
      return `src-${padded}.md`
    })
    await Promise.all(sources.map((source) => writeFixture(source, "Link to [[Foo]].\n")))

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: sources,
    })

    const allRewritten = await Promise.all(sources.map((source) => readNote(source)))
    expect(allRewritten).toEqual(Array.from({ length: sources.length }, () => "Link to [[Bar]].\n"))
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

    await expect(moveNote({ oldPath: "Foo.md", newPath: "Bar.md" })).rejects.toThrow(
      new Error('destination exists: "Bar.md"'),
    )
    // The existing destination is left untouched.
    expect(await readNote("Bar.md")).toBe("occupied\n")
    expect(await readNote("Foo.md")).toBe("content\n")
  })

  it("throws when the source note does not exist", async () => {
    const { moveNote } = setupVault()
    await expect(moveNote({ oldPath: "Missing.md", newPath: "Bar.md" })).rejects.toThrow(
      new Error('note not found: "Missing.md"'),
    )
  })

  it("throws when the source is under a protected path", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("About Me/Me.md", "memory\n")

    await expect(moveNote({ oldPath: "About Me/Me.md", newPath: "Bar.md" })).rejects.toThrow(
      new Error('cannot move protected path "About Me/Me.md"'),
    )
    expect(await noteExists("About Me/Me.md")).toBe(true)
  })

  it("throws when the destination is under a protected path", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote({ oldPath: "Foo.md", newPath: "About Me/Foo.md" })).rejects.toThrow(
      new Error('cannot move into protected path "About Me/Foo.md"'),
    )
    expect(await noteExists("Foo.md")).toBe(true)
  })

  it("refuses a destination that reaches a protected path through .. segments", async () => {
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")

    // Normalizes to "Daily Notes/Foo.md", which must not slip past the guard.
    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "Inbox/../Daily Notes/Foo.md" }),
    ).rejects.toThrow(new Error('cannot move into protected path "Daily Notes/Foo.md"'))
    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Daily Notes/Foo.md")).toBe(false)
  })

  it("rejects an absolute container path as the source", async () => {
    // Absolute inputs are rejected outright — the old bypass route into
    // protected folders never reaches a guard or the filesystem.
    const { vault, writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("About Me/Me.md", "memory\n")

    await expect(
      moveNote({ oldPath: `${vault}/About Me/Me.md`, newPath: "Bar.md" }),
    ).rejects.toThrow(
      new Error(`absolute path blocked: "${vault}/About Me/Me.md" must be vault-relative`),
    )
    expect(await noteExists("About Me/Me.md")).toBe(true)
    expect(await noteExists("Bar.md")).toBe(false)
  })

  it("rejects an absolute container path as the destination", async () => {
    const { vault, writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: `${vault}/About Me/Foo.md` }),
    ).rejects.toThrow(
      new Error(`absolute path blocked: "${vault}/About Me/Foo.md" must be vault-relative`),
    )
    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("About Me/Foo.md")).toBe(false)
  })

  it("refuses a source that escapes and re-enters the vault into a protected folder", async () => {
    const { vault, writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("About Me/Me.md", "memory\n")

    await expect(
      moveNote({
        oldPath: join("..", basename(vault), "About Me/Me.md"),
        newPath: "Bar.md",
      }),
    ).rejects.toThrow(new Error('cannot move protected path "About Me/Me.md"'))
    expect(await noteExists("About Me/Me.md")).toBe(true)
  })

  it("refuses a case-aliased spelling of a protected source", async () => {
    // On a case-insensitive filesystem "about me/" names the same folder as
    // "About Me/" — the guard's comparison is case-folded so the alias cannot
    // slip past it.
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("About Me/Me.md", "memory\n")

    await expect(moveNote({ oldPath: "about me/Me.md", newPath: "Bar.md" })).rejects.toThrow(
      new Error('cannot move protected path "about me/Me.md"'),
    )
    expect(await noteExists("About Me/Me.md")).toBe(true)
  })

  it("throws when source and destination are identical", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote({ oldPath: "Foo.md", newPath: "Foo.md" })).rejects.toThrow(
      new Error("source and destination are the same path"),
    )
  })

  it("recognizes a traversal and a plain spelling of the same note as the same path", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote({ oldPath: "Inbox/../Foo.md", newPath: "Foo.md" })).rejects.toThrow(
      new Error("source and destination are the same path"),
    )
    expect(await readNote("Foo.md")).toBe("content\n")
  })

  it("moves a case-aliased old path via the on-disk spelling and rewrites backlinks", async (testContext) => {
    // This test is only meaningful where the filesystem resolves case-aliased
    // paths to the same file (macOS/Windows bind mounts) — the sibling test
    // below covers the case-sensitive branch, so exactly one of the two runs
    // per platform.
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Projects/todo.md", "content\n")
    if (!(await noteExists("projects/todo.md"))) testContext.skip()
    await writeFixture("Hub.md", "Links [[todo]].\n")

    const result = await moveNote({
      oldPath: "projects/todo.md",
      newPath: "Archive/done.md",
    })

    expect(result).toEqual({
      moved_to: "Archive/done.md",
      links_updated: 1,
      updated_notes: ["Hub.md"],
      pruned_empty_folders: 0,
    })
    expect(await noteExists("Projects/todo.md")).toBe(false)
    expect(await readNote("Archive/done.md")).toBe("content\n")
    expect(await readNote("Hub.md")).toBe("Links [[done]].\n")
  })

  it("refuses a case-aliased old path when the filesystem is case-sensitive", async (testContext) => {
    // On a case-sensitive filesystem the aliased spelling names a file that
    // does not exist, so nothing may be moved — the inverse platform branch
    // of the sibling test above.
    const { writeFixture, moveNote, noteExists } = setupVault()
    await writeFixture("Projects/todo.md", "content\n")
    if (await noteExists("projects/todo.md")) testContext.skip()

    await expect(
      moveNote({ oldPath: "projects/todo.md", newPath: "Archive/done.md" }),
    ).rejects.toThrow(new Error('note not found: "projects/todo.md"'))
    expect(await noteExists("Projects/todo.md")).toBe(true)
  })

  it("reconciles a case-aliased old path to the filesystem listing's spelling on any host", async () => {
    // The stat probe is redirected to the real spelling for the aliased path,
    // so the listing-reconciliation branch runs on every host — CI's
    // case-sensitive filesystem would otherwise never execute it. The
    // platform-gated pair above covers the real-filesystem behavior.
    const { vault, writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Projects/todo.md", "content\n")
    await writeFixture("Hub.md", "Links [[todo]].\n")

    const actualFs =
      await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")
    const aliasedFullPath = join(vault, "projects/todo.md")
    const realFullPath = join(vault, "Projects/todo.md")
    vi.mocked(statOrNull).mockImplementation((path) => {
      if (path === aliasedFullPath) return actualFs.statOrNull(realFullPath)
      return actualFs.statOrNull(path)
    })
    onTestFinished(() => vi.mocked(statOrNull).mockRestore())

    const result = await moveNote({
      oldPath: "projects/todo.md",
      newPath: "Archive/done.md",
    })

    expect(result).toEqual({
      moved_to: "Archive/done.md",
      links_updated: 1,
      updated_notes: ["Hub.md"],
      pruned_empty_folders: 0,
    })
    expect(await noteExists("Projects/todo.md")).toBe(false)
    expect(await readNote("Archive/done.md")).toBe("content\n")
    expect(await readNote("Hub.md")).toBe("Links [[done]].\n")
  })

  it("does not substitute a case-variant sibling that is a different file", async () => {
    // Simulates a case-sensitive vault holding two case-distinct files where
    // the requested one is absent from the supplied path list — the stat probe reports a real
    // but different inode for the input, and its existence check stays false.
    // The reconciliation must decline, because matching by folded name alone
    // would move and unlink the sibling, the wrong user-visible note.
    const { vault, writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Projects/todo.md", "sibling content\n")
    await writeFixture("Hub.md", "Links [[todo]].\n")

    const actualFs =
      await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")
    const aliasedFullPath = join(vault, "projects/todo.md")
    const distinctFilePath = join(vault, "Hub.md")
    vi.mocked(statOrNull).mockImplementation((path) => {
      if (path === aliasedFullPath) return actualFs.statOrNull(distinctFilePath)
      return actualFs.statOrNull(path)
    })
    vi.mocked(fileExists).mockImplementation((path) => {
      if (path === aliasedFullPath) return Promise.resolve(false)
      return actualFs.fileExists(path)
    })
    onTestFinished(() => {
      vi.mocked(statOrNull).mockRestore()
      vi.mocked(fileExists).mockRestore()
    })

    await expect(
      moveNote({ oldPath: "projects/todo.md", newPath: "Archive/done.md" }),
    ).rejects.toThrow(new Error('note not found: "projects/todo.md"'))
    expect(await readNote("Projects/todo.md")).toBe("sibling content\n")
    expect(await noteExists("Archive/done.md")).toBe(false)
  })

  /** Redirects the stat probe for the lowercase spelling to the real file,
   *  putting the move on the case-only rename branch on every host. */
  const forceCaseOnlyRenameDetection = (vault: string): void => {
    const lowercaseFullPath = join(vault, "foo.md")
    const realFullPath = join(vault, "Foo.md")
    vi.mocked(statOrNull).mockImplementation(async (path) => {
      const actualFs =
        await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")

      if (path === lowercaseFullPath) return actualFs.statOrNull(realFullPath)
      return actualFs.statOrNull(path)
    })
    onTestFinished(() => vi.mocked(statOrNull).mockRestore())
  }

  it("performs a case-only rename and rewrites links to the new casing", async () => {
    // The stat probe reports the same inode for both spellings, as a
    // case-insensitive filesystem would; on a case-sensitive filesystem the
    // real rename behaves as an ordinary move, so the assertions hold on
    // both hosts.
    const { vault, writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "Self [[Foo]].\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")
    forceCaseOnlyRenameDetection(vault)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "foo.md",
      backlinkSources: ["Hub.md"],
    })

    expect(result).toEqual({
      moved_to: "foo.md",
      links_updated: 2,
      updated_notes: ["Hub.md"],
      pruned_empty_folders: 0,
    })
    expect(await readNote("foo.md")).toBe("Self [[foo]].\n")
    expect(await readNote("Hub.md")).toBe("Links [[foo]].\n")
  })

  it("points a Canvas file card and text card at the new casing on a case-only rename", async () => {
    const { vault, writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    await writeFixture(
      "Board.canvas",
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"Foo.md","x":0,"y":0,"width":400,"height":400}',
        '{"id":"t1","type":"text","text":"See [[Foo]]","x":500,"y":0,"width":250,"height":60}',
      ]),
    )
    forceCaseOnlyRenameDetection(vault)

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "foo.md",
      backlinkSources: ["Board.canvas"],
    })

    expect(await readNote("Board.canvas")).toBe(
      obsidianCanvas([
        '{"id":"f1","type":"file","file":"foo.md","x":0,"y":0,"width":400,"height":400}',
        '{"id":"t1","type":"text","text":"See [[foo]]","x":500,"y":0,"width":250,"height":60}',
      ]),
    )
    expect(result).toEqual({
      moved_to: "foo.md",
      links_updated: 2,
      updated_notes: ["Board.canvas"],
      pruned_empty_folders: 0,
    })
  })

  it("moves between case-variant names when the filesystem treats them as distinct files", async (testContext) => {
    // Runs only where the filesystem is case-sensitive — the pair are then
    // two real paths, the same-file probe declines, and the move proceeds as
    // an ordinary move.
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    if (await noteExists("foo.md")) testContext.skip()

    const result = await moveNote({ oldPath: "Foo.md", newPath: "foo.md" })

    expect(result.moved_to).toBe("foo.md")
    expect(await noteExists("Foo.md")).toBe(false)
    expect(await readNote("foo.md")).toBe("content\n")
  })

  it("aborts a case-only rename when the filesystem rename fails", async () => {
    const { vault, writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    forceCaseOnlyRenameDetection(vault)

    const oldFullPath = join(vault, "Foo.md")
    const newFullPath = join(vault, "foo.md")
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (source === oldFullPath && destination === newFullPath) {
        throw new Error("EACCES: permission denied")
      }
      const actualFsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      return actualFsPromises.rename(source, destination)
    })
    onTestFinished(() => vi.mocked(rename).mockRestore())

    await expect(moveNote({ oldPath: "Foo.md", newPath: "foo.md" })).rejects.toThrow(
      new Error('move aborted: could not rename to "foo.md". Nothing was written.'),
    )
    expect(await readNote("Foo.md")).toBe("content\n")
  })

  it("reports the renamed-but-stale-links state when the post-rename write fails", async () => {
    const { vault, writeFixture, moveNote, readNote } = setupVault()
    // The self-link makes the post-rename content write happen.
    await writeFixture("Foo.md", "Self [[Foo]].\n")
    forceCaseOnlyRenameDetection(vault)

    const newFullPath = join(vault, "foo.md")
    vi.mocked(atomicWriteFile).mockImplementation(async (writeParams, writeLogger) => {
      if (writeParams.filePath === newFullPath) {
        throw new Error("ENOSPC: no space left")
      }
      const actualVaultFilesystem =
        await vi.importActual<typeof import("../vault-filesystem.js")>("../vault-filesystem.js")
      return actualVaultFilesystem.atomicWriteFile(writeParams, writeLogger)
    })
    onTestFinished(() => vi.mocked(atomicWriteFile).mockRestore())

    await expect(moveNote({ oldPath: "Foo.md", newPath: "foo.md" })).rejects.toThrow(
      new Error(
        'move incomplete: renamed to "foo.md" but its own links still use the old casing. Edit the note to update them.',
      ),
    )
    // The rename itself went through — the note lives at the new spelling
    // with its original content.
    expect(await readNote("foo.md")).toBe("Self [[Foo]].\n")
  })

  it("names the already-renamed state when a backlink write fails after a case-only rename", async () => {
    const { vault, writeFixture, moveNote, readNote } = setupVault()
    // No self-link, so the only atomicWriteFile call is the backlink source.
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")
    forceCaseOnlyRenameDetection(vault)

    const hubFullPath = join(vault, "Hub.md")
    vi.mocked(atomicWriteFile).mockImplementation(async (writeParams, writeLogger) => {
      if (writeParams.filePath === hubFullPath) {
        throw new Error("ENOSPC: no space left")
      }
      const actualVaultFilesystem =
        await vi.importActual<typeof import("../vault-filesystem.js")>("../vault-filesystem.js")
      return actualVaultFilesystem.atomicWriteFile(writeParams, writeLogger)
    })
    onTestFinished(() => vi.mocked(atomicWriteFile).mockRestore())

    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "foo.md",
        backlinkSources: ["Hub.md"],
      }),
    ).rejects.toThrow(
      new Error(
        'move incomplete: failed updating "Hub.md" (0/1 sources written). ' +
          'The note was already renamed to "foo.md"; update the remaining ' +
          "links directly.",
      ),
    )
    expect(await readNote("foo.md")).toBe("content\n")
    expect(await readNote("Hub.md")).toBe("Links [[Foo]].\n")
  })

  it("tells the caller to delete the written copy when a backlink write fails in an ordinary move", async () => {
    const { vault, writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    const hubFullPath = join(vault, "Hub.md")
    vi.mocked(atomicWriteFile).mockImplementation(async (writeParams, writeLogger) => {
      if (writeParams.filePath === hubFullPath) {
        throw new Error("ENOSPC: no space left")
      }
      const actualVaultFilesystem =
        await vi.importActual<typeof import("../vault-filesystem.js")>("../vault-filesystem.js")
      return actualVaultFilesystem.atomicWriteFile(writeParams, writeLogger)
    })
    onTestFinished(() => vi.mocked(atomicWriteFile).mockRestore())

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "Bar.md", backlinkSources: ["Hub.md"] }),
    ).rejects.toThrow(
      new Error(
        'move incomplete: failed updating "Hub.md" (0/1 sources written). ' +
          'Original not deleted — delete "Bar.md", then re-run to finish.',
      ),
    )
    // Both copies exist, which is why a plain re-run would fail on the destination.
    expect(await readNote("Foo.md")).toBe("content\n")
    expect(await readNote("Bar.md")).toBe("content\n")
  })

  it("tells the caller to delete the original when deleting it fails in an ordinary move", async () => {
    const { vault, writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    const oldFullPath = join(vault, "Foo.md")
    vi.mocked(unlink).mockImplementation(async (path) => {
      if (path === oldFullPath) {
        throw new Error("EACCES: permission denied")
      }
      const actualFsPromises =
        await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      return actualFsPromises.unlink(path)
    })
    onTestFinished(() => vi.mocked(unlink).mockRestore())

    await expect(
      moveNote({ oldPath: "Foo.md", newPath: "Bar.md", backlinkSources: ["Hub.md"] }),
    ).rejects.toThrow(
      new Error(
        'move incomplete: "Bar.md" written but could not delete "Foo.md". Delete "Foo.md" manually to finish.',
      ),
    )
    // Every write landed before the delete, so only the original copy is left over.
    expect({
      original: await readNote("Foo.md"),
      moved: await readNote("Bar.md"),
      backlinkSource: await readNote("Hub.md"),
    }).toEqual({
      original: "content\n",
      moved: "content\n",
      backlinkSource: "Links [[Bar]].\n",
    })
  })

  it("throws when a path does not end in .md", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote({ oldPath: "Foo.md", newPath: "Bar.txt" })).rejects.toThrow(
      new Error('path must end in ".md" (received "Bar.txt")'),
    )
  })

  it("throws when a path escapes the vault root", async () => {
    const { writeFixture, moveNote } = setupVault()
    await writeFixture("Foo.md", "content\n")

    await expect(moveNote({ oldPath: "Foo.md", newPath: "../escape.md" })).rejects.toThrow(
      new Error('path traversal blocked: "../escape.md" escapes vault root'),
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
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Hub.md", "Ghost.md"],
      }),
    ).rejects.toThrow(
      new Error('move aborted: could not read backlink source "Ghost.md". Nothing was written.'),
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
      new Error(
        'move aborted: could not resolve backlink source "../escape.md". Nothing was written.',
      ),
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
      new Error(
        'move aborted: could not resolve backlink source "../escape.md". Nothing was written.',
      ),
    )

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "note move aborted: could not resolve a backlink source path",
      {
        source: "../escape.md",
        from: "Foo.md",
        to: "Bar.md",
        error: '[Error]: path traversal blocked: "../escape.md" escapes vault root',
      },
    )
  })

  it("logs the offending source and destination when a rewrite aborts the move", async () => {
    const { vault, writeFixture, moveNote, logger } = setupVault()
    await writeFixture("Foo.md", "content\n")
    await writeFixture("Hub.md", "Links [[Foo]].\n")

    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Hub.md", "Ghost.md"],
      }),
    ).rejects.toThrow(
      new Error('move aborted: could not read backlink source "Ghost.md". Nothing was written.'),
    )

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "note move aborted: could not read/plan a backlink source",
      {
        source: "Ghost.md",
        from: "Foo.md",
        to: "Bar.md",
        error: `[Error]: ENOENT: no such file or directory, open '${join(vault, "Ghost.md")}'`,
      },
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
      linksUpdated: 1,
      sourcesUpdated: 1,
      sourcesFailed: 0,
      prunedFolderCount: 0,
    })
  })
})

describe("moveNote — properties blocks the server cannot read or keep", () => {
  const LIST_BLOCK_MESSAGE =
    "properties block holds a list, not key-value pairs, so rewriting the note would delete it"

  const UNCLOSED_FLOW_MESSAGE =
    "properties block is not valid YAML at line 2, column 17: Flow sequence in block collection must be sufficiently indented and end with a ]"

  /** Awaits a call that must reject and returns what it rejected with. */
  const captureRejection = async (pending: Promise<unknown>): Promise<unknown> => {
    try {
      await pending
    } catch (error) {
      return error
    }
    throw new Error("expected the call to reject, but it resolved")
  }

  /** The parts of a properties-block refusal callers rely on, or null when the throw is anything else. */
  const describeRefusal = (thrown: unknown): { kind: string; message: string } | null => {
    if (!(thrown instanceof UnsupportedPropertiesBlockError)) return null
    return { kind: thrown.kind, message: thrown.message }
  }

  /** The refusal parseNoteForRewrite gives a note's content, or null when a rewrite keeps it. */
  const describeRewriteRefusal = (content: string): { kind: string; message: string } | null => {
    try {
      parseNoteForRewrite(content)
      return null
    } catch (error) {
      return describeRefusal(error)
    }
  }

  it("aborts when a backlink source it must rewrite holds a list block", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    const fixtures = {
      "Old/Target.md": "Target body\n",
      "Hub.md": "Links [[Old/Target]].\n",
      "Notes/Listy.md": "---\n- a\n---\nSee [[Old/Target]]\n",
    }
    for (const [path, content] of Object.entries(fixtures)) await writeFixture(path, content)

    const refusal = await captureRejection(
      moveNote({
        oldPath: "Old/Target.md",
        newPath: "New/Target.md",
        backlinkSources: ["Hub.md", "Notes/Listy.md"],
      }),
    )

    expect(describeRefusal(refusal)).toEqual({
      kind: "not-key-value",
      message: `move aborted: could not rewrite backlink source "Notes/Listy.md": ${LIST_BLOCK_MESSAGE}. Nothing was written.`,
    })
    expect(await noteExists("New/Target.md")).toBe(false)
    expect({
      "Old/Target.md": await readNote("Old/Target.md"),
      "Hub.md": await readNote("Hub.md"),
      "Notes/Listy.md": await readNote("Notes/Listy.md"),
    }).toEqual(fixtures)
  })

  it.each([
    {
      label: "a list block",
      content: "---\n- a\n- b\n---\nbody\n",
      rewriteRefusal: { kind: "not-key-value", message: LIST_BLOCK_MESSAGE },
    },
    {
      label: "a single-value block",
      content: "---\nJust a paragraph.\n---\nbody\n",
      rewriteRefusal: {
        kind: "not-key-value",
        message:
          "properties block holds a single value, not key-value pairs (a --- line at the top and a later --- line make a properties block), so rewriting the note would delete it",
      },
    },
    {
      label: "an explicitly tagged block",
      content: "---\nstatus: !done\n---\nbody\n",
      rewriteRefusal: {
        kind: "explicit-tag",
        message: "properties block uses the YAML tag !done, which rewriting the note would drop",
      },
    },
  ])(
    "renames a note holding $label byte-for-byte when it has no links to rewrite",
    async ({ content, rewriteRefusal }) => {
      const { writeFixture, moveNote, noteExists, readNote } = setupVault()
      await writeFixture("Inbox/Draft.md", content)
      // A rewrite would refuse this block, so the move must not rewrite the note
      expect(describeRewriteRefusal(content)).toEqual(rewriteRefusal)

      const result = await moveNote({ oldPath: "Inbox/Draft.md", newPath: "Inbox/Spec.md" })

      expect(result).toEqual({
        moved_to: "Inbox/Spec.md",
        links_updated: 0,
        updated_notes: [],
        pruned_empty_folders: 0,
      })
      expect(await noteExists("Inbox/Draft.md")).toBe(false)
      expect(await readNote("Inbox/Spec.md")).toBe(content)
    },
  )

  it("aborts when the note being moved has a block that is not valid YAML", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    const content = "---\ntitle: [unclosed\n---\nbody\n"
    await writeFixture("Old/Broken.md", content)

    const refusal = await captureRejection(
      moveNote({ oldPath: "Old/Broken.md", newPath: "New/Broken.md" }),
    )

    expect(describeRefusal(refusal)).toEqual({
      kind: "invalid-yaml",
      message: `move aborted: could not read "Old/Broken.md": ${UNCLOSED_FLOW_MESSAGE}. Nothing was written.`,
    })
    expect(await noteExists("New/Broken.md")).toBe(false)
    expect(await readNote("Old/Broken.md")).toBe(content)
  })

  it("aborts when a backlink source has a block that is not valid YAML", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    const fixtures = {
      "Old/Target.md": "Target body\n",
      "Hub.md": "Links [[Old/Target]].\n",
      "Notes/Broken.md": "---\ntitle: [unclosed\n---\nSee [[Old/Target]]\n",
    }
    for (const [path, content] of Object.entries(fixtures)) await writeFixture(path, content)

    const refusal = await captureRejection(
      moveNote({
        oldPath: "Old/Target.md",
        newPath: "New/Target.md",
        backlinkSources: ["Hub.md", "Notes/Broken.md"],
      }),
    )

    expect(describeRefusal(refusal)).toEqual({
      kind: "invalid-yaml",
      message: `move aborted: could not read backlink source "Notes/Broken.md": ${UNCLOSED_FLOW_MESSAGE}. Nothing was written.`,
    })
    expect(await noteExists("New/Target.md")).toBe(false)
    expect({
      "Old/Target.md": await readNote("Old/Target.md"),
      "Hub.md": await readNote("Hub.md"),
      "Notes/Broken.md": await readNote("Notes/Broken.md"),
    }).toEqual(fixtures)
  })

  it("aborts as a rewrite failure when a rewritten backlink source would open with a broken block", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    // The empty block reads fine, so the rewrite writes no properties and the
    // body's own --- lines would become the note's first block
    const fixtures = {
      "Old/Target.md": "Target body\n",
      "Notes/Stacked.md": "---\n---\n---\ntitle: [unclosed\n---\nSee [[Old/Target]]\n",
    }
    for (const [path, content] of Object.entries(fixtures)) await writeFixture(path, content)

    const refusal = await captureRejection(
      moveNote({
        oldPath: "Old/Target.md",
        newPath: "New/Target.md",
        backlinkSources: ["Notes/Stacked.md"],
      }),
    )

    expect(refusal).toBeInstanceOf(UnkeepableOpeningBlockError)
    expect(refusal).toHaveProperty(
      "message",
      `move aborted: could not rewrite backlink source "Notes/Stacked.md": the note would open with a properties block the server cannot keep: ${UNCLOSED_FLOW_MESSAGE}. Nothing was written.`,
    )
    expect(await noteExists("New/Target.md")).toBe(false)
    expect({
      "Old/Target.md": await readNote("Old/Target.md"),
      "Notes/Stacked.md": await readNote("Notes/Stacked.md"),
    }).toEqual(fixtures)
  })

  it("aborts as a rewrite failure when the moved note's own rewrite would open with a broken block", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    // The move one folder deeper must rewrite the relative image link, and
    // with the empty block written back as none, the body's own --- lines
    // would become the note's first block
    const content = "---\n---\n---\ntitle: [unclosed\n---\n![[../assets/photo.png]]\n"
    await writeFixture("assets/photo.png", "img")
    await writeFixture("Notes/Stacked.md", content)

    const refusal = await captureRejection(
      moveNote({ oldPath: "Notes/Stacked.md", newPath: "Notes/Sub/Stacked.md" }),
    )

    expect(refusal).toBeInstanceOf(UnkeepableOpeningBlockError)
    expect(refusal).toHaveProperty(
      "message",
      `move aborted: could not rewrite "Notes/Stacked.md": the note would open with a properties block the server cannot keep: ${UNCLOSED_FLOW_MESSAGE}. Nothing was written.`,
    )
    expect(await noteExists("Notes/Sub/Stacked.md")).toBe(false)
    expect(await readNote("Notes/Stacked.md")).toBe(content)
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
    ).rejects.toThrow(new Error('destination exists: "Bar.md"'))
    // Both notes are untouched — the failed move wrote nothing.
    expect(await readNote("Bar.md")).toBe("occupied\n")
    expect(await readNote("Foo.md")).toBe("content\n")
  })
})

describe("moveNote — concurrent write locking", () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Invokes moveNote WITHOUT awaiting it. The multi-file lock is acquired
   *  synchronously before moveNote's first await, so the locks are already
   *  held when this returns. Callers pass a pre-fetched path list so nothing
   *  yields the event loop before acquisition — deliberately a plain (not
   *  async) function, because an async wrapper would flatten the returned
   *  promise. */
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
    ).rejects.toThrow(new Error("concurrent write in progress"))

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
      vaultFs.writeNote({ vaultPath: vault, path: "Bar.md", body: "squatter" }, logger),
    ).rejects.toThrow(new Error("concurrent write in progress"))

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
          trashOption: "system",
        },
        logger,
      ),
    ).rejects.toThrow(new Error("concurrent write in progress"))

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

    await expect(secondMove).rejects.toThrow(new Error("concurrent write in progress"))

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
    const holdHubLock = withExclusiveFileLock(join(vault, "Hub.md"), async () => {
      await delay(50)
    })

    const movePromise = startMove({
      vault,
      logger,
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Hub.md"],
      allNotePaths,
    })
    await expect(movePromise).rejects.toThrow(new Error("concurrent write in progress"))

    // Fail-fast means fail-clean — nothing was moved or rewritten.
    await holdHubLock
    expect(await noteExists("Foo.md")).toBe(true)
    expect(await noteExists("Bar.md")).toBe(false)
    expect(await readNote("Hub.md")).toBe("Links [[Foo]].\n")
  })

  it("releases every lock when the move completes", async () => {
    const { vault, logger, writeFixture, moveNote, noteExists, readNote } = setupVault()
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

    // The move fails inside the lock, after acquisition — the existence
    // check runs within the locked span.
    await expect(
      moveNote({
        oldPath: "Foo.md",
        newPath: "Bar.md",
        backlinkSources: ["Hub.md"],
      }),
    ).rejects.toThrow(new Error('destination exists: "Bar.md"'))

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
    // A self-link makes the difference observable — as the moved note it is
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

describe("moveNote — hidden paths", () => {
  it("rejects a hidden old_path", async () => {
    const { writeFixture, moveNote } = setupVault()
    // The note exists on disk so a removed guard would let the move succeed.
    await writeFixture(".trash/secret.md", "# Secret\n")
    await expect(moveNote({ oldPath: ".trash/secret.md", newPath: "Rescued.md" })).rejects.toThrow(
      new Error('hidden path blocked: ".trash/secret.md" targets a hidden file or folder'),
    )
  })

  it("rejects a hidden new_path and leaves the source note in place", async () => {
    const { writeFixture, moveNote, noteExists, readNote } = setupVault()
    await writeFixture("Visible.md", "# Visible\n")
    await expect(
      moveNote({ oldPath: "Visible.md", newPath: ".obsidian/hidden.md" }),
    ).rejects.toThrow(
      new Error('hidden path blocked: ".obsidian/hidden.md" targets a hidden file or folder'),
    )
    expect(await noteExists("Visible.md")).toBe(true)
    expect(await readNote("Visible.md")).toBe("# Visible\n")
  })
})

describe("moveNote — filesystem backlink verification", () => {
  it("discovers and rewrites a backlink the index missed", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    await writeFixture("Linker.md", "See [[Foo]] for details.\n")

    // Pass empty backlinkSources — simulates a stale index that hasn't
    // indexed Linker.md's link yet. The filesystem scan should find it.
    // Rename (not folder move) so the basename changes and the link needs
    // rewriting — a folder move with unchanged basename keeps [[Foo]]
    // resolvable via shortest-path matching and would be a no-op.
    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: [],
    })

    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Linker.md"],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Linker.md")).toBe("See [[Bar]] for details.\n")
  })

  it("discovers backlinks in frontmatter the index missed", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    await writeFixture("Related.md", '---\nrelated:\n  - "[[Foo]]"\n---\nBody.\n')

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Renamed.md",
      backlinkSources: [],
    })

    expect(result).toEqual({
      moved_to: "Renamed.md",
      links_updated: 1,
      updated_notes: ["Related.md"],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Related.md")).toBe('---\nrelated:\n  - "[[Renamed]]"\n---\nBody.\n')
  })

  it("does not false-positive on notes containing the basename as prose", async () => {
    const { writeFixture, moveNote, logger } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    // The fixture contains "Foo" as prose text, not as a link.
    await writeFixture("Prose.md", "The Foo concept is clear.\n")

    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: [],
    })

    // Prose.md passes the pre-filter (contains "Foo") but should NOT be
    // identified as a backlink source because "Foo" is prose, not a link.
    // Full result assertion also proves the move executed (not a silent no-op).
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 0,
      updated_notes: [],
      pruned_empty_folders: 0,
    })
    // The retry log must NOT have fired with Prose.md — a scan that
    // false-positives on prose would still produce the same result (the
    // preflight finds no links, planned rewrite is filtered out), so the
    // result assertion alone can't catch the regression. No other note links
    // Foo.md, so the log must never fire, whatever its context.
    expect(vi.mocked(logger.info)).not.toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      expect.anything(),
    )
  })

  it("skips unreadable notes during the scan without aborting", async () => {
    const { vault, writeFixture, readNote, logger } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    await writeFixture("Good.md", "Link: [[Foo]]\n")

    // Call moveNote directly with allNotePaths including "Ghost.md" — a path
    // that doesn't exist on disk. The filesystem scan will try to read it,
    // fail with ENOENT, log a warning, and skip it without aborting.
    const result = await noteMover.moveNote(
      {
        vaultPath: vault,
        oldPath: "Foo.md",
        newPath: "Bar.md",
        protectedPaths: PROTECTED,
        backlinkSources: [],
        allNotePaths: ["Foo.md", "Ghost.md", "Good.md"],
        allAssetPaths: [],
        pruneEmptyFolders: false,
        windowsBindMount: false,
      },
      logger,
    )

    // Good.md should still be discovered and rewritten
    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 1,
      updated_notes: ["Good.md"],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Good.md")).toBe("Link: [[Bar]]\n")
    // The ghost note should have been logged as a warning
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "backlink scan: skipping a file that could not be read or parsed",
      {
        path: "Ghost.md",
        error: `[Error]: ENOENT: no such file or directory, open '${join(vault, "Ghost.md")}'`,
      },
    )
  })

  it("handles index-known and filesystem-discovered sources together", async () => {
    const { writeFixture, moveNote, readNote, logger } = setupVault()
    await writeFixture("Foo.md", "# Foo\n")
    await writeFixture("Known.md", "Index knows: [[Foo]]\n")
    await writeFixture("Unknown.md", "Index missed: [[Foo]]\n")

    // Known.md is in backlinkSources (from the index); Unknown.md is not
    const result = await moveNote({
      oldPath: "Foo.md",
      newPath: "Bar.md",
      backlinkSources: ["Known.md"],
    })

    expect(result).toEqual({
      moved_to: "Bar.md",
      links_updated: 2,
      updated_notes: ["Known.md", "Unknown.md"],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Known.md")).toBe("Index knows: [[Bar]]\n")
    expect(await readNote("Unknown.md")).toBe("Index missed: [[Bar]]\n")
    // The retry loop fires because Unknown.md was not in backlinkSources
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      "backlink verification discovered sources the index missed",
      { from: "Foo.md", to: "Bar.md", additionalSources: ["Unknown.md"], attempt: 0 },
    )
  })

  it("discovers a markdown-link backlink via percent-encoded pre-filter", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("My Note.md", "# My Note\n")
    // The link carries a percent-encoded space — the raw content contains
    // "My%20Note" but not "My Note" as a contiguous substring in the URL part.
    // The pre-filter's encodedStem check catches this.
    await writeFixture("Linker.md", "See [here](My%20Note.md) for info.\n")

    const result = await moveNote({
      oldPath: "My Note.md",
      newPath: "Renamed Note.md",
      backlinkSources: [],
    })

    expect(result).toEqual({
      moved_to: "Renamed Note.md",
      links_updated: 1,
      updated_notes: ["Linker.md"],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Linker.md")).toBe("See [here](Renamed%20Note.md) for info.\n")
  })

  it("discovers a markdown-link backlink whose target uses %28/%29 encoding", async () => {
    const { writeFixture, moveNote, readNote } = setupVault()
    await writeFixture("New (Draft).md", "# Draft\n")
    // The rewriter's encodeMarkdownLinkPath encodes parentheses as %28/%29,
    // so the raw content holds neither "New (Draft)" nor "New%20(Draft)".
    // The pre-filter's parenEncodedStem check catches this.
    await writeFixture("Hub.md", "See [x](New%20%28Draft%29.md).\n")

    const result = await moveNote({
      oldPath: "New (Draft).md",
      newPath: "Finished.md",
      backlinkSources: [],
    })

    expect(result).toEqual({
      moved_to: "Finished.md",
      links_updated: 1,
      updated_notes: ["Hub.md"],
      pruned_empty_folders: 0,
    })
    expect(await readNote("Hub.md")).toBe("See [x](Finished.md).\n")
  })
})

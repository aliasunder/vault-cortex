import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  onTestFinished,
} from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseNote } from "../../obsidian-markdown/frontmatter.js"
import { createMemoryStore } from "../memory-store.js"
import { logger } from "../../../logger.js"

const {
  getMemory,
  updateMemory,
  listMemoryFiles,
  listMemoryFileNames,
  deleteMemory,
} = createMemoryStore({ memoryDir: "About Me" })

let vault: string

const PRINCIPLES_MD = `---
title: "Principles — About Me"
type: profile
tags:
  - about-me
  - principles
created: 2026-04-22T20:51:21-04:00
related:
  - "[[People/Alex Rivera|Alex Rivera]]"
---

# Principles

> [!info] Scope of this file
> **Contains:** Values, decision heuristics, non-negotiables.
> **Convention:** Append newest first; never overwrite dated entries.

## Decision heuristics (newest first)
- **2026-05-06**: Secrets invisible at every layer
- **2026-05-05**: Least-privilege for AI agents

## Working style (newest first)
- **2026-05-04**: Single-purpose files

## Empty section (newest first)
`

const OPINIONS_MD = `---
title: "Opinions — About Me"
type: profile
tags:
  - about-me
  - opinions
created: 2026-04-22T22:04:32-04:00
---

# Opinions

## AI tooling & memory (newest first)
- **2026-05-07**: **Research current docs before configuring.** AI agents should consult docs
- **2026-05-04**: **Clean breaks over placeholders.** Remove all references

## Code patterns (newest first)
- **2026-05-07**: **.reduce() over filter/map chains.** Single reduce pass
`

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "memory-test-"))
  await mkdir(join(vault, "About Me"), { recursive: true })
  await writeFile(join(vault, "About Me/Principles.md"), PRINCIPLES_MD, "utf8")
  await writeFile(join(vault, "About Me/Opinions.md"), OPINIONS_MD, "utf8")
})

afterEach(async () => {
  await rm(vault, { recursive: true })
})

describe("getMemory", () => {
  it("concatenates all memory files when no file specified", async () => {
    const result = await getMemory({ vaultPath: vault }, logger)
    expect(result).toContain("# Opinions")
    expect(result).toContain("# Principles")
    expect(result).toContain("\n\n---\n\n")
    expect(result).not.toContain("title:")
  })

  it("returns files in alphabetical order", async () => {
    const result = await getMemory({ vaultPath: vault }, logger)
    const opinionsIdx = result.indexOf("# Opinions")
    const principlesIdx = result.indexOf("# Principles")
    expect(opinionsIdx).toBeLessThan(principlesIdx)
  })

  it("returns a single file without frontmatter", async () => {
    const result = await getMemory(
      { vaultPath: vault, file: "Principles" },
      logger,
    )
    expect(result).toContain("# Principles")
    expect(result).toContain("## Decision heuristics")
    expect(result).not.toContain("title:")
    expect(result).not.toContain("---")
  })

  it("returns a specific section body", async () => {
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    expect(result).toContain("Secrets invisible at every layer")
    expect(result).toContain("Least-privilege for AI agents")
    expect(result).not.toContain("## Decision heuristics")
    expect(result).not.toContain("Working style")
  })

  it("section matching is case-insensitive", async () => {
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "decision heuristics (newest first)",
      },
      logger,
    )
    expect(result).toContain("Secrets invisible at every layer")
  })

  it("resolves a section addressed by its short name (no suffix)", async () => {
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style",
      },
      logger,
    )
    expect(result).toBe("- **2026-05-04**: Single-purpose files")
  })

  it("returns empty string for section with no entries", async () => {
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Empty section (newest first)",
      },
      logger,
    )
    expect(result).toBe("")
  })

  it("throws on non-existent file", async () => {
    await expect(
      getMemory({ vaultPath: vault, file: "Nonexistent" }, logger),
    ).rejects.toThrow('memory file not found: "About Me/Nonexistent.md"')
  })

  it("throws on non-existent section", async () => {
    await expect(
      getMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Nonexistent section",
        },
        logger,
      ),
    ).rejects.toThrow('section not found: "Nonexistent section"')
  })

  it("returns empty string when About Me directory does not exist", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "empty-vault-"))
    const result = await getMemory({ vaultPath: emptyVault }, logger)
    expect(result).toBe("")
    await rm(emptyVault, { recursive: true })
  })

  // A memory file is a bare name, never a path — a separator would let
  // "../.." read notes outside the memory directory (or the vault).
  it("rejects a file name containing path separators instead of reading outside the memory directory", async () => {
    // A real note one level above About Me/ — the guard, not a missing
    // file, must be what rejects the read.
    await writeFile(join(vault, "Outside.md"), "# Outside\n", "utf8")
    await expect(
      getMemory({ vaultPath: vault, file: "../Outside" }, logger),
    ).rejects.toThrow(
      'memory file must be a bare name without path separators: "../Outside"',
    )
  })
})

describe("updateMemory", () => {
  it("inserts entry at top of section by default", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "new entry text",
        date: "2026-05-08",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    const lines = result.split("\n")
    expect(lines[0]).toBe("- **2026-05-08**: new entry text")
    expect(lines[1]).toContain("2026-05-06")
  })

  it("inserts entry at bottom when position is 'bottom'", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "bottom entry",
        date: "2026-04-01",
        position: "bottom",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    const lines = result.split("\n").filter((line) => line.startsWith("- "))
    expect(lines[lines.length - 1]).toBe("- **2026-04-01**: bottom entry")
  })

  it("inserts entry into empty section", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Empty section (newest first)",
        entry: "first entry",
        date: "2026-05-08",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Empty section (newest first)",
      },
      logger,
    )
    expect(result).toBe("- **2026-05-08**: first entry")
  })

  it("preserves frontmatter round-trip", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "new entry",
        date: "2026-05-08",
      },
      logger,
    )
    const raw = await readFile(join(vault, "About Me/Principles.md"), "utf8")
    expect(raw).toContain("title: Principles — About Me")
    expect(raw).toContain("type: profile")
    expect(raw).toContain("- about-me")
    expect(raw).toContain("- principles")
    // Local-offset created stamp survives byte-identically — never
    // re-serialized to UTC-Z
    expect(raw).toContain("created: 2026-04-22T20:51:21-04:00")
  })

  it("uses today's date when no date option provided", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-15T14:00:00"))
    try {
      await updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Working style (newest first)",
          entry: "today entry",
        },
        logger,
      )
      const result = await getMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Working style (newest first)",
        },
        logger,
      )
      expect(result).toContain("- **2026-07-15**: today entry")
    } finally {
      vi.useRealTimers()
    }
  })

  it("case-insensitive section matching", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "WORKING STYLE (NEWEST FIRST)",
        entry: "case test",
        date: "2026-05-08",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style (newest first)",
      },
      logger,
    )
    expect(result).toContain("- **2026-05-08**: case test")
  })

  it("auto-creates file when it does not exist", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Ghost",
        section: "New section",
        entry: "first entry",
        date: "2026-05-15",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Ghost",
        section: "New section (newest first)",
      },
      logger,
    )
    expect(result).toBe("- **2026-05-15**: first entry")
  })

  it("auto-creates section in existing file", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Brand new section",
        entry: "section entry",
        date: "2026-05-15",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Brand new section (newest first)",
      },
      logger,
    )
    expect(result).toBe("- **2026-05-15**: section entry")
  })

  it("appends to an existing section by its short name without duplicating it", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style",
        entry: "short-name entry",
        date: "2026-05-09",
      },
      logger,
    )
    const principlesContent = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    // The entry lands in the existing section — no second "## Working style …"
    // heading is appended at EOF (the duplicate-section bug).
    expect(principlesContent.match(/^## Working style/gm)).toHaveLength(1)
    expect(principlesContent).toContain("- **2026-05-09**: short-name entry")

    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find(
      (outline) => outline.file === "Principles",
    )!
    const workingStyle = principles.headings.find(
      (heading) => heading.text === "Working style (newest first)",
    )
    expect(workingStyle?.entryCount).toBe(2)
  })
})

describe("updateMemory idempotency", () => {
  it("returns 'unchanged' and writes nothing when the exact entry already exists in the section", async () => {
    const firstOutcome = await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "retry-safe entry",
        date: "2026-07-02",
      },
      logger,
    )
    expect(firstOutcome).toBe("appended")
    const contentAfterFirstCall = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )

    const secondOutcome = await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "retry-safe entry",
        date: "2026-07-02",
      },
      logger,
    )
    expect(secondOutcome).toBe("unchanged")

    // The file is byte-identical to the state after the first call — the
    // retry neither duplicated the entry nor touched anything else.
    const contentAfterSecondCall = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    expect(contentAfterSecondCall).toBe(contentAfterFirstCall)
    const bulletOccurrenceCount =
      contentAfterSecondCall.split("- **2026-07-02**: retry-safe entry")
        .length - 1
    expect(bulletOccurrenceCount).toBe(1)
  })

  it("treats an entry already present from a hand edit as unchanged", async () => {
    // Duplicates the fixture line that exists in PRINCIPLES_MD verbatim.
    const outcome = await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "Secrets invisible at every layer",
        date: "2026-05-06",
      },
      logger,
    )
    expect(outcome).toBe("unchanged")
    // The no-op left the file byte-identical to the fixture — the entry was
    // neither duplicated nor was anything else touched.
    const fileContent = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    expect(fileContent).toBe(PRINCIPLES_MD)
  })

  // A multiline entry would write a block the line-based duplicate guard
  // (and deleteMemory's exact line match) can never detect — it must be
  // rejected before anything is written.
  it.each([
    { lineBreakKind: "a line feed", entry: "line one\nline two" },
    { lineBreakKind: "a carriage return", entry: "carriage\rreturn" },
  ])(
    "rejects an entry containing $lineBreakKind, which duplicate detection could never see",
    async ({ entry }) => {
      await expect(
        updateMemory(
          {
            vaultPath: vault,
            file: "Principles",
            section: "Decision heuristics (newest first)",
            entry,
            date: "2026-07-02",
          },
          logger,
        ),
      ).rejects.toThrow(
        "entry must be a single line: memory entries are single dated bullets — collapse newlines or append multiple entries",
      )
      // Nothing was written — the file is byte-identical to the fixture.
      const fileContent = await readFile(
        join(vault, "About Me/Principles.md"),
        "utf8",
      )
      expect(fileContent).toBe(PRINCIPLES_MD)
    },
  )

  // The date lands inside the same single-line bullet as the entry, so a
  // malformed or newline-bearing date corrupts the format the same way a
  // multiline entry does — it must be rejected before anything is written.
  // "2026-13-40" is shape-valid but calendar-impossible.
  it.each([
    { dateKind: "a non-zero-padded date", date: "2026-7-2" },
    { dateKind: "a timestamp", date: "2026-07-02T10:00:00" },
    { dateKind: "free text with a line break", date: "today\n" },
    { dateKind: "a calendar-impossible date", date: "2026-13-40" },
  ])("rejects $dateKind as the entry date", async ({ date }) => {
    await expect(
      updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Decision heuristics (newest first)",
          entry: "valid entry",
          date,
        },
        logger,
      ),
    ).rejects.toThrow(
      "date must be a real ISO calendar date (YYYY-MM-DD, e.g. 2026-07-02)",
    )
    // Nothing was written — the file is byte-identical to the fixture.
    const fileContent = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    expect(fileContent).toBe(PRINCIPLES_MD)
  })

  // A section name with a line break would write a corrupted multi-line
  // "## heading" that findSection could never match again — every retry
  // would append another broken section instead of hitting the duplicate
  // guard, so it must be rejected before anything is written.
  it("rejects a section name containing a line break, which would corrupt the heading", async () => {
    await expect(
      updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Decision heuristics\n(newest first)",
          entry: "valid entry",
          date: "2026-07-02",
        },
        logger,
      ),
    ).rejects.toThrow(
      "section must be a single line: section names become H2 headings — remove line breaks",
    )
    // Nothing was written — the file is byte-identical to the fixture.
    const fileContent = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    expect(fileContent).toBe(PRINCIPLES_MD)
  })

  it("rejects an entry containing a control character", async () => {
    await expect(
      updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Decision heuristics (newest first)",
          entry: "likes\x00nulls",
          date: "2026-07-02",
        },
        logger,
      ),
    ).rejects.toThrow(
      "entry contains a control character (U+0000 at position 5) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  it("rejects a section name containing a control character", async () => {
    await expect(
      updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Bad\x07Section",
          entry: "valid entry",
          date: "2026-07-02",
        },
        logger,
      ),
    ).rejects.toThrow(
      "section contains a control character (U+0007 at position 3) — control characters other than tab, LF, and CR are not allowed",
    )
  })

  // A memory file is a bare name, never a path — a separator would let
  // "../.." escape the memory directory (and the vault) entirely.
  it.each([
    { separatorKind: "a forward slash", file: "../Escaped" },
    { separatorKind: "a backslash", file: "..\\Escaped" },
  ])(
    "rejects a file name containing $separatorKind instead of writing outside the memory directory",
    async ({ file }) => {
      await expect(
        updateMemory(
          {
            vaultPath: vault,
            file,
            section: "Decision heuristics (newest first)",
            entry: "valid entry",
            date: "2026-07-02",
          },
          logger,
        ),
      ).rejects.toThrow(
        `memory file must be a bare name without path separators: "${file}"`,
      )
      // No file escaped the memory directory into the vault root.
      await expect(
        readFile(join(vault, "Escaped.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it("appends when the same text arrives with a different date", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "same text",
        date: "2026-07-01",
      },
      logger,
    )
    const outcome = await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "same text",
        date: "2026-07-02",
      },
      logger,
    )
    expect(outcome).toBe("appended")
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    expect(result).toContain("- **2026-07-01**: same text")
    expect(result).toContain("- **2026-07-02**: same text")
  })

  it("appends when the same date arrives with different text", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "first entry of the day",
        date: "2026-07-02",
      },
      logger,
    )
    const outcome = await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "second entry of the day",
        date: "2026-07-02",
      },
      logger,
    )
    expect(outcome).toBe("appended")
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    expect(result).toContain("- **2026-07-02**: first entry of the day")
    expect(result).toContain("- **2026-07-02**: second entry of the day")
  })

  it("an identical bullet in a different section does not suppress the append", async () => {
    const firstOutcome = await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        entry: "cross-section entry",
        date: "2026-07-02",
      },
      logger,
    )
    // The duplicate must actually be on disk before the cross-section call —
    // otherwise the second "appended" proves nothing about section scoping.
    expect(firstOutcome).toBe("appended")
    const outcome = await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style (newest first)",
        entry: "cross-section entry",
        date: "2026-07-02",
      },
      logger,
    )
    expect(outcome).toBe("appended")
    const workingStyle = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style (newest first)",
      },
      logger,
    )
    expect(workingStyle).toContain("- **2026-07-02**: cross-section entry")
  })
})

describe("updateMemory auto-creation", () => {
  it("auto-creates directory and file when neither exist", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "no-dir-"))
    await updateMemory(
      {
        vaultPath: emptyVault,
        file: "Preferences",
        section: "Editor settings",
        entry: "Prefers dark mode",
        date: "2026-05-15",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: emptyVault,
        file: "Preferences",
        section: "Editor settings (newest first)",
      },
      logger,
    )
    expect(result).toBe("- **2026-05-15**: Prefers dark mode")
    await rm(emptyVault, { recursive: true })
  })

  it("auto-created file has correct frontmatter", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "fm-test-"))
    await updateMemory(
      {
        vaultPath: emptyVault,
        file: "Working Preferences",
        section: "Tools",
        entry: "Uses VS Code",
        date: "2026-05-15",
      },
      logger,
    )
    const raw = await readFile(
      join(emptyVault, "About Me/Working Preferences.md"),
      "utf8",
    )
    const parsed = parseNote(raw)
    expect(parsed.data.title).toBe("Working Preferences")
    expect(parsed.data.type).toBe("profile")
    expect(parsed.data.tags).toEqual(["memory", "working-preferences"])
    expect(parsed.data.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    // DateTime.now().toISO() stamps an offset-form ISO 8601 string; the
    // serializer must write it unquoted and verbatim — never re-encoded
    // to a Z-suffixed UTC form
    expect(raw).toMatch(
      /^created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/m,
    )
    await rm(emptyVault, { recursive: true })
  })

  it("seeds a generic scope callout in an auto-created file and reports created-file", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "new-callout-"))
    const outcome = await updateMemory(
      {
        vaultPath: emptyVault,
        file: "Health",
        section: "Sleep",
        entry: "Aims for 8 hours",
        date: "2026-05-15",
      },
      logger,
    )
    expect(outcome).toBe("created-file")
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    const health = outlines.find((outline) => outline.file === "Health")!
    expect(health.leading_callout?.title).toBe("Scope of this file")
    // Generic form: convention + a Contains placeholder, no per-file Does-NOT-contain.
    expect(health.leading_callout?.body).toBe(
      "**Contains:** (describe what belongs in this file — and what doesn't)\n**Convention:** append newest first; never overwrite dated entries; ISO dates only.",
    )
    await rm(emptyVault, { recursive: true })
  })

  it("reports created-section then appended for subsequent writes", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "outcome-"))
    const first = await updateMemory(
      { vaultPath: emptyVault, file: "Notes", section: "A", entry: "one" },
      logger,
    )
    const second = await updateMemory(
      { vaultPath: emptyVault, file: "Notes", section: "B", entry: "two" },
      logger,
    )
    const third = await updateMemory(
      { vaultPath: emptyVault, file: "Notes", section: "B", entry: "three" },
      logger,
    )
    expect(first).toBe("created-file")
    expect(second).toBe("created-section")
    expect(third).toBe("appended")
    await rm(emptyVault, { recursive: true })
  })

  it("auto-created file has correct H1 and H2 structure", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "structure-"))
    await updateMemory(
      {
        vaultPath: emptyVault,
        file: "Preferences",
        section: "Editor settings",
        entry: "Dark mode",
        date: "2026-05-15",
      },
      logger,
    )
    const raw = await readFile(
      join(emptyVault, "About Me/Preferences.md"),
      "utf8",
    )
    expect(raw).toContain("# Preferences")
    expect(raw).toContain("## Editor settings (newest first)")
    expect(raw).toContain("- **2026-05-15**: Dark mode")
    await rm(emptyVault, { recursive: true })
  })

  it("auto-created section preserves existing file content", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "New category",
        entry: "appended entry",
        date: "2026-05-15",
      },
      logger,
    )
    const raw = await readFile(join(vault, "About Me/Principles.md"), "utf8")
    expect(raw).toContain("## Decision heuristics (newest first)")
    expect(raw).toContain("Secrets invisible at every layer")
    expect(raw).toContain("## Working style (newest first)")
    expect(raw).toContain("## New category (newest first)")
    expect(raw).toContain("- **2026-05-15**: appended entry")
    expect(raw).toContain("title: Principles — About Me")
  })

  it("auto-created section entry is readable via getMemory", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Opinions",
        section: "Design preferences",
        entry: "Minimalist UI",
        date: "2026-05-15",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Opinions",
        section: "Design preferences (newest first)",
      },
      logger,
    )
    expect(result).toBe("- **2026-05-15**: Minimalist UI")
  })

  it("does not double-append suffix when section already has it", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Opinions",
        section: "Design preferences (newest first)",
        entry: "Already suffixed",
        date: "2026-05-15",
      },
      logger,
    )
    const raw = await readFile(join(vault, "About Me/Opinions.md"), "utf8")
    expect(raw).toContain("## Design preferences (newest first)")
    expect(raw).not.toContain(
      "## Design preferences (newest first) (newest first)",
    )
  })
})

describe("deleteMemory", () => {
  it("deletes an exact matching entry", async () => {
    await deleteMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        date: "2026-05-05",
        entry: "Least-privilege for AI agents",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    expect(result).not.toContain("Least-privilege")
    expect(result).toContain("Secrets invisible")
  })

  it("resolves a section addressed by its short name (no suffix)", async () => {
    await deleteMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics",
        date: "2026-05-06",
        entry: "Secrets invisible at every layer",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    expect(result).not.toContain("Secrets invisible")
    expect(result).toContain("Least-privilege for AI agents")
  })

  it("throws on no matching entry", async () => {
    await expect(
      deleteMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Decision heuristics (newest first)",
          date: "2026-05-05",
          entry: "nonexistent text",
        },
        logger,
      ),
    ).rejects.toThrow('no entry matching (2026-05-05, "nonexistent text")')
  })

  // Server-written bullets only carry real calendar dates, so a malformed
  // date can never match — the guard turns a guaranteed "no entry matching"
  // miss into an actionable format error before any file read.
  it("rejects a calendar-impossible date and leaves the file unchanged", async () => {
    await expect(
      deleteMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Decision heuristics (newest first)",
          date: "2026-13-40",
          entry: "Least-privilege for AI agents",
        },
        logger,
      ),
    ).rejects.toThrow(
      "date must be a real ISO calendar date (YYYY-MM-DD, e.g. 2026-07-02)",
    )
    const fileContent = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    expect(fileContent).toBe(PRINCIPLES_MD)
  })

  it("throws on ambiguous match", async () => {
    const dupeContent = `---
title: Dupe
---

# Dupe

## Section (newest first)
- **2026-01-01**: same entry
- **2026-01-01**: same entry
`
    await writeFile(join(vault, "About Me/Dupe.md"), dupeContent, "utf8")
    await expect(
      deleteMemory(
        {
          vaultPath: vault,
          file: "Dupe",
          section: "Section (newest first)",
          date: "2026-01-01",
          entry: "same entry",
        },
        logger,
      ),
    ).rejects.toThrow("ambiguous: 2 entries match")
  })

  it("preserves frontmatter after deletion", async () => {
    await deleteMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        date: "2026-05-05",
        entry: "Least-privilege for AI agents",
      },
      logger,
    )
    const raw = await readFile(join(vault, "About Me/Principles.md"), "utf8")
    expect(raw).not.toContain("Least-privilege for AI agents")
    expect(raw).toContain("title: Principles — About Me")
    expect(raw).toContain("type: profile")
    // Local-offset created stamp survives byte-identically — never
    // re-serialized to UTC-Z
    expect(raw).toContain("created: 2026-04-22T20:51:21-04:00")
  })

  it("case-insensitive section matching", async () => {
    await deleteMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "DECISION HEURISTICS (NEWEST FIRST)",
        date: "2026-05-06",
        entry: "Secrets invisible at every layer",
      },
      logger,
    )
    const result = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    expect(result).not.toContain("Secrets invisible")
  })

  it("throws on non-existent file", async () => {
    await expect(
      deleteMemory(
        {
          vaultPath: vault,
          file: "Ghost",
          section: "Section",
          date: "2026-01-01",
          entry: "entry",
        },
        logger,
      ),
    ).rejects.toThrow('memory file not found: "About Me/Ghost.md"')
  })

  it("throws on non-existent section", async () => {
    await expect(
      deleteMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Nope",
          date: "2026-01-01",
          entry: "entry",
        },
        logger,
      ),
    ).rejects.toThrow('section not found: "Nope"')
  })
})

describe("listMemoryFiles", () => {
  it("returns outlines sorted by filename", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    expect(outlines).toHaveLength(2)
    expect(outlines[0]?.file).toBe("Opinions")
    expect(outlines[1]?.file).toBe("Principles")
  })

  it("includes byte size per file", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    for (const outline of outlines) {
      expect(outline.bytes).toBeGreaterThan(0)
      expect(typeof outline.bytes).toBe("number")
    }
  })

  it("uses frontmatter title", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    expect(outlines[0]?.title).toBe("Opinions — About Me")
    expect(outlines[1]?.title).toBe("Principles — About Me")
  })

  it("surfaces each file's leading scope callout (null when absent)", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find(
      (outline) => outline.file === "Principles",
    )!
    const opinions = outlines.find((outline) => outline.file === "Opinions")!
    expect(principles.leading_callout).toEqual({
      type: "info",
      title: "Scope of this file",
      body: "**Contains:** Values, decision heuristics, non-negotiables.\n**Convention:** Append newest first; never overwrite dated entries.",
    })
    // OPINIONS_MD has no leading callout.
    expect(opinions.leading_callout).toBeNull()
  })

  it("falls back to filename when no frontmatter title", async () => {
    await writeFile(
      join(vault, "About Me/NoTitle.md"),
      "---\ntype: profile\n---\n\n# NoTitle\n",
      "utf8",
    )
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const noTitle = outlines.find((outline) => outline.file === "NoTitle")
    expect(noTitle?.title).toBe("NoTitle")
  })

  it("defaults entry_policy to append-only when the property is absent", async () => {
    // The base fixtures (Principles, Opinions) declare no entry-policy.
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find((outline) => outline.file === "Principles")
    expect(principles?.entry_policy).toBe("append-only")
  })

  it("surfaces entry_policy living when declared in frontmatter", async () => {
    await writeFile(
      join(vault, "About Me/Living.md"),
      [
        "---",
        "title: Living",
        "type: profile",
        "entry-policy: living",
        "---",
        "",
        "# Living",
        "",
        "## Upcoming (newest first)",
        "- **2026-07-11**: a current-state entry",
      ].join("\n"),
      "utf8",
    )
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const living = outlines.find((outline) => outline.file === "Living")
    expect(living?.entry_policy).toBe("living")
  })

  it("treats an unrecognized entry-policy value as append-only", async () => {
    // Only the explicit "living" opt-in relaxes append-only; a typo must not
    // silently authorize destructive maintenance.
    await writeFile(
      join(vault, "About Me/Typo.md"),
      [
        "---",
        "title: Typo",
        "type: profile",
        "entry-policy: sometimes",
        "---",
        "",
        "# Typo",
      ].join("\n"),
      "utf8",
    )
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const typo = outlines.find((outline) => outline.file === "Typo")
    expect(typo?.entry_policy).toBe("append-only")
  })

  it("does not treat a heading-looking line inside a code fence as a section", async () => {
    // The shared heading parser is fence-aware, so a "## ..."-looking line inside
    // a code block is not surfaced as a section. The prior memory-local parser was
    // not fence-aware and would have added "Fake Section" as a real H2.
    await writeFile(
      join(vault, "About Me/Fenced.md"),
      [
        "---",
        "title: Fenced",
        "type: profile",
        "---",
        "",
        "# Fenced",
        "",
        "## Real (newest first)",
        "- **2026-06-22**: a real entry",
        "",
        "```md",
        "## Fake Section",
        "```",
      ].join("\n"),
      "utf8",
    )
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const fenced = outlines.find((outline) => outline.file === "Fenced")!
    expect(fenced.headings.map((heading) => heading.text)).toEqual([
      "Fenced",
      "Real (newest first)",
    ])
  })

  it("includes correct entry counts per section", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find(
      (outline) => outline.file === "Principles",
    )!
    const heuristics = principles.headings.find(
      (heading) => heading.text === "Decision heuristics (newest first)",
    )
    expect(heuristics?.entryCount).toBe(2)

    const workingStyle = principles.headings.find(
      (heading) => heading.text === "Working style (newest first)",
    )
    expect(workingStyle?.entryCount).toBe(1)

    const emptySection = principles.headings.find(
      (heading) => heading.text === "Empty section (newest first)",
    )
    expect(emptySection?.entryCount).toBe(0)
  })

  it("identifies H1 and H2 headings correctly", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find(
      (outline) => outline.file === "Principles",
    )!
    const h1s = principles.headings.filter((heading) => heading.level === 1)
    const h2s = principles.headings.filter((heading) => heading.level === 2)
    expect(h1s).toHaveLength(1)
    expect(h1s[0]?.text).toBe("Principles")
    expect(h2s).toHaveLength(3)
  })

  it("does not count callout lines as entries", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find(
      (outline) => outline.file === "Principles",
    )!
    const h1 = principles.headings.find((heading) => heading.level === 1)
    expect(h1?.entryCount).toBeUndefined()
  })

  it("returns empty array when About Me directory is empty", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "empty-mem-"))
    await mkdir(join(emptyVault, "About Me"))
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    expect(outlines).toEqual([])
    await rm(emptyVault, { recursive: true })
  })

  it("returns empty array when About Me directory does not exist", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "no-dir-"))
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    expect(outlines).toEqual([])
    await rm(emptyVault, { recursive: true })
  })
})

describe("listMemoryFileNames", () => {
  it("returns file names (without .md) sorted alphabetically", async () => {
    const names = await listMemoryFileNames({ vaultPath: vault }, logger)
    expect(names).toEqual(["Opinions", "Principles"])
  })

  it("ignores non-markdown files", async () => {
    await writeFile(join(vault, "About Me/notes.txt"), "ignore me", "utf8")
    const names = await listMemoryFileNames({ vaultPath: vault }, logger)
    expect(names).toEqual(["Opinions", "Principles"])
  })

  it("returns an empty array when the memory directory does not exist", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "no-dir-names-"))
    const names = await listMemoryFileNames({ vaultPath: emptyVault }, logger)
    expect(names).toEqual([])
    await rm(emptyVault, { recursive: true })
  })
})

describe("custom memoryDir", () => {
  const customStore = createMemoryStore({ memoryDir: "Profile" })

  it("reads from the configured directory", async () => {
    const customVault = await mkdtemp(join(tmpdir(), "custom-mem-"))
    await mkdir(join(customVault, "Profile"), { recursive: true })
    await writeFile(
      join(customVault, "Profile/Principles.md"),
      PRINCIPLES_MD,
      "utf8",
    )
    const result = await customStore.getMemory(
      { vaultPath: customVault, file: "Principles" },
      logger,
    )
    expect(result).toContain("# Principles")
    await rm(customVault, { recursive: true })
  })

  it("error messages reference the configured directory name", async () => {
    const customVault = await mkdtemp(join(tmpdir(), "custom-mem-"))
    await expect(
      customStore.getMemory(
        { vaultPath: customVault, file: "Nonexistent" },
        logger,
      ),
    ).rejects.toThrow('memory file not found: "Profile/Nonexistent.md"')
    await rm(customVault, { recursive: true })
  })

  it("returns empty string when configured directory does not exist", async () => {
    const customVault = await mkdtemp(join(tmpdir(), "custom-mem-"))
    const result = await customStore.getMemory(
      { vaultPath: customVault },
      logger,
    )
    expect(result).toBe("")
    await rm(customVault, { recursive: true })
  })
})

describe("bootstrapMemoryDir", () => {
  const { bootstrapMemoryDir, listMemoryFiles } = createMemoryStore({
    memoryDir: "About Me",
  })

  it("creates memory directory and template files when dir does not exist", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "bootstrap-"))
    await bootstrapMemoryDir({ vaultPath: emptyVault }, logger)
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    expect(outlines).toHaveLength(5)
    expect(outlines.map((outline) => outline.file).sort()).toEqual([
      "Agents",
      "Me",
      "Opinions",
      "Principles",
      "Routines",
    ])
    await rm(emptyVault, { recursive: true })
  })

  it("template files have correct frontmatter", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "bootstrap-fm-"))
    await bootstrapMemoryDir({ vaultPath: emptyVault }, logger)
    const raw = await readFile(
      join(emptyVault, "About Me/Principles.md"),
      "utf8",
    )
    const parsed = parseNote(raw)
    expect(parsed.data.title).toBe("Principles")
    expect(parsed.data.type).toBe("profile")
    expect(parsed.data["entry-policy"]).toBe("append-only")
    expect(parsed.data.tags).toEqual(["memory", "principles"])
    expect(parsed.data.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(parsed.data.related).toEqual([
      "[[About Me/Opinions]]",
      "[[About Me/Me]]",
      "[[About Me/Agents]]",
    ])
    await rm(emptyVault, { recursive: true })
  })

  it("bootstraps the Agents template with directive sections", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "bootstrap-agents-"))
    await bootstrapMemoryDir({ vaultPath: emptyVault }, logger)
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    const agents = outlines.find((outline) => outline.file === "Agents")
    expect(agents).toBeDefined()
    expect(agents?.entry_policy).toBe("append-only")
    const sectionNames = agents?.headings
      .filter((heading) => heading.level === 2)
      .map((heading) => heading.text)
    expect(sectionNames).toEqual([
      "Communication (newest first)",
      "Working style (newest first)",
      "Verification & scope (newest first)",
    ])
    await rm(emptyVault, { recursive: true })
  })

  it("bootstraps the Routines template as a living current-state file", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "bootstrap-living-"))
    await bootstrapMemoryDir({ vaultPath: emptyVault }, logger)
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    const routines = outlines.find((outline) => outline.file === "Routines")
    expect(routines?.entry_policy).toBe("living")
    const sectionNames = routines?.headings
      .filter((heading) => heading.level === 2)
      .map((heading) => heading.text)
    expect(sectionNames).toEqual([
      "Active commitments (newest first)",
      "Upcoming (newest first)",
      "Daily/weekly rhythm (newest first)",
      "Recent past (newest first)",
    ])
    await rm(emptyVault, { recursive: true })
  })

  it("template files have correct H2 sections", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "bootstrap-h2-"))
    await bootstrapMemoryDir({ vaultPath: emptyVault }, logger)
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    const principles = outlines.find(
      (outline) => outline.file === "Principles",
    )!
    const sectionNames = principles.headings
      .filter((heading) => heading.level === 2)
      .map((heading) => heading.text)
    expect(sectionNames).toEqual([
      "Decision heuristics (newest first)",
      "Working style (newest first)",
      "Non-negotiables (newest first)",
    ])
    await rm(emptyVault, { recursive: true })
  })

  it("template files open with a scope callout and count zero entries", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "bootstrap-callout-"))
    await bootstrapMemoryDir({ vaultPath: emptyVault }, logger)
    const outlines = await listMemoryFiles({ vaultPath: emptyVault }, logger)
    const opinions = outlines.find((outline) => outline.file === "Opinions")!
    // The callout is surfaced and is NOT miscounted as a dated entry.
    expect(opinions.leading_callout?.type).toBe("info")
    expect(opinions.leading_callout?.title).toBe("Scope of this file")
    expect(opinions.leading_callout?.body).toContain("**Contains:**")
    const totalEntries = opinions.headings.reduce(
      (sum, heading) => sum + (heading.entryCount ?? 0),
      0,
    )
    expect(totalEntries).toBe(0)
    await rm(emptyVault, { recursive: true })
  })

  it("is a no-op when memory directory already exists", async () => {
    const contentBefore = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    await bootstrapMemoryDir({ vaultPath: vault }, logger)
    const contentAfter = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    expect(contentAfter).toBe(contentBefore)
  })

  it("preserves existing files when directory already exists", async () => {
    await bootstrapMemoryDir({ vaultPath: vault }, logger)
    const raw = await readFile(join(vault, "About Me/Principles.md"), "utf8")
    const parsed = parseNote(raw)
    expect(parsed.data.title).toBe("Principles — About Me")
    expect(raw).toContain("Secrets invisible at every layer")
  })
})

describe("large-shrink guard", () => {
  it("refuses a delete that would shrink the file by more than half", async () => {
    // One dominant entry: deleting it drops the file from ~2 KB to ~90 bytes,
    // a >50% shrink the guard must reject (a skeleton template overwriting real content).
    const dominantEntry = "x".repeat(2000)
    const fileContent = `---
title: Big
---

# Big

## Notes (newest first)
- **2026-06-14**: ${dominantEntry}
- **2026-06-13**: small tail entry
`
    await writeFile(join(vault, "About Me/Big.md"), fileContent, "utf8")

    await expect(
      deleteMemory(
        {
          vaultPath: vault,
          file: "Big",
          section: "Notes (newest first)",
          date: "2026-06-14",
          entry: dominantEntry,
        },
        logger,
      ),
    ).rejects.toThrow("refusing memory write")

    // The guard fires before the write, so the file is left fully intact.
    expect(await readFile(join(vault, "About Me/Big.md"), "utf8")).toBe(
      fileContent,
    )
  })

  it("allows a normal single-entry delete on a real-sized file", async () => {
    await deleteMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        date: "2026-05-05",
        entry: "Least-privilege for AI agents",
      },
      logger,
    )
    const content = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )
    expect(content).not.toContain("Least-privilege for AI agents")
    expect(content).toContain("Secrets invisible at every layer")
  })

  it("skips the guard for files at or below the 200-byte floor", async () => {
    const tiny = `---
title: T
---

# T

## S (newest first)
- **2026-06-14**: hi
`
    // Sanity-check the fixture is genuinely under the guard's floor.
    expect(Buffer.byteLength(tiny, "utf8")).toBeLessThan(200)
    await writeFile(join(vault, "About Me/T.md"), tiny, "utf8")

    await deleteMemory(
      {
        vaultPath: vault,
        file: "T",
        section: "S (newest first)",
        date: "2026-06-14",
        entry: "hi",
      },
      logger,
    )
    const content = await readFile(join(vault, "About Me/T.md"), "utf8")
    expect(content).not.toContain("- **2026-06-14**: hi")
  })
})

describe("memory write size logging", () => {
  it("updateMemory logs before/after byte counts", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
    onTestFinished(() => infoSpy.mockRestore())

    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style (newest first)",
        entry: "new entry",
        date: "2026-06-14",
      },
      logger,
    )
    const written = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )

    expect(infoSpy).toHaveBeenCalledWith("updated memory", {
      file: "Principles",
      section: "Working style (newest first)",
      date: "2026-06-14",
      outcome: "appended",
      beforeBytes: Buffer.byteLength(PRINCIPLES_MD, "utf8"),
      afterBytes: Buffer.byteLength(written, "utf8"),
    })
  })

  it("deleteMemory logs before/after byte counts", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
    onTestFinished(() => infoSpy.mockRestore())

    await deleteMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
        date: "2026-05-05",
        entry: "Least-privilege for AI agents",
      },
      logger,
    )
    const written = await readFile(
      join(vault, "About Me/Principles.md"),
      "utf8",
    )

    expect(infoSpy).toHaveBeenCalledWith("deleted memory entry", {
      file: "Principles",
      section: "Decision heuristics (newest first)",
      date: "2026-05-05",
      beforeBytes: Buffer.byteLength(PRINCIPLES_MD, "utf8"),
      afterBytes: Buffer.byteLength(written, "utf8"),
    })
  })
})

describe("concurrent memory writes", () => {
  it("does not lose entries when appending to the same section concurrently", async () => {
    // Each updateMemory is a read-modify-write. Fired together they would
    // interleave (all read the same base, last write wins) and silently drop
    // entries without serialization. With the per-file lock, all five land.
    const entries = ["alpha", "bravo", "charlie", "delta", "echo"]
    await Promise.all(
      entries.map((entry) =>
        updateMemory(
          {
            vaultPath: vault,
            file: "Principles",
            section: "Working style (newest first)",
            entry,
            date: "2026-06-14",
          },
          logger,
        ),
      ),
    )

    const section = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style (newest first)",
      },
      logger,
    )
    // All five new entries plus the original survive, newest-first in the order
    // they serialized (each appends at the top), with no losses or duplicates.
    const bulletLines = section
      .split("\n")
      .filter((line) => line.startsWith("- **"))
    expect(bulletLines).toEqual([
      "- **2026-06-14**: echo",
      "- **2026-06-14**: delta",
      "- **2026-06-14**: charlie",
      "- **2026-06-14**: bravo",
      "- **2026-06-14**: alpha",
      "- **2026-05-04**: Single-purpose files",
    ])
  })

  it("persists concurrent updates to different files without interference", async () => {
    // Different files key on different lock paths, so concurrent writes to each
    // must both land intact and not corrupt one another (or deadlock).
    await Promise.all([
      updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Working style (newest first)",
          entry: "principles entry",
          date: "2026-06-14",
        },
        logger,
      ),
      updateMemory(
        {
          vaultPath: vault,
          file: "Opinions",
          section: "Code patterns (newest first)",
          entry: "opinions entry",
          date: "2026-06-14",
        },
        logger,
      ),
    ])

    const principles = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Working style (newest first)",
      },
      logger,
    )
    const opinions = await getMemory(
      {
        vaultPath: vault,
        file: "Opinions",
        section: "Code patterns (newest first)",
      },
      logger,
    )
    expect(
      principles.split("\n").filter((line) => line.startsWith("- **")),
    ).toEqual([
      "- **2026-06-14**: principles entry",
      "- **2026-05-04**: Single-purpose files",
    ])
    expect(
      opinions.split("\n").filter((line) => line.startsWith("- **")),
    ).toEqual([
      "- **2026-06-14**: opinions entry",
      "- **2026-05-07**: **.reduce() over filter/map chains.** Single reduce pass",
    ])
  })

  it("leaves a consistent file when an update and delete race on one file", async () => {
    // A concurrent add + remove on the same file must serialize so neither
    // operates on stale content: the deleted entry is gone, the added entry is
    // present, and the untouched original survives — no torn or lost lines.
    await Promise.all([
      updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Decision heuristics (newest first)",
          entry: "freshly added",
          date: "2026-06-14",
        },
        logger,
      ),
      deleteMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Decision heuristics (newest first)",
          date: "2026-05-05",
          entry: "Least-privilege for AI agents",
        },
        logger,
      ),
    ])

    const section = await getMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Decision heuristics (newest first)",
      },
      logger,
    )
    // The add applied then the delete: new entry on top, the targeted entry
    // gone, the untouched entry intact — exactly two bullets, no torn lines.
    const bulletLines = section
      .split("\n")
      .filter((line) => line.startsWith("- **"))
    expect(bulletLines).toEqual([
      "- **2026-06-14**: freshly added",
      "- **2026-05-06**: Secrets invisible at every layer",
    ])
  })
})

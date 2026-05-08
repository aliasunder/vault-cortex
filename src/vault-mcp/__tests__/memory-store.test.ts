import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { memoryStore } from "../memory-store.js"
import { logger } from "../../logger.js"

const { getMemory, updateMemory, listMemoryFiles, deleteMemory } = memoryStore

let vault: string

const PRINCIPLES_MD = `---
title: "Principles — About Me"
type: profile
tags:
  - about-me
  - principles
created: 2026-04-22T20:51:21-04:00
related:
  - "[[People/Tanisha Aberdeen|Tanisha Aberdeen]]"
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

## Empty section
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

  it("returns empty string for section with no entries", async () => {
    const result = await getMemory(
      { vaultPath: vault, file: "Principles", section: "Empty section" },
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

  it("throws when About Me directory does not exist", async () => {
    const emptyVault = await mkdtemp(join(tmpdir(), "empty-vault-"))
    await expect(getMemory({ vaultPath: emptyVault }, logger)).rejects.toThrow(
      "About Me directory not found",
    )
    await rm(emptyVault, { recursive: true })
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
    const lines = result.split("\n").filter((l) => l.startsWith("- "))
    expect(lines[lines.length - 1]).toBe("- **2026-04-01**: bottom entry")
  })

  it("inserts entry into empty section", async () => {
    await updateMemory(
      {
        vaultPath: vault,
        file: "Principles",
        section: "Empty section",
        entry: "first entry",
        date: "2026-05-08",
      },
      logger,
    )
    const result = await getMemory(
      { vaultPath: vault, file: "Principles", section: "Empty section" },
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
  })

  it("uses today's date when no date option provided", async () => {
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
    const today = new Date().toISOString().slice(0, 10)
    expect(result).toContain(`- **${today}**: today entry`)
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

  it("throws on non-existent file", async () => {
    await expect(
      updateMemory(
        { vaultPath: vault, file: "Ghost", section: "Section", entry: "entry" },
        logger,
      ),
    ).rejects.toThrow('memory file not found: "About Me/Ghost.md"')
  })

  it("throws on non-existent section", async () => {
    await expect(
      updateMemory(
        {
          vaultPath: vault,
          file: "Principles",
          section: "Nonexistent",
          entry: "entry",
        },
        logger,
      ),
    ).rejects.toThrow('section not found: "Nonexistent"')
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

  it("throws on ambiguous match", async () => {
    const dupeContent = `---
title: Dupe
---

# Dupe

## Section
- **2026-01-01**: same entry
- **2026-01-01**: same entry
`
    await writeFile(join(vault, "About Me/Dupe.md"), dupeContent, "utf8")
    await expect(
      deleteMemory(
        {
          vaultPath: vault,
          file: "Dupe",
          section: "Section",
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
    expect(raw).toContain("title: Principles — About Me")
    expect(raw).toContain("type: profile")
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
    expect(outlines[0].file).toBe("Opinions")
    expect(outlines[1].file).toBe("Principles")
  })

  it("uses frontmatter title", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    expect(outlines[0].title).toBe("Opinions — About Me")
    expect(outlines[1].title).toBe("Principles — About Me")
  })

  it("falls back to filename when no frontmatter title", async () => {
    await writeFile(
      join(vault, "About Me/NoTitle.md"),
      "---\ntype: profile\n---\n\n# NoTitle\n",
      "utf8",
    )
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const noTitle = outlines.find((o) => o.file === "NoTitle")
    expect(noTitle?.title).toBe("NoTitle")
  })

  it("includes correct entry counts per section", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find((o) => o.file === "Principles")!
    const heuristics = principles.headings.find(
      (h) => h.text === "Decision heuristics (newest first)",
    )
    expect(heuristics?.entryCount).toBe(2)

    const workingStyle = principles.headings.find(
      (h) => h.text === "Working style (newest first)",
    )
    expect(workingStyle?.entryCount).toBe(1)

    const emptySection = principles.headings.find(
      (h) => h.text === "Empty section",
    )
    expect(emptySection?.entryCount).toBe(0)
  })

  it("identifies H1 and H2 headings correctly", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find((o) => o.file === "Principles")!
    const h1s = principles.headings.filter((h) => h.level === 1)
    const h2s = principles.headings.filter((h) => h.level === 2)
    expect(h1s).toHaveLength(1)
    expect(h1s[0].text).toBe("Principles")
    expect(h2s).toHaveLength(3)
  })

  it("does not count callout lines as entries", async () => {
    const outlines = await listMemoryFiles({ vaultPath: vault }, logger)
    const principles = outlines.find((o) => o.file === "Principles")!
    const h1 = principles.headings.find((h) => h.level === 1)
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

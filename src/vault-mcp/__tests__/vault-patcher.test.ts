import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { vaultPatcher } from "../vault-patcher.js"
import { logger } from "../../logger.js"

const { patchNote, replaceInNote } = vaultPatcher

let vault: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "vault-patcher-test-"))
})

afterEach(async () => {
  await rm(vault, { recursive: true })
})

// ── Helpers ─────────────────────────────────────────────────────

const writeTestNote = async (name: string, content: string): Promise<void> => {
  const dir = join(vault, ...name.split("/").slice(0, -1))
  if (dir !== vault) await mkdir(dir, { recursive: true })
  await writeFile(join(vault, name), content, "utf8")
}

const readTestNote = async (name: string): Promise<string> =>
  readFile(join(vault, name), "utf8")

const NOTE_WITH_SECTIONS = `---
title: Test Note
tags: [test]
---

# Main Title

Intro paragraph.

## Active
- [ ] Task A
- [ ] Task B

### Subtasks
- [ ] Sub-task 1

## Up Next
- [ ] Task C

## Done
- [x] Task D
`

const NOTE_NO_FRONTMATTER = `# Title

## Section One
Content one.

## Section Two
Content two.
`

const NOTE_WITH_CODE_BLOCK = `---
title: Code Example
---

## Real Heading

Some text.

\`\`\`markdown
## Fake Heading Inside Code
This should be ignored.
\`\`\`

## Another Real Heading

More text.
`

// ── parseHeadings (tested indirectly via patchNote) ─────────────

describe("heading parsing", () => {
  it.each([
    { level: 1, heading: "H1" },
    { level: 2, heading: "H2" },
    { level: 3, heading: "H3" },
    { level: 4, heading: "H4" },
    { level: 5, heading: "H5" },
    { level: 6, heading: "H6" },
  ] as const)("appends to H$level heading", async ({ level, heading }) => {
    const content = `---
title: Levels
---

# H1
Content under H1.
## H2
Content under H2.
### H3
Content under H3.
#### H4
Content under H4.
##### H5
Content under H5.
###### H6
Content under H6.
`
    await writeTestNote(`level-${level}.md`, content)
    await patchNote(
      {
        vaultPath: vault,
        path: `level-${level}.md`,
        operation: "append",
        content: `Appended to ${heading}.`,
        heading,
        headingLevel: level,
      },
      logger,
    )
    const updated = await readTestNote(`level-${level}.md`)
    const lines = updated.split("\n")
    const existingIdx = lines.findIndex(
      (l) => l === `Content under ${heading}.`,
    )
    const appendedIdx = lines.findIndex((l) => l === `Appended to ${heading}.`)
    expect(existingIdx).toBeGreaterThan(-1)
    expect(appendedIdx).toBeGreaterThan(existingIdx)
  })

  it("ignores headings inside fenced code blocks", async () => {
    await writeTestNote("code.md", NOTE_WITH_CODE_BLOCK)
    // "Fake Heading Inside Code" should not be found
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "code.md",
          operation: "append",
          content: "new content",
          heading: "Fake Heading Inside Code",
        },
        logger,
      ),
    ).rejects.toThrow("heading not found")
  })

  it("targets real headings around code blocks", async () => {
    await writeTestNote("code.md", NOTE_WITH_CODE_BLOCK)
    await patchNote(
      {
        vaultPath: vault,
        path: "code.md",
        operation: "append",
        content: "appended text",
        heading: "Real Heading",
      },
      logger,
    )
    const updated = await readTestNote("code.md")
    const lines = updated.split("\n")
    const someTextIdx = lines.findIndex((l) => l === "Some text.")
    const appendedIdx = lines.findIndex((l) => l === "appended text")
    const anotherIdx = lines.findIndex((l) => l === "## Another Real Heading")
    expect(someTextIdx).toBeGreaterThan(-1)
    expect(appendedIdx).toBeGreaterThan(someTextIdx)
    expect(anotherIdx).toBeGreaterThan(appendedIdx)
  })

  it("strips trailing hashes from headings", async () => {
    const content = `---
title: Hashes
---

## Title With Hashes ##

Content here.
`
    await writeTestNote("hashes.md", content)
    await patchNote(
      {
        vaultPath: vault,
        path: "hashes.md",
        operation: "append",
        content: "new line",
        heading: "Title With Hashes",
      },
      logger,
    )
    const updated = await readTestNote("hashes.md")
    const lines = updated.split("\n")
    const contentIdx = lines.findIndex((l) => l === "Content here.")
    const newLineIdx = lines.findIndex((l) => l === "new line")
    expect(contentIdx).toBeGreaterThan(-1)
    expect(newLineIdx).toBeGreaterThan(contentIdx)
  })

  it("returns empty list for file with no headings", async () => {
    await writeTestNote("flat.md", "---\ntitle: Flat\n---\n\nJust text.\n")
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "flat.md",
          operation: "append",
          content: "more text",
          heading: "Nonexistent",
        },
        logger,
      ),
    ).rejects.toThrow("heading not found")
  })
})

// ── findHeading (tested indirectly via error messages) ──────────

describe("heading lookup", () => {
  it("matches case-sensitively", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "note.md",
          operation: "append",
          content: "text",
          heading: "active",
        },
        logger,
      ),
    ).rejects.toThrow("heading not found")
  })

  it("errors on heading not found with available list", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "note.md",
          operation: "append",
          content: "text",
          heading: "Missing",
        },
        logger,
      ),
    ).rejects.toThrow(/Available headings:.*Active/)
  })

  it("errors on ambiguous heading", async () => {
    const content = `---
title: Ambiguous
---

## Section
First content.

## Section
Second content.
`
    await writeTestNote("ambig.md", content)
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "ambig.md",
          operation: "append",
          content: "text",
          heading: "Section",
        },
        logger,
      ),
    ).rejects.toThrow(/ambiguous.*2 sections.*heading_level/)
  })

  it("disambiguates with heading_level", async () => {
    const content = `---
title: Levels
---

# Overview
Top-level content.

## Overview
Sub-level content.
`
    await writeTestNote("levels.md", content)
    await patchNote(
      {
        vaultPath: vault,
        path: "levels.md",
        operation: "append",
        content: "added to H2",
        heading: "Overview",
        headingLevel: 2,
      },
      logger,
    )
    const updated = await readTestNote("levels.md")
    const lines = updated.split("\n")
    const h1Idx = lines.findIndex((l) => l === "# Overview")
    const topContentIdx = lines.findIndex((l) => l === "Top-level content.")
    const h2Idx = lines.findIndex((l) => l === "## Overview")
    const subContentIdx = lines.findIndex((l) => l === "Sub-level content.")
    const addedIdx = lines.findIndex((l) => l === "added to H2")
    // added to H2 must be in the H2 section (after Sub-level content), not H1
    expect(addedIdx).toBeGreaterThan(subContentIdx)
    expect(addedIdx).toBeGreaterThan(h2Idx)
    // H1 section content must be unchanged (added text is NOT between H1 and H2)
    expect(topContentIdx).toBeGreaterThan(h1Idx)
    expect(h2Idx).toBeGreaterThan(topContentIdx)
  })

  it("errors on empty heading", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "note.md",
          operation: "append",
          content: "text",
          heading: "   ",
        },
        logger,
      ),
    ).rejects.toThrow("heading cannot be empty")
  })
})

// ── patchNote operations ────────────────────────────────────────

describe("patchNote — file-level operations", () => {
  it("appends to end of file", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "append",
        content: "## New Section\nNew content.",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toMatch(/Task D\n+## New Section\nNew content\./)
  })

  it("prepends after frontmatter", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "prepend",
        content: "> [!note] Important\n> Read this first.",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toContain("tags:\n  - test\n---\n> [!note] Important")
  })

  it("errors on replace without heading", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "note.md",
          operation: "replace",
          content: "text",
        },
        logger,
      ),
    ).rejects.toThrow('operation "replace" requires a heading target')
  })

  it("errors on insert_before without heading", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "note.md",
          operation: "insert_before",
          content: "text",
        },
        logger,
      ),
    ).rejects.toThrow('operation "insert_before" requires a heading target')
  })
})

describe("patchNote — section-level append", () => {
  it("appends to end of section body", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "append",
        content: "- [ ] Task E",
        heading: "Up Next",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    const lines = updated.split("\n")
    const upNextIdx = lines.findIndex((l) => l === "## Up Next")
    const taskCIdx = lines.findIndex((l) => l === "- [ ] Task C")
    const taskEIdx = lines.findIndex((l) => l === "- [ ] Task E")
    const doneIdx = lines.findIndex((l) => l === "## Done")
    // Task E must be after existing Up Next content, before ## Done
    expect(upNextIdx).toBeGreaterThan(-1)
    expect(taskCIdx).toBeGreaterThan(upNextIdx)
    expect(taskEIdx).toBeGreaterThan(taskCIdx)
    expect(doneIdx).toBeGreaterThan(taskEIdx)
  })

  it("appends to section with children (end of full section)", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "append",
        content: "- [ ] New task after subtasks",
        heading: "Active",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toMatch(
      /Sub-task 1\n+- \[ \] New task after subtasks\n+## Up Next/,
    )
  })

  it("appends to last section in file", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "append",
        content: "- [x] Task E",
        heading: "Done",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    const lines = updated.split("\n")
    const doneIdx = lines.findIndex((l) => l === "## Done")
    const taskDIdx = lines.findIndex((l) => l === "- [x] Task D")
    const taskEIdx = lines.findIndex((l) => l === "- [x] Task E")
    // Task E must be in the Done section, after existing Task D
    expect(taskDIdx).toBeGreaterThan(doneIdx)
    expect(taskEIdx).toBeGreaterThan(taskDIdx)
    // No heading after Task E (it's the last section)
    const headingsAfter = lines
      .slice(taskEIdx + 1)
      .filter((l) => /^#{1,6} /.test(l))
    expect(headingsAfter).toHaveLength(0)
  })
})

describe("patchNote — section-level prepend", () => {
  it("prepends right after heading line", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "prepend",
        content: "- [ ] Urgent task",
        heading: "Active",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toMatch(/## Active\n- \[ \] Urgent task\n- \[ \] Task A/)
  })
})

describe("patchNote — section-level replace", () => {
  it("replaces section body, preserving heading", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "replace",
        content: "Completely new content.\n",
        heading: "Up Next",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toContain("## Up Next\nCompletely new content.\n")
    expect(updated).not.toContain("Task C")
    expect(updated).toContain("## Done")
  })

  it("replaces section with children (all children replaced)", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "replace",
        content: "Replaced all active content.\n",
        heading: "Active",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toContain("## Active\nReplaced all active content.")
    expect(updated).not.toContain("Subtasks")
    expect(updated).not.toContain("Sub-task 1")
    expect(updated).toContain("## Up Next")
  })
})

describe("patchNote — insert_before", () => {
  it("inserts content above the heading line", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "insert_before",
        content: "## Context\nSome context here.\n",
        heading: "Done",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toMatch(
      /Task C\n+## Context\nSome context here\.\n+## Done/,
    )
  })

  it("inserts before the first heading", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: "insert_before",
        content: "# Preface\nBefore everything.\n",
        heading: "Main Title",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    const lines = updated.split("\n")
    // Frontmatter closes with ---
    const fmCloseIdx = lines.indexOf("---", 1)
    const prefaceIdx = lines.findIndex((l) => l === "# Preface")
    const mainIdx = lines.findIndex((l) => l === "# Main Title")
    // Preface must be after frontmatter fence, before original heading
    expect(prefaceIdx).toBeGreaterThan(fmCloseIdx)
    expect(mainIdx).toBeGreaterThan(prefaceIdx)
    // Original content still intact after Main Title
    expect(updated).toContain("Intro paragraph.")
  })
})

// ── Frontmatter preservation ────────────────────────────────────

describe("frontmatter preservation", () => {
  const operations = ["append", "prepend", "replace", "insert_before"] as const

  it.each(
    operations.map((op) => ({
      name: op,
      op,
      heading: op === "append" || op === "prepend" ? undefined : "Active",
    })),
  )(
    "$name preserves frontmatter and modifies body",
    async ({ op, heading }) => {
      await writeTestNote("note.md", NOTE_WITH_SECTIONS)
      await patchNote(
        {
          vaultPath: vault,
          path: "note.md",
          operation: op,
          content: `marker-${op}`,
          heading,
        },
        logger,
      )
      const updated = await readTestNote("note.md")
      // Frontmatter preserved
      expect(updated).toContain("title: Test Note")
      expect(updated).toContain("tags:")
      expect(updated).toContain("- test")
      // Body was actually modified
      expect(updated).toContain(`marker-${op}`)
      // Frontmatter is still at the top (starts with ---)
      expect(updated.startsWith("---\n")).toBe(true)
    },
  )

  it("handles file with no frontmatter", async () => {
    await writeTestNote("no-fm.md", NOTE_NO_FRONTMATTER)
    await patchNote(
      {
        vaultPath: vault,
        path: "no-fm.md",
        operation: "append",
        content: "Appended text.",
        heading: "Section One",
      },
      logger,
    )
    const updated = await readTestNote("no-fm.md")
    const lines = updated.split("\n")
    const sectionOneIdx = lines.findIndex((l) => l === "## Section One")
    const contentIdx = lines.findIndex((l) => l === "Content one.")
    const appendIdx = lines.findIndex((l) => l === "Appended text.")
    const sectionTwoIdx = lines.findIndex((l) => l === "## Section Two")
    // Appended text must be within Section One (after content, before Section Two)
    expect(contentIdx).toBeGreaterThan(sectionOneIdx)
    expect(appendIdx).toBeGreaterThan(contentIdx)
    expect(sectionTwoIdx).toBeGreaterThan(appendIdx)
    // Section Two content untouched
    expect(updated).toContain("Content two.")
  })

  it("preserves complex frontmatter (nested objects, arrays)", async () => {
    const content = `---
title: Complex
tags: [a, b, c]
nested:
  key: value
  list:
    - one
    - two
number: 42
---

## Section
Body text.
`
    await writeTestNote("complex.md", content)
    await patchNote(
      {
        vaultPath: vault,
        path: "complex.md",
        operation: "replace",
        content: "New body.",
        heading: "Section",
      },
      logger,
    )
    const updated = await readTestNote("complex.md")
    expect(updated).toContain("title: Complex")
    expect(updated).toContain("number: 42")
    expect(updated).toContain("key: value")
    // Verify list-type frontmatter values preserved
    expect(updated).toContain("- a")
    expect(updated).toContain("- b")
    expect(updated).toContain("- c")
    expect(updated).toContain("- one")
    expect(updated).toContain("- two")
    // Verify body was replaced
    expect(updated).toContain("New body.")
    expect(updated).not.toContain("Body text.")
  })
})

// ── Error cases ─────────────────────────────────────────────────

describe("patchNote errors", () => {
  it("errors on file not found", async () => {
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "missing.md",
          operation: "append",
          content: "text",
        },
        logger,
      ),
    ).rejects.toThrow('note not found: "missing.md"')
  })

  it("errors on path traversal", async () => {
    await expect(
      patchNote(
        {
          vaultPath: vault,
          path: "../escape.md",
          operation: "append",
          content: "text",
        },
        logger,
      ),
    ).rejects.toThrow("path traversal blocked")
  })
})

// ── Edge cases ──────────────────────────────────────────────────

describe("patchNote edge cases", () => {
  it("handles empty section body", async () => {
    const content = `---
title: Empty
---

## Empty Section

## Next Section
Content.
`
    await writeTestNote("empty.md", content)
    await patchNote(
      {
        vaultPath: vault,
        path: "empty.md",
        operation: "append",
        content: "Now has content.",
        heading: "Empty Section",
      },
      logger,
    )
    const updated = await readTestNote("empty.md")
    expect(updated).toMatch(/## Empty Section\n+Now has content\.\n+## Next/)
  })

  it("handles note with only frontmatter", async () => {
    await writeTestNote("only-fm.md", "---\ntitle: Empty\n---\n")
    await patchNote(
      {
        vaultPath: vault,
        path: "only-fm.md",
        operation: "append",
        content: "## First Section\nContent.",
      },
      logger,
    )
    const updated = await readTestNote("only-fm.md")
    // Frontmatter preserved
    expect(updated).toContain("title: Empty")
    expect(updated.startsWith("---\n")).toBe(true)
    // Content was appended
    expect(updated).toContain("## First Section")
    expect(updated).toContain("Content.")
  })

  it("handles heading at very end of file with no body", async () => {
    const content = `---
title: Trailing
---

## Has Content
Some text.

## Trailing Heading
`
    await writeTestNote("trailing.md", content)
    await patchNote(
      {
        vaultPath: vault,
        path: "trailing.md",
        operation: "append",
        content: "Added to trailing.",
        heading: "Trailing Heading",
      },
      logger,
    )
    const updated = await readTestNote("trailing.md")
    const lines = updated.split("\n")
    const hasContentIdx = lines.findIndex((l) => l === "## Has Content")
    const someTextIdx = lines.findIndex((l) => l === "Some text.")
    const headingIdx = lines.findIndex((l) => l === "## Trailing Heading")
    const addedIdx = lines.findIndex((l) => l === "Added to trailing.")
    // Previous section intact
    expect(someTextIdx).toBeGreaterThan(hasContentIdx)
    expect(headingIdx).toBeGreaterThan(someTextIdx)
    // Added content is after the trailing heading
    expect(addedIdx).toBeGreaterThan(headingIdx)
    // No heading after the added content
    const headingsAfter = lines
      .slice(addedIdx + 1)
      .filter((l) => /^#{1,6} /.test(l))
    expect(headingsAfter).toHaveLength(0)
  })

  it("handles file in subdirectory", async () => {
    const content = `---
title: Nested
---

## Section
Body.
`
    await writeTestNote("sub/dir/nested.md", content)
    await patchNote(
      {
        vaultPath: vault,
        path: "sub/dir/nested.md",
        operation: "append",
        content: "More body.",
        heading: "Section",
      },
      logger,
    )
    const updated = await readTestNote("sub/dir/nested.md")
    const lines = updated.split("\n")
    const bodyIdx = lines.findIndex((l) => l === "Body.")
    const moreIdx = lines.findIndex((l) => l === "More body.")
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(moreIdx).toBeGreaterThan(bodyIdx)
    expect(updated).toContain("title: Nested")
  })
})

// ── replaceInNote ───────────────────────────────────────────────

describe("replaceInNote", () => {
  it("replaces first occurrence by default", async () => {
    const content = `---
title: Replace Test
---

The word apple appears here.
And apple appears here too.
`
    await writeTestNote("replace.md", content)
    const result = await replaceInNote(
      {
        vaultPath: vault,
        path: "replace.md",
        oldText: "apple",
        newText: "orange",
      },
      logger,
    )
    expect(result).toBe("Replaced 1 occurrence in replace.md")
    const updated = await readTestNote("replace.md")
    expect(updated).toContain("The word orange appears here.")
    expect(updated).toContain("And apple appears here too.")
  })

  it("replaces all occurrences when flag is set", async () => {
    const content = `---
title: Replace All
---

apple and apple and apple.
`
    await writeTestNote("replace-all.md", content)
    const result = await replaceInNote(
      {
        vaultPath: vault,
        path: "replace-all.md",
        oldText: "apple",
        newText: "orange",
        replaceAllOccurrences: true,
      },
      logger,
    )
    expect(result).toBe("Replaced 3 occurrences in replace-all.md")
    const updated = await readTestNote("replace-all.md")
    expect(updated).toContain("orange and orange and orange.")
    expect(updated).not.toContain("apple")
  })

  it("errors when old_text not found", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await expect(
      replaceInNote(
        {
          vaultPath: vault,
          path: "note.md",
          oldText: "nonexistent text",
          newText: "replacement",
        },
        logger,
      ),
    ).rejects.toThrow('text not found in "note.md"')
  })

  it("handles multi-line old_text", async () => {
    const content = `---
title: Multiline
---

Line one.
Line two.
Line three.
`
    await writeTestNote("multi.md", content)
    await replaceInNote(
      {
        vaultPath: vault,
        path: "multi.md",
        oldText: "Line one.\nLine two.",
        newText: "Replaced block.",
      },
      logger,
    )
    const updated = await readTestNote("multi.md")
    expect(updated).toContain("Replaced block.\nLine three.")
    expect(updated).not.toContain("Line one.")
  })

  it("replaces with empty string (deletion)", async () => {
    const content = `---
title: Delete
---

Keep this. Remove this. Keep this too.
`
    await writeTestNote("delete.md", content)
    await replaceInNote(
      {
        vaultPath: vault,
        path: "delete.md",
        oldText: "Remove this. ",
        newText: "",
      },
      logger,
    )
    const updated = await readTestNote("delete.md")
    expect(updated).toContain("Keep this. Keep this too.")
  })

  it("preserves frontmatter during replacement", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await replaceInNote(
      {
        vaultPath: vault,
        path: "note.md",
        oldText: "Task A",
        newText: "Task Alpha",
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toContain("title: Test Note")
    expect(updated).toContain("tags:")
    expect(updated).toContain("Task Alpha")
  })

  it("is case-sensitive", async () => {
    const content = `---
title: Case
---

Hello World.
`
    await writeTestNote("case.md", content)
    await expect(
      replaceInNote(
        {
          vaultPath: vault,
          path: "case.md",
          oldText: "hello world",
          newText: "replaced",
        },
        logger,
      ),
    ).rejects.toThrow("text not found")
  })

  it("errors on file not found", async () => {
    await expect(
      replaceInNote(
        {
          vaultPath: vault,
          path: "missing.md",
          oldText: "text",
          newText: "new",
        },
        logger,
      ),
    ).rejects.toThrow('note not found: "missing.md"')
  })

  it("errors on path traversal", async () => {
    await expect(
      replaceInNote(
        {
          vaultPath: vault,
          path: "../escape.md",
          oldText: "text",
          newText: "new",
        },
        logger,
      ),
    ).rejects.toThrow("path traversal blocked")
  })

  it("truncates long old_text in error message", async () => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    const longText = "x".repeat(100)
    await expect(
      replaceInNote(
        {
          vaultPath: vault,
          path: "note.md",
          oldText: longText,
          newText: "new",
        },
        logger,
      ),
    ).rejects.toThrow(/x{80}…/)
  })
})

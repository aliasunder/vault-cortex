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
  it("handles all 6 heading levels", async () => {
    const content = `---
title: Levels
---

# H1
## H2
### H3
#### H4
##### H5
###### H6
`
    await writeTestNote("levels.md", content)
    // Verify we can target each level
    for (const [level, text] of [
      [1, "H1"],
      [2, "H2"],
      [3, "H3"],
      [4, "H4"],
      [5, "H5"],
      [6, "H6"],
    ] as const) {
      const result = await patchNote(
        {
          vaultPath: vault,
          path: "levels.md",
          operation: "append",
          content: `Level ${level} content`,
          heading: text,
          headingLevel: level,
        },
        logger,
      )
      expect(result).toContain(`Applied append`)
    }
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
    const result = await patchNote(
      {
        vaultPath: vault,
        path: "code.md",
        operation: "append",
        content: "appended text",
        heading: "Real Heading",
      },
      logger,
    )
    expect(result).toContain("Applied append")
    const updated = await readTestNote("code.md")
    expect(updated).toContain("appended text")
  })

  it("strips trailing hashes from headings", async () => {
    const content = `---
title: Hashes
---

## Title With Hashes ##

Content here.
`
    await writeTestNote("hashes.md", content)
    const result = await patchNote(
      {
        vaultPath: vault,
        path: "hashes.md",
        operation: "append",
        content: "new line",
        heading: "Title With Hashes",
      },
      logger,
    )
    expect(result).toContain("Applied append")
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
    const result = await patchNote(
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
    expect(result).toContain("Applied append")
    const updated = await readTestNote("levels.md")
    expect(updated).toContain("Sub-level content.")
    expect(updated).toContain("added to H2")
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
    const taskEIdx = lines.findIndex((l) => l === "- [ ] Task E")
    const doneIdx = lines.findIndex((l) => l === "## Done")
    expect(taskEIdx).toBeGreaterThan(-1)
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
    const taskDIdx = lines.findIndex((l) => l === "- [x] Task D")
    const taskEIdx = lines.findIndex((l) => l === "- [x] Task E")
    expect(taskDIdx).toBeGreaterThan(-1)
    expect(taskEIdx).toBeGreaterThan(taskDIdx)
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
    const prefaceIdx = lines.findIndex((l) => l === "# Preface")
    const mainIdx = lines.findIndex((l) => l === "# Main Title")
    expect(prefaceIdx).toBeGreaterThan(-1)
    expect(mainIdx).toBeGreaterThan(prefaceIdx)
    expect(updated).toContain("Before everything.")
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
  )("$name preserves frontmatter", async ({ op, heading }) => {
    await writeTestNote("note.md", NOTE_WITH_SECTIONS)
    await patchNote(
      {
        vaultPath: vault,
        path: "note.md",
        operation: op,
        content: "new content",
        heading,
      },
      logger,
    )
    const updated = await readTestNote("note.md")
    expect(updated).toContain("title: Test Note")
    expect(updated).toContain("tags:")
    expect(updated).toContain("- test")
  })

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
    expect(updated).toContain("Content one.")
    expect(updated).toContain("Appended text.")
    const lines = updated.split("\n")
    const contentIdx = lines.findIndex((l) => l === "Content one.")
    const appendIdx = lines.findIndex((l) => l === "Appended text.")
    expect(appendIdx).toBeGreaterThan(contentIdx)
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
    expect(updated).toContain("New body.")
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
    expect(updated).toContain("## First Section\nContent.")
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
    const headingIdx = lines.findIndex((l) => l === "## Trailing Heading")
    const addedIdx = lines.findIndex((l) => l === "Added to trailing.")
    expect(headingIdx).toBeGreaterThan(-1)
    expect(addedIdx).toBeGreaterThan(headingIdx)
  })

  it("handles file in subdirectory", async () => {
    const content = `---
title: Nested
---

## Section
Body.
`
    await writeTestNote("sub/dir/nested.md", content)
    const result = await patchNote(
      {
        vaultPath: vault,
        path: "sub/dir/nested.md",
        operation: "append",
        content: "More body.",
        heading: "Section",
      },
      logger,
    )
    expect(result).toContain("sub/dir/nested.md")
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

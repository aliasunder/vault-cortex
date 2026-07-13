import { describe, it, expect, vi, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
vi.mock("sqlite-vec", { spy: true })
import { createSearchIndex } from "../search-index.js"
import { logger } from "../../../logger.js"

/** Read-only inspection connection — needs the vec extension loaded so the
 *  memory_entry_vectors virtual table is queryable from outside the factory. */
const openInspectConnection = (dbPath: string): Database.Database => {
  const inspect = new Database(dbPath, { readonly: true })
  sqliteVec.load(inspect)
  return inspect
}

const DIMENSIONS = 384

/** Creates a mock embedder that returns deterministic embeddings. */
const createMockEmbedder = () => ({
  embedText: vi.fn().mockResolvedValue(new Float32Array(DIMENSIONS).fill(0.1)),
  embedBatch: vi
    .fn()
    .mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => new Float32Array(DIMENSIONS).fill(0.1))),
    ),
})

/** Builds a fileStat object for upsertNote. Defaults to size 100. */
const testStat = (
  mtimeMs: number,
  size = 100,
): { mtimeMs: number; size: number } => ({ mtimeMs, size })

/** Total entry texts sent to the embedder across all embedBatch calls —
 *  the observable that proves how many entries were actually (re-)embedded. */
const totalTextsEmbedded = (
  embedder: ReturnType<typeof createMockEmbedder>,
): number =>
  embedder.embedBatch.mock.calls.reduce(
    (sum: number, call: unknown[]) => sum + (call[0] as string[]).length,
    0,
  )

/** File-backed index plus a second read-only connection for asserting raw
 *  table state — :memory: databases can't be inspected from outside the
 *  factory closure (same approach as the warm-DB migration tests). */
const createInspectableMemoryIndex = async (options?: {
  withEmbedder?: boolean
}) => {
  const dir = await mkdtemp(join(tmpdir(), "memory-index-"))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, "index.db")
  const embedder =
    (options?.withEmbedder ?? true) ? createMockEmbedder() : undefined
  const index = createSearchIndex(dbPath, embedder, undefined, {
    memoryDir: "About Me",
  })
  const inspect = openInspectConnection(dbPath)
  onTestFinished(() => {
    inspect.close()
  })
  return { index, embedder, inspect, dir }
}

type EntryRow = {
  file: string
  section: string
  entry_date: string
  entry_text: string
  entry_index: number
}

const selectEntryRows = (inspect: Database.Database): EntryRow[] =>
  inspect
    .prepare<[], EntryRow>(
      `SELECT file, section, entry_date, entry_text, entry_index
       FROM memory_entries ORDER BY file, entry_index`,
    )
    .all()

const countVectors = (inspect: Database.Database): number => {
  const row = inspect
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM memory_entry_vectors`,
    )
    .get()
  if (row === undefined) throw new Error("count query returned no row")
  return row.n
}

const OPINIONS_V1 = `---
title: Opinions
---

# Opinions

## Code patterns (newest first)

- **2026-07-02**: Wrap function bodies in braces.
- **2026-05-07**: Immutable over mutable.

## Process (newest first)

- **2026-06-25**: Sequential over parallel review.
`

describe("memory entry indexing", () => {
  it("indexes a memory file's dated entries as exact rows", async () => {
    const { index, inspect } = await createInspectableMemoryIndex()
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(selectEntryRows(inspect)).toEqual([
      {
        file: "Opinions",
        section: "Code patterns (newest first)",
        entry_date: "2026-07-02",
        entry_text: "- **2026-07-02**: Wrap function bodies in braces.",
        entry_index: 0,
      },
      {
        file: "Opinions",
        section: "Code patterns (newest first)",
        entry_date: "2026-05-07",
        entry_text: "- **2026-05-07**: Immutable over mutable.",
        entry_index: 1,
      },
      {
        file: "Opinions",
        section: "Process (newest first)",
        entry_date: "2026-06-25",
        entry_text: "- **2026-06-25**: Sequential over parallel review.",
        entry_index: 2,
      },
    ])
  })

  it("does not index entries for a note outside the memory dir", async () => {
    const { index, inspect } = await createInspectableMemoryIndex()
    index.upsertNote(
      {
        filePath: "Projects/journal.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    // The note itself was indexed (the trigger ran) — only the entry
    // extraction is memory-dir-scoped.
    const noteResults = index.fullTextSearch(
      { query: "immutable", filters: {} },
      logger,
    )
    expect(noteResults.map((result) => result.path)).toEqual([
      "Projects/journal.md",
    ])
    expect(selectEntryRows(inspect)).toEqual([])
  })

  it("does not index entries for a note nested below the memory dir", async () => {
    const { index, inspect } = await createInspectableMemoryIndex()
    index.upsertNote(
      {
        filePath: "About Me/archive/Old.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(selectEntryRows(inspect)).toEqual([])
  })

  it("embeds each entry once with the file-and-section-prefixed text", async () => {
    const { index, embedder } = await createInspectableMemoryIndex()
    if (embedder === undefined) throw new Error("embedder required")
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Opinions.md", rawContent: OPINIONS_V1 },
      logger,
    )
    const embeddedEntryTexts = embedder.embedBatch.mock.calls.flatMap(
      (call: unknown[]) => call[0] as string[],
    )
    expect(embeddedEntryTexts).toEqual([
      "Opinions > Code patterns (newest first)\n- **2026-07-02**: Wrap function bodies in braces.",
      "Opinions > Code patterns (newest first)\n- **2026-05-07**: Immutable over mutable.",
      "Opinions > Process (newest first)\n- **2026-06-25**: Sequential over parallel review.",
    ])
  })

  it("re-embeds exactly one entry when a new entry is appended at the top of a section", async () => {
    const { index, embedder, inspect } = await createInspectableMemoryIndex()
    if (embedder === undefined) throw new Error("embedder required")
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Opinions.md", rawContent: OPINIONS_V1 },
      logger,
    )
    embedder.embedBatch.mockClear()

    // Top-insert (the memory append default) shifts every later entry's
    // index — hash-identity reconciliation must still see them as unchanged.
    const withTopAppend = OPINIONS_V1.replace(
      "- **2026-07-02**: Wrap function bodies in braces.",
      "- **2026-07-11**: Newest opinion lands on top.\n- **2026-07-02**: Wrap function bodies in braces.",
    )
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: withTopAppend,
        fileStat: testStat(2000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Opinions.md", rawContent: withTopAppend },
      logger,
    )

    expect(totalTextsEmbedded(embedder)).toBe(1)
    expect(
      embedder.embedBatch.mock.calls.flatMap(
        (call: unknown[]) => call[0] as string[],
      ),
    ).toEqual([
      "Opinions > Code patterns (newest first)\n- **2026-07-11**: Newest opinion lands on top.",
    ])
    // The shifted entries kept their rows; indices were refreshed in place.
    expect(selectEntryRows(inspect).map((row) => row.entry_index)).toEqual([
      0, 1, 2, 3,
    ])
    expect(countVectors(inspect)).toBe(4)
  })

  it("re-embeds only an edited entry and replaces its vector", async () => {
    const { index, embedder, inspect } = await createInspectableMemoryIndex()
    if (embedder === undefined) throw new Error("embedder required")
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Opinions.md", rawContent: OPINIONS_V1 },
      logger,
    )
    embedder.embedBatch.mockClear()

    const withEdit = OPINIONS_V1.replace(
      "- **2026-05-07**: Immutable over mutable.",
      "- **2026-05-07**: Immutable over mutable, always.",
    )
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: withEdit,
        fileStat: testStat(2000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Opinions.md", rawContent: withEdit },
      logger,
    )

    expect(totalTextsEmbedded(embedder)).toBe(1)
    // Still 3 rows and 3 vectors — the old row and its vector are gone, not
    // orphaned beside the new ones.
    expect(selectEntryRows(inspect)).toHaveLength(3)
    expect(countVectors(inspect)).toBe(3)
    const editedRow = selectEntryRows(inspect).find(
      (row) => row.entry_date === "2026-05-07",
    )
    expect(editedRow?.entry_text).toBe(
      "- **2026-05-07**: Immutable over mutable, always.",
    )
  })

  it("deletes the row and vector of a pruned entry so recall storage no longer holds it", async () => {
    // The living-file case from the entry-policy convention: an entry pruned
    // from a current-state memory file must vanish from the entry index.
    const { index, embedder, inspect } = await createInspectableMemoryIndex()
    if (embedder === undefined) throw new Error("embedder required")
    index.upsertNote(
      {
        filePath: "About Me/Routines.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Routines.md", rawContent: OPINIONS_V1 },
      logger,
    )
    // The prune target was present before (the trigger state is real).
    expect(
      selectEntryRows(inspect).some((row) => row.entry_date === "2026-05-07"),
    ).toBe(true)
    expect(countVectors(inspect)).toBe(3)

    const withPrune = OPINIONS_V1.replace(
      "- **2026-05-07**: Immutable over mutable.\n",
      "",
    )
    index.upsertNote(
      {
        filePath: "About Me/Routines.md",
        rawContent: withPrune,
        fileStat: testStat(2000),
      },
      logger,
    )
    const remainingRows = selectEntryRows(inspect)
    expect(remainingRows).toHaveLength(2)
    expect(remainingRows.some((row) => row.entry_date === "2026-05-07")).toBe(
      false,
    )
    expect(countVectors(inspect)).toBe(2)
  })

  it("removeNote clears the file's entry rows, FTS rows, and vectors", async () => {
    const { index, inspect } = await createInspectableMemoryIndex()
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Opinions.md", rawContent: OPINIONS_V1 },
      logger,
    )
    expect(selectEntryRows(inspect)).toHaveLength(3)

    index.removeNote("About Me/Opinions.md")
    expect(selectEntryRows(inspect)).toEqual([])
    expect(countVectors(inspect)).toBe(0)
    const ftsCount = inspect
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM memory_entries_fts`,
      )
      .get()
    expect(ftsCount?.n).toBe(0)
  })

  it("treats a rename as delete plus create, re-embedding under the new file name", async () => {
    const { index, embedder, inspect } = await createInspectableMemoryIndex()
    if (embedder === undefined) throw new Error("embedder required")
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Opinions.md", rawContent: OPINIONS_V1 },
      logger,
    )
    embedder.embedBatch.mockClear()

    // The watcher delivers a rename as unlink + add.
    index.removeNote("About Me/Opinions.md")
    index.upsertNote(
      {
        filePath: "About Me/Beliefs.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(2000),
      },
      logger,
    )
    await index.embedNote(
      { notePath: "About Me/Beliefs.md", rawContent: OPINIONS_V1 },
      logger,
    )

    const rows = selectEntryRows(inspect)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.file === "Beliefs")).toBe(true)
    // One-time full re-embed under the new name — the documented rename cost.
    expect(totalTextsEmbedded(embedder)).toBe(3)
  })

  it("maintains entry rows and FTS without an embedder, creating no vector table", async () => {
    const { index, inspect } = await createInspectableMemoryIndex({
      withEmbedder: false,
    })
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(selectEntryRows(inspect)).toHaveLength(3)
    const vectorTable = inspect
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE name = 'memory_entry_vectors'`,
      )
      .get()
    expect(vectorTable).toBeUndefined()
  })

  it("creates no memory tables when no memoryDir is configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-index-"))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const dbPath = join(dir, "index.db")
    const index = createSearchIndex(dbPath)
    index.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: OPINIONS_V1,
        fileStat: testStat(1000),
      },
      logger,
    )
    const inspect = new Database(dbPath, { readonly: true })
    onTestFinished(() => {
      inspect.close()
    })
    const memoryTables = inspect
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE name LIKE 'memory_entries%' AND type IN ('table', 'view')`,
      )
      .all()
    expect(memoryTables).toEqual([])
  })
})

describe("memory entry rebuild reconciliation", () => {
  const AGENTS_MD = `---
title: Agents
---

# Agents

## Communication (newest first)

- **2026-07-09**: Answer every question explicitly.
`

  /** A vault on disk with two memory files, indexed via rebuildFromVault. */
  const createRebuiltVault = async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-rebuild-"))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const memoryDirPath = join(dir, "About Me")
    await mkdir(memoryDirPath, { recursive: true })
    await writeFile(join(memoryDirPath, "Opinions.md"), OPINIONS_V1)
    await writeFile(join(memoryDirPath, "Agents.md"), AGENTS_MD)
    const dbPath = join(dir, "index.db")
    const embedder = createMockEmbedder()
    const index = createSearchIndex(dbPath, embedder, undefined, {
      memoryDir: "About Me",
    })
    const inspect = openInspectConnection(dbPath)
    onTestFinished(() => {
      inspect.close()
    })
    return { dir, memoryDirPath, index, embedder, inspect }
  }

  it("indexes and embeds entries from every memory file during rebuild", async () => {
    const { dir, index, inspect } = await createRebuiltVault()
    const { embedding } = await index.rebuildFromVault(
      { vaultPath: dir },
      logger,
    )
    await embedding
    const rows = selectEntryRows(inspect)
    expect(rows.map((row) => [row.file, row.entry_date])).toEqual([
      ["Agents", "2026-07-09"],
      ["Opinions", "2026-07-02"],
      ["Opinions", "2026-05-07"],
      ["Opinions", "2026-06-25"],
    ])
    expect(countVectors(inspect)).toBe(4)
  })

  it("removes entries for a memory file deleted while the server was down", async () => {
    const { dir, memoryDirPath, index, inspect } = await createRebuiltVault()
    const firstBuild = await index.rebuildFromVault({ vaultPath: dir }, logger)
    await firstBuild.embedding
    // The deleted file's entries were present after the first rebuild —
    // the cleanup below has something real to remove.
    expect(selectEntryRows(inspect).some((row) => row.file === "Agents")).toBe(
      true,
    )

    await unlink(join(memoryDirPath, "Agents.md"))
    const secondBuild = await index.rebuildFromVault({ vaultPath: dir }, logger)
    await secondBuild.embedding

    const rows = selectEntryRows(inspect)
    expect(rows.some((row) => row.file === "Agents")).toBe(false)
    expect(rows).toHaveLength(3)
    expect(countVectors(inspect)).toBe(3)
  })

  it("embeds zero entries on a second rebuild with unchanged files", async () => {
    const { dir, index, embedder } = await createRebuiltVault()
    const firstBuild = await index.rebuildFromVault({ vaultPath: dir }, logger)
    await firstBuild.embedding
    embedder.embedBatch.mockClear()

    const secondBuild = await index.rebuildFromVault({ vaultPath: dir }, logger)
    await secondBuild.embedding
    expect(totalTextsEmbedded(embedder)).toBe(0)
  })
})

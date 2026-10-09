import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setImmediate as setImmediateAsync } from "node:timers/promises"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import * as sqliteVec from "sqlite-vec"
vi.mock("sqlite-vec", { spy: true })
import { createSearchIndex, INDEXABLE_TEXT_EXTENSIONS } from "../search-index.js"
import type { NoteMetadata, OutgoingLinkEntry, SearchIndex, TaskEntry } from "../search-index.js"
import type { StatusClassification } from "../../obsidian-markdown/tasks.js"
import { logger } from "../../../logger.js"
import { statOrNull } from "../../../utils/fs.js"
import { extractPdfText } from "../../obsidian-markdown/pdf.js"

vi.mock("node:fs/promises", { spy: true })
vi.mock("../../../utils/fs.js", { spy: true })
vi.mock("../../obsidian-markdown/pdf.js", { spy: true })

const realSqliteVec = await vi.importActual<typeof sqliteVec>("sqlite-vec")

let index: SearchIndex

beforeEach(() => {
  index = createSearchIndex(":memory:")
})

const NOTE_WITH_FRONTMATTER = `---
title: Principles
type: about-me
tags: [principles, self]
related: [Routines, Career]
created: 2025-08-12T09:00:00-07:00
---

# Principles

## Decision heuristics

- Prefer reversible decisions when context is thin
- Avoid burnout by setting boundaries early
`

const NOTE_MINIMAL = `# Just a note

Some content without frontmatter.
`

const NOTE_WITH_CALLOUT = `---
title: Me
---

# Me

> [!info] Scope of this file
> **Contains:** identity facts.
> **Convention:** append newest first.

## Identity

- a fact about burnout boundaries
`

/** Narrows a row from a `SELECT COUNT(*) as count` query without a type assertion. */
const countRow = (row: unknown): { count: number } => {
  if (typeof row === "object" && row !== null && "count" in row && typeof row.count === "number") {
    return { count: row.count }
  }
  throw new Error("expected a count row")
}

const seedEmbeddingSource = (
  searchIndex: SearchIndex,
  params: { notePath: string; rawContent: string },
): symbol => {
  return searchIndex.upsertNote(
    {
      filePath: params.notePath,
      rawContent: params.rawContent,
      fileStat: { mtimeMs: 1000, size: Buffer.byteLength(params.rawContent) },
    },
    logger,
  )
}

const createEmbeddingRaceIndex = async (sourceKind: "note" | "file") => {
  const dir = await mkdtemp(join(tmpdir(), "embedding-race-"))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const embedder = {
    embedText: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) => {
      return Promise.resolve(texts.map(() => new Float32Array(384).fill(0.1)))
    }),
  }
  const dbPath = join(dir, "index.db")
  const searchIndex = createSearchIndex(dbPath, embedder, undefined, { fileToolsEnabled: true })
  const inspect = new Database(dbPath)
  sqliteVec.load(inspect)
  onTestFinished(() => {
    inspect.close()
  })
  const path = sourceKind === "note" ? "reuse.md" : "reuse.txt"
  const chunkTable = sourceKind === "note" ? "note_chunks" : "file_content_chunks"
  const vectorTable = sourceKind === "note" ? "note_vectors" : "file_content_vectors"
  const sourceTable = sourceKind === "note" ? "notes" : "file_content"
  const upsert = (content: string): symbol => {
    const params = { filePath: path, rawContent: content, fileStat: testStat(1000) }

    return sourceKind === "note"
      ? searchIndex.upsertNote(params, logger)
      : searchIndex.upsertFileContent(params, logger)
  }
  const embed = (content: string, sourceVersion: symbol): Promise<void> => {
    return sourceKind === "note"
      ? searchIndex.embedNote({ notePath: path, rawContent: content, sourceVersion }, logger)
      : searchIndex.embedFileContent({ filePath: path, sourceVersion }, logger)
  }
  const remove = (): void => {
    if (sourceKind === "note") {
      searchIndex.removeNote(path)
      return
    }
    searchIndex.removeFileContent({ filePath: path }, logger)
  }
  const chunks = (): Array<{ chunk_index: number; chunk_text: string }> => {
    return inspect
      .prepare<[], { chunk_index: number; chunk_text: string }>(
        `SELECT chunk_index, chunk_text FROM ${chunkTable} ORDER BY chunk_index`,
      )
      .all()
  }
  const vectorCount = (): number => {
    return countRow(inspect.prepare(`SELECT COUNT(*) AS count FROM ${vectorTable}`).get()).count
  }
  return {
    searchIndex,
    embedder,
    inspect,
    dir,
    path,
    sourceTable,
    upsert,
    embed,
    remove,
    chunks,
    vectorCount,
  }
}

/** Builds a fileStat object for upsertNote. Defaults to size 100. */
const testStat = (mtimeMs: number, size = 100): { mtimeMs: number; size: number } => ({
  mtimeMs,
  size,
})

/** The factory keeps its connection private; capture it only during construction for test cleanup. */
const createPropertyTestIndex = (): SearchIndex => {
  const loadSpy = vi.spyOn(sqliteVec, "load").mockImplementation((database) => {
    if (!(database instanceof Database)) throw new Error("expected a SQLite database")

    onTestFinished(() => {
      database.close()
    })
    realSqliteVec.load(database)
  })

  try {
    return createSearchIndex(":memory:")
  } finally {
    loadSpy.mockRestore()
  }
}

const seedPropertyNotes = (
  propertyIndex: SearchIndex,
  notes: ReadonlyArray<{ filePath: string; frontmatter: string }>,
): void => {
  for (const note of notes) {
    propertyIndex.upsertNote(
      {
        filePath: note.filePath,
        rawContent: `---\n${note.frontmatter}\n---\nsearchable body\n`,
        fileStat: testStat(1000),
      },
      logger,
    )
  }
}

/** Expected NoteMetadata.modified for a testStat mtime — same epoch-ms → ISO
 *  conversion the index performs, computed independently in the test's zone. */
const isoFromMillis = (mtimeMs: number): string => {
  const iso = DateTime.fromMillis(mtimeMs).toISO()

  if (iso === null) throw new Error(`invalid test mtime: ${mtimeMs}`)
  return iso
}

/** Poisons one factory-prepared statement, identified by an SQL fragment: a
 *  prototype-level prepare spy patches the matching statement's .run to throw
 *  while armed. Must be installed BEFORE createSearchIndex — every write
 *  statement is prepared at factory scope — and stays disarmed so factory
 *  setup and seeding writes succeed until a test arms it. */
const installStatementPoison = (sqlFragment: string) => {
  const message = `injected failure on: ${sqlFragment}`
  // prepare's generic conditional return type doesn't resolve through .call,
  // so a concrete function type pins the default instantiation explicitly.
  const realPrepare: (this: Database.Database, source: string) => Database.Statement =
    Database.prototype.prepare
  // The patched .run closes over this mutable flag so tests can trigger the
  // failure long after the statement was prepared.
  const poisonState = { armed: false }
  const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
    this: Database.Database,
    source: string,
  ) {
    const statement = realPrepare.call(this, source)

    if (source.includes(sqlFragment)) {
      const realRun = statement.run.bind(statement)
      statement.run = (...runParams: unknown[]) => {
        if (poisonState.armed) throw new Error(message)
        return realRun(...runParams)
      }
    }
    return statement
  })
  onTestFinished(() => prepareSpy.mockRestore())
  return {
    message,
    arm: () => {
      poisonState.armed = true
    },
    disarm: () => {
      poisonState.armed = false
    },
  }
}

/** Version A of the atomicity-test note: distinct title, tag, body term,
 *  one task (so the poisoned tasks statement provably fires), one link. */
const ATOMIC_NOTE_VERSION_A = `---
title: Version A
tags: [atomic-a]
---

Alpha body about penguins.

- [ ] alpha task

[[Alpha Target]]
`

/** Version B — differs from A in every asserted dimension. */
const ATOMIC_NOTE_VERSION_B = `---
title: Version B
tags: [atomic-b]
---

Beta body about walruses.

- [ ] beta task

[[Beta Target]]
`

/** The full NoteMetadata row version A produces with testStat(1000). */
const versionAMetadata = (): NoteMetadata => ({
  path: "atomic/target.md",
  title: "Version A",
  tags: ["atomic-a"],
  related: [],
  folder: "atomic",
  type: null,
  created: null,
  modified: isoFromMillis(1000),
  bytes: 100,
  properties: { title: "Version A", tags: ["atomic-a"] },
  leading_callout: null,
})

/** The full TaskEntry version A's `- [ ] alpha task` (line 8) produces. */
const versionATask = (): TaskEntry => ({
  path: "atomic/target.md",
  line: 8,
  status: "todo",
  status_char: " ",
  description: "alpha task",
  folder: "atomic",
  depends_on: [],
  tags: [],
  depth: 0,
  is_kanban_task: false,
})

/** The full OutgoingLinkEntry for version A's unresolved [[Alpha Target]]. */
const versionALink = (): OutgoingLinkEntry => ({
  path: "Alpha Target",
  title: null,
  exists: false,
  kind: "note",
  bytes: null,
  daily_note_forward_ref: false,
})

describe("schema creation", () => {
  it("creates a searchable index with notes and FTS tables", () => {
    const isolatedIndex = createSearchIndex(":memory:")
    isolatedIndex.upsertNote(
      { filePath: "test.md", rawContent: "# Test\n", fileStat: testStat(1000) },
      logger,
    )
    const results = isolatedIndex.fullTextSearch({ query: "Test" }, logger)
    expect(results).toHaveLength(1)
  })

  it("loads the sqlite-vec extension during construction", () => {
    createSearchIndex(":memory:")
    expect(sqliteVec.load).toHaveBeenCalled()
  })

  it("sqlite-vec native binary loads on this platform", () => {
    const db = new Database(":memory:")
    sqliteVec.load(db)
    const row = db.prepare("SELECT vec_version() AS version").get()
    expect(row).toHaveProperty("version")
  })
})

describe("equal-score tie-breaking in retrieval legs", () => {
  const IDENTICAL_NOTE = "# Shared\n\nwalrus habitat survey notes\n"

  it("orders equal-bm25 notes by path regardless of insertion order", () => {
    const tieIndex = createSearchIndex(":memory:")
    // Reverse-alphabetical insertion — without the path tie-break, equal
    // bm25 scores return in insertion order and zzz.md would rank first.
    tieIndex.upsertNote(
      {
        filePath: "zzz.md",
        rawContent: IDENTICAL_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )
    tieIndex.upsertNote(
      {
        filePath: "aaa.md",
        rawContent: IDENTICAL_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )

    const results = tieIndex.fullTextSearch({ query: "walrus" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders equal-mtime folder listings by path regardless of insertion order", () => {
    const tieIndex = createSearchIndex(":memory:")
    tieIndex.upsertNote(
      {
        filePath: "docs/zzz.md",
        rawContent: IDENTICAL_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )
    tieIndex.upsertNote(
      {
        filePath: "docs/aaa.md",
        rawContent: IDENTICAL_NOTE,
        fileStat: testStat(1000),
      },
      logger,
    )

    const results = tieIndex.searchByFolder({ folder: "docs" }, logger)
    expect(results.map((result) => result.path)).toEqual(["docs/aaa.md", "docs/zzz.md"])
  })

  const TAGGED_NOTE = "---\ntags: [project]\n---\n\n# Tagged\n"

  /** Two same-mtime notes sharing content, zzz.md inserted first. */
  const createReverseInsertedPair = (rawContent: string): SearchIndex => {
    const tieIndex = createSearchIndex(":memory:")
    tieIndex.upsertNote({ filePath: "zzz.md", rawContent, fileStat: testStat(1000) }, logger)
    tieIndex.upsertNote({ filePath: "aaa.md", rawContent, fileStat: testStat(1000) }, logger)
    return tieIndex
  }

  it("orders equal-mtime tag search results by path", () => {
    const tieIndex = createReverseInsertedPair(TAGGED_NOTE)
    const results = tieIndex.searchByTag({ tag: "project" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders equal-count tags alphabetically in the tag listing", () => {
    const tieIndex = createReverseInsertedPair("---\ntags: [zzz-tag, aaa-tag]\n---\n\n# Tags\n")
    const results = tieIndex.listAllTags({}, logger)
    expect(results.map((tagCount) => tagCount.tag)).toEqual(["aaa-tag", "zzz-tag"])
  })

  it("orders equal-mtime recent notes by path", () => {
    const tieIndex = createReverseInsertedPair(IDENTICAL_NOTE)
    const results = tieIndex.recentNotes({}, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders equal-created recent notes by path in created sort", () => {
    const tieIndex = createReverseInsertedPair(
      "---\ncreated: 2026-01-01T00:00:00-05:00\n---\n\n# Created\n",
    )
    const results = tieIndex.recentNotes({ sort_by: "created" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders equal-count property keys alphabetically", () => {
    const tieIndex = createReverseInsertedPair("---\nzz_last: 1\naa_first: 1\n---\n\n# Props\n")
    const results = tieIndex.listPropertyKeys({}, logger)
    expect(results.map((keyInfo) => keyInfo.key)).toEqual(["aa_first", "zz_last"])
  })

  it("orders equal-count sample values alphabetically within a property key", () => {
    // Each note contributes a different status value (one note each), so all
    // three sample values tie at count 1 — the alphabetical tie-break in the
    // sample-values sub-query decides their order.
    const tieIndex = createSearchIndex(":memory:")
    tieIndex.upsertNote(
      {
        filePath: "a.md",
        rawContent: "---\nstatus: zzz-status\n---\n\n# A\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    tieIndex.upsertNote(
      {
        filePath: "b.md",
        rawContent: "---\nstatus: aaa-status\n---\n\n# B\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    tieIndex.upsertNote(
      {
        filePath: "c.md",
        rawContent: "---\nstatus: mmm-status\n---\n\n# C\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = tieIndex.listPropertyKeys({}, logger)
    const statusKey = results.find((keyInfo) => keyInfo.key === "status")
    expect(statusKey?.sample_values).toEqual(["aaa-status", "mmm-status", "zzz-status"])
  })

  it("orders equal-count property values alphabetically", () => {
    const tieIndex = createReverseInsertedPair(
      "---\nstatus: [zzz-value, aaa-value]\n---\n\n# Values\n",
    )
    const results = tieIndex.listPropertyValues({ key: "status" }, logger)
    expect(results.map((valueCount) => valueCount.value)).toEqual(["aaa-value", "zzz-value"])
  })

  it("orders equal-mtime property search results by path", () => {
    const tieIndex = createReverseInsertedPair("---\nstatus: active\n---\n\n# Status\n")
    const results = tieIndex.searchByProperty({ key: "status", value: "active" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders same-title backlinks by source path", () => {
    const tieIndex = createSearchIndex(":memory:")
    tieIndex.upsertNote(
      {
        filePath: "Target.md",
        rawContent: "# Target\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const linkingNote = "---\ntitle: Same Title\n---\n\n[[Target]]\n"
    tieIndex.upsertNote(
      { filePath: "zzz.md", rawContent: linkingNote, fileStat: testStat(1000) },
      logger,
    )
    tieIndex.upsertNote(
      { filePath: "aaa.md", rawContent: linkingNote, fileStat: testStat(1000) },
      logger,
    )

    const backlinks = tieIndex.getBacklinks({ path: "Target.md" }, logger)
    expect(backlinks.map((backlink) => backlink.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders equal-mtime orphans by path", () => {
    const tieIndex = createReverseInsertedPair(IDENTICAL_NOTE)
    const results = tieIndex.findOrphans({}, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders equal-mtime notes by path in the modified-on-date listing", () => {
    const middayMtime = DateTime.fromISO("2026-06-15T12:00:00").toMillis()
    const tieIndex = createSearchIndex(":memory:")
    tieIndex.upsertNote(
      {
        filePath: "zzz.md",
        rawContent: IDENTICAL_NOTE,
        fileStat: testStat(middayMtime),
      },
      logger,
    )
    tieIndex.upsertNote(
      {
        filePath: "aaa.md",
        rawContent: IDENTICAL_NOTE,
        fileStat: testStat(middayMtime),
      },
      logger,
    )

    const results = tieIndex.modifiedOnDate({ date: "2026-06-15" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "zzz.md"])
  })

  it("orders equal-bm25 file results by path in FTS-only hybrid search", async () => {
    const tieIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })
    const identicalFileContent = "walrus habitat survey notes"
    tieIndex.upsertNonMdFile("zzz.txt", 100)
    tieIndex.upsertFileContent(
      {
        filePath: "zzz.txt",
        rawContent: identicalFileContent,
        fileStat: testStat(1000, 100),
      },
      logger,
    )
    tieIndex.upsertNonMdFile("aaa.txt", 100)
    tieIndex.upsertFileContent(
      {
        filePath: "aaa.txt",
        rawContent: identicalFileContent,
        fileStat: testStat(1000, 100),
      },
      logger,
    )

    // With no embedder, fusion runs over the FTS legs alone — the file leg's
    // internal order decides which tied file takes RRF rank 1, so this
    // exercises the leg-level tie-break, not the fusion one.
    const { results } = await tieIndex.hybridSearch({ query: "walrus" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.txt", "zzz.txt"])
  })

  /** Every text embeds to the same vector, so all KNN distances tie. */
  const createUniformEmbedder = () => ({
    embedText: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) => {
      return Promise.resolve(texts.map(() => new Float32Array(384).fill(0.1)))
    }),
  })

  it("orders tied-distance note vector hits by path regardless of insertion order", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder())
    // Insertion order (mmm, zzz, aaa) differs from both path order and its
    // reverse, so the asserted order can come only from the secondary sort
    // keys — whichever way a vec0 build returns tied distances.
    for (const notePath of ["mmm.md", "zzz.md", "aaa.md"]) {
      const sourceVersion = tieIndex.upsertNote(
        {
          filePath: notePath,
          rawContent: IDENTICAL_NOTE,
          fileStat: testStat(1000),
        },
        logger,
      )
      await tieIndex.embedNote(
        { sourceVersion: sourceVersion, notePath, rawContent: IDENTICAL_NOTE },
        logger,
      )
    }

    // "orca" shares no stems with the note content, so the FTS leg is empty
    // and the ranking comes from the vector leg's tied distances alone.
    const { results } = await tieIndex.hybridSearch({ query: "orca" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "mmm.md", "zzz.md"])
  })

  it("orders tied-distance file vector hits by path regardless of insertion order", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder(), undefined, {
      fileToolsEnabled: true,
    })
    const identicalFileContent = "walrus habitat survey notes"
    // Insertion order (mmm, zzz, aaa) differs from both path order and its
    // reverse, so the asserted order can come only from the secondary sort
    // keys — whichever way a vec0 build returns tied distances.
    for (const filePath of ["mmm.txt", "zzz.txt", "aaa.txt"]) {
      tieIndex.upsertNonMdFile(filePath, 100)
      const sourceVersion = tieIndex.upsertFileContent(
        {
          filePath,
          rawContent: identicalFileContent,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await tieIndex.embedFileContent({ sourceVersion: sourceVersion, filePath }, logger)
    }

    // "orca" shares no stems with the file content, so the FTS legs are
    // empty and the ranking comes from the file vector leg's tied distances.
    const { results } = await tieIndex.hybridSearch({ query: "orca" }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.txt", "mmm.txt", "zzz.txt"])
  })

  it("orders tied-distance note vector hits by path under a folder filter", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder())
    // In-folder insertion order (mmm, zzz, aaa) differs from both path order
    // and its reverse, so the asserted order can come only from the secondary
    // sort keys — whichever way a vec0 build returns tied distances. The
    // equally-tied note outside the folder is dropped by hybrid-search's
    // post-SQL note filter under either KNN statement — this pins the
    // in-folder statement's ordering keys, not which statement ran.
    for (const notePath of ["docs/mmm.md", "docs/zzz.md", "other/out.md", "docs/aaa.md"]) {
      const sourceVersion = tieIndex.upsertNote(
        {
          filePath: notePath,
          rawContent: IDENTICAL_NOTE,
          fileStat: testStat(1000),
        },
        logger,
      )
      await tieIndex.embedNote(
        { sourceVersion: sourceVersion, notePath, rawContent: IDENTICAL_NOTE },
        logger,
      )
    }

    const { results } = await tieIndex.hybridSearch(
      { query: "orca", filters: { folder: "docs" } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual([
      "docs/aaa.md",
      "docs/mmm.md",
      "docs/zzz.md",
    ])
  })

  it("orders tied-distance file vector hits by path under a folder filter", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder(), undefined, {
      fileToolsEnabled: true,
    })
    const identicalFileContent = "walrus habitat survey notes"
    // Same three-way seeding as the note test above — file legs scope to the
    // folder in SQL alone, so the outside seed here genuinely proves the
    // in-folder statement ran.
    for (const filePath of ["docs/mmm.txt", "docs/zzz.txt", "other/out.txt", "docs/aaa.txt"]) {
      tieIndex.upsertNonMdFile(filePath, 100)
      const sourceVersion = tieIndex.upsertFileContent(
        {
          filePath,
          rawContent: identicalFileContent,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await tieIndex.embedFileContent({ sourceVersion: sourceVersion, filePath }, logger)
    }

    const { results } = await tieIndex.hybridSearch(
      { query: "orca", filters: { folder: "docs" } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual([
      "docs/aaa.txt",
      "docs/mmm.txt",
      "docs/zzz.txt",
    ])
  })

  it("keeps path order for note ties straddling the KNN window boundary", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder())
    // Eight tied notes against a window of six (limit 2 → candidateLimit 6):
    // without over-fetch, vec0's tie order chooses which six enter, and
    // aaa.md is inserted first so reverse-insertion emission drops it at the
    // boundary. With over-fetch all eight are path-ordered before the window
    // truncates, so aaa and bbb must top the results.
    for (const notePath of [
      "aaa.md",
      "bbb.md",
      "ccc.md",
      "ddd.md",
      "eee.md",
      "fff.md",
      "ggg.md",
      "hhh.md",
    ]) {
      const sourceVersion = tieIndex.upsertNote(
        {
          filePath: notePath,
          rawContent: IDENTICAL_NOTE,
          fileStat: testStat(1000),
        },
        logger,
      )
      await tieIndex.embedNote(
        { sourceVersion: sourceVersion, notePath, rawContent: IDENTICAL_NOTE },
        logger,
      )
    }

    const { results } = await tieIndex.hybridSearch({ query: "orca", limit: 2 }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.md", "bbb.md"])
  })

  it("keeps path order for file ties straddling the KNN window boundary", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder(), undefined, {
      fileToolsEnabled: true,
    })
    const identicalFileContent = "walrus habitat survey notes"
    // Same eight-versus-six construction as the note test above.
    for (const filePath of [
      "aaa.txt",
      "bbb.txt",
      "ccc.txt",
      "ddd.txt",
      "eee.txt",
      "fff.txt",
      "ggg.txt",
      "hhh.txt",
    ]) {
      tieIndex.upsertNonMdFile(filePath, 100)
      const sourceVersion = tieIndex.upsertFileContent(
        {
          filePath,
          rawContent: identicalFileContent,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await tieIndex.embedFileContent({ sourceVersion: sourceVersion, filePath }, logger)
    }

    const { results } = await tieIndex.hybridSearch({ query: "orca", limit: 2 }, logger)
    expect(results.map((result) => result.path)).toEqual(["aaa.txt", "bbb.txt"])
  })

  it("keeps path order for note ties straddling the folder-scoped KNN window boundary", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder())
    // Eight tied in-folder notes against a window of six (limit 2 →
    // candidateLimit 6): docs/aaa and docs/bbb are inserted first, so if the
    // folder statement's over-fetch reverts, reverse-insertion emission drops
    // both at the boundary. The equally-tied note outside the folder is
    // excluded by the folder filter.
    for (const notePath of [
      "docs/aaa.md",
      "docs/bbb.md",
      "docs/ccc.md",
      "other/out.md",
      "docs/ddd.md",
      "docs/eee.md",
      "docs/fff.md",
      "docs/ggg.md",
      "docs/hhh.md",
    ]) {
      const sourceVersion = tieIndex.upsertNote(
        {
          filePath: notePath,
          rawContent: IDENTICAL_NOTE,
          fileStat: testStat(1000),
        },
        logger,
      )
      await tieIndex.embedNote(
        { sourceVersion: sourceVersion, notePath, rawContent: IDENTICAL_NOTE },
        logger,
      )
    }

    const { results } = await tieIndex.hybridSearch(
      { query: "orca", filters: { folder: "docs" }, limit: 2 },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["docs/aaa.md", "docs/bbb.md"])
  })

  it("keeps path order for file ties straddling the folder-scoped KNN window boundary", async () => {
    const tieIndex = createSearchIndex(":memory:", createUniformEmbedder(), undefined, {
      fileToolsEnabled: true,
    })
    const identicalFileContent = "walrus habitat survey notes"
    // Same eight-versus-six construction as the folder-scoped note test
    // above. File legs scope to the folder in SQL alone, and assets/out.txt
    // sorts before every docs/ path — with folder scoping intact the window
    // never contains it, while the plain KNN statement would rank it first
    // and fail the assertion.
    for (const filePath of [
      "docs/aaa.txt",
      "docs/bbb.txt",
      "docs/ccc.txt",
      "assets/out.txt",
      "docs/ddd.txt",
      "docs/eee.txt",
      "docs/fff.txt",
      "docs/ggg.txt",
      "docs/hhh.txt",
    ]) {
      tieIndex.upsertNonMdFile(filePath, 100)
      const sourceVersion = tieIndex.upsertFileContent(
        {
          filePath,
          rawContent: identicalFileContent,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await tieIndex.embedFileContent({ sourceVersion: sourceVersion, filePath }, logger)
    }

    const { results } = await tieIndex.hybridSearch(
      { query: "orca", filters: { folder: "docs" }, limit: 2 },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["docs/aaa.txt", "docs/bbb.txt"])
  })
})

describe("leading callout", () => {
  it("surfaces a note's leading callout in discovery results", () => {
    index.upsertNote(
      {
        filePath: "About Me/Me.md",
        rawContent: NOTE_WITH_CALLOUT,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0]?.leading_callout).toEqual({
      type: "info",
      title: "Scope of this file",
      body: "**Contains:** identity facts.\n**Convention:** append newest first.",
    })
  })

  it("returns callout null for a note without a leading callout", () => {
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.leading_callout).toBeNull()
  })

  it("omits the callout from fullTextSearch by default, includes it on request", () => {
    index.upsertNote(
      {
        filePath: "About Me/Me.md",
        rawContent: NOTE_WITH_CALLOUT,
        fileStat: testStat(1000),
      },
      logger,
    )

    const withoutFlag = index.fullTextSearch({ query: "burnout" }, logger)
    expect(withoutFlag).toHaveLength(1)
    expect(withoutFlag[0]?.leading_callout).toBeUndefined()

    const withFlag = index.fullTextSearch(
      { query: "burnout", include_leading_callout: true },
      logger,
    )
    expect(withFlag[0]?.leading_callout?.title).toBe("Scope of this file")
  })

  it("adds the leading_callout column to a pre-existing notes table (warm-DB migration)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-db-"))
    onTestFinished(() => rm(dir, { recursive: true }))
    const dbPath = join(dir, "search.db")
    // Simulate a database file created before the leading_callout column existed.
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE notes (
        path TEXT PRIMARY KEY, title TEXT, content TEXT, tags TEXT, related TEXT,
        folder TEXT, type TEXT, created TEXT, mtime INTEGER, properties TEXT
      );
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        path UNINDEXED, title, content, tokenize='porter unicode61'
      );
      CREATE TABLE links (
        source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (source, target)
      );
    `)
    legacyDb.close()

    // Opening through the factory must add the missing column, not throw on upsert.
    const warmIndex = createSearchIndex(dbPath)
    expect(() => {
      warmIndex.upsertNote(
        {
          filePath: "About Me/Me.md",
          rawContent: NOTE_WITH_CALLOUT,
          fileStat: testStat(1000),
        },
        logger,
      )
    }).not.toThrow()
    const results = warmIndex.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0]?.leading_callout?.title).toBe("Scope of this file")
    expect(results[0]?.bytes).toBe(100)
  })

  it("adds the bytes column to a pre-existing non_md_files table (warm-DB migration)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-db-"))
    onTestFinished(() => rm(dir, { recursive: true }))
    const dbPath = join(dir, "search.db")
    // Simulate a database file created before the non_md_files bytes column.
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE non_md_files (
        path TEXT PRIMARY KEY, base_path TEXT NOT NULL, basename TEXT NOT NULL
      );
    `)
    legacyDb.close()

    // Opening through the factory must add the missing column — the 4-column
    // upsert would throw against the legacy 3-column table otherwise.
    const warmIndex = createSearchIndex(dbPath)
    expect(() => warmIndex.upsertNonMdFile("photo.png", 77)).not.toThrow()
    warmIndex.upsertNote(
      {
        filePath: "source.md",
        rawContent: "![[photo.png]]",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(warmIndex.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 77,
        daily_note_forward_ref: false,
      },
    ])
  })
})

describe("bytes", () => {
  it("surfaces file size in bytes in discovery results", () => {
    index.upsertNote(
      {
        filePath: "notes/sized.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000, 42),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.bytes).toBe(42)
  })

  it("includes bytes in full text search results", () => {
    index.upsertNote(
      {
        filePath: "sized.md",
        rawContent: "searchable content\n",
        fileStat: testStat(1000, 256),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "searchable" }, logger)
    expect(results[0]?.bytes).toBe(256)
  })

  it("includes bytes in recent notes results", () => {
    index.upsertNote(
      {
        filePath: "recent.md",
        rawContent: "---\ntitle: R\n---\nbody\n",
        fileStat: testStat(5000, 128),
      },
      logger,
    )
    const results = index.recentNotes({}, logger)
    expect(results[0]?.bytes).toBe(128)
  })

  it("stores and retrieves a bytes value of 0", () => {
    index.upsertNote(
      {
        filePath: "notes/zero.md",
        rawContent: "body\n",
        fileStat: testStat(1000, 0),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.bytes).toBe(0)
  })
})

describe("upsertNote", () => {
  it("indexes a note with full frontmatter", () => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
    expect(results[0]?.title).toBe("Principles")
    expect(results[0]?.tags).toEqual(["principles", "self"])
  })

  it("extracts title from frontmatter", () => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results[0]?.title).toBe("Principles")
  })

  it("falls back to filename for title when no frontmatter title", () => {
    index.upsertNote(
      {
        filePath: "notes/random.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "notes" }, logger)
    expect(results[0]?.title).toBe("random")
  })

  it("indexes a note whose block is not valid YAML from its body, with no properties, and warns", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    // The block carries a tag and a frontmatter link; neither may reach the
    // index, since Obsidian reads no properties from such a block. The body
    // links to a different note, so a body link can never cover the
    // frontmatter one.
    index.upsertNote(
      {
        filePath: "Meetings/Q3 plan.md",
        rawContent:
          '---\ntitle: Meeting: Q3 plan\ntags: [meeting]\nrelated: ["[[Roadmap]]"]\n---\nAgenda for the quokka launch.\n\n- [ ] Book the room\n\nSee [[Budget]].\n',
        fileStat: testStat(1000),
      },
      logger,
    )

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "indexed note without its unreadable properties block",
      {
        path: "Meetings/Q3 plan.md",
        error:
          "[Error]: properties block is not valid YAML at line 2, column 8: Nested mappings are not allowed in compact mappings",
      },
    )
    const bodyHits = index.fullTextSearch({ query: "quokka" }, logger)
    expect(bodyHits.map((result) => [result.path, result.title, result.tags])).toEqual([
      ["Meetings/Q3 plan.md", "Q3 plan", []],
    ])
    expect(index.searchByTag({ tag: "meeting" }, logger)).toEqual([])
    expect(
      index.listTasks({ status: "all" }, logger).tasks.map((task) => [task.path, task.description]),
    ).toEqual([["Meetings/Q3 plan.md", "Book the room"]])
    expect(
      index.getOutgoingLinks({ path: "Meetings/Q3 plan.md" }, logger).map((link) => link.path),
    ).toEqual(["Budget"])
  })

  it("replaces every row of a note whose block became unreadable with the new body", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    index.upsertNote(
      {
        filePath: "plan.md",
        rawContent: "---\ntitle: Plan\ntags: [plan]\n---\nolder amber text\n\n- [ ] Old task\n",
        fileStat: testStat(1000),
      },
      logger,
    )

    index.upsertNote(
      {
        filePath: "plan.md",
        rawContent: "---\ntitle: Meeting: Q3 plan\n---\nnewer opal text\n",
        fileStat: testStat(2000),
      },
      logger,
    )

    expect(index.fullTextSearch({ query: "amber" }, logger)).toEqual([])
    // The old block's title gives way to the file name
    const opalHits = index.fullTextSearch({ query: "opal" }, logger)
    expect(opalHits.map((result) => [result.path, result.title])).toEqual([["plan.md", "plan"]])
    expect(index.searchByTag({ tag: "plan" }, logger)).toEqual([])
    expect(index.listTasks({ status: "all" }, logger)).toEqual({ total: 0, tasks: [] })
  })

  it("stores folder as first path segment", () => {
    // Nested two levels deep, so the first segment differs from the parent folder.
    index.upsertNote(
      {
        filePath: "About Me/Archive/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results.map((result) => result.folder)).toEqual(["About Me"])
  })

  it("stores created as null when the frontmatter value is not an ISO date", () => {
    index.upsertNote(
      {
        filePath: "dated.md",
        rawContent: "---\ncreated: 2026-01-15\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "undated.md",
        rawContent: "---\ncreated: next week\n---\nbody\n",
        fileStat: testStat(1000),
      },
      logger,
    )

    // The ISO note keeps its date, so the null comes from the failed parse,
    // not from created never being stored.
    const createdByPath = index
      .recentNotes({}, logger)
      .map((note) => ({ path: note.path, created: note.created }))
    expect(createdByPath).toEqual([
      { path: "dated.md", created: DateTime.fromISO("2026-01-15").toISO() },
      { path: "undated.md", created: null },
    ])
  })

  it("stores the file name as title and null as type when those values are not text", () => {
    index.upsertNote(
      {
        filePath: "text-values.md",
        rawContent: "---\ntitle: Plan\ntype: meeting\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "non-text-values.md",
        rawContent: "---\ntitle: 2024\ntype: [meeting]\n---\nbody\n",
        fileStat: testStat(1000),
      },
      logger,
    )

    // The text-valued note keeps both values, so the fallbacks come from the
    // values' types, not from title and type never being stored.
    const titleAndTypeByPath = index
      .recentNotes({}, logger)
      .map((note) => ({ path: note.path, title: note.title, type: note.type }))
    expect(titleAndTypeByPath).toEqual([
      { path: "text-values.md", title: "Plan", type: "meeting" },
      { path: "non-text-values.md", title: "non-text-values", type: null },
    ])
  })

  it("stores empty folder for root-level notes", () => {
    index.upsertNote(
      {
        filePath: "root.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(1000),
      },
      logger,
    )
    const recent = index.recentNotes({}, logger)
    expect(recent[0]?.folder).toBe("")
  })

  it("updates existing note on re-index", () => {
    index.upsertNote(
      {
        filePath: "test.md",
        rawContent: "---\ntitle: V1\n---\nold\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "test.md",
        rawContent: "---\ntitle: V2\n---\nnew content\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "new content" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe("V2")
  })

  it("handles notes with no frontmatter", () => {
    index.upsertNote(
      {
        filePath: "bare.md",
        rawContent: "Just plain text\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "plain text" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.tags).toEqual([])
  })

  it("normalizes tags to array when given as string", () => {
    index.upsertNote(
      {
        filePath: "t.md",
        rawContent: "---\ntags: single-tag\n---\nbody\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const tags = index.listAllTags({}, logger)
    expect(tags).toEqual([{ tag: "single-tag", count: 1 }])
  })

  it.each([
    // Labels stay within 40 characters, past which vitest cuts the title
    { label: 'a quoted "#Alpha" as Alpha', frontmatter: 'tags: ["#Alpha"]', stored: ["Alpha"] },
    { label: "a comma-joined text value as no tag", frontmatter: "tags: alpha, beta", stored: [] },
    { label: "a bare number as no tag", frontmatter: "tags: 2024", stored: [] },
    { label: "the tags under a Tags key", frontmatter: "Tags: [x]", stored: ["x"] },
  ])("stores $label", ({ frontmatter, stored }) => {
    index.upsertNote(
      {
        filePath: "tagged.md",
        rawContent: `---\n${frontmatter}\n---\nbody\n`,
        fileStat: testStat(1000),
      },
      logger,
    )

    expect(index.recentNotes({}, logger).map((note) => note.tags)).toEqual([stored])
  })

  it("exposes the status registry it was built with", () => {
    const statusRegistry: ReadonlyMap<string, StatusClassification> = new Map([
      [" ", "todo"],
      ["x", "done"],
      ["D", "done"],
    ])
    const registryIndex = createSearchIndex(":memory:", undefined, undefined, {
      statusRegistry,
    })

    expect(registryIndex.statusRegistry).toBe(statusRegistry)
  })

  it("exposes the built-in statuses when no registry is given", () => {
    expect(index.statusRegistry).toEqual(
      new Map<string, StatusClassification>([
        [" ", "todo"],
        ["x", "done"],
        ["X", "done"],
        ["/", "in_progress"],
        ["-", "cancelled"],
      ]),
    )
  })

  it("threads the status registry to classify custom task statuses", () => {
    const statusRegistry: ReadonlyMap<string, StatusClassification> = new Map([
      [" ", "todo"],
      ["x", "done"],
      ["D", "done"],
      [">", "non_task"],
    ])
    const registryIndex = createSearchIndex(":memory:", undefined, undefined, {
      statusRegistry,
    })
    registryIndex.upsertNote(
      {
        filePath: "tasks.md",
        rawContent:
          "---\ntitle: Tasks\n---\n\n- [D] Deployed task\n- [>] Forwarded ref\n- [ ] Normal task\n",
        fileStat: testStat(1000),
      },
      logger,
    )

    const result = registryIndex.listTasks({ status: "all" }, logger)

    expect(result).toEqual({
      total: 2,
      tasks: [
        {
          path: "tasks.md",
          line: 5,
          status: "done",
          status_char: "D",
          description: "Deployed task",
          folder: "",
          depends_on: [],
          tags: [],
          depth: 0,
          is_kanban_task: false,
        },
        {
          path: "tasks.md",
          line: 7,
          status: "todo",
          status_char: " ",
          description: "Normal task",
          folder: "",
          depends_on: [],
          tags: [],
          depth: 0,
          is_kanban_task: false,
        },
      ],
    })
  })
})

describe("upsertNote atomicity", () => {
  it("rolls back to the prior version when a statement fails mid-upsert", () => {
    const taskInsertPoison = installStatementPoison("INSERT INTO tasks")
    const atomicIndex = createSearchIndex(":memory:")
    atomicIndex.upsertNote(
      {
        filePath: "atomic/target.md",
        rawContent: ATOMIC_NOTE_VERSION_A,
        fileStat: testStat(1000),
      },
      logger,
    )

    // By the time the poisoned task INSERT fires, version B's FTS delete,
    // notes upsert, FTS insert, and tasks delete have already run inside the
    // transaction — intact version-A state below proves genuine rollback,
    // not a no-op.
    taskInsertPoison.arm()
    expect(() => {
      atomicIndex.upsertNote(
        {
          filePath: "atomic/target.md",
          rawContent: ATOMIC_NOTE_VERSION_B,
          fileStat: testStat(2000),
        },
        logger,
      )
    }).toThrow(taskInsertPoison.message)
    taskInsertPoison.disarm()

    expect(atomicIndex.recentNotes({}, logger)).toEqual([versionAMetadata()])
    const versionAHits = atomicIndex.fullTextSearch({ query: "penguins" }, logger)
    expect(versionAHits.map((result) => result.path)).toEqual(["atomic/target.md"])
    expect(atomicIndex.fullTextSearch({ query: "walruses" }, logger)).toEqual([])
    expect(atomicIndex.listTasks({ status: "all" }, logger)).toEqual({
      total: 1,
      tasks: [versionATask()],
    })
    expect(atomicIndex.getOutgoingLinks({ path: "atomic/target.md" }, logger)).toEqual([
      versionALink(),
    ])
  })

  it("rolls back the link phase when a link statement fails mid-upsert", () => {
    const linkInsertPoison = installStatementPoison("INSERT OR IGNORE INTO links")
    const atomicIndex = createSearchIndex(":memory:")
    atomicIndex.upsertNote(
      {
        filePath: "atomic/target.md",
        rawContent: ATOMIC_NOTE_VERSION_A,
        fileStat: testStat(1000),
      },
      logger,
    )

    // By the time the poisoned link INSERT fires, `deleteLinksStmt` has
    // already cleared version A's links inside the transaction — the intact
    // version-A link below proves link-phase rollback specifically, which
    // the tasks-phase poison above never exercises (it throws before the
    // links table is touched).
    linkInsertPoison.arm()
    expect(() => {
      atomicIndex.upsertNote(
        {
          filePath: "atomic/target.md",
          rawContent: ATOMIC_NOTE_VERSION_B,
          fileStat: testStat(2000),
        },
        logger,
      )
    }).toThrow(linkInsertPoison.message)
    linkInsertPoison.disarm()

    expect(atomicIndex.recentNotes({}, logger)).toEqual([versionAMetadata()])
    const versionAHits = atomicIndex.fullTextSearch({ query: "penguins" }, logger)
    expect(versionAHits.map((result) => result.path)).toEqual(["atomic/target.md"])
    expect(atomicIndex.fullTextSearch({ query: "walruses" }, logger)).toEqual([])
    expect(atomicIndex.listTasks({ status: "all" }, logger)).toEqual({
      total: 1,
      tasks: [versionATask()],
    })
    expect(atomicIndex.getOutgoingLinks({ path: "atomic/target.md" }, logger)).toEqual([
      versionALink(),
    ])
  })

  it("leaves no trace when a statement fails on a first-ever upsert", () => {
    const taskInsertPoison = installStatementPoison("INSERT INTO tasks")
    const atomicIndex = createSearchIndex(":memory:")
    // The control note's positive assertions below prove the query path works,
    // so the target note's empty results can't pass vacuously (fullTextSearch
    // catches SQL errors and returns []).
    atomicIndex.upsertNote(
      {
        filePath: "atomic/control.md",
        rawContent: "Control body about flamingos.\n",
        fileStat: testStat(500),
      },
      logger,
    )

    taskInsertPoison.arm()
    expect(() => {
      atomicIndex.upsertNote(
        {
          filePath: "atomic/target.md",
          rawContent: ATOMIC_NOTE_VERSION_A,
          fileStat: testStat(1000),
        },
        logger,
      )
    }).toThrow(taskInsertPoison.message)
    taskInsertPoison.disarm()

    const controlMetadata: NoteMetadata = {
      path: "atomic/control.md",
      title: "control",
      tags: [],
      related: [],
      folder: "atomic",
      type: null,
      created: null,
      modified: isoFromMillis(500),
      bytes: 100,
      properties: {},
      leading_callout: null,
    }
    expect(atomicIndex.recentNotes({}, logger)).toEqual([controlMetadata])
    expect(atomicIndex.fullTextSearch({ query: "penguins" }, logger)).toEqual([])
    const controlHits = atomicIndex.fullTextSearch({ query: "flamingos" }, logger)
    expect(controlHits.map((result) => result.path)).toEqual(["atomic/control.md"])
    expect(atomicIndex.listTasks({ status: "all" }, logger)).toEqual({
      total: 0,
      tasks: [],
    })
    expect(atomicIndex.getOutgoingLinks({ path: "atomic/target.md" }, logger)).toEqual([])
  })
})

describe("removeNote", () => {
  it("removes an indexed note", () => {
    index.upsertNote(
      {
        filePath: "test.md",
        rawContent: "# Removable\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.removeNote("test.md")
    const results = index.fullTextSearch({ query: "Removable" }, logger)
    expect(results).toHaveLength(0)
  })

  it("does not throw for non-existent path", () => {
    expect(() => index.removeNote("ghost.md")).not.toThrow()
  })
})

describe("removeNote atomicity", () => {
  it("keeps the note fully present when a delete fails mid-removal", () => {
    // The tasks delete is the last unconditional statement in removeNote (no
    // embedder or memoryDir here), so the FTS, notes, and links deletes have
    // all run inside the transaction when the poison fires — full presence
    // below proves they rolled back.
    const taskDeletePoison = installStatementPoison("DELETE FROM tasks")
    const atomicIndex = createSearchIndex(":memory:")
    atomicIndex.upsertNote(
      {
        filePath: "atomic/target.md",
        rawContent: ATOMIC_NOTE_VERSION_A,
        fileStat: testStat(1000),
      },
      logger,
    )

    taskDeletePoison.arm()
    expect(() => atomicIndex.removeNote("atomic/target.md")).toThrow(taskDeletePoison.message)
    taskDeletePoison.disarm()

    expect(atomicIndex.recentNotes({}, logger)).toEqual([versionAMetadata()])
    const versionAHits = atomicIndex.fullTextSearch({ query: "penguins" }, logger)
    expect(versionAHits.map((result) => result.path)).toEqual(["atomic/target.md"])
    expect(atomicIndex.listTasks({ status: "all" }, logger)).toEqual({
      total: 1,
      tasks: [versionATask()],
    })
    expect(atomicIndex.getOutgoingLinks({ path: "atomic/target.md" }, logger)).toEqual([
      versionALink(),
    ])
  })
})

describe("fullTextSearch", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/notes.md",
        rawContent:
          "---\ntitle: Project Notes\ntype: project\ntags: [project]\n---\n\nMeeting notes about the vault project\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/random.md",
        rawContent: NOTE_MINIMAL,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("finds notes by content keyword", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("finds notes by title", () => {
    const results = index.fullTextSearch({ query: "Principles" }, logger)
    expect(results).toHaveLength(1)
  })

  it("returns snippets without HTML markup", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0]?.snippet).not.toContain("<mark>")
    expect(results[0]?.snippet).toContain("burnout")
  })

  it("includes type in search results", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0]?.type).toBe("about-me")
  })

  it("rounds score to at most 4 significant figures", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    const score = results[0]?.score
    expect(score).toBeDefined()
    expect(score).toBe(Number(score?.toPrecision(4)))
  })

  it("omits created when null", () => {
    const results = index.fullTextSearch({ query: "content without" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]).not.toHaveProperty("created")
  })

  it("includes created when present", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results[0]).toHaveProperty("created")
    expect(results[0]?.created).toContain("2025")
  })

  it("returns modified as ISO 8601 string", () => {
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(typeof results[0]?.modified).toBe("string")
    expect(results[0]?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("respects custom snippet_tokens", () => {
    const short = index.fullTextSearch({ query: "burnout", snippet_tokens: 5 }, logger)
    const long = index.fullTextSearch({ query: "burnout", snippet_tokens: 60 }, logger)
    expect(long[0]?.snippet?.length).toBeGreaterThan(short[0]?.snippet?.length ?? 0)
  })

  it("respects folder filter", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { folder: "Projects" } },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/notes.md")
  })

  it("strips trailing slashes from folder filter before matching", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { folder: "Projects/" } },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/notes.md")
  })

  it("does not match a sibling folder whose name starts with the folder filter", () => {
    index.upsertNote(
      {
        filePath: "ProjectsOld/old.md",
        rawContent: "---\ntitle: Old\n---\n\nOld meeting notes\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.fullTextSearch(
      { query: "notes", filters: { folder: "Projects" } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["Projects/notes.md"])
  })

  it("ignores ASCII letter case in the folder filter", () => {
    const results = index.fullTextSearch(
      { query: "notes", filters: { folder: "projects" } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["Projects/notes.md"])
  })

  it("respects tags filter", () => {
    const results = index.fullTextSearch({ query: "notes", filters: { tags: ["project"] } }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/notes.md")
  })

  it("matches a tags filter by a parent tag in any letter case, not a longer tag", () => {
    index.upsertNote(
      {
        filePath: "Projects/child.md",
        rawContent: "---\ntags: [Project/child]\n---\n\nMeeting notes about the child\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/decoy.md",
        rawContent: "---\ntags: [projects]\n---\n\nMeeting notes about the decoy\n",
        fileStat: testStat(5000),
      },
      logger,
    )

    const results = index.fullTextSearch(
      { query: "notes", filters: { tags: ["#PROJECT"] } },
      logger,
    )
    expect(results.map((result) => result.path).toSorted()).toEqual([
      "Projects/child.md",
      "Projects/notes.md",
    ])
  })

  it("rejects a tags filter entry that is only a #", () => {
    const searchWithEmptyTag = () => {
      return index.fullTextSearch({ query: "notes", filters: { tags: ["#"] } }, logger)
    }

    expect(searchWithEmptyTag).toThrow(new Error('tag must not be empty after its leading "#"'))
  })

  it("respects type filter", () => {
    const results = index.fullTextSearch({ query: "notes", filters: { type: "project" } }, logger)
    expect(results).toHaveLength(1)
  })

  it("respects limit", () => {
    const results = index.fullTextSearch({ query: "notes", limit: 1 }, logger)
    expect(results).toHaveLength(1)
  })

  it("returns empty for no matches", () => {
    const results = index.fullTextSearch({ query: "xyznonexistent" }, logger)
    expect(results).toHaveLength(0)
  })

  it("handles porter stemming", () => {
    index.upsertNote(
      {
        filePath: "stem.md",
        rawContent: "The runners were running quickly\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "run" }, logger)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((result) => result.path === "stem.md")).toBe(true)
  })

  it("multi-word query matches notes containing both terms (implicit AND)", () => {
    const results = index.fullTextSearch({ query: "burnout boundaries" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("multi-word query does not require exact phrase adjacency", () => {
    index.upsertNote(
      {
        filePath: "spread.md",
        rawContent: "The word alpha appears here. Much later, beta shows up.\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "alpha beta" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("spread.md")
  })

  it("exact phrase match with quotes", () => {
    index.upsertNote(
      {
        filePath: "phrase.md",
        rawContent: "Learn machine learning today\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "separate.md",
        rawContent: "The machine was broken. Learning was slow.\n",
        fileStat: testStat(5001),
      },
      logger,
    )
    const phraseResults = index.fullTextSearch({ query: '"machine learning"' }, logger)
    expect(phraseResults.some((result) => result.path === "phrase.md")).toBe(true)
    expect(phraseResults.some((result) => result.path === "separate.md")).toBe(false)
  })

  it("query with FTS5 operators does not throw", () => {
    expect(() => {
      index.fullTextSearch({ query: 'test "quoted" AND (grouped) OR NOT *wild*' }, logger)
    }).not.toThrow()
  })

  it("hyphenated query matches content containing the hyphenated term", () => {
    index.upsertNote(
      {
        filePath: "project.md",
        rawContent: "The flux-capacitor enables time travel\n",
        fileStat: testStat(6000),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "flux-capacitor" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("project.md")
  })

  it("dotted query matches content containing the dotted term", () => {
    index.upsertNote(
      {
        filePath: "directories.md",
        rawContent: "Submitted the listing to mcpservers.org yesterday\n",
        fileStat: testStat(6001),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "unrelated.md",
        rawContent: "The mcpservers registry has no org field\n",
        fileStat: testStat(6002),
      },
      logger,
    )
    const results = index.fullTextSearch({ query: "mcpservers.org" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("directories.md")
  })

  it("query with stray punctuation does not throw", () => {
    expect(() => {
      index.fullTextSearch({ query: "what's new in deploy/local, server.json & .env?" }, logger)
    }).not.toThrow()
  })
})

// ── Metadata search (frontmatter in FTS5) ──────────────────────
//
// Test notes use terms that appear ONLY in frontmatter — never in
// the title or body — so the tests genuinely prove FTS metadata
// indexing (and fail if the metadata column is empty).

const NOTE_WITH_TAXONOMY = `---
title: Garden Layout
type: blueprint
tags: [perennial, xeriscaping]
status: dormant
lifecycle: evergreen
---

# Garden Layout

Raised beds along the south fence with drip irrigation.
`

const NOTE_WITH_PRIORITY = `---
title: Fence Repair
type: maintenance
tags: [structural]
status: overdue
priority: critical
---

# Fence Repair

Replace the rotted posts on the north side.
`

describe("metadata search", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "garden/layout.md",
        rawContent: NOTE_WITH_TAXONOMY,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "garden/fence.md",
        rawContent: NOTE_WITH_PRIORITY,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "garden/notes.md",
        rawContent:
          "---\ntitle: Soil Notes\ntype: reference\ntags: [compost]\n---\n\nAmend with gypsum before planting season.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("finds a note by a type value that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "blueprint" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })

  it("finds a note by a status value that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "overdue" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/fence.md")
  })

  it("finds a note by a tag that appears only in frontmatter", () => {
    const results = index.fullTextSearch({ query: "xeriscaping" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })

  it("finds a note by a frontmatter key name", () => {
    const results = index.fullTextSearch({ query: "lifecycle" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })

  it("cross-field query matches a frontmatter term + body term together", () => {
    const results = index.fullTextSearch({ query: "compost gypsum" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/notes.md")
  })

  it("snippet contains body text, not metadata, for a frontmatter-only match", () => {
    const results = index.fullTextSearch({ query: "overdue" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.snippet).not.toContain("status")
    expect(results[0]?.snippet).not.toContain("overdue")
    expect(results[0]?.snippet).toContain("rotted posts")
  })

  it("does not match notes that lack the queried frontmatter term", () => {
    const results = index.fullTextSearch({ query: "dormant" }, logger)
    const paths = results.map((result) => result.path)
    expect(paths).toEqual(["garden/layout.md"])
  })

  it("warm-DB migration: FTS metadata column is added to a pre-existing database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-fts-"))
    onTestFinished(() => rm(dir, { recursive: true }))
    const dbPath = join(dir, "search.db")
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE notes (
        path TEXT PRIMARY KEY, title TEXT, content TEXT, tags TEXT, related TEXT,
        folder TEXT, type TEXT, created TEXT, mtime INTEGER, properties TEXT,
        leading_callout TEXT, bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        path UNINDEXED, title, content, tokenize='porter unicode61'
      );
      CREATE TABLE links (
        source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (source, target)
      );
    `)
    legacyDb.close()

    const warmIndex = createSearchIndex(dbPath)
    warmIndex.upsertNote(
      {
        filePath: "garden/layout.md",
        rawContent: NOTE_WITH_TAXONOMY,
        fileStat: testStat(1000),
      },
      logger,
    )

    const results = warmIndex.fullTextSearch({ query: "xeriscaping" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("garden/layout.md")
  })
})

describe("searchByTag", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "a.md",
        rawContent: "---\ntags: [project/vault-mcp, self]\n---\nbody\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "b.md",
        rawContent: "---\ntags: [project/other]\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "c.md",
        rawContent: "---\ntags: [unrelated]\n---\nbody\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("prefix match: parent tag matches children", () => {
    const results = index.searchByTag({ tag: "project" }, logger)
    expect(results.map((result) => result.path)).toEqual(["b.md", "a.md"])
  })

  it("prefix match needs a / after the tag, so projects and my-project do not match", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [projects]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "e.md",
        rawContent: "---\ntags: [my-project]\n---\nbody\n",
        fileStat: testStat(5000),
      },
      logger,
    )

    const results = index.searchByTag({ tag: "project" }, logger)
    expect(results.map((result) => result.path)).toEqual(["b.md", "a.md"])
  })

  it('matches notes tagged project when the tag has a leading "#", but not a trailing "/"', () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [project]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    // The bare tag finds d.md, so the empty "/" result below comes from the
    // "/" alone, not from a fixture without a matching note.
    const bareTagResults = index.searchByTag({ tag: "project" }, logger)
    expect(bareTagResults.map((result) => result.path)).toEqual(["d.md", "b.md", "a.md"])

    const hashResults = index.searchByTag({ tag: "#project" }, logger)
    expect(hashResults.map((result) => result.path)).toEqual(["d.md", "b.md", "a.md"])
    expect(index.searchByTag({ tag: "project/" }, logger)).toEqual([])
  })

  it("treats a stored tag that ends in a slash as itself and as nested under its parent", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [foo//]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )

    // `foo//` is stored as `foo/`: the query `foo/` is the tag itself, the
    // query `foo` is its parent, and exact mode with `foo` is neither
    expect(index.searchByTag({ tag: "foo/" }, logger).map((result) => result.path)).toEqual([
      "d.md",
    ])
    expect(index.searchByTag({ tag: "foo" }, logger).map((result) => result.path)).toEqual(["d.md"])
    expect(index.searchByTag({ tag: "foo", exact: true }, logger)).toEqual([])
  })

  it("ignores letter case in both modes, with Projects and my-project as decoys", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [Project]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "e.md",
        rawContent: "---\ntags: [project]\n---\nbody\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    // The decoys sit in a note of their own, so a match on either one would
    // add f.md to the results
    index.upsertNote(
      {
        filePath: "f.md",
        rawContent: "---\ntags: [Projects, my-project]\n---\nbody\n",
        fileStat: testStat(6000),
      },
      logger,
    )

    expect(index.searchByTag({ tag: "PROJECT" }, logger).map((result) => result.path)).toEqual([
      "e.md",
      "d.md",
      "b.md",
      "a.md",
    ])
    expect(
      index.searchByTag({ tag: "PROJECT", exact: true }, logger).map((result) => result.path),
    ).toEqual(["e.md", "d.md"])
  })

  it("folds the query the way it folds stored tags, so a capital sharp s finds a small one", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [ß, Straße]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )

    expect(index.searchByTag({ tag: "ẞ" }, logger).map((result) => result.path)).toEqual(["d.md"])
    expect(index.searchByTag({ tag: "STRASSE" }, logger)).toEqual([])
  })

  it("folds a stored non-ASCII tag in prefix mode, where LIKE alone ignores only ASCII case", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [Ärger/Alt]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )

    expect(index.searchByTag({ tag: "ärger" }, logger).map((result) => result.path)).toEqual([
      "d.md",
    ])
  })

  it('removes a leading "#" in exact mode too', () => {
    const results = index.searchByTag({ tag: "#Project/Vault-MCP", exact: true }, logger)
    expect(results.map((result) => result.path)).toEqual(["a.md"])
  })

  it("rejects a tag that is only a #", () => {
    expect(() => index.searchByTag({ tag: "#" }, logger)).toThrow(
      new Error('tag must not be empty after its leading "#"'),
    )
  })

  it("exact match returns the tag itself, not tags nested under it", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [project]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )

    const results = index.searchByTag({ tag: "project", exact: true }, logger)
    expect(results.map((result) => result.path)).toEqual(["d.md"])
  })

  it("exact match finds specific tag", () => {
    const results = index.searchByTag({ tag: "project/vault-mcp", exact: true }, logger)
    expect(results.map((result) => result.path)).toEqual(["a.md"])
  })

  it("returns each match's full metadata, with tags other than the matched one", () => {
    index.upsertNote(
      {
        filePath: "Projects/plan.md",
        rawContent:
          "---\ntags: [project/alpha, planning]\ntype: plan\ncreated: 2026-01-15\nrelated: [Roadmap]\nstatus: active\n---\n> [!info] Scope\n> Next quarter.\n\nBody.\n",
        fileStat: testStat(4000, 321),
      },
      logger,
    )

    expect(index.searchByTag({ tag: "project/alpha" }, logger)).toEqual([
      {
        path: "Projects/plan.md",
        title: "plan",
        tags: ["project/alpha", "planning"],
        related: ["Roadmap"],
        folder: "Projects",
        type: "plan",
        created: DateTime.fromISO("2026-01-15").toISO(),
        modified: isoFromMillis(4000),
        bytes: 321,
        properties: {
          tags: ["project/alpha", "planning"],
          type: "plan",
          created: "2026-01-15",
          related: ["Roadmap"],
          status: "active",
        },
        leading_callout: { type: "info", title: "Scope", body: "Next quarter." },
      },
    ])
  })

  it("returns empty for non-existent tag", () => {
    const results = index.searchByTag({ tag: "nope" }, logger)
    expect(results).toHaveLength(0)
  })

  it("prefix match treats LIKE wildcards in the tag as literal characters", () => {
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [a_b/child]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    // Without escaping, LIKE 'a_b/%' would also match this tag — the "_"
    // wildcard matches the "x" in "axb".
    index.upsertNote(
      {
        filePath: "e.md",
        rawContent: "---\ntags: [axb/child]\n---\nbody\n",
        fileStat: testStat(5000),
      },
      logger,
    )

    const results = index.searchByTag({ tag: "a_b" }, logger)
    expect(results.map((result) => result.path)).toEqual(["d.md"])
  })
})

describe("searchByFolder", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "About Me/sub/deep.md",
        rawContent: "---\ntitle: Deep\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/notes.md",
        rawContent: "---\ntitle: P\n---\nbody\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("recursive mode includes nested files", () => {
    const results = index.searchByFolder({ folder: "About Me", recursive: true }, logger)
    expect(results).toHaveLength(2)
  })

  it("non-recursive mode excludes nested files", () => {
    const results = index.searchByFolder({ folder: "About Me", recursive: false }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("sorts results by most recently modified", () => {
    const results = index.searchByFolder({ folder: "About Me" }, logger)
    expect(results.map((note) => note.path)).toEqual([
      "About Me/sub/deep.md",
      "About Me/Principles.md",
    ])
  })

  it("strips trailing slashes from folder before matching", () => {
    const results = index.searchByFolder({ folder: "About Me/" }, logger)
    expect(results.map((note) => note.path)).toEqual([
      "About Me/sub/deep.md",
      "About Me/Principles.md",
    ])
  })

  it("does not match a sibling folder whose name starts with the folder's name", () => {
    index.upsertNote(
      {
        filePath: "ProjectsOld/old.md",
        rawContent: "---\ntitle: Old\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.searchByFolder({ folder: "Projects" }, logger)
    expect(results.map((note) => note.path)).toEqual(["Projects/notes.md"])
  })

  it("ignores ASCII letter case in folder", () => {
    const results = index.searchByFolder({ folder: "about me" }, logger)
    expect(results.map((note) => note.path)).toEqual([
      "About Me/sub/deep.md",
      "About Me/Principles.md",
    ])
  })

  it("applies limit after sorting, keeping the most recently modified notes", () => {
    // Principles.md was indexed first but is older, so it is the one cut.
    const results = index.searchByFolder({ folder: "About Me", limit: 1 }, logger)
    expect(results.map((note) => note.path)).toEqual(["About Me/sub/deep.md"])
  })
})

describe("listAllTags", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "About Me/Principles.md",
        rawContent: NOTE_WITH_FRONTMATTER,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "a.md",
        rawContent: "---\ntags: [principles, work]\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )
  })

  it("returns tags with counts ordered by count desc", () => {
    const tags = index.listAllTags({}, logger)
    expect(tags[0]).toEqual({ tag: "principles", count: 2 })
    expect(tags.find((tagEntry) => tagEntry.tag === "self")).toEqual({
      tag: "self",
      count: 1,
    })
  })

  it("merges spellings that differ in letter case under the most-used spelling, counting notes", () => {
    index.upsertNote(
      {
        filePath: "b.md",
        rawContent: "---\ntags: [work]\n---\nbody\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "c.md",
        rawContent: "---\ntags: [Work, Work, Work]\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "d.md",
        rawContent: "---\ntags: [WORK]\n---\nbody\n",
        fileStat: testStat(5000),
      },
      logger,
    )

    // `Work` wins with three occurrences in one note. Ranking by notes would
    // pick `work` (two notes), and the binary tie-break alone would pick `WORK`
    expect(index.listAllTags({}, logger)).toEqual([
      { tag: "Work", count: 4 },
      { tag: "principles", count: 2 },
      { tag: "self", count: 1 },
    ])
  })

  it("breaks a spelling tie by binary order and counts a note with both spellings once", () => {
    index.upsertNote(
      {
        filePath: "b.md",
        rawContent: "---\ntags: [tie, Tie]\n---\nbody\n",
        fileStat: testStat(3000),
      },
      logger,
    )

    // One occurrence each: `Tie` sorts before `tie` in binary order, though
    // `tie` comes first in the note, and the single note carrying both counts once
    expect(index.listAllTags({}, logger)).toEqual([
      { tag: "principles", count: 2 },
      { tag: "Tie", count: 1 },
      { tag: "self", count: 1 },
      { tag: "work", count: 1 },
    ])
  })

  it("adds no tag for a mapping-valued tags property", () => {
    const tagsBefore = index.listAllTags({}, logger)
    index.upsertNote(
      {
        filePath: "mapped.md",
        rawContent: "---\ntags:\n  project: true\n---\nmappedbody\n",
        fileStat: testStat(3000),
      },
      logger,
    )

    expect(
      index.fullTextSearch({ query: "mappedbody" }, logger).map((result) => result.path),
    ).toEqual(["mapped.md"])
    expect(index.listAllTags({}, logger)).toEqual(tagsBefore)
    expect(index.searchByTag({ tag: "[object Object]" }, logger)).toEqual([])
  })

  it("handles notes with no tags", () => {
    index.upsertNote(
      {
        filePath: "bare.md",
        rawContent: "no tags\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    const tags = index.listAllTags({}, logger)
    expect(tags).toHaveLength(3)
    const results = index.fullTextSearch({ query: "no tags" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("bare.md")
  })
})

describe("recentNotes", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "old.md",
        rawContent: "---\ncreated: 2025-01-01\n---\nold\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "new.md",
        rawContent: "---\ncreated: 2026-05-01\n---\nnew\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "no-created.md",
        rawContent: "no date\n",
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("sorts by modified by default", () => {
    const results = index.recentNotes({}, logger)
    expect(results[0]?.path).toBe("new.md")
    expect(results[1]?.path).toBe("no-created.md")
    expect(results[2]?.path).toBe("old.md")
  })

  it("sorts by created date", () => {
    const results = index.recentNotes({ sort_by: "created" }, logger)
    expect(results[0]?.path).toBe("new.md")
    expect(results[1]?.path).toBe("old.md")
  })

  it("puts nulls last for created sort", () => {
    const results = index.recentNotes({ sort_by: "created" }, logger)
    expect(results[results.length - 1]?.path).toBe("no-created.md")
  })

  it("respects limit", () => {
    const results = index.recentNotes({ limit: 1 }, logger)
    expect(results).toHaveLength(1)
  })

  it("floors a fractional limit instead of failing with SQLite's datatype mismatch", () => {
    const results = index.recentNotes({ limit: 1.9 }, logger)
    expect(results.map((note) => note.path)).toEqual(["new.md"])
  })
})

// ── Property query fixtures ──────────────────────────────────────

const NOTE_WITH_STATUS = `---
title: Active Project
type: project
tags: [project, active]
status: in-progress
priority: high
---

# Active Project

Work in progress.
`

const NOTE_WITH_DIFFERENT_STATUS = `---
title: Done Project
type: project
tags: [project, done]
status: done
priority: low
---

# Done Project

Completed work.
`

const NOTE_WITH_NO_CUSTOM_PROPS = `---
title: Plain Note
tags: [note]
---

# Plain Note

No custom properties.
`

describe("listPropertyKeys", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/active.md",
        rawContent: NOTE_WITH_STATUS,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/done.md",
        rawContent: NOTE_WITH_DIFFERENT_STATUS,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_WITH_NO_CUSTOM_PROPS,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("returns all property keys with counts", () => {
    const keys = index.listPropertyKeys({}, logger)
    expect(keys).toEqual([
      { key: "tags", count: 3, sample_values: ["project", "active", "done"] },
      { key: "title", count: 3, sample_values: ["Active Project", "Done Project", "Plain Note"] },
      { key: "priority", count: 2, sample_values: ["high", "low"] },
      { key: "status", count: 2, sample_values: ["done", "in-progress"] },
      { key: "type", count: 2, sample_values: ["project"] },
    ])
  })

  it("includes sample_values for each key", () => {
    const keys = index.listPropertyKeys({}, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toEqual({
      key: "status",
      count: 2,
      sample_values: ["done", "in-progress"],
    })
  })

  it("returns at most 3 sample values", () => {
    for (let i = 0; i < 5; i++) {
      index.upsertNote(
        {
          filePath: `extra/n${i}.md`,
          rawContent: `---\nvariety: value-${i}\n---\nbody\n`,
          fileStat: testStat(4000 + i),
        },
        logger,
      )
    }
    const keys = index.listPropertyKeys({}, logger)
    const varietyKey = keys.find((entry) => entry.key === "variety")
    expect(varietyKey).toEqual({
      key: "variety",
      count: 5,
      sample_values: ["value-0", "value-1", "value-2"],
    })
  })

  it("sorts by count descending", () => {
    const keys = index.listPropertyKeys({}, logger)
    for (let i = 1; i < keys.length; i++) {
      const prev = keys[i - 1]
      const curr = keys[i]

      if (!prev || !curr) continue
      expect(prev.count).toBeGreaterThanOrEqual(curr.count)
    }
  })

  it("respects folder filter", () => {
    const keys = index.listPropertyKeys({ folder: "Projects" }, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toBeDefined()
    expect(statusKey?.count).toBe(2)
  })

  it("folder filter excludes notes outside the folder", () => {
    const keys = index.listPropertyKeys({ folder: "notes" }, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toBeUndefined()
  })

  it("sample_values are scoped to the folder filter", () => {
    index.upsertNote(
      {
        filePath: "Other/other.md",
        rawContent: "---\nstatus: blocked\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const keys = index.listPropertyKeys({ folder: "Projects" }, logger)
    const statusKey = keys.find((entry) => entry.key === "status")
    expect(statusKey).toBeDefined()
    expect(statusKey?.sample_values).not.toContain("blocked")
  })

  /** Keys of the two Projects/ notes from beforeEach: every key appears in
   *  both, so all counts tie at 2 and the keys sort alphabetically. */
  const PROJECTS_FOLDER_KEYS = [
    { key: "priority", count: 2, sample_values: ["high", "low"] },
    { key: "status", count: 2, sample_values: ["done", "in-progress"] },
    { key: "tags", count: 2, sample_values: ["project", "active", "done"] },
    { key: "title", count: 2, sample_values: ["Active Project", "Done Project"] },
    { key: "type", count: 2, sample_values: ["project"] },
  ]

  it("does not match a sibling folder whose name starts with the folder's name", () => {
    index.upsertNote(
      {
        filePath: "ProjectsOld/old.md",
        rawContent: "---\nstatus: blocked\narchived_on: 2026-01-01\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const keys = index.listPropertyKeys({ folder: "Projects" }, logger)
    expect(keys).toEqual(PROJECTS_FOLDER_KEYS)
  })

  it("ignores ASCII letter case in folder", () => {
    const keys = index.listPropertyKeys({ folder: "projects" }, logger)
    expect(keys).toEqual(PROJECTS_FOLDER_KEYS)
  })

  it("counts notes whose value is null but leaves null out of sample_values", () => {
    const propertyIndex = createSearchIndex(":memory:")
    const reviewedValues = ["true", "false", "", "true"]
    reviewedValues.forEach((reviewedValue, noteNumber) => {
      propertyIndex.upsertNote(
        {
          filePath: `note-${noteNumber}.md`,
          rawContent: `---\nreviewed: ${reviewedValue}\n---\nbody\n`,
          fileStat: testStat(1000),
        },
        logger,
      )
    })

    // The empty value is YAML null. Checkbox values come back as "1" and "0".
    const keys = propertyIndex.listPropertyKeys({}, logger)
    expect(keys).toEqual([{ key: "reviewed", count: 4, sample_values: ["1", "0"] }])
  })

  it("ranks sample_values by counting each array element separately, keeping the top 3", () => {
    const propertyIndex = createSearchIndex(":memory:")
    const topicLists = ["[alpha, beta]", "[alpha]", "[gamma]", "[gamma]", "[delta]"]
    topicLists.forEach((topicList, noteNumber) => {
      propertyIndex.upsertNote(
        {
          filePath: `note-${noteNumber}.md`,
          rawContent: `---\ntopics: ${topicList}\n---\nbody\n`,
          fileStat: testStat(1000),
        },
        logger,
      )
    })

    // alpha and gamma occur twice; beta and delta once each, tied, so the
    // alphabetical tie-break keeps beta and drops delta.
    const keys = propertyIndex.listPropertyKeys({}, logger)
    expect(keys).toEqual([{ key: "topics", count: 5, sample_values: ["alpha", "gamma", "beta"] }])
  })
})

describe("listPropertyValues", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/active.md",
        rawContent: NOTE_WITH_STATUS,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/done.md",
        rawContent: NOTE_WITH_DIFFERENT_STATUS,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_WITH_NO_CUSTOM_PROPS,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("returns distinct values with counts for a scalar property", () => {
    const values = index.listPropertyValues({ key: "status" }, logger)
    expect(values).toHaveLength(2)
    expect(values.find((entry) => entry.value === "in-progress")).toEqual({
      value: "in-progress",
      count: 1,
    })
    expect(values.find((entry) => entry.value === "done")).toEqual({
      value: "done",
      count: 1,
    })
  })

  it("enumerates individual array elements for array properties", () => {
    const values = index.listPropertyValues({ key: "tags" }, logger)
    expect(values.find((entry) => entry.value === "project")).toBeDefined()
    expect(values.find((entry) => entry.value === "active")).toBeDefined()
    expect(values.find((entry) => entry.value === "note")).toBeDefined()
  })

  it("sorts by count descending", () => {
    const values = index.listPropertyValues({ key: "tags" }, logger)
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1]
      const curr = values[i]

      if (!prev || !curr) continue
      expect(prev.count).toBeGreaterThanOrEqual(curr.count)
    }
  })

  it("respects limit", () => {
    const values = index.listPropertyValues({ key: "tags", limit: 2 }, logger)
    expect(values).toHaveLength(2)
  })

  it("respects folder filter", () => {
    index.upsertNote(
      {
        filePath: "Other/excluded.md",
        rawContent: "---\nstatus: blocked\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const values = index.listPropertyValues({ key: "status", folder: "Projects" }, logger)
    expect(values).toHaveLength(2)
    const blockedValue = values.find((entry) => entry.value === "blocked")
    expect(blockedValue).toBeUndefined()
  })

  it("returns empty for non-existent key", () => {
    const values = index.listPropertyValues({ key: "nonexistent" }, logger)
    expect(values).toHaveLength(0)
  })

  it("does not match a sibling folder whose name starts with the folder's name", () => {
    index.upsertNote(
      {
        filePath: "ProjectsOld/old.md",
        rawContent: "---\nstatus: blocked\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const values = index.listPropertyValues({ key: "status", folder: "Projects" }, logger)
    expect(values).toEqual([
      { value: "done", count: 1 },
      { value: "in-progress", count: 1 },
    ])
  })

  it("ignores ASCII letter case in folder", () => {
    const values = index.listPropertyValues({ key: "status", folder: "projects" }, logger)
    expect(values).toEqual([
      { value: "done", count: 1 },
      { value: "in-progress", count: 1 },
    ])
  })

  it("combines scalar numbers and identical displayed text into one occurrence count", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "number-a.md", frontmatter: "rank: 4" },
      { filePath: "number-b.md", frontmatter: "rank: 4" },
      { filePath: "text.md", frontmatter: 'rank: "4"' },
    ])

    expect(propertyIndex.listPropertyValues({ key: "rank" }, logger)).toEqual([
      { value: "4", count: 3 },
    ])
  })

  it("counts checkbox values with the numbers 1 and 0 and skips null values", () => {
    const propertyIndex = createSearchIndex(":memory:")
    const reviewedValues = ["true", "1", "false", ""]
    reviewedValues.forEach((reviewedValue, noteNumber) => {
      propertyIndex.upsertNote(
        {
          filePath: `note-${noteNumber}.md`,
          rawContent: `---\nreviewed: ${reviewedValue}\n---\nbody\n`,
          fileStat: testStat(1000),
        },
        logger,
      )
    })

    // true groups with the number 1; the empty value is YAML null.
    const values = propertyIndex.listPropertyValues({ key: "reviewed" }, logger)
    expect(values).toEqual([
      { value: "1", count: 2 },
      { value: "0", count: 1 },
    ])
  })
})

describe("searchByProperty", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Projects/active.md",
        rawContent: NOTE_WITH_STATUS,
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/done.md",
        rawContent: NOTE_WITH_DIFFERENT_STATUS,
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/plain.md",
        rawContent: NOTE_WITH_NO_CUSTOM_PROPS,
        fileStat: testStat(3000),
      },
      logger,
    )
  })

  it("finds notes by scalar property value", () => {
    const results = index.searchByProperty({ key: "status", value: "in-progress" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/active.md")
  })

  it("finds notes by array property value", () => {
    const results = index.searchByProperty({ key: "tags", value: "active" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/active.md")
  })

  it("returns NoteMetadata with all fields", () => {
    const results = index.searchByProperty({ key: "status", value: "done" }, logger)
    expect(results).toHaveLength(1)
    const result = results[0]
    expect(result).toBeDefined()
    expect(result?.path).toBe("Projects/done.md")
    expect(result?.title).toBe("Done Project")
    expect(result?.tags).toEqual(["project", "done"])
    expect(result?.folder).toBe("Projects")
    expect(result?.type).toBe("project")
    expect(result?.bytes).toBe(100)
    expect(result?.properties).toEqual(expect.objectContaining({ status: "done", priority: "low" }))
  })

  it("returns empty for non-matching value", () => {
    const results = index.searchByProperty({ key: "status", value: "archived" }, logger)
    expect(results).toHaveLength(0)
  })

  it("returns empty for non-existent key", () => {
    const results = index.searchByProperty({ key: "nonexistent", value: "any" }, logger)
    expect(results).toHaveLength(0)
  })

  it("respects folder filter", () => {
    index.upsertNote(
      {
        filePath: "Other/also-active.md",
        rawContent: "---\nstatus: in-progress\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.searchByProperty(
      { key: "status", value: "in-progress", folder: "Projects" },
      logger,
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("Projects/active.md")
  })

  it("does not match a sibling folder whose name starts with the folder filter", () => {
    index.upsertNote(
      {
        filePath: "ProjectsOld/old.md",
        rawContent: "---\nstatus: in-progress\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.searchByProperty(
      { key: "status", value: "in-progress", folder: "Projects" },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["Projects/active.md"])
  })

  it("ignores ASCII letter case in the folder filter", () => {
    index.upsertNote(
      {
        filePath: "Other/also-active.md",
        rawContent: "---\nstatus: in-progress\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.searchByProperty(
      { key: "status", value: "in-progress", folder: "projects" },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["Projects/active.md"])
  })

  it("respects limit", () => {
    index.upsertNote(
      {
        filePath: "Projects/another.md",
        rawContent: "---\nstatus: in-progress\n---\nbody\n",
        fileStat: testStat(4000),
      },
      logger,
    )
    const results = index.searchByProperty(
      { key: "status", value: "in-progress", limit: 1 },
      logger,
    )
    expect(results).toHaveLength(1)
  })

  it("finds notes by YAML date property (normalized from Date object)", () => {
    index.upsertNote(
      {
        filePath: "dated.md",
        rawContent: "---\ndue: 2026-05-13\n---\nbody\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    const results = index.searchByProperty({ key: "due", value: "2026-05-13" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("dated.md")
  })

  it("compares values as text, so '1' matches the number 1, the text '1', and a checked checkbox", () => {
    const propertyIndex = createSearchIndex(":memory:")
    const rankValues = ["1", '"1"', "true", "0", "false", '"2"']
    rankValues.forEach((rankValue, noteNumber) => {
      propertyIndex.upsertNote(
        {
          filePath: `note-${noteNumber}.md`,
          rawContent: `---\nrank: ${rankValue}\n---\nbody\n`,
          fileStat: testStat(1000),
        },
        logger,
      )
    })

    const results = propertyIndex.searchByProperty({ key: "rank", value: "1" }, logger)
    expect(results.map((result) => result.path)).toEqual(["note-0.md", "note-1.md", "note-2.md"])

    const zeroResults = propertyIndex.searchByProperty({ key: "rank", value: "0" }, logger)
    expect(zeroResults.map((result) => result.path)).toEqual(["note-3.md", "note-4.md"])

    const trueResults = propertyIndex.searchByProperty({ key: "rank", value: "true" }, logger)
    expect(trueResults).toEqual([])
  })
})

// Obsidian accepts any property name, and YAML keeps "a.b" or "k[0]" as
// one flat key. Every property query must match such a key as data, never
// read it as JSON path syntax.
describe("property keys containing JSON path syntax", () => {
  const PATH_SYNTAX_KEYS = [
    { label: "a dotted key", key: "a.b", value: "dotted-value" },
    { label: "a bracketed key", key: "k[0]", value: "bracket-value" },
  ]

  const seedPathSyntaxNotes = (): void => {
    index.upsertNote(
      {
        filePath: "Projects/path-syntax-keys.md",
        rawContent:
          '---\na.b: dotted-value\n"k[0]": bracket-value\nplain: shared\n---\nsearchable body\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    // Carries both requested values under other keys, so a query that
    // ignores the key would still match it.
    index.upsertNote(
      {
        filePath: "Projects/decoy-other-keys.md",
        rawContent:
          "---\nother: dotted-value\nanother: bracket-value\nplain: shared\n---\nsearchable body\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "notes/decoy-no-keys.md",
        rawContent: "---\nplain: shared\n---\nsearchable body\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    // Matches the search text but carries none of the filtered keys, so a
    // filter that stops constraining results would let it through.
    index.upsertNote(
      {
        filePath: "notes/decoy-unfiltered.md",
        rawContent: "---\nunrelated: x\n---\nsearchable body\n",
        fileStat: testStat(4000),
      },
      logger,
    )
  }

  it.each(PATH_SYNTAX_KEYS)("listPropertyKeys samples the values of $label", ({ key, value }) => {
    seedPathSyntaxNotes()
    const keys = index.listPropertyKeys({}, logger)

    expect(keys.find((entry) => entry.key === key)).toEqual({
      key,
      count: 1,
      sample_values: [value],
    })
  })

  it.each(PATH_SYNTAX_KEYS)("listPropertyValues counts the values of $label", ({ key, value }) => {
    seedPathSyntaxNotes()

    expect(index.listPropertyValues({ key }, logger)).toEqual([{ value, count: 1 }])
  })

  it.each(PATH_SYNTAX_KEYS)("searchByProperty matches $label", ({ key, value }) => {
    seedPathSyntaxNotes()
    const results = index.searchByProperty({ key, value }, logger)

    expect(results.map((result) => result.path)).toEqual(["Projects/path-syntax-keys.md"])
  })

  it.each(PATH_SYNTAX_KEYS)(
    "fullTextSearch's properties filter matches $label",
    ({ key, value }) => {
      seedPathSyntaxNotes()
      const results = index.fullTextSearch(
        { query: "searchable", filters: { properties: { [key]: value } } },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["Projects/path-syntax-keys.md"])
    },
  )

  it("fullTextSearch's properties filter keeps matching a plain key", () => {
    seedPathSyntaxNotes()
    const results = index.fullTextSearch(
      { query: "searchable", filters: { properties: { plain: "shared" } } },
      logger,
    )

    expect(results.map((result) => result.path).toSorted()).toEqual([
      "Projects/decoy-other-keys.md",
      "Projects/path-syntax-keys.md",
      "notes/decoy-no-keys.md",
    ])
  })

  it("array values under a dotted key are enumerated and matched", () => {
    index.upsertNote(
      {
        filePath: "Projects/array-under-dotted-key.md",
        rawContent: "---\nc.d:\n  - one\n  - two\n---\nbody\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/decoy-scalar-dotted-key.md",
        rawContent: "---\nc.d: three\n---\nbody\n",
        fileStat: testStat(2000),
      },
      logger,
    )

    expect(index.listPropertyValues({ key: "c.d" }, logger)).toEqual([
      { value: "one", count: 1 },
      { value: "three", count: 1 },
      { value: "two", count: 1 },
    ])
    const matches = index.searchByProperty({ key: "c.d", value: "one" }, logger)
    expect(matches.map((result) => result.path)).toEqual(["Projects/array-under-dotted-key.md"])
  })

  it("fullTextSearch's properties filter matches a list property by any element", () => {
    index.upsertNote(
      {
        filePath: "Projects/co-authored.md",
        rawContent: "---\nauthors:\n  - Alice\n  - Bob\n---\nsearchable body\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/solo.md",
        rawContent: "---\nauthors:\n  - Carol\n---\nsearchable body\n",
        fileStat: testStat(2000),
      },
      logger,
    )

    const results = index.fullTextSearch(
      { query: "searchable", filters: { properties: { authors: "Bob" } } },
      logger,
    )

    expect(results.map((result) => result.path)).toEqual(["Projects/co-authored.md"])
  })

  it("fullTextSearch's properties filter compares values by exact type", () => {
    index.upsertNote(
      {
        filePath: "Projects/rated.md",
        rawContent: "---\nrating: 4\n---\nsearchable body\n",
        fileStat: testStat(1000),
      },
      logger,
    )

    const asNumber = index.fullTextSearch(
      { query: "searchable", filters: { properties: { rating: 4 } } },
      logger,
    )
    const asString = index.fullTextSearch(
      { query: "searchable", filters: { properties: { rating: "4" } } },
      logger,
    )

    expect(asNumber.map((result) => result.path)).toEqual(["Projects/rated.md"])
    expect(asString.map((result) => result.path)).toEqual([])
  })

  it.each([
    { label: "an object scalar", stored: "{a: 1}", other: "{a: 2}", wanted: '{"a":1}' },
    {
      label: "an object with a large nested number",
      stored: "{v: 1e21}",
      other: "{v: 2e21}",
      wanted: '{"v":1e+21}',
    },
    {
      label: "an object list member with a small nested number",
      stored: "[{v: 1e-7}]",
      other: "[{v: 2e-7}]",
      wanted: '{"v":1e-7}',
    },
    {
      label: "a nested list member with exponent numbers",
      stored: "[[1e21, 1e-7]]",
      other: "[[2e21, 2e-7]]",
      wanted: "[1e+21,1e-7]",
    },
  ])("fullTextSearch matches $label by stored JSON text", ({ stored, other, wanted }) => {
    const propertyIndex = createPropertyTestIndex()
    const propertyNotes = [
      { path: "Projects/matched.md", key: "meta", value: stored, body: "searchable" },
      { path: "Projects/wrong-key.md", key: "other", value: stored, body: "searchable" },
      { path: "Projects/wrong-value.md", key: "meta", value: other, body: "searchable" },
      { path: "Projects/unrelated.md", key: "meta", value: stored, body: "unrelated" },
    ]

    for (const note of propertyNotes) {
      propertyIndex.upsertNote(
        {
          filePath: note.path,
          rawContent: `---\n${note.key}: ${note.value}\n---\n${note.body}\n`,
          fileStat: testStat(1000),
        },
        logger,
      )
    }

    const results = propertyIndex.fullTextSearch(
      { query: "searchable", filters: { properties: { meta: wanted } } },
      logger,
    )

    expect(results.map((result) => result.path)).toEqual(["Projects/matched.md"])
  })

  it("fullTextSearch's properties filter matches a boolean value", () => {
    index.upsertNote(
      {
        filePath: "Projects/published.md",
        rawContent: "---\npublished: true\n---\nsearchable body\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/draft.md",
        rawContent: "---\npublished: false\n---\nsearchable body\n",
        fileStat: testStat(2000),
      },
      logger,
    )

    const results = index.fullTextSearch(
      { query: "searchable", filters: { properties: { published: true } } },
      logger,
    )

    expect(results.map((result) => result.path)).toEqual(["Projects/published.md"])
  })

  it.each([
    { label: "positive", source: "1000000000000000128", differentNumber: "1000000000000000256" },
    { label: "negative", source: "-1000000000000000128", differentNumber: "-1000000000000000256" },
  ])(
    "fullTextSearch matches $label scalar and list numbers at stored JavaScript precision",
    ({ source, differentNumber }) => {
      const propertyIndex = createPropertyTestIndex()
      seedPropertyNotes(propertyIndex, [
        { filePath: "list.md", frontmatter: `rank: [${source}, ${source}]` },
        { filePath: "scalar.md", frontmatter: `rank: ${source}` },
        { filePath: "text.md", frontmatter: `rank: ${JSON.stringify(String(Number(source)))}` },
        { filePath: "different.md", frontmatter: `rank: ${differentNumber}` },
        { filePath: "wrong-key.md", frontmatter: `other: ${source}` },
      ])

      const results = propertyIndex.fullTextSearch(
        { query: "searchable", filters: { properties: { rank: Number(source) } } },
        logger,
      )

      expect(results.map((result) => result.path).toSorted()).toEqual(["list.md", "scalar.md"])
    },
  )
})

describe("displayed property value grouping", () => {
  it("combines scalar and repeated list members across numeric, text, and checkbox values", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "scalar.md", frontmatter: "rank: 4" },
      {
        filePath: "list.md",
        frontmatter: 'rank: [4, "4", 4.0, true, 1, "1", false, 0, "0", null, "", "4.0"]',
      },
      { filePath: "null.md", frontmatter: "rank: null" },
    ])

    expect(propertyIndex.listPropertyValues({ key: "rank" }, logger)).toEqual([
      { value: "4", count: 4 },
      { value: "0", count: 3 },
      { value: "1", count: 3 },
      { value: "", count: 1 },
      { value: "4.0", count: 1 },
    ])
    expect(propertyIndex.listPropertyKeys({}, logger)).toEqual([
      { key: "rank", count: 3, sample_values: ["4", "0", "1"] },
    ])
  })

  it("combines objects and nested arrays with their identical JSON text without deeper expansion", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "object.md", frontmatter: "rank: {a: 1}" },
      { filePath: "object-text.md", frontmatter: `rank: '{"a":1}'` },
      { filePath: "nested.md", frontmatter: `rank: [[2, 3], '[2,3]', null, ""]` },
    ])

    expect(propertyIndex.listPropertyValues({ key: "rank" }, logger)).toEqual([
      { value: "[2,3]", count: 2 },
      { value: '{"a":1}', count: 2 },
      { value: "", count: 1 },
    ])
  })

  it("combines occurrences before the value limit and scopes both counting queries by folder and key", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "Projects/numbers.md", frontmatter: "rank: [1, 1, 1]" },
      { filePath: "Projects/text.md", frontmatter: 'rank: ["1", "1", "1"]' },
      { filePath: "Projects/decoy.md", frontmatter: "rank: [2, 2, 2, 2]" },
      { filePath: "Projects/other-key.md", frontmatter: "other: [2, 2, 2, 2, 2, 2, 2]" },
      { filePath: "Other/outside.md", frontmatter: "rank: [2, 2, 2, 2, 2, 2, 2]" },
      { filePath: "ProjectsOld/sibling.md", frontmatter: "rank: [2, 2, 2, 2, 2, 2, 2]" },
    ])

    expect(
      propertyIndex.listPropertyValues({ key: "rank", folder: "projects", limit: 1 }, logger),
    ).toEqual([{ value: "1", count: 6 }])
    expect(propertyIndex.listPropertyKeys({ folder: "projects" }, logger)).toEqual([
      { key: "rank", count: 3, sample_values: ["1", "2"] },
      { key: "other", count: 1, sample_values: ["2"] },
    ])
  })

  it("fills top-three sample slots with distinct combined values before dropping lower-ranked decoys", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "numbers.md", frontmatter: "rank: [1, 1, 1]" },
      { filePath: "text.md", frontmatter: 'rank: ["1", "1", "1"]' },
      { filePath: "second.md", frontmatter: "rank: [2, 2, 2, 2]" },
      { filePath: "third.md", frontmatter: "rank: [3, 3]" },
      { filePath: "fourth.md", frontmatter: "rank: 4" },
    ])

    expect(propertyIndex.listPropertyKeys({}, logger)).toEqual([
      { key: "rank", count: 5, sample_values: ["1", "2", "3"] },
    ])
  })

  it("orders equal-count displayed strings by UTF-8 bytes rather than numeric or UTF-16 order", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "values.md", frontmatter: 'rank: [2, 10, "😀", "\uE000"]' },
    ])

    expect(propertyIndex.listPropertyValues({ key: "rank" }, logger)).toEqual([
      { value: "10", count: 1 },
      { value: "2", count: 1 },
      { value: "\uE000", count: 1 },
      { value: "😀", count: 1 },
    ])
    expect(propertyIndex.listPropertyKeys({}, logger)).toEqual([
      { key: "rank", count: 1, sample_values: ["10", "2", "\uE000"] },
    ])
  })

  it.each([
    { label: "a precise decimal", source: "43.65322512345678", displayed: "43.65322512345678" },
    { label: "a small exponent", source: "0.0000001", displayed: "1e-7" },
    { label: "a large exponent", source: "1e21", displayed: "1e+21" },
    {
      label: "a rounded large integer",
      source: "12345678901234567890",
      displayed: "12345678901234567000",
    },
  ])(
    "preserves the displayed number for $label and combines its scalar, list, and text occurrences",
    ({ source, displayed }) => {
      const propertyIndex = createPropertyTestIndex()
      seedPropertyNotes(propertyIndex, [
        { filePath: "scalar.md", frontmatter: `rank: ${source}` },
        { filePath: "list.md", frontmatter: `rank: [${source}]` },
        { filePath: "text.md", frontmatter: `rank: ${JSON.stringify(displayed)}` },
      ])

      expect(propertyIndex.listPropertyValues({ key: "rank" }, logger)).toEqual([
        { value: displayed, count: 3 },
      ])
      expect(propertyIndex.listPropertyKeys({}, logger)).toEqual([
        { key: "rank", count: 3, sample_values: [displayed] },
      ])
    },
  )
})

describe("numeric property search", () => {
  it.each([
    {
      label: "a precise decimal",
      source: "43.65322512345678",
      displayed: "43.65322512345678",
      exponent: "4.365322512345678e1",
    },
    { label: "a small exponent", source: "0.0000001", displayed: "1e-7", exponent: "1e-7" },
    { label: "a large exponent", source: "1e21", displayed: "1e+21", exponent: "1e21" },
    {
      label: "a rounded large integer",
      source: "12345678901234567890",
      displayed: "12345678901234567000",
      exponent: "1.2345678901234567e19",
    },
    {
      label: "a positive int64 binary64 mismatch",
      source: "1000000000000000128",
      displayed: "1000000000000000100",
      exponent: "1.000000000000000128e18",
    },
    {
      label: "a negative int64 binary64 mismatch",
      source: "-1000000000000000128",
      displayed: "-1000000000000000100",
      exponent: "-1.000000000000000128e18",
    },
  ])(
    "finds scalar and list numbers from source, listed, and exponent forms for $label",
    ({ source, displayed, exponent }) => {
      const propertyIndex = createPropertyTestIndex()
      const queryValues = [...new Set([source, displayed, exponent])]
      seedPropertyNotes(propertyIndex, [
        { filePath: "Projects/scalar.md", frontmatter: `rank: ${source}` },
        { filePath: "Projects/list.md", frontmatter: `rank: [${source}, ${source}]` },
        { filePath: "Projects/wrong-key.md", frontmatter: `other: ${source}` },
        { filePath: "ProjectsOld/sibling.md", frontmatter: `rank: ${source}` },
        { filePath: "Other/outside.md", frontmatter: `rank: ${source}` },
        ...queryValues.map((queryValue, queryNumber) => ({
          filePath: `Projects/text-${queryNumber}.md`,
          frontmatter: `rank: ${JSON.stringify(queryValue)}`,
        })),
      ])

      queryValues.forEach((queryValue, queryNumber) => {
        const results = propertyIndex.searchByProperty(
          { key: "rank", value: queryValue, folder: "projects" },
          logger,
        )
        expect(results.map((result) => result.path)).toEqual([
          "Projects/list.md",
          "Projects/scalar.md",
          `Projects/text-${queryNumber}.md`,
        ])
      })
    },
  )

  it.each([
    {
      label: "the exact integer below 2^53",
      source: "9007199254740991",
      alias: "9.007199254740991e15",
      differentNumber: "9007199254740992",
    },
    {
      label: "a rounded positive alias at 2^53",
      source: "9007199254740992",
      alias: "9007199254740993",
      differentNumber: "9007199254740994",
    },
    {
      label: "a rounded negative alias at 2^53",
      source: "-9007199254740992",
      alias: "-9007199254740993",
      differentNumber: "-9007199254740994",
    },
    { label: "underflow to zero", source: "0", alias: "1e-999", differentNumber: "1" },
  ])(
    "matches the stored JavaScript number for $label while keeping exact text and checkboxes distinct",
    ({ source, alias, differentNumber }) => {
      const propertyIndex = createPropertyTestIndex()
      seedPropertyNotes(propertyIndex, [
        { filePath: "a-source.md", frontmatter: `rank: ${source}` },
        { filePath: "b-alias.md", frontmatter: `rank: ${alias}` },
        { filePath: "c-list.md", frontmatter: `rank: [${source}, ${alias}]` },
        { filePath: "d-source-text.md", frontmatter: `rank: ${JSON.stringify(source)}` },
        { filePath: "e-alias-text.md", frontmatter: `rank: ${JSON.stringify(alias)}` },
        { filePath: "f-checkbox.md", frontmatter: "rank: false" },
        { filePath: "g-different-number.md", frontmatter: `rank: ${differentNumber}` },
      ])

      const results = propertyIndex.searchByProperty({ key: "rank", value: alias }, logger)
      expect(results.map((result) => result.path)).toEqual([
        "a-source.md",
        "b-alias.md",
        "c-list.md",
        "e-alias-text.md",
      ])

      const sourceResults = propertyIndex.searchByProperty({ key: "rank", value: source }, logger)
      const exactSourcePaths = ["a-source.md", "b-alias.md", "c-list.md", "d-source-text.md"]
      const sourcePaths = source === "0" ? [...exactSourcePaths, "f-checkbox.md"] : exactSourcePaths
      expect(sourceResults.map((result) => result.path)).toEqual(sourcePaths)
    },
  )

  it.each([
    { label: "canonical digits", queryValue: "4", numberValue: "4" },
    { label: "leading-zero decimal", queryValue: "04", numberValue: "4" },
    { label: "explicit positive sign", queryValue: "+4", numberValue: "4" },
    { label: "decimal fraction", queryValue: "4.0", numberValue: "4" },
    { label: "leading decimal point", queryValue: ".5", numberValue: "0.5" },
    { label: "signed leading decimal point", queryValue: "-.5", numberValue: "-0.5" },
    { label: "trailing decimal point", queryValue: "4.", numberValue: "4" },
    { label: "decimal exponent", queryValue: "4e0", numberValue: "4" },
    { label: "signed uppercase exponent", queryValue: "4E+0", numberValue: "4" },
    { label: "hexadecimal", queryValue: "0x10", numberValue: "16" },
    { label: "octal", queryValue: "0o10", numberValue: "8" },
    { label: "a checkbox-like numeric spelling", queryValue: "1.0", numberValue: "1" },
  ])(
    "accepts $label for stored numbers without normalizing literal text or checkboxes",
    ({ queryValue, numberValue }) => {
      const propertyIndex = createPropertyTestIndex()
      seedPropertyNotes(propertyIndex, [
        { filePath: "a-number.md", frontmatter: `rank: ${numberValue}` },
        { filePath: "b-list.md", frontmatter: `rank: [${numberValue}]` },
        { filePath: "c-exact-text.md", frontmatter: `rank: ${JSON.stringify(queryValue)}` },
        { filePath: "d-list-text.md", frontmatter: `rank: [${JSON.stringify(queryValue)}]` },
        { filePath: "e-decoy-text.md", frontmatter: 'rank: "4.00"' },
        { filePath: "f-checkbox.md", frontmatter: "rank: true" },
        { filePath: "g-list-checkbox.md", frontmatter: "rank: [true]" },
        ...(queryValue === numberValue
          ? []
          : [
              {
                filePath: "h-canonical-text.md",
                frontmatter: `rank: ${JSON.stringify(numberValue)}`,
              },
            ]),
      ])

      const results = propertyIndex.searchByProperty({ key: "rank", value: queryValue }, logger)
      expect(results.map((result) => result.path)).toEqual([
        "a-number.md",
        "b-list.md",
        "c-exact-text.md",
        "d-list-text.md",
      ])
    },
  )

  it.each([
    { label: "empty text", queryValue: "" },
    { label: "whitespace", queryValue: " " },
    { label: "leading whitespace", queryValue: " 4" },
    { label: "trailing whitespace", queryValue: "4 " },
    { label: "a final newline", queryValue: "4\n" },
    { label: "a final CRLF", queryValue: "4\r\n" },
    { label: "a numeric prefix", queryValue: "4cats" },
    { label: "a comment", queryValue: "4 # comment" },
    { label: "an expression", queryValue: "2+2" },
    { label: "binary notation", queryValue: "0b100" },
    { label: "a separator", queryValue: "1_000" },
    { label: "an uppercase hexadecimal prefix", queryValue: "0X10" },
    { label: "an uppercase octal prefix", queryValue: "0O10" },
    { label: "signed hexadecimal", queryValue: "+0x10" },
    { label: "Infinity", queryValue: "Infinity" },
    { label: "YAML infinity", queryValue: ".inf" },
    { label: "NaN", queryValue: "NaN" },
    { label: "YAML NaN", queryValue: ".nan" },
    { label: "overflow", queryValue: "1e999" },
  ])("keeps $label as an exact text query without a numeric match", ({ queryValue }) => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "a-text.md", frontmatter: `rank: ${JSON.stringify(queryValue)}` },
      { filePath: "b-list-text.md", frontmatter: `rank: [${JSON.stringify(queryValue)}]` },
      { filePath: "c-numbers.md", frontmatter: "rank: [0, 1, 4, 8, 16, 1000]" },
      { filePath: "d-checkbox.md", frontmatter: "rank: false" },
      { filePath: "e-other-text.md", frontmatter: 'rank: "4"' },
    ])

    const results = propertyIndex.searchByProperty({ key: "rank", value: queryValue }, logger)
    expect(results.map((result) => result.path)).toEqual(["a-text.md", "b-list-text.md"])
  })

  it.each([
    { label: "object JSON", structuredValue: "{a: 1}", queryValue: '{"a":1}' },
    { label: "nested-list JSON", structuredValue: "[[2, 3]]", queryValue: "[2,3]" },
  ])("preserves exact matching for $label", ({ structuredValue, queryValue }) => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "a-structured.md", frontmatter: `rank: ${structuredValue}` },
      { filePath: "b-text.md", frontmatter: `rank: ${JSON.stringify(queryValue)}` },
      { filePath: "c-number.md", frontmatter: "rank: 1" },
    ])

    const results = propertyIndex.searchByProperty({ key: "rank", value: queryValue }, logger)
    expect(results.map((result) => result.path)).toEqual(["a-structured.md", "b-text.md"])
  })

  it("preserves checkbox digit matching in scalar and list properties", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "a-checkbox-list.md", frontmatter: "rank: [true, false]" },
      { filePath: "b-number-list.md", frontmatter: "rank: [1, 0]" },
      { filePath: "c-text-list.md", frontmatter: 'rank: ["1", "0"]' },
      { filePath: "d-checked.md", frontmatter: "rank: true" },
      { filePath: "e-unchecked.md", frontmatter: "rank: false" },
    ])

    const checkedResults = propertyIndex.searchByProperty({ key: "rank", value: "1" }, logger)
    const uncheckedResults = propertyIndex.searchByProperty({ key: "rank", value: "0" }, logger)

    expect(checkedResults.map((result) => result.path)).toEqual([
      "a-checkbox-list.md",
      "b-number-list.md",
      "c-text-list.md",
      "d-checked.md",
    ])
    expect(uncheckedResults.map((result) => result.path)).toEqual([
      "a-checkbox-list.md",
      "b-number-list.md",
      "c-text-list.md",
      "e-unchecked.md",
    ])
  })

  it("preserves mtime/path ordering and applies the limit after numeric matching", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "z-list.md", frontmatter: "rank: [4]" },
      { filePath: "a-number.md", frontmatter: "rank: 4" },
      { filePath: "b-text.md", frontmatter: 'rank: "4.0"' },
    ])
    propertyIndex.upsertNote(
      { filePath: "newest.md", rawContent: "---\nrank: 4\n---\nbody\n", fileStat: testStat(2000) },
      logger,
    )

    const results = propertyIndex.searchByProperty({ key: "rank", value: "4.0", limit: 2 }, logger)
    expect(results.map((result) => result.path)).toEqual(["newest.md", "a-number.md"])
  })

  it("leaves full-text property number/string distinction and boolean-to-number normalization unchanged", () => {
    const propertyIndex = createPropertyTestIndex()
    seedPropertyNotes(propertyIndex, [
      { filePath: "number.md", frontmatter: "rank: 4\nreviewed: 1" },
      { filePath: "text.md", frontmatter: 'rank: "4"\nreviewed: "1"' },
      { filePath: "checkbox.md", frontmatter: "rank: 5\nreviewed: true" },
      { filePath: "false.md", frontmatter: "rank: 5\nreviewed: false" },
      { filePath: "other-key.md", frontmatter: "other: 4" },
    ])

    const numberResults = propertyIndex.fullTextSearch(
      { query: "searchable", filters: { properties: { rank: 4 } } },
      logger,
    )
    const textResults = propertyIndex.fullTextSearch(
      { query: "searchable", filters: { properties: { rank: "4" } } },
      logger,
    )
    const checkboxResults = propertyIndex.fullTextSearch(
      { query: "searchable", filters: { properties: { reviewed: true } } },
      logger,
    )

    expect(numberResults.map((result) => result.path)).toEqual(["number.md"])
    expect(textResults.map((result) => result.path)).toEqual(["text.md"])
    expect(checkboxResults.map((result) => result.path).toSorted()).toEqual([
      "checkbox.md",
      "number.md",
    ])
  })
})

describe("markdown path requirement", () => {
  it("getBacklinks rejects a path without .md or .canvas extension", () => {
    expect(() => index.getBacklinks({ path: "Projects/Plan" }, logger)).toThrow(
      /^path must end in "\.md" or "\.canvas" \(received "Projects\/Plan"\)$/,
    )
  })

  it("getOutgoingLinks rejects a path without .md or .canvas extension", () => {
    expect(() => index.getOutgoingLinks({ path: "Projects/Plan" }, logger)).toThrow(
      /^path must end in "\.md" or "\.canvas" \(received "Projects\/Plan"\)$/,
    )
  })
})

describe("rebuildFromVault bounded I/O", () => {
  it.each([
    { operation: "size", extension: ".png", table: "non_md_files", decoyName: "healthy.md" },
    { operation: "note", extension: ".md", table: "notes", decoyName: "healthy.txt" },
    { operation: "text", extension: ".txt", table: "file_content", decoyName: "healthy.md" },
    { operation: "canvas", extension: ".canvas", table: "file_content", decoyName: "healthy.md" },
  ] as const)(
    "bounds the $operation pass to 16 operations and indexes its seventeenth item",
    async ({ operation, extension, table, decoyName }) => {
      const directory = await mkdtemp(join(tmpdir(), "rebuild-bound-"))
      const vaultPath = join(directory, "vault")
      const releaseGate = Promise.withResolvers<undefined>()
      const boundReached = Promise.withResolvers<undefined>()
      const pendingRebuilds: Promise<unknown>[] = []
      const restoreOperations: Array<() => void> = []
      const openDatabases: Database.Database[] = []
      onTestFinished(async () => {
        releaseGate.resolve(undefined)
        await Promise.allSettled(pendingRebuilds)
        restoreOperations.forEach((restore) => restore())
        openDatabases.forEach((database) => database.close())
        await rm(directory, { recursive: true, force: true })
      })
      await mkdir(vaultPath)
      const targetFiles = Array.from(
        { length: 17 },
        (_unused, index) => `source-${String(index).padStart(2, "0")}${extension}`,
      )
      for (const fileName of targetFiles) {
        const content =
          extension === ".canvas"
            ? JSON.stringify({
                nodes: [
                  {
                    id: "text",
                    type: "text",
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                    text: "targetquartz",
                  },
                ],
                edges: [],
              })
            : "targetquartz"
        await writeFile(join(vaultPath, fileName), content)
      }
      await writeFile(join(vaultPath, decoyName), "decoyamber")
      const targetPaths = new Set(targetFiles.map((fileName) => join(vaultPath, fileName)))
      const activePaths = new Set<string>()
      const startedPaths = new Set<string>()
      const activeCounts: number[] = []
      const holdTargetOperation = async (requestedPath: string): Promise<void> => {
        startedPaths.add(requestedPath)
        activePaths.add(requestedPath)
        activeCounts.push(activePaths.size)
        if (activePaths.size === 16) boundReached.resolve(undefined)
        await releaseGate.promise
        activePaths.delete(requestedPath)
      }
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      const actualFsUtils =
        await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")

      if (operation === "size") {
        const statSpy = vi.mocked(statOrNull).mockImplementation(async (requestedPath) => {
          if (targetPaths.has(requestedPath)) await holdTargetOperation(requestedPath)
          return actualFsUtils.statOrNull(requestedPath)
        })
        restoreOperations.push(() => statSpy.mockRestore())
      }
      if (operation !== "size") {
        const readSpy = vi.mocked(readFile).mockImplementation(async (requestedPath, options) => {
          if (typeof requestedPath === "string" && targetPaths.has(requestedPath))
            await holdTargetOperation(requestedPath)
          return actualFs.readFile(requestedPath, options)
        })
        restoreOperations.push(() => readSpy.mockRestore())
      }
      const dbPath = join(directory, "search.db")
      const search = createSearchIndex(dbPath, undefined, undefined, { fileToolsEnabled: true })
      const database = new Database(dbPath, { readonly: true })
      openDatabases.push(database)
      const rebuilding = search.rebuildFromVault({ vaultPath }, logger)
      pendingRebuilds.push(rebuilding)
      await boundReached.promise
      await setImmediateAsync()

      expect(activePaths.size).toBe(16)
      expect(startedPaths.size).toBe(16)
      expect(database.prepare(`SELECT path FROM ${table}`).all()).toEqual([])
      releaseGate.resolve(undefined)
      const rebuilt = await rebuilding
      await rebuilt.embedding

      expect(Math.max(...activeCounts)).toBe(16)
      expect(activePaths.size).toBe(0)
      expect(startedPaths.size).toBe(17)
      expect(database.prepare(`SELECT path FROM ${table} ORDER BY path`).all()).toEqual(
        targetFiles.map((path) => ({ path })),
      )
      expect(
        (await search.hybridSearch({ query: "targetquartz" }, logger)).results
          .map((entry) => entry.path)
          .toSorted(),
      ).toEqual(operation === "size" ? [] : targetFiles)
      expect(
        (await search.hybridSearch({ query: "decoyamber" }, logger)).results.map(
          (entry) => entry.path,
        ),
      ).toEqual([decoyName])
    },
  )

  it("bounds PDF extraction to four operations and indexes its fifth item", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rebuild-pdf-bound-"))
    const vaultPath = join(directory, "vault")
    const releaseGate = Promise.withResolvers<undefined>()
    const boundReached = Promise.withResolvers<undefined>()
    const pendingRebuilds: Promise<unknown>[] = []
    const restoreOperations: Array<() => void> = []
    const openDatabases: Database.Database[] = []
    onTestFinished(async () => {
      releaseGate.resolve(undefined)
      await Promise.allSettled(pendingRebuilds)
      restoreOperations.forEach((restore) => restore())
      openDatabases.forEach((database) => database.close())
      await rm(directory, { recursive: true, force: true })
    })
    await mkdir(vaultPath)
    const targetFiles = Array.from({ length: 5 }, (_unused, index) => `source-${index}.pdf`)
    const targetMarkers = new Set(targetFiles.map((fileName) => `marker-${fileName}`))
    for (const fileName of targetFiles)
      await writeFile(join(vaultPath, fileName), `marker-${fileName}`)
    await writeFile(join(vaultPath, "healthy.md"), "decoyamber")
    await writeFile(join(vaultPath, "healthy.txt"), "decoyberyl")
    const activeMarkers = new Set<string>()
    const startedMarkers = new Set<string>()
    const activeCounts: number[] = []
    const extractSpy = vi.mocked(extractPdfText).mockImplementation(async (pdfData) => {
      const marker = Buffer.from(pdfData).toString("utf8")

      if (!targetMarkers.has(marker)) throw new Error(`unexpected PDF input: ${marker}`)
      startedMarkers.add(marker)
      activeMarkers.add(marker)
      activeCounts.push(activeMarkers.size)
      if (activeMarkers.size === 4) boundReached.resolve(undefined)
      await releaseGate.promise
      activeMarkers.delete(marker)
      return { text: "pdfquartz", totalPages: 1 }
    })
    restoreOperations.push(() => extractSpy.mockRestore())
    const dbPath = join(directory, "search.db")
    const search = createSearchIndex(dbPath, undefined, undefined, { fileToolsEnabled: true })
    const database = new Database(dbPath, { readonly: true })
    openDatabases.push(database)
    const rebuilding = search.rebuildFromVault({ vaultPath }, logger)
    pendingRebuilds.push(rebuilding)
    await boundReached.promise
    await setImmediateAsync()

    expect(activeMarkers.size).toBe(4)
    expect(startedMarkers.size).toBe(4)
    releaseGate.resolve(undefined)
    const rebuilt = await rebuilding
    await rebuilt.embedding

    expect(Math.max(...activeCounts)).toBe(4)
    expect(activeMarkers.size).toBe(0)
    expect(startedMarkers.size).toBe(5)
    expect(database.prepare("SELECT path FROM file_content ORDER BY path").all()).toEqual(
      ["healthy.txt", ...targetFiles].map((path) => ({ path })),
    )
    expect(
      (await search.hybridSearch({ query: "pdfquartz" }, logger)).results
        .map((entry) => entry.path)
        .toSorted(),
    ).toEqual(targetFiles)
    expect(
      (await search.hybridSearch({ query: "decoyamber" }, logger)).results.map(
        (entry) => entry.path,
      ),
    ).toEqual(["healthy.md"])
    expect(
      (await search.hybridSearch({ query: "decoyberyl" }, logger)).results.map(
        (entry) => entry.path,
      ),
    ).toEqual(["healthy.txt"])
  })
})

describe("rebuildFromVault filesystem failures", () => {
  const createRebuildVault = async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "rebuild-error-"))
    onTestFinished(() => rm(vaultPath, { recursive: true, force: true }))
    const search = createSearchIndex(":memory:", undefined, undefined, { fileToolsEnabled: true })
    await writeFile(join(vaultPath, "healthy.md"), "healthyamber")
    return { vaultPath, search }
  }

  it.each(["EACCES", "EIO"])("skips a non-markdown %s stat failure and recovers", async (code) => {
    const { vaultPath, search } = await createRebuildVault()
    const filePath = join(vaultPath, "image.png")
    await writeFile(filePath, "image data")
    const actualFs =
      await vi.importActual<typeof import("../../../utils/fs.js")>("../../../utils/fs.js")
    const statSpy = vi.mocked(statOrNull).mockImplementation(async (requestedPath) => {
      if (requestedPath === filePath)
        throw Object.assign(new Error("controlled stat failure"), { code })
      return actualFs.statOrNull(requestedPath)
    })
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => {
      statSpy.mockRestore()
      warnSpy.mockRestore()
    })
    const rebuilt = await search.rebuildFromVault({ vaultPath }, logger)
    await rebuilt.embedding

    expect(rebuilt.count).toBe(1)
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith("skipped unstattable file during rebuild", {
      path: "image.png",
      error: "[Error]: controlled stat failure",
    })
    expect(
      search.fullTextSearch({ query: "healthyamber" }, logger).map((entry) => entry.path),
    ).toEqual(["healthy.md"])
    search.upsertNote(
      { filePath: "source.md", rawContent: "![[image.png]]", fileStat: testStat(1000) },
      logger,
    )
    expect(
      search
        .getOutgoingLinks({ path: "source.md" }, logger)
        .map((link) => ({ path: link.path, exists: link.exists })),
    ).toEqual([{ path: "image.png", exists: false }])
    statSpy.mockRestore()
    const recovered = await search.rebuildFromVault({ vaultPath }, logger)
    await recovered.embedding
    search.upsertNote(
      { filePath: "source.md", rawContent: "![[image.png]]", fileStat: testStat(1000) },
      logger,
    )
    expect(
      search
        .getOutgoingLinks({ path: "source.md" }, logger)
        .map((link) => ({ path: link.path, exists: link.exists })),
    ).toEqual([{ path: "image.png", exists: true }])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    { fileName: "broken.md", sourceKind: "note" },
    { fileName: "broken.canvas", sourceKind: "canvas file" },
    { fileName: "broken.txt", sourceKind: "text file" },
    { fileName: "broken.pdf", sourceKind: "PDF" },
  ])(
    "warns and skips an unreadable $sourceKind while indexing healthy files",
    async ({ fileName, sourceKind }) => {
      const { vaultPath, search } = await createRebuildVault()
      const filePath = join(vaultPath, fileName)
      await writeFile(filePath, "brokenquartz")
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
      const readSpy = vi.mocked(readFile).mockImplementation(async (requestedPath, options) => {
        if (requestedPath === filePath) throw new Error("controlled read failure")
        return actualFs.readFile(requestedPath, options)
      })
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => {
        readSpy.mockRestore()
        warnSpy.mockRestore()
      })
      const rebuilt = await search.rebuildFromVault({ vaultPath }, logger)
      await rebuilt.embedding

      expect(rebuilt.count).toBe(1)
      expect(readSpy).toHaveBeenCalledWith(filePath, ...(fileName.endsWith(".pdf") ? [] : ["utf8"]))
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        `skipped unreadable ${sourceKind} during rebuild`,
        { path: fileName, error: "[Error]: controlled read failure" },
      )
      expect(
        (await search.hybridSearch({ query: "healthyamber" }, logger)).results.map(
          (entry) => entry.path,
        ),
      ).toEqual(["healthy.md"])
      expect((await search.hybridSearch({ query: "brokenquartz" }, logger)).results).toEqual([])
    },
  )

  it("contains a rebuild PDF extraction failure and indexes its next valid extraction", async () => {
    const { vaultPath, search } = await createRebuildVault()
    await writeFile(join(vaultPath, "broken.pdf"), "controlled bytes")
    const extractSpy = vi
      .mocked(extractPdfText)
      .mockRejectedValueOnce(new Error("controlled PDF failure"))
      .mockResolvedValueOnce({ text: "recoveredopal", totalPages: 1 })
    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => {
      extractSpy.mockRestore()
      warnSpy.mockRestore()
    })
    const rebuilt = await search.rebuildFromVault({ vaultPath }, logger)
    await rebuilt.embedding
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith("skipped unreadable PDF during rebuild", {
      path: "broken.pdf",
      error: "[Error]: controlled PDF failure",
    })
    expect(
      (await search.hybridSearch({ query: "healthyamber" }, logger)).results.map(
        (entry) => entry.path,
      ),
    ).toEqual(["healthy.md"])
    expect((await search.hybridSearch({ query: "recoveredopal" }, logger)).results).toEqual([])
    const recovered = await search.rebuildFromVault({ vaultPath }, logger)
    await recovered.embedding
    expect(
      (await search.hybridSearch({ query: "recoveredopal" }, logger)).results.map(
        (entry) => entry.path,
      ),
    ).toEqual(["broken.pdf"])
    expect(extractSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe("rebuildFromVault", () => {
  let vaultDir: string

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "vault-idx-test-"))
    await mkdir(join(vaultDir, "About Me"), { recursive: true })
    await mkdir(join(vaultDir, ".obsidian"), { recursive: true })
    await writeFile(join(vaultDir, "About Me/Principles.md"), NOTE_WITH_FRONTMATTER, "utf8")
    await writeFile(join(vaultDir, "root.md"), NOTE_MINIMAL, "utf8")
    await writeFile(join(vaultDir, ".obsidian/config.md"), "hidden\n", "utf8")
  })

  afterEach(async () => {
    await rm(vaultDir, { recursive: true })
  })

  it("indexes all visible .md files", async () => {
    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    expect(count).toBe(2)
  })

  it("skips hidden directories", async () => {
    const { count: indexedCount } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    expect(indexedCount).toBe(2)
    const hidden = index.fullTextSearch({ query: "hidden" }, logger)
    expect(hidden).toHaveLength(0)
  })

  it("clears existing data before rebuilding", async () => {
    index.upsertNote(
      {
        filePath: "stale.md",
        rawContent: "stale content\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    const results = index.fullTextSearch({ query: "stale" }, logger)
    expect(results).toHaveLength(0)
  })

  it("makes indexed notes searchable", async () => {
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe("About Me/Principles.md")
  })

  it("indexes a note whose block is not valid YAML from its body, counts it, and warns once", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    await writeFile(
      join(vaultDir, "broken.md"),
      "---\ntitle: [unclosed\n---\nbroken body text, see [[root]]\n",
      "utf8",
    )

    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    // Two fixture notes from beforeEach plus this one: a skipped note would leave 2
    expect(count).toBe(3)
    // Pass 2 parses the note again for its links and must not warn a second time
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "indexed note without its unreadable properties block",
      {
        path: "broken.md",
        error:
          "[Error]: properties block is not valid YAML at line 2, column 17: Flow sequence in block collection must be sufficiently indented and end with a ]",
      },
    )
    const brokenHits = index.fullTextSearch({ query: "broken" }, logger)
    expect(brokenHits.map((result) => [result.path, result.title])).toEqual([
      ["broken.md", "broken"],
    ])
    expect(
      index.getBacklinks({ path: "root.md" }, logger).map((backlink) => backlink.path),
    ).toEqual(["broken.md"])
  })

  it("skips a note whose index write fails, warns, and indexes the rest", async () => {
    const taskInsertPoison = installStatementPoison("INSERT INTO tasks")
    const poisonedIndex = createSearchIndex(":memory:")
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    // The only fixture note with a task, so the poisoned statement fires for it alone
    await writeFile(join(vaultDir, "tasked.md"), "tasked body text\n\n- [ ] A task\n", "utf8")

    taskInsertPoison.arm()
    const { count } = await poisonedIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)
    taskInsertPoison.disarm()

    expect(count).toBe(2)
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "skipped note that failed to index during rebuild",
      { path: "tasked.md", error: `[Error]: ${taskInsertPoison.message}` },
    )
    expect(poisonedIndex.fullTextSearch({ query: "tasked" }, logger)).toEqual([])
    const healthyHits = poisonedIndex.fullTextSearch({ query: "burnout" }, logger)
    expect(healthyHits.map((result) => result.path)).toEqual(["About Me/Principles.md"])
  })

  it("does not report a note with an unreadable block as indexed when its index write fails", async () => {
    const taskInsertPoison = installStatementPoison("INSERT INTO tasks")
    const poisonedIndex = createSearchIndex(":memory:")
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    // The only fixture note with a task, so the poisoned statement fires for it alone
    await writeFile(
      join(vaultDir, "tasked.md"),
      "---\ntitle: [unclosed\n---\ntasked body text\n\n- [ ] A task\n",
      "utf8",
    )

    taskInsertPoison.arm()
    const { count } = await poisonedIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)
    taskInsertPoison.disarm()

    expect(count).toBe(2)
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "skipped note that failed to index during rebuild",
      { path: "tasked.md", error: `[Error]: ${taskInsertPoison.message}` },
    )
  })

  it("keeps none of the links of a note whose link pass fails partway", async () => {
    const dbDir = await mkdtemp(join(tmpdir(), "rebuild-partial-links-"))
    onTestFinished(() => rm(dbDir, { recursive: true, force: true }))
    const dbPath = join(dbDir, "index.db")
    const linkFailureIndex = createSearchIndex(dbPath)
    // The trigger fails the second link only, after the first one is inserted
    const schemaWriter = new Database(dbPath)
    schemaWriter.exec(
      "CREATE TRIGGER fail_beta_link BEFORE INSERT ON links WHEN NEW.target = 'beta' BEGIN SELECT RAISE(ABORT, 'injected link failure'); END",
    )
    schemaWriter.close()
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    await writeFile(join(vaultDir, "linker.md"), "See [[alpha]], then [[beta]].\n", "utf8")

    const { count } = await linkFailureIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)

    // The note's Pass 1 rows are committed, so it counts as indexed and stays searchable
    expect(count).toBe(3)
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "skipped the links of a note whose link pass failed during rebuild",
      { path: "linker.md", error: "[SqliteError]: injected link failure" },
    )
    expect(
      linkFailureIndex.fullTextSearch({ query: "alpha" }, logger).map((result) => result.path),
    ).toEqual(["linker.md"])
    expect(linkFailureIndex.getOutgoingLinks({ path: "linker.md" }, logger)).toEqual([])
  })

  it("keeps the memory entries and vectors of a note that fails to index but is still on disk", async () => {
    const taskInsertPoison = installStatementPoison("INSERT INTO tasks")
    const dbDir = await mkdtemp(join(tmpdir(), "rebuild-keep-failed-"))
    onTestFinished(() => rm(dbDir, { recursive: true, force: true }))
    const dbPath = join(dbDir, "index.db")
    const embedder = {
      embedText: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
      embedBatch: vi.fn().mockImplementation((texts: string[]) => {
        return Promise.resolve(texts.map(() => new Float32Array(384).fill(0.1)))
      }),
    }
    const memoryIndex = createSearchIndex(dbPath, embedder, undefined, { memoryDir: "About Me" })
    const inspect = new Database(dbPath, { readonly: true })
    sqliteVec.load(inspect)
    onTestFinished(() => {
      inspect.close()
    })
    const selectStoredRows = () => ({
      entries: inspect.prepare("SELECT file, entry_date, entry_text FROM memory_entries").all(),
      noteChunks: inspect
        .prepare<[], { note_path: string; chunk_index: number; chunk_text: string }>(
          "SELECT note_path, chunk_index, chunk_text FROM note_chunks ORDER BY note_path",
        )
        .all(),
      noteVectors: countRow(inspect.prepare("SELECT COUNT(*) AS count FROM note_vectors").get())
        .count,
      entryVectors: countRow(
        inspect.prepare("SELECT COUNT(*) AS count FROM memory_entry_vectors").get(),
      ).count,
    })
    // The only fixture note with a task, so the poisoned statement fires for it alone
    await writeFile(
      join(vaultDir, "About Me/Opinions.md"),
      "# Opinions\n\n## Code patterns (newest first)\n\n- **2026-08-01**: Named over positional.\n\n## Follow-ups\n\n- [ ] Revisit naming\n",
      "utf8",
    )
    const firstBuild = await memoryIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)
    await firstBuild.embedding
    const rowsAfterFirstBuild = selectStoredRows()
    // The first build stored rows for the note, so keeping them below is not vacuous.
    // Chunks are checked by path only, because their text is the chunker's concern.
    expect(rowsAfterFirstBuild).toMatchObject({
      entries: [
        {
          file: "Opinions",
          entry_date: "2026-08-01",
          entry_text: "- **2026-08-01**: Named over positional.",
        },
      ],
      noteVectors: 3,
      entryVectors: 1,
    })
    expect(rowsAfterFirstBuild.noteChunks.map((chunk) => chunk.note_path)).toEqual([
      "About Me/Opinions.md",
      "About Me/Principles.md",
      "root.md",
    ])

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    taskInsertPoison.arm()
    const secondBuild = await memoryIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)
    taskInsertPoison.disarm()
    await secondBuild.embedding

    // The warning and the empty search prove the second build skipped the note
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "skipped note that failed to index during rebuild",
      { path: "About Me/Opinions.md", error: `[Error]: ${taskInsertPoison.message}` },
    )
    expect(memoryIndex.fullTextSearch({ query: "positional" }, logger)).toEqual([])
    // A note still on disk is not treated as deleted; its rows wait for the next good index
    expect(selectStoredRows()).toEqual(rowsAfterFirstBuild)
  })

  it.each([
    { label: "a list", content: "---\n- a\n- b\n---\nquokka body text\n" },
    { label: "a single value", content: "---\nJust a paragraph.\n---\nquokka body text\n" },
    { label: "an explicitly tagged value", content: "---\nstatus: !done\n---\nquokka body text\n" },
  ])("indexes a note whose properties block holds $label", async ({ content }) => {
    await writeFile(join(vaultDir, "kept.md"), content, "utf8")

    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    // Two fixture notes from beforeEach plus this one: a skipped note would leave 2
    expect(count).toBe(3)
    const bodyHits = index.fullTextSearch({ query: "quokka" }, logger).map((result) => result.path)
    expect(bodyHits).toEqual(["kept.md"])
  })

  it("indexes a note opening with Multi Column plugin syntax as plain content", async () => {
    await writeFile(
      join(vaultDir, "multi-column.md"),
      "--- start-multi-column: ExampleRegion1\ncolumn snippet text\n\n--- end-multi-column\n",
      "utf8",
    )
    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    expect(count).toBe(3)
    // The plugin line stays in the indexed content — it would vanish if
    // it were parsed as frontmatter
    const firstLineHits = index
      .fullTextSearch({ query: "ExampleRegion1" }, logger)
      .map((result) => result.path)
    expect(firstLineHits).toEqual(["multi-column.md"])
    const propertyHits = index.searchByProperty(
      { key: "start-multi-column", value: "ExampleRegion1" },
      logger,
    )
    expect(propertyHits).toHaveLength(0)
  })

  it("resolves a link into a note whose block is not valid YAML", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    const brokenContent = "---\ntitle: [unclosed\n---\nbroken body text\n"
    await writeFile(join(vaultDir, "broken.md"), brokenContent, "utf8")
    await writeFile(join(vaultDir, "linker.md"), "# Linker\n\nSee [[broken]].\n", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    // The note is in the notes table, so the link resolves to it; the title
    // is the file name because the block's title was not read
    expect(index.getOutgoingLinks({ path: "linker.md" }, logger)).toEqual([
      {
        path: "broken.md",
        title: "broken",
        exists: true,
        kind: "note",
        bytes: Buffer.byteLength(brokenContent),
        daily_note_forward_ref: false,
      },
    ])
  })

  it("resolves a frontmatter wikilink whose target is indexed later (forward reference)", async () => {
    // related: points to a note that sorts after the source, so the source is
    // indexed first; the two-pass rebuild must still resolve it. The body has
    // no link to z-target, so only frontmatter extraction can produce the edge.
    await writeFile(
      join(vaultDir, "a-source.md"),
      '---\ntitle: Source\nrelated: ["[[z-target]]"]\n---\n\n# Source\n\nProse only.\n',
      "utf8",
    )
    await writeFile(join(vaultDir, "z-target.md"), "# Z Target\n\nBody.\n", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    const backlinks = index.getBacklinks({ path: "z-target.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("a-source.md")
  })

  it("does not count extensionless wikilinks to non-md files as broken", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[Trip Route]] and [[missing-note]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "Trip Route.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Trip Route.canvas")
    expect(asset?.exists).toBe(true)
    expect(asset?.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "missing-note")
    expect(broken?.exists).toBe(false)
    expect(broken?.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves markdown-style file embeds through the two-pass rebuild", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\n![p](photo.png) and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "photo.png"), "png-bytes", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    // Results order by target, so "genuinely-missing" sorts first.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "genuinely-missing",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
      {
        path: "photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 9,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves extensionless wikilinks to non-md files by basename", async () => {
    await mkdir(join(vaultDir, "canvases"), { recursive: true })
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[Dashboard]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "canvases/Dashboard.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "canvases/Dashboard.canvas")
    expect(asset?.exists).toBe(true)
    expect(asset?.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken?.exists).toBe(false)
    expect(broken?.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves extensionless wikilinks to non-md files by exact path", async () => {
    await mkdir(join(vaultDir, "views"), { recursive: true })
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\nSee [[views/Inventory]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "views/Inventory.base"), "filters: []\n", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "views/Inventory.base")
    expect(asset?.exists).toBe(true)
    expect(asset?.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken?.exists).toBe(false)
    expect(broken?.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not match a folder-qualified target against a same-named file in a different folder", async () => {
    await mkdir(join(vaultDir, "other"), { recursive: true })
    await writeFile(join(vaultDir, "source.md"), "# Source\n\nSee [[views/Inventory]].\n", "utf8")
    await writeFile(join(vaultDir, "other/Inventory.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.path).toBe("views/Inventory")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not let LIKE wildcards in the target match unrelated files", async () => {
    await mkdir(join(vaultDir, "foo/aXb"), { recursive: true })
    await writeFile(join(vaultDir, "source.md"), "# Source\n\nSee [[a_b/c]].\n", "utf8")
    await writeFile(join(vaultDir, "foo/aXb/c.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves extensionless wikilinks to non-md files by relative path", async () => {
    await mkdir(join(vaultDir, "sub"), { recursive: true })
    await writeFile(
      join(vaultDir, "sub/source.md"),
      "# Source\n\nSee [[../Route]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "Route.canvas"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "sub/source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Route.canvas")
    expect(asset?.exists).toBe(true)
    expect(asset?.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken?.exists).toBe(false)
    expect(broken?.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("skips non-md files in hidden directories", async () => {
    await writeFile(join(vaultDir, "source.md"), "# Source\n\nSee [[config]].\n", "utf8")
    await writeFile(join(vaultDir, ".obsidian/config.json"), "{}", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves explicit-extension wikilinks against the non-md file index", async () => {
    await writeFile(
      join(vaultDir, "source.md"),
      "# Source\n\n![[photo.png]] and [[genuinely-missing]].\n",
      "utf8",
    )
    await writeFile(join(vaultDir, "photo.png"), "binary", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "photo.png")
    expect(asset?.exists).toBe(true)
    expect(asset?.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "genuinely-missing")
    expect(broken?.exists).toBe(false)
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves an extensionless target to a note when both note and non-md file share the same base name", async () => {
    await writeFile(join(vaultDir, "Report.md"), "# Report\n\nNote content.\n", "utf8")
    await writeFile(join(vaultDir, "Report.pdf"), "binary", "utf8")
    await writeFile(join(vaultDir, "source.md"), "# Source\n\nSee [[Report]].\n", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.path).toBe("Report.md")
    expect(outgoing[0]?.kind).toBe("note")
    expect(outgoing[0]?.exists).toBe(true)
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a case-differing asset target through the SQL suffix tier's fold", async () => {
    // The stored path differs from the link target only in case — the SQL
    // suffix tier must match via LIKE's ASCII fold, mirroring the JS
    // resolver's foldAsciiCase.
    await mkdir(join(vaultDir, "photos"), { recursive: true })
    await writeFile(join(vaultDir, "source.md"), "# Source\n\n![[sunset.png]]\n", "utf8")
    await writeFile(join(vaultDir, "photos", "Sunset.png"), "binary", "utf8")
    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.path).toBe("photos/Sunset.png")
    expect(outgoing[0]?.kind).toBe("file")
    expect(outgoing[0]?.exists).toBe(true)
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("indexes a symlinked .md file", async () => {
    await mkdir(join(vaultDir, "real"), { recursive: true })
    await writeFile(
      join(vaultDir, "real/original.md"),
      "# Original\n\nSymlink target content.\n",
      "utf8",
    )
    await symlink("real/original.md", join(vaultDir, "linked.md"))

    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    expect(count).toBe(4)

    const results = index.fullTextSearch({ query: "symlink target content" }, logger)
    expect(results).toHaveLength(2)
    const paths = results.map((result) => result.path).sort()
    expect(paths).toEqual(["linked.md", "real/original.md"])
  })

  it("indexes a symlinked non-.md file for link resolution", async () => {
    await mkdir(join(vaultDir, "boards"), { recursive: true })
    await writeFile(join(vaultDir, "boards/real-board.canvas"), "{}", "utf8")
    await symlink("boards/real-board.canvas", join(vaultDir, "Board.canvas"))
    await writeFile(join(vaultDir, "source.md"), "# Source\n\nSee [[Board]].\n", "utf8")

    await index.rebuildFromVault({ vaultPath: vaultDir }, logger)

    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toEqual([
      expect.objectContaining({
        path: "Board.canvas",
        exists: true,
        kind: "file",
      }),
    ])
  })

  it("indexes a symlink whose target is outside the vault root", async () => {
    // Obsidian supports symlinks to files outside the vault (e.g. repo files
    // symlinked into the vault for browsing), so vault-cortex follows suit
    const outsideDir = await mkdtemp(join(tmpdir(), "vault-outside-"))
    onTestFinished(async () => rm(outsideDir, { recursive: true }))
    await writeFile(join(outsideDir, "external.md"), "# External\n\nExternal content.\n", "utf8")
    await symlink(join(outsideDir, "external.md"), join(vaultDir, "linked-external.md"))

    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    expect(count).toBe(3)

    const results = index.fullTextSearch({ query: "external content" }, logger)
    expect(results.map((result) => result.path)).toEqual(["linked-external.md"])
  })

  it("skips a broken symlink without crashing the rebuild", async () => {
    // A valid internal symlink proves the system indexes symlinks —
    // without it, the test passes trivially even if all symlinks are ignored
    await symlink("root.md", join(vaultDir, "valid-link.md"))
    await symlink("nonexistent/target.md", join(vaultDir, "broken.md"))

    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    expect(count).toBe(3) // 2 baseline + valid-link.md (broken.md filtered)

    const results = index.fullTextSearch({ query: "burnout" }, logger)
    expect(results).toHaveLength(1)
  })

  it("skips a symlink whose target is a directory, not a file", async () => {
    // A valid internal symlink proves the system indexes symlinks —
    // without it, the test passes trivially even if all symlinks are ignored
    await symlink("root.md", join(vaultDir, "valid-link.md"))
    await mkdir(join(vaultDir, "realdir"), { recursive: true })
    await writeFile(join(vaultDir, "realdir/inner.md"), "inner\n", "utf8")
    await symlink(join(vaultDir, "realdir"), join(vaultDir, "dirlink.md"))

    const { count } = await index.rebuildFromVault({ vaultPath: vaultDir }, logger)
    expect(count).toBe(4) // 2 baseline + valid-link.md + inner.md (dirlink.md filtered)

    const results = index.fullTextSearch({ query: "inner" }, logger)
    expect(results.map((result) => result.path)).toEqual(["realdir/inner.md"])
  })
})

// ── Link query methods ───────────────────────────────────────────

describe("getBacklinks", () => {
  beforeEach(() => {
    // hub links to spoke-a and spoke-b; spoke-a links back to hub.
    // upsertNote re-resolves stale targets, so ordering doesn't matter.
    index.upsertNote(
      {
        filePath: "hub.md",
        rawContent: "# Hub\n\nLinks to [[spoke-a]] and [[spoke-b]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "spoke-a.md",
        rawContent: "# Spoke A\n\nLinks back to [[hub]].\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "spoke-b.md",
        rawContent: "# Spoke B\n\nNo backlink.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "island.md",
        rawContent: "# Island\n\nNo links at all.\n",
        fileStat: testStat(4000),
      },
      logger,
    )
  })

  it("finds notes linking to the target", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("hub.md")
  })

  it("finds backlinks from notes that link to the target", () => {
    const backlinks = index.getBacklinks({ path: "hub.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("spoke-a.md")
  })

  it("returns empty for notes with no backlinks", () => {
    const backlinks = index.getBacklinks({ path: "island.md" }, logger)
    expect(backlinks).toHaveLength(0)
  })

  it("includes title in results", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks[0]?.title).toBe("hub")
  })

  it("includes bytes in results", () => {
    const backlinks = index.getBacklinks({ path: "spoke-a.md" }, logger)
    expect(backlinks[0]?.bytes).toBe(100)
  })
})

describe("getOutgoingLinks", () => {
  beforeEach(() => {
    // source links to target-exists (will be resolved) and NonExistent (unresolved)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[target-exists]] and [[NonExistent]].\n",
        fileStat: testStat(1000, 11),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "target-exists.md",
        rawContent: "---\ntitle: Target\n---\n\n# Target\n\nBody.\n",
        fileStat: testStat(2000, 222),
      },
      logger,
    )
  })

  it("returns outgoing links with exists flag and kind", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(links).toHaveLength(2)

    const existing = links.find((link) => link.path === "target-exists.md")
    expect(existing).toBeDefined()
    expect(existing?.exists).toBe(true)
    expect(existing?.kind).toBe("note")
    expect(existing?.title).toBe("Target")
  })

  it("marks unresolved links as exists: false with kind note", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    const missing = links.find((link) => link.path === "NonExistent")
    expect(missing).toBeDefined()
    expect(missing?.exists).toBe(false)
    expect(missing?.kind).toBe("note")
    expect(missing?.title).toBeNull()
    expect(missing?.bytes).toBeNull()
  })

  it("includes bytes for existing targets, null for broken links", () => {
    const links = index.getOutgoingLinks({ path: "source.md" }, logger)
    const existing = links.find((link) => link.path === "target-exists.md")
    expect(existing?.bytes).toBe(222)
    const broken = links.find((link) => link.path === "NonExistent")
    expect(broken?.bytes).toBeNull()
  })

  it.each(["Daily Notes", "Daily Notes/", "Daily Notes///"])(
    "flags daily note forward-refs with folder %s",
    (dailyNotesFolder) => {
      index.upsertNote(
        {
          filePath: "Daily Notes/2026-06-24.md",
          rawContent: "# 2026-06-24\n\n[[Daily Notes/2026-06-25|Tomorrow >>]] and [[missing]].\n",
          fileStat: testStat(1000),
        },
        logger,
      )

      const links = index.getOutgoingLinks(
        { path: "Daily Notes/2026-06-24.md", dailyNotesFolder },
        logger,
      )
      expect(links).toEqual([
        {
          path: "Daily Notes/2026-06-25",
          title: null,
          exists: false,
          kind: "note",
          bytes: null,
          daily_note_forward_ref: true,
        },
        {
          path: "missing",
          title: null,
          exists: false,
          kind: "note",
          bytes: null,
          daily_note_forward_ref: false,
        },
      ])
    },
  )

  it("returns empty for notes with no outgoing links", () => {
    index.upsertNote(
      {
        filePath: "lonely.md",
        rawContent: "# Lonely\n\nNo links.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    const links = index.getOutgoingLinks({ path: "lonely.md" }, logger)
    expect(links).toHaveLength(0)
  })
})

describe("findOrphans", () => {
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "hub.md",
        rawContent: "# Hub\n\n[[connected]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "connected.md",
        rawContent: "# Connected\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Projects/orphan.md",
        rawContent:
          "---\ntitle: Orphan\ntype: project\ntags: [project]\n---\n\n# Orphan\n\nNobody links here.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-05-13.md",
        rawContent: "---\ntitle: 2026-05-13\n---\n\n# Daily\n",
        fileStat: testStat(4000),
      },
      logger,
    )
  })

  it("finds notes with no incoming links", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).toContain("Projects/orphan.md")
  })

  it("translates oversized exclusions while retaining and logging the SQLite diagnostic", () => {
    const queryIndex = createSearchIndex(":memory:")
    const requestLogger = { ...logger, warn: vi.fn() }
    const excludeFolders = Array.from({ length: 1000 }, (_, folderIndex) => `Folder${folderIndex}`)
    const queryError = (() => {
      try {
        queryIndex.findOrphans({ excludeFolders }, requestLogger)
      } catch (error) {
        return error
      }
      throw new Error("expected the orphan query to fail")
    })()

    if (!(queryError instanceof Error) || !(queryError.cause instanceof Database.SqliteError)) {
      throw new Error("expected a domain error with the original SQLite cause")
    }
    expect({
      message: queryError.message,
      causeName: queryError.cause.name,
      causeCode: queryError.cause.code,
      causeMessage: queryError.cause.message,
    }).toEqual({
      message: "too many excluded folders",
      causeName: "SqliteError",
      causeCode: "SQLITE_ERROR",
      causeMessage: "Expression tree is too large (maximum depth 1000)",
    })
    expect(requestLogger.warn).toHaveBeenCalledTimes(1)
    expect(requestLogger.warn).toHaveBeenCalledWith("orphan exclusion query capacity exceeded", {
      excludedFolderCount: 1000,
      error: "[SqliteError]: Expression tree is too large (maximum depth 1000)",
    })
  })

  it("propagates unrelated SQLite query failures unchanged", () => {
    const queryIndex = createSearchIndex(":memory:")
    const requestLogger = { ...logger, warn: vi.fn() }
    const sqliteError = new Database.SqliteError("no such table: notes", "SQLITE_ERROR")
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementationOnce(() => {
      throw sqliteError
    })
    onTestFinished(() => prepareSpy.mockRestore())
    const queryError = (() => {
      try {
        queryIndex.findOrphans({}, requestLogger)
      } catch (error) {
        return error
      }
      throw new Error("expected the orphan query to fail")
    })()

    expect(queryError).toBe(sqliteError)
    expect(requestLogger.warn).not.toHaveBeenCalled()
  })

  it("excludes connected notes", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).not.toContain("connected.md")
  })

  it("includes all folders when no exclusions provided", () => {
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).toContain("Daily Notes/2026-05-13.md")
  })

  it("excludes Daily Notes when passed in excludeFolders", () => {
    const orphans = index.findOrphans({ excludeFolders: ["Daily Notes"] }, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).not.toContain("Daily Notes/2026-05-13.md")
  })

  it("strips trailing slashes from excludeFolders before matching", () => {
    const orphans = index.findOrphans({ excludeFolders: ["Daily Notes/"] }, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).not.toContain("Daily Notes/2026-05-13.md")
    expect(orphanPaths).toContain("Projects/orphan.md")
  })

  it("does not exclude a sibling folder whose name starts with an excluded folder", () => {
    index.upsertNote(
      {
        filePath: "ProjectsOld/old.md",
        rawContent: "# Old\n\nNobody links here either.\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    const orphans = index.findOrphans({ excludeFolders: ["Projects"] }, logger)
    expect(orphans.map((orphan) => orphan.path)).toEqual([
      "ProjectsOld/old.md",
      "Daily Notes/2026-05-13.md",
      "hub.md",
    ])
  })

  it("ignores ASCII letter case in excludeFolders", () => {
    const orphans = index.findOrphans({ excludeFolders: ["projects"] }, logger)
    expect(orphans.map((orphan) => orphan.path)).toEqual(["Daily Notes/2026-05-13.md", "hub.md"])
  })

  it("respects limit", () => {
    const orphans = index.findOrphans({ limit: 1 }, logger)
    expect(orphans).toHaveLength(1)
  })

  it("returns NoteMetadata with all fields", () => {
    const orphans = index.findOrphans({}, logger)
    const projectOrphan = orphans.find((orphan) => orphan.path === "Projects/orphan.md")
    expect(projectOrphan).toBeDefined()
    expect(projectOrphan?.title).toBe("Orphan")
    expect(projectOrphan?.tags).toEqual(["project"])
    expect(projectOrphan?.folder).toBe("Projects")
    expect(projectOrphan?.bytes).toBe(100)
    expect(typeof projectOrphan?.modified).toBe("string")
  })

  it("treats self-linking notes as orphans", () => {
    index.upsertNote(
      {
        filePath: "self-ref.md",
        rawContent: "# Self\n\nLinks to [[self-ref]].\n",
        fileStat: testStat(5000),
      },
      logger,
    )
    const orphans = index.findOrphans({}, logger)
    const orphanPaths = orphans.map((orphan) => orphan.path)
    expect(orphanPaths).toContain("self-ref.md")
  })
})

describe("forward reference resolution", () => {
  it("resolves backlinks when target is indexed after source", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\nLinks to [[target]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )

    const backlinks = index.getBacklinks({ path: "target.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("source.md")
  })

  it("re-resolves a full-path forward reference when the target is created later", () => {
    // A full-path link is stored without .md ("folder/target") while the target
    // doesn't exist yet. Frontmatter related: links are usually full-path, so
    // this is the common incremental case. Body has no link → only the
    // frontmatter edge is under test.
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent:
          '---\ntitle: Source\nrelated: ["[[folder/target]]"]\n---\n\n# Source\n\nProse only.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    // Target absent → link stored unresolved → no backlink yet.
    expect(index.getBacklinks({ path: "folder/target.md" }, logger)).toHaveLength(0)

    index.upsertNote(
      {
        filePath: "folder/target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "folder/target.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("source.md")
  })

  it("re-resolves a relative ../ forward reference when the target is created later", () => {
    // A source-relative link is stored raw ("../Health/later") while the target
    // doesn't exist yet. Re-resolution must re-run with the link's own source so
    // the relative form upgrades, not just basename/full-path forms.
    index.upsertNote(
      {
        filePath: "Areas/Work/early.md",
        rawContent: "# Early\n\nLinks to [[../Health/later]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getBacklinks({ path: "Areas/Health/later.md" }, logger)).toHaveLength(0)

    index.upsertNote(
      {
        filePath: "Areas/Health/later.md",
        rawContent: "# Later\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "Areas/Health/later.md" }, logger)
    expect(backlinks).toEqual([{ path: "Areas/Work/early.md", title: "early", bytes: 100 }])
  })

  it("keeps a ../ forward reference unresolved past a same-basename note in another folder", () => {
    // A ../ target resolves only through the relative tier (exact membership of
    // the path computed from the link's source), so a same-basename note
    // elsewhere must neither capture the link nor evict it from the unresolved
    // set before the intended target exists.
    index.upsertNote(
      {
        filePath: "Areas/Work/early.md",
        rawContent: "# Early\n\nLinks to [[../Health/later]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Health/later.md",
        rawContent: "# Decoy\n\nBody.\n",
        fileStat: testStat(1500),
      },
      logger,
    )
    // The decoy's write swept the unresolved set; the link must not have
    // attached to it.
    expect(index.getBacklinks({ path: "Health/later.md" }, logger)).toHaveLength(0)

    index.upsertNote(
      {
        filePath: "Areas/Health/later.md",
        rawContent: "# Later\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "Areas/Health/later.md" }, logger)
    expect(backlinks).toEqual([{ path: "Areas/Work/early.md", title: "early", bytes: 100 }])
    expect(index.getBacklinks({ path: "Health/later.md" }, logger)).toHaveLength(0)
  })
})

describe("frontmatter links in the graph", () => {
  // Every fixture below gives the source a body with NO link to the target, so
  // the asserted edge can only come from the frontmatter wikilink — never from a
  // body link that happened to cover it.

  it("surfaces a frontmatter-only target in getOutgoingLinks", () => {
    index.upsertNote(
      {
        filePath: "session.md",
        rawContent:
          '---\ntitle: Session\nrelated: ["[[task-board]]"]\n---\n\n# Session\n\nProse with no links.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "task-board.md",
        rawContent: "# Task Board\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const links = index.getOutgoingLinks({ path: "session.md" }, logger)
    expect(links).toHaveLength(1)
    expect(links[0]?.path).toBe("task-board.md")
    expect(links[0]?.exists).toBe(true)
    expect(links[0]?.kind).toBe("note")
  })

  it("surfaces a frontmatter-only source in getBacklinks", () => {
    index.upsertNote(
      {
        filePath: "session.md",
        rawContent:
          '---\ntitle: Session\nrelated: ["[[task-board]]"]\n---\n\n# Session\n\nProse with no links.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "task-board.md",
        rawContent: "# Task Board\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "task-board.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("session.md")
  })

  it("does not flag a frontmatter-referenced note as an orphan, but still flags a truly unreferenced one", () => {
    index.upsertNote(
      {
        filePath: "referencer.md",
        rawContent:
          '---\ntitle: Referencer\nrelated: ["[[referenced]]"]\n---\n\n# Referencer\n\nNo body links.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "referenced.md",
        rawContent: "# Referenced\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "true-orphan.md",
        rawContent: "# True Orphan\n\nNobody links here.\n",
        fileStat: testStat(3000),
      },
      logger,
    )
    const orphanPaths = index.findOrphans({}, logger).map((orphan) => orphan.path)
    // referenced only via frontmatter → connected, not an orphan
    expect(orphanPaths).not.toContain("referenced.md")
    // genuinely unreferenced → still an orphan (proves exclusion is selective)
    expect(orphanPaths).toContain("true-orphan.md")
  })

  it("counts a target linked from both body and frontmatter as a single edge", () => {
    index.upsertNote(
      {
        filePath: "double.md",
        rawContent:
          '---\ntitle: Double\nrelated: ["[[shared]]"]\n---\n\n# Double\n\nAlso links [[shared]] in the body.\n',
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "shared.md",
        rawContent: "# Shared\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const backlinks = index.getBacklinks({ path: "shared.md" }, logger)
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0]?.path).toBe("double.md")
  })
})

describe("relative links (path from current file)", () => {
  // Obsidian's "Path from current file" format writes links relative to the
  // linking note. note.md links up and across to a sibling folder via
  // "../Health/target"; the target is indexed first so it exists at link time.
  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "Areas/Health/target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "Areas/Work/note.md",
        rawContent: "# Note\n\nLinks to [[../Health/target]].\n",
        fileStat: testStat(2000),
      },
      logger,
    )
  })

  it("resolves the ../ link so the target lists the source as a backlink", () => {
    const backlinks = index.getBacklinks({ path: "Areas/Health/target.md" }, logger)
    expect(backlinks).toEqual([{ path: "Areas/Work/note.md", title: "note", bytes: 100 }])
  })

  it("resolves the ../ link so the source lists the target as an outgoing link", () => {
    const outgoing = index.getOutgoingLinks({ path: "Areas/Work/note.md" }, logger)
    expect(outgoing).toEqual([
      {
        path: "Areas/Health/target.md",
        title: "target",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })
})

// ── brokenLinkCount ─────────────────────────────────────────────

describe("brokenLinkCount", () => {
  it("returns 0 when all link targets exist", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[target]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "target.md",
        rawContent: "# Target\n\nBody.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("counts links to non-existent notes", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[missing-a]] and [[missing-b]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(2)
  })

  it("counts only broken links, not resolved ones", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[exists]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "exists.md",
        rawContent: "# Exists\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not count escaped-pipe wikilinks as broken when the target note exists", () => {
    index.upsertNote(
      {
        filePath: "dashboard.md",
        rawContent: "| Link |\n| --- |\n| [[sessions/log-a\\|log-a]] |\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "sessions/log-a.md",
        rawContent: "# Log A\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const outgoing = index.getOutgoingLinks({ path: "dashboard.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.path).toBe("sessions/log-a.md")
    expect(outgoing[0]?.exists).toBe(true)
    expect(outgoing[0]?.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("does not count wikilinks to non-note files as broken when files are registered", () => {
    index.upsertNonMdFile("photo.png", 100)
    index.upsertNonMdFile("report.pdf", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]] and [[report.pdf]] and [[real-note]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(3)
    const photo = outgoing.find((link) => link.path === "photo.png")
    expect(photo?.exists).toBe(true)
    expect(photo?.kind).toBe("file")
    const pdf = outgoing.find((link) => link.path === "report.pdf")
    expect(pdf?.exists).toBe(true)
    expect(pdf?.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "real-note")
    expect(broken?.exists).toBe(false)
    expect(broken?.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("excludes extensionless targets after upsertNonMdFile registers the file", () => {
    index.upsertNonMdFile("Trip Route.canvas", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[Trip Route]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(2)
    const asset = outgoing.find((link) => link.path === "Trip Route.canvas")
    expect(asset?.exists).toBe(true)
    expect(asset?.kind).toBe("file")
    const broken = outgoing.find((link) => link.path === "missing")
    expect(broken?.exists).toBe(false)
    expect(broken?.kind).toBe("note")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("upsertNonMdFile re-resolves previously unresolved links to non-md paths", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[Route]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(1)

    index.upsertNonMdFile("Route.canvas", 100)
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.path).toBe("Route.canvas")
    expect(outgoing[0]?.exists).toBe(true)
    expect(outgoing[0]?.kind).toBe("file")
  })

  it("removeNonMdFile makes previously resolved file links broken again", () => {
    index.upsertNonMdFile("Route.canvas", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[Route]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(0)

    index.removeNonMdFile("Route.canvas")
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
    const outgoing = index.getOutgoingLinks({ path: "source.md" }, logger)
    expect(outgoing).toHaveLength(1)
    expect(outgoing[0]?.exists).toBe(false)
    expect(outgoing[0]?.kind).toBe("note")
  })

  it.each(["Daily Notes", "Daily Notes/", "Daily Notes///"])(
    "excludes daily forward references with folder %s and retains sibling-folder failures",
    (dailyNotesFolder) => {
      index.upsertNote(
        {
          filePath: "Daily Notes/2026-06-24.md",
          rawContent:
            "# 2026-06-24\n\n[[Daily Notes/2026-06-25|Tomorrow >>]] and [[missing-note]] and [[Daily Notes Extra/missing]].\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      expect(index.brokenLinkCount({ dailyNotesFolder }, logger)).toEqual({
        count: 2,
        excludedFolder: dailyNotesFolder,
        excludedCount: 1,
      })
    },
  )

  it("excludes .md-suffixed forward-reference targets", () => {
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-06-24.md",
        rawContent: "# 2026-06-24\n\n[[Daily Notes/2026-06-25.md|Tomorrow >>]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({ dailyNotesFolder: "Daily Notes" }, logger).count).toBe(0)
  })

  it("still counts broken links outside the daily note folder", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[missing-a]] and [[missing-b]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({ dailyNotesFolder: "Daily Notes" }, logger).count).toBe(2)
  })

  it("excludes all broken links under the daily notes folder, not just dates", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[Daily Notes/random-text]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    const result = index.brokenLinkCount({ dailyNotesFolder: "Daily Notes" }, logger)
    expect(result.count).toBe(1)
    expect(result.excludedCount).toBe(1)
  })

  it("counts all broken links when no daily note exclusion is set", () => {
    index.upsertNote(
      {
        filePath: "Daily Notes/2026-06-24.md",
        rawContent: "# 2026-06-24\n\n[[Daily Notes/2026-06-25|Tomorrow >>]] and [[missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(2)
  })
})

// ── modifiedOnDate ──────────────────────────────────────────────

describe("markdown-style links to non-md targets", () => {
  it("resolves a markdown image embed as a file", () => {
    index.upsertNonMdFile("pics/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![photo](pics/photo.png) and [[genuinely-missing]].\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    // The broken control link proves link indexing ran — without it, a broken
    // count of 0 could come from extraction silently producing nothing.
    // Results order by target, so "genuinely-missing" sorts first.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "genuinely-missing",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
      {
        path: "pics/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("resolves a markdown link to a PDF as a file", () => {
    index.upsertNonMdFile("papers/report.pdf", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\nSee [the paper](papers/report.pdf).\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "papers/report.pdf",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("percent-decodes a markdown file path with folders and spaces", () => {
    index.upsertNonMdFile("Trip Photos/pic 1.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![shot](Trip%20Photos/pic%201.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Trip Photos/pic 1.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("percent-decodes a markdown link to a note with spaces end-to-end", () => {
    index.upsertNote(
      {
        filePath: "My Note.md",
        rawContent: "# My Note\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[link](My%20Note.md)\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "My Note.md",
        title: "My Note",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("keeps markdown links to .md notes resolving with the target stored as written", () => {
    index.upsertNote(
      {
        filePath: "Projects/target.md",
        rawContent: "# Target\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[t](Projects/target.md)\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Projects/target.md",
        title: "target",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("resolves an extensionless markdown link like a wikilink", () => {
    index.upsertNote(
      {
        filePath: "Some Note.md",
        rawContent: "# Some Note\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[team notes](Some%20Note)\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Some Note.md",
        title: "Some Note",
        exists: true,
        kind: "note",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("counts a markdown link to a missing file as broken with the target as written", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![x](missing.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "missing.png",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("does not index scheme-prefixed markdown targets as links", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent:
          "# Source\n\n[o](obsidian://open?vault=v) [z](zotero://select/items/123) [f](ftp://host/file.pdf) [u](HTTPS://x.com/a.png) [[Control]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    // The Control wikilink proves link indexing ran — without it, both
    // assertions could pass from extraction silently producing nothing.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "Control",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })
})

describe("file targets written with extensions", () => {
  it("resolves a wikilink embed by basename when the file lives in a subfolder", () => {
    index.upsertNonMdFile("attachments/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "attachments/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a markdown embed by basename when the file lives in a subfolder", () => {
    index.upsertNonMdFile("attachments/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![diagram](photo.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "attachments/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a relative file link against the source note's folder", () => {
    index.upsertNonMdFile("assets/photo.png", 100)
    index.upsertNote(
      {
        filePath: "A/note.md",
        rawContent: "# Note\n\n![x](../assets/photo.png)\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "A/note.md" }, logger)).toEqual([
      {
        path: "assets/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a folder-qualified target with extension by path suffix", () => {
    index.upsertNonMdFile("deep/sub/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n[[sub/photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "deep/sub/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it("resolves a shared basename deterministically to the shortest path", () => {
    index.upsertNonMdFile("bb/photo.png", 100)
    index.upsertNonMdFile("a/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "a/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("prefers a full-filename match over a multi-dot stem match", () => {
    // "photo.png.canvas" strips to base_path "photo.png" — the same text as
    // the target — so the stem tiers would hit it. The full-filename family
    // must win: the target names an actual .png that exists elsewhere.
    index.upsertNonMdFile("photo.png.canvas", 100)
    index.upsertNonMdFile("a/photo.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "a/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("falls back to a multi-dot stem match when no full-filename match exists", () => {
    // With only photo.png.canvas in the vault, [[photo.png]] still resolves
    // via its stem — the same matching that gives [[Trip Route]] →
    // Trip Route.canvas. The stem tiers are a fallback, not dead code.
    index.upsertNonMdFile("photo.png.canvas", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo.png.canvas",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
  })

  it("does not resolve a basename whose extension differs from the file's", () => {
    index.upsertNonMdFile("attachments/photo.jpg", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    // The suffix match is on the full filename, not the extension-stripped
    // stem — photo.jpg must not satisfy a photo.png link.
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo.png",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })

  it("upsertNonMdFile re-resolves a previously unresolved with-extension target", () => {
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.brokenLinkCount({}, logger).count).toBe(1)

    index.upsertNonMdFile("attachments/photo.png", 100)
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "attachments/photo.png",
        title: null,
        exists: true,
        kind: "file",
        bytes: 100,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(0)
  })

  it.each([
    { label: "full path", target: "assets/photo.png", filePath: "assets/photo.png" },
    { label: "relative path", target: "../assets/photo.png", filePath: "assets/photo.png" },
    { label: "filename suffix", target: "photo.png", filePath: "deep/assets/photo.png" },
    { label: "folded suffix", target: "PHOTO.png", filePath: "deep/assets/photo.png" },
    { label: "stem path", target: "assets/Route", filePath: "assets/Route.canvas" },
    { label: "relative stem", target: "../assets/Route", filePath: "assets/Route.canvas" },
    { label: "stem suffix", target: "assets/Route", filePath: "deep/assets/Route.canvas" },
    { label: "folded stem suffix", target: "assets/ROUTE", filePath: "deep/assets/Route.canvas" },
    { label: "bare stem", target: "Route", filePath: "assets/Route.canvas" },
    { label: "multi-dot stem", target: "photo.png", filePath: "assets/photo.png.canvas" },
    { label: "literal wildcards", target: "photo_%25.png", filePath: "assets/photo_%25.png" },
  ])(
    "re-resolves a $label forward asset link past unrelated candidates",
    ({ target, filePath }) => {
      const assetIndex = createSearchIndex(":memory:")
      assetIndex.upsertNote(
        {
          filePath: "Projects/source.md",
          rawContent: `![[${target}]]\n![[unrelated.png]]`,
          fileStat: testStat(1000),
        },
        logger,
      )
      assetIndex.upsertNonMdFile("elsewhere/decoy.png", 42)
      expect(
        assetIndex
          .getOutgoingLinks({ path: "Projects/source.md" }, logger)
          .map((link) => link.path),
      ).toEqual([target, "unrelated.png"].toSorted())

      assetIndex.upsertNonMdFile(filePath, 100)

      expect(assetIndex.getOutgoingLinks({ path: "Projects/source.md" }, logger)).toEqual(
        [
          {
            path: filePath,
            title: null,
            exists: true,
            kind: "file",
            bytes: 100,
            daily_note_forward_ref: false,
          },
          {
            path: "unrelated.png",
            title: null,
            exists: false,
            kind: "note",
            bytes: null,
            daily_note_forward_ref: false,
          },
        ].toSorted((a, b) => a.path.localeCompare(b.path)),
      )
    },
  )

  it("does not let LIKE wildcards in the target match unrelated files via full-path suffix", () => {
    // Only photo1final.png exists — if the _ in the target were treated as a
    // LIKE wildcard it would match (1 satisfies _), giving a false resolution.
    index.upsertNonMdFile("img/photo1final.png", 100)
    index.upsertNote(
      {
        filePath: "source.md",
        rawContent: "# Source\n\n![[photo_final.png]]\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    expect(index.getOutgoingLinks({ path: "source.md" }, logger)).toEqual([
      {
        path: "photo_final.png",
        title: null,
        exists: false,
        kind: "note",
        bytes: null,
        daily_note_forward_ref: false,
      },
    ])
    expect(index.brokenLinkCount({}, logger).count).toBe(1)
  })
})

describe("modifiedOnDate", () => {
  const midday = DateTime.fromISO("2026-06-15T12:00:00").toMillis()
  const lateEvening = DateTime.fromISO("2026-06-15T23:00:00").toMillis()
  const nextDayMorning = DateTime.fromISO("2026-06-16T08:00:00").toMillis()

  beforeEach(() => {
    index.upsertNote(
      {
        filePath: "today-note.md",
        rawContent: "---\ntitle: Today\n---\n# Today\n",
        fileStat: testStat(midday),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "today-late.md",
        rawContent: "---\ntitle: Today Late\n---\n# Late\n",
        fileStat: testStat(lateEvening),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "tomorrow-note.md",
        rawContent: "---\ntitle: Tomorrow\n---\n# Tomorrow\n",
        fileStat: testStat(nextDayMorning),
      },
      logger,
    )
  })

  it("returns notes modified on the given date, ordered by mtime descending", () => {
    const results = index.modifiedOnDate({ date: "2026-06-15" }, logger)
    const paths = results.map((note) => note.path)
    expect(paths).toEqual(["today-late.md", "today-note.md"])
  })

  it("excludes notes modified on other dates", () => {
    const results = index.modifiedOnDate({ date: "2026-06-15" }, logger)
    const paths = results.map((note) => note.path)
    expect(paths).not.toContain("tomorrow-note.md")
  })

  it("respects the limit parameter", () => {
    const results = index.modifiedOnDate({ date: "2026-06-15", limit: 1 }, logger)
    const paths = results.map((note) => note.path)
    expect(paths).toEqual(["today-late.md"])
  })

  it("returns empty array for a date with no modifications", () => {
    const results = index.modifiedOnDate({ date: "2020-01-01" }, logger)
    expect(results).toEqual([])
  })
})

// ── vaultStats ──────────────────────────────────────────────────

describe("vaultStats", () => {
  it("returns correct total note count", () => {
    index.upsertNote(
      {
        filePath: "a.md",
        rawContent: "---\ntags: [one]\nstatus: active\n---\n# A\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "b.md",
        rawContent: "---\ntags: [two]\n---\n# B\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const stats = index.vaultStats({}, logger)
    expect(stats.totalNotes).toBe(2)
  })

  it("counts untagged notes", () => {
    index.upsertNote(
      {
        filePath: "tagged.md",
        rawContent: "---\ntags: [one]\n---\n# Tagged\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "untagged.md",
        rawContent: "# Untagged\n\nNo frontmatter.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const stats = index.vaultStats({}, logger)
    expect(stats.untaggedNotes).toBe(1)
  })

  it("counts notes without frontmatter properties", () => {
    index.upsertNote(
      {
        filePath: "with-props.md",
        rawContent: "---\nstatus: active\n---\n# Props\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    index.upsertNote(
      {
        filePath: "no-props.md",
        rawContent: "# Bare\n\nNo frontmatter at all.\n",
        fileStat: testStat(2000),
      },
      logger,
    )
    const stats = index.vaultStats({}, logger)
    expect(stats.noPropertiesNotes).toBe(1)
  })

  it("returns all zeros on an empty index", () => {
    const stats = index.vaultStats({}, logger)
    expect(stats).toEqual({
      totalNotes: 0,
      untaggedNotes: 0,
      noPropertiesNotes: 0,
    })
  })
})

// ── Embedding pipeline ───────────────────────────────────────────

describe("embedding pipeline", () => {
  const DIMENSIONS = 384

  const createMockEmbedder = () => ({
    embedText: vi.fn().mockResolvedValue(new Float32Array(DIMENSIONS).fill(0.1)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) => {
      return Promise.resolve(texts.map(() => new Float32Array(DIMENSIONS).fill(0.1)))
    }),
  })

  const NOTE_FOR_EMBEDDING = `---
title: Test Note
tags: [test]
---

This is a test note with enough content to be indexed.
It has multiple sentences to verify chunking works correctly.
`

  describe("with embedder", () => {
    it("embedNote calls the embedder when provided", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const sourceVersion = seedEmbeddingSource(embeddingIndex, {
        notePath: "test.md",
        rawContent: NOTE_FOR_EMBEDDING,
      })

      await embeddingIndex.embedNote(
        { sourceVersion: sourceVersion, notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )

      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
    })

    it("prefixes chunk text with type and tags when enrichChunkMetadata is set", async () => {
      const mockEmbedder = createMockEmbedder()
      const enrichedIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
        ranking: { enrichChunkMetadata: true },
      })

      const sourceVersion = seedEmbeddingSource(enrichedIndex, {
        notePath: "typed.md",
        rawContent:
          "---\ntitle: Typed Note\ntype: reference\ntags: [search, ranking]\n---\n\nBody content for enrichment.\n",
      })

      await enrichedIndex.embedNote(
        {
          sourceVersion: sourceVersion,
          notePath: "typed.md",
          rawContent:
            "---\ntitle: Typed Note\ntype: reference\ntags: [search, ranking]\n---\n\nBody content for enrichment.\n",
        },
        logger,
      )

      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
      expect(mockEmbedder.embedText).toHaveBeenCalledWith(
        "Typed Note\nType: reference. Tags: search, ranking.\n\n\nBody content for enrichment.",
      )
    })

    it("prefixes the tags the index stores: a Tags key read, # removed, invalid names left out", async () => {
      const mockEmbedder = createMockEmbedder()
      const enrichedIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
        ranking: { enrichChunkMetadata: true },
      })
      const rawContent =
        '---\ntitle: Tagged Note\nTags: ["#Search", "a b", "1984"]\n---\n\nBody content.\n'

      const sourceVersion = seedEmbeddingSource(enrichedIndex, {
        notePath: "tagged.md",
        rawContent,
      })
      await enrichedIndex.embedNote({ sourceVersion, notePath: "tagged.md", rawContent }, logger)

      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
      expect(mockEmbedder.embedText).toHaveBeenCalledWith(
        "Tagged Note\nTags: Search.\n\n\nBody content.",
      )
    })

    it("embeds unprefixed chunk text under enrichment when the note has no type or tags", async () => {
      const mockEmbedder = createMockEmbedder()
      const enrichedIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
        ranking: { enrichChunkMetadata: true },
      })

      const sourceVersion = seedEmbeddingSource(enrichedIndex, {
        notePath: "bare.md",
        rawContent: "---\ntitle: Bare Note\n---\n\nBody without metadata.\n",
      })

      await enrichedIndex.embedNote(
        {
          sourceVersion: sourceVersion,
          notePath: "bare.md",
          rawContent: "---\ntitle: Bare Note\n---\n\nBody without metadata.\n",
        },
        logger,
      )

      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
      expect(mockEmbedder.embedText).toHaveBeenCalledWith("Bare Note\n\n\nBody without metadata.")
    })

    it("leaves chunk text unprefixed by default even when frontmatter has type and tags", async () => {
      const mockEmbedder = createMockEmbedder()
      const defaultIndex = createSearchIndex(":memory:", mockEmbedder)

      const sourceVersion = seedEmbeddingSource(defaultIndex, {
        notePath: "typed.md",
        rawContent:
          "---\ntitle: Typed Note\ntype: reference\ntags: [search, ranking]\n---\n\nBody content for enrichment.\n",
      })

      await defaultIndex.embedNote(
        {
          sourceVersion: sourceVersion,
          notePath: "typed.md",
          rawContent:
            "---\ntitle: Typed Note\ntype: reference\ntags: [search, ranking]\n---\n\nBody content for enrichment.\n",
        },
        logger,
      )

      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
      expect(mockEmbedder.embedText).toHaveBeenCalledWith(
        "Typed Note\n\n\nBody content for enrichment.",
      )
    })

    it("content-hash gating skips unchanged chunks on re-embed", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      // First embed
      const sourceVersion = seedEmbeddingSource(embeddingIndex, {
        notePath: "test.md",
        rawContent: NOTE_FOR_EMBEDDING,
      })

      await embeddingIndex.embedNote(
        { sourceVersion: sourceVersion, notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)

      // Second embed with same content — should skip (hash match)
      await embeddingIndex.embedNote(
        { sourceVersion: sourceVersion, notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
    })

    it("re-embeds when content changes", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const originalSourceVersion = seedEmbeddingSource(embeddingIndex, {
        notePath: "test.md",
        rawContent: NOTE_FOR_EMBEDDING,
      })

      await embeddingIndex.embedNote(
        {
          sourceVersion: originalSourceVersion,
          notePath: "test.md",
          rawContent: NOTE_FOR_EMBEDDING,
        },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)

      const updatedNote = NOTE_FOR_EMBEDDING.replace(
        "multiple sentences",
        "different content entirely",
      )
      const updatedSourceVersion = seedEmbeddingSource(embeddingIndex, {
        notePath: "test.md",
        rawContent: updatedNote,
      })

      await embeddingIndex.embedNote(
        { sourceVersion: updatedSourceVersion, notePath: "test.md", rawContent: updatedNote },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(2)
    })

    it("removeNote deletes associated chunks and vectors", async () => {
      const fixture = await createEmbeddingRaceIndex("note")
      const originalSourceVersion = fixture.upsert(NOTE_FOR_EMBEDDING)
      await fixture.embed(NOTE_FOR_EMBEDDING, originalSourceVersion)
      expect(fixture.chunks()).toHaveLength(1)
      expect(fixture.vectorCount()).toBe(1)

      fixture.remove()
      expect(fixture.inspect.prepare("SELECT path FROM notes").all()).toEqual([])
      expect(fixture.chunks()).toEqual([])
      expect(fixture.vectorCount()).toBe(0)

      fixture.embedder.embedText.mockClear()
      const updatedSourceVersion = fixture.upsert(NOTE_FOR_EMBEDDING)
      await fixture.embed(NOTE_FOR_EMBEDDING, updatedSourceVersion)
      expect(fixture.embedder.embedText).toHaveBeenCalledTimes(1)
      expect(fixture.chunks()).toHaveLength(1)
      expect(fixture.vectorCount()).toBe(1)
    })

    it("embedNote produces a chunk even for empty content", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const sourceVersion = seedEmbeddingSource(embeddingIndex, {
        notePath: "empty.md",
        rawContent: "",
      })

      await embeddingIndex.embedNote(
        { sourceVersion: sourceVersion, notePath: "empty.md", rawContent: "" },
        logger,
      )

      // chunker returns at least one chunk (the title-only fallback), so
      // embedText is called even for empty content
      expect(mockEmbedder.embedText).toHaveBeenCalledExactlyOnceWith("empty")
    })

    it("embedNote propagates embedder errors to the caller", async () => {
      const mockEmbedder = createMockEmbedder()
      mockEmbedder.embedText.mockRejectedValueOnce(new Error("embedding failed"))
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const sourceVersion = seedEmbeddingSource(embeddingIndex, {
        notePath: "test.md",
        rawContent: NOTE_FOR_EMBEDDING,
      })

      await expect(
        embeddingIndex.embedNote(
          { sourceVersion: sourceVersion, notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
          logger,
        ),
      ).rejects.toThrow("embedding failed")
    })
  })

  describe("without embedder", () => {
    it("embedNote is a no-op when no embedder is provided", async () => {
      const noEmbedIndex = createSearchIndex(":memory:")

      const sourceVersion = seedEmbeddingSource(noEmbedIndex, {
        notePath: "test.md",
        rawContent: NOTE_FOR_EMBEDDING,
      })

      await expect(
        noEmbedIndex.embedNote(
          { sourceVersion: sourceVersion, notePath: "test.md", rawContent: NOTE_FOR_EMBEDDING },
          logger,
        ),
      ).resolves.toBeUndefined()
    })

    it("removeNote works without vector tables", () => {
      const noEmbedIndex = createSearchIndex(":memory:")

      noEmbedIndex.upsertNote(
        {
          filePath: "test.md",
          rawContent: NOTE_FOR_EMBEDDING,
          fileStat: testStat(1000),
        },
        logger,
      )

      noEmbedIndex.removeNote("test.md")

      // Verify the note was actually removed from the FTS index
      const results = noEmbedIndex.fullTextSearch({ query: "test note" }, logger)
      expect(results).toHaveLength(0)
    })
  })

  describe("rebuildFromVault with embedding", () => {
    it("embeds notes during rebuild Pass 3", async () => {
      const mockEmbedder = createMockEmbedder()
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const vaultDir = await mkdtemp(join(tmpdir(), "embed-test-"))
      onTestFinished(async () => {
        await rm(vaultDir, { recursive: true })
      })

      await writeFile(
        join(vaultDir, "note1.md"),
        "---\ntitle: Note 1\n---\nFirst note content here.",
      )
      await writeFile(
        join(vaultDir, "note2.md"),
        "---\ntitle: Note 2\n---\nSecond note content here.",
      )

      const { count, embedding } = await embeddingIndex.rebuildFromVault(
        { vaultPath: vaultDir },
        logger,
      )
      await embedding

      expect(count).toBe(2)
      // Both notes are short → 1 chunk each → exactly 2 embedText calls
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(2)
    })

    it("continues embedding remaining notes when one fails during rebuild", async () => {
      const mockEmbedder = createMockEmbedder()
      // First embedText call rejects, subsequent calls use the default (resolve)
      mockEmbedder.embedText.mockRejectedValueOnce(new Error("embedding failed"))
      const embeddingIndex = createSearchIndex(":memory:", mockEmbedder)

      const vaultDir = await mkdtemp(join(tmpdir(), "embed-err-"))
      onTestFinished(async () => {
        await rm(vaultDir, { recursive: true })
      })

      await writeFile(join(vaultDir, "note1.md"), "---\ntitle: Note 1\n---\nFirst note content.")
      await writeFile(join(vaultDir, "note2.md"), "---\ntitle: Note 2\n---\nSecond note content.")

      const warnSpy = vi.spyOn(logger, "warn")
      const { count, embedding } = await embeddingIndex.rebuildFromVault(
        { vaultPath: vaultDir },
        logger,
      )
      await embedding

      expect(count).toBe(2)
      // One note failed, warn logged with the specific error
      expect(warnSpy).toHaveBeenCalledWith(
        "failed to embed note",
        expect.objectContaining({ error: "[Error]: embedding failed" }),
      )
      // Both notes attempted embedding (first failed, second succeeded)
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(2)
      warnSpy.mockRestore()
    })

    it("embeds file content during rebuild Pass 3", async () => {
      const mockEmbedder = createMockEmbedder()
      const vaultDir = await mkdtemp(join(tmpdir(), "embed-file-rebuild-"))
      const dbDir = await mkdtemp(join(tmpdir(), "embed-file-rebuild-db-"))
      onTestFinished(async () => {
        await rm(vaultDir, { recursive: true })
        await rm(dbDir, { recursive: true })
      })
      const dbPath = join(dbDir, "search.db")
      const embeddingIndex = createSearchIndex(dbPath, mockEmbedder, undefined, {
        fileToolsEnabled: true,
      })

      await writeFile(
        join(vaultDir, "note1.md"),
        "---\ntitle: Note 1\n---\nFirst note content here.",
      )
      await writeFile(
        join(vaultDir, "guide.txt"),
        "Comprehensive deployment guide covering infrastructure setup.",
      )

      const { embedding } = await embeddingIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)
      await embedding

      const inspectDb = new Database(dbPath, { readonly: true })
      sqliteVec.load(inspectDb)
      onTestFinished(() => {
        inspectDb.close()
      })
      const fileChunks = inspectDb
        .prepare<[string], { count: number }>(
          "SELECT COUNT(*) as count FROM file_content_chunks WHERE file_path = ?",
        )
        .get("guide.txt")
      expect(fileChunks?.count).toBe(1)
      const fileVectors = inspectDb
        .prepare<unknown[], { count: number }>("SELECT COUNT(*) as count FROM file_content_vectors")
        .get()
      expect(fileVectors?.count).toBe(1)
    })

    it("removes chunks and vectors for a file deleted while the server was down", async () => {
      const mockEmbedder = createMockEmbedder()
      const vaultDir = await mkdtemp(join(tmpdir(), "embed-file-deleted-"))
      const dbDir = await mkdtemp(join(tmpdir(), "embed-file-deleted-db-"))
      onTestFinished(async () => {
        await rm(vaultDir, { recursive: true })
        await rm(dbDir, { recursive: true })
      })
      const dbPath = join(dbDir, "search.db")
      const embeddingIndex = createSearchIndex(dbPath, mockEmbedder, undefined, {
        fileToolsEnabled: true,
      })

      await writeFile(join(vaultDir, "ephemeral.txt"), "Transient file body.")

      const firstRebuild = await embeddingIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)
      await firstRebuild.embedding

      const inspectDb = new Database(dbPath, { readonly: true })
      sqliteVec.load(inspectDb)
      onTestFinished(() => {
        inspectDb.close()
      })
      const selectChunkCountStmt = inspectDb.prepare<[string], { count: number }>(
        "SELECT COUNT(*) as count FROM file_content_chunks WHERE file_path = ?",
      )
      // The first rebuild actually embedded the file, so the cleanup assertion
      // below can't pass by the file never being indexed
      expect(selectChunkCountStmt.get("ephemeral.txt")?.count).toBe(1)

      await rm(join(vaultDir, "ephemeral.txt"))
      const secondRebuild = await embeddingIndex.rebuildFromVault({ vaultPath: vaultDir }, logger)
      await secondRebuild.embedding

      expect(selectChunkCountStmt.get("ephemeral.txt")?.count).toBe(0)
      const fileVectors = inspectDb
        .prepare<unknown[], { count: number }>("SELECT COUNT(*) as count FROM file_content_vectors")
        .get()
      expect(fileVectors?.count).toBe(0)
    })
  })
})

describe("fullTextSearch created filter", () => {
  const noteCreatedOn = (createdDate: string): string => `---
title: Dated note
created: ${createdDate}
---
Shared datefilter content for boundary tests.
`

  const NOTE_WITHOUT_CREATED = `# Undated note

Shared datefilter content for boundary tests.
`

  /** Seeds three dated notes (2026-03-09 / -10 / -11) plus one without a
   *  created property, all matching the "datefilter" query term. */
  const indexWithCreatedDates = (): SearchIndex => {
    const dateIndex = createSearchIndex(":memory:")
    dateIndex.upsertNote(
      {
        filePath: "early.md",
        rawContent: noteCreatedOn("2026-03-09"),
        fileStat: testStat(1000),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "middle.md",
        rawContent: noteCreatedOn("2026-03-10"),
        fileStat: testStat(1000),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "late.md",
        rawContent: noteCreatedOn("2026-03-11"),
        fileStat: testStat(1000),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "undated.md",
        rawContent: NOTE_WITHOUT_CREATED,
        fileStat: testStat(1000),
      },
      logger,
    )
    return dateIndex
  }

  it("created.on matches only notes created on that calendar day", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { on: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["middle.md"])
  })

  it("created.before is exclusive of the boundary day", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { before: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["early.md"])
  })

  it("created.after is exclusive of the boundary day", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { after: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["late.md"])
  })

  it("created before and after combine into a range", () => {
    const dateIndex = indexWithCreatedDates()
    const results = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { created: { after: "2026-03-09", before: "2026-03-11" } },
      },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["middle.md"])
  })

  it("a created filter never matches notes without a created property", () => {
    const dateIndex = indexWithCreatedDates()
    // Bound satisfied by every dated note — only the undated note can be
    // excluded, proving NULL exclusion rather than an over-tight bound
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { before: "2099-01-01" } } },
      logger,
    )
    const resultPaths = results.map((result) => result.path)
    expect(resultPaths.toSorted()).toEqual(["early.md", "late.md", "middle.md"])
  })

  it("created.on matches on the calendar day of a created value with a time component", () => {
    const dateIndex = createSearchIndex(":memory:")
    dateIndex.upsertNote(
      {
        filePath: "timed.md",
        rawContent: noteCreatedOn("2026-03-10T23:45:00"),
        fileStat: testStat(1000),
      },
      logger,
    )
    // A neighbor on the adjacent day proves the filter actually ran —
    // without it, an ignored filter would return the same single result
    dateIndex.upsertNote(
      {
        filePath: "next-day.md",
        rawContent: noteCreatedOn("2026-03-11T00:15:00"),
        fileStat: testStat(1000),
      },
      logger,
    )
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { created: { on: "2026-03-10" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["timed.md"])
  })

  it("rejects a malformed created date with remediation text", () => {
    const dateIndex = indexWithCreatedDates()
    expect(() => {
      dateIndex.fullTextSearch(
        { query: "datefilter", filters: { created: { on: "March 10" } } },
        logger,
      )
    }).toThrow(/^invalid created\.on date: "March 10"\. Use YYYY-MM-DD \(e\.g\. 2026-07-03\)\.$/)
  })

  it("rejects a calendar-invalid created date", () => {
    const dateIndex = indexWithCreatedDates()
    expect(() => {
      dateIndex.fullTextSearch(
        {
          query: "datefilter",
          filters: { created: { before: "2026-02-31" } },
        },
        logger,
      )
    }).toThrow(
      /^invalid created\.before date: "2026-02-31"\. Use YYYY-MM-DD \(e\.g\. 2026-07-03\)\.$/,
    )
  })
})

describe("fullTextSearch modified filter", () => {
  const noteModifiedAt = (title: string): string => `---
title: ${title}
tags: [datefilter-test]
---
Shared datefilter content for mtime boundary tests.
`

  /** Seeds three notes stat-stamped minutes around the 2026-06-15 day
   *  boundaries: 23:59 the day before, midday, and 00:30 the day after —
   *  so an off-by-one on either boundary flips a test. */
  const indexWithModifiedTimes = (): SearchIndex => {
    const dateIndex = createSearchIndex(":memory:")
    dateIndex.upsertNote(
      {
        filePath: "day-before.md",
        rawContent: noteModifiedAt("Day before"),
        fileStat: testStat(DateTime.fromISO("2026-06-14T23:59:00").toMillis()),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "during.md",
        rawContent: noteModifiedAt("During"),
        fileStat: testStat(DateTime.fromISO("2026-06-15T12:00:00").toMillis()),
      },
      logger,
    )
    dateIndex.upsertNote(
      {
        filePath: "day-after.md",
        rawContent: noteModifiedAt("Day after"),
        fileStat: testStat(DateTime.fromISO("2026-06-16T00:30:00").toMillis()),
      },
      logger,
    )
    return dateIndex
  }

  it("modified.on matches notes touched within that server-local day", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { modified: { on: "2026-06-15" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["during.md"])
  })

  it("modified.before matches strictly earlier days", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { modified: { before: "2026-06-15" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["day-before.md"])
  })

  it("modified.after matches strictly later days", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      { query: "datefilter", filters: { modified: { after: "2026-06-15" } } },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["day-after.md"])
  })

  it("modified after and before combine into a range", () => {
    const dateIndex = indexWithModifiedTimes()
    const results = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { modified: { after: "2026-06-14", before: "2026-06-16" } },
      },
      logger,
    )
    expect(results.map((result) => result.path)).toEqual(["during.md"])
  })

  it("rejects a malformed modified date with remediation text", () => {
    const dateIndex = indexWithModifiedTimes()
    expect(() => {
      dateIndex.fullTextSearch(
        { query: "datefilter", filters: { modified: { after: "yesterday" } } },
        logger,
      )
    }).toThrow(
      /^invalid modified\.after date: "yesterday"\. Use YYYY-MM-DD \(e\.g\. 2026-07-03\)\.$/,
    )
  })

  it("rejects a calendar-invalid modified date", () => {
    const dateIndex = indexWithModifiedTimes()
    expect(() => {
      dateIndex.fullTextSearch(
        {
          query: "datefilter",
          filters: { modified: { before: "2026-02-31" } },
        },
        logger,
      )
    }).toThrow(
      /^invalid modified\.before date: "2026-02-31"\. Use YYYY-MM-DD \(e\.g\. 2026-07-03\)\.$/,
    )
  })

  it("date filters AND-combine with other filters and the text query", () => {
    const dateIndex = indexWithModifiedTimes()
    // All three notes carry the datefilter-test tag — with the tag filter
    // satisfied, only the date bound can narrow the results to during.md
    const tagMatchedResults = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { modified: { on: "2026-06-15" }, tags: ["datefilter-test"] },
      },
      logger,
    )
    expect(tagMatchedResults.map((result) => result.path)).toEqual(["during.md"])
    // And in reverse, during.md matches the modified bound but lacks the
    // required tag, so the tag filter must exclude it despite the date match
    const tagExcludedResults = dateIndex.fullTextSearch(
      {
        query: "datefilter",
        filters: { modified: { on: "2026-06-15" }, tags: ["nonexistent-tag"] },
      },
      logger,
    )
    expect(tagExcludedResults).toHaveLength(0)
  })
})

// ── File content indexing constants ──────────────────────────

describe("INDEXABLE_TEXT_EXTENSIONS", () => {
  it("contains the expected set of extensions for FTS indexing", () => {
    expect([...INDEXABLE_TEXT_EXTENSIONS].sort()).toEqual([
      ".base",
      ".csv",
      ".json",
      ".log",
      ".pdf",
      ".svg",
      ".txt",
      ".xml",
      ".yaml",
      ".yml",
    ])
  })
})

// ── Canvas file content + link graph ──────────────────────────

describe("canvas note catalog reuse", () => {
  const observeCatalogScans = () => {
    const scans = vi.fn()
    const realPrepare: (this: Database.Database, source: string) => Database.Statement =
      Database.prototype.prepare
    /** The native method needs its SQLite receiver; count executions rather than preparations. */
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      const statement = realPrepare.call(this, source)

      if (source.trim() === "SELECT path FROM notes") {
        const realAll = statement.all.bind(statement)
        vi.spyOn(statement, "all").mockImplementation((...allParams: unknown[]) => {
          scans()
          return realAll(...allParams)
        })
      }
      return statement
    })
    onTestFinished(() => prepareSpy.mockRestore())
    return scans
  }
  const canvasWithTarget = (target?: string): string =>
    JSON.stringify({
      nodes: target
        ? [{ id: "file", type: "file", x: 0, y: 0, width: 100, height: 100, file: target }]
        : [],
      edges: [],
    })
  const saveCanvas = (search: SearchIndex, target?: string): void => {
    search.upsertFileContent(
      { filePath: "board.canvas", rawContent: canvasWithTarget(target), fileStat: testStat(1000) },
      logger,
    )
  }
  const outgoingPaths = (search: SearchIndex): string[] =>
    search.getOutgoingLinks({ path: "board.canvas" }, logger).map((link) => link.path)

  it("avoids empty-canvas scans and shares one catalog across repeated linked saves", () => {
    const scans = observeCatalogScans()
    const search = createSearchIndex(":memory:", undefined, undefined, { fileToolsEnabled: true })
    search.upsertNote(
      { filePath: "Target.md", rawContent: "targetamber", fileStat: testStat(1000) },
      logger,
    )
    search.upsertNote(
      { filePath: "Decoy.md", rawContent: "decoyquartz", fileStat: testStat(1000) },
      logger,
    )
    scans.mockClear()
    saveCanvas(search)
    expect(scans).not.toHaveBeenCalled()
    expect(outgoingPaths(search)).toEqual([])
    for (const _unused of Array.from({ length: 12 })) saveCanvas(search, "Target")
    expect(scans).toHaveBeenCalledTimes(1)
    expect(outgoingPaths(search)).toEqual(["Target.md"])
    saveCanvas(search)
    expect(outgoingPaths(search)).toEqual([])
    expect(scans).toHaveBeenCalledTimes(1)
  })

  it("refreshes the catalog after note additions, deletions and recreation with asset fallback", () => {
    const scans = observeCatalogScans()
    const search = createSearchIndex(":memory:", undefined, undefined, { fileToolsEnabled: true })
    search.upsertNonMdFile("Target.canvas", 100)
    saveCanvas(search, "Target")
    expect(outgoingPaths(search)).toEqual(["Target.canvas"])
    search.upsertNote(
      { filePath: "Target.md", rawContent: "targetamber", fileStat: testStat(1000) },
      logger,
    )
    scans.mockClear()
    saveCanvas(search, "Target")
    expect(scans).toHaveBeenCalledTimes(1)
    expect(outgoingPaths(search)).toEqual(["Target.md"])
    search.removeNote("Target.md")
    scans.mockClear()
    saveCanvas(search, "Target")
    expect(scans).toHaveBeenCalledTimes(1)
    expect(outgoingPaths(search)).toEqual(["Target.canvas"])
    search.upsertNote(
      { filePath: "Target.md", rawContent: "recreatedopal", fileStat: testStat(2000) },
      logger,
    )
    scans.mockClear()
    saveCanvas(search, "Target")
    saveCanvas(search, "Target")
    expect(scans).toHaveBeenCalledTimes(1)
    expect(outgoingPaths(search)).toEqual(["Target.md"])
  })

  it("keeps committed membership after a failed note upsert rolls back", () => {
    const poison = installStatementPoison("INSERT INTO tasks")
    const search = createSearchIndex(":memory:", undefined, undefined, { fileToolsEnabled: true })
    search.upsertNonMdFile("Target.canvas", 100)
    saveCanvas(search, "Target")
    poison.arm()
    expect(() =>
      search.upsertNote(
        {
          filePath: "Target.md",
          rawContent: "- [ ] task that triggers poison",
          fileStat: testStat(1000),
        },
        logger,
      ),
    ).toThrow(new Error(poison.message))
    poison.disarm()
    saveCanvas(search, "Target")
    expect(outgoingPaths(search)).toEqual(["Target.canvas"])
  })

  it("uses the rebuild catalog for a canvas corpus and later saves", async () => {
    const scans = observeCatalogScans()
    const directory = await mkdtemp(join(tmpdir(), "canvas-catalog-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, "Target.md"), "targetamber")
    await writeFile(join(directory, "Decoy.md"), "decoyquartz")
    const canvasNames = Array.from({ length: 9 }, (_unused, position) => `board-${position}.canvas`)
    for (const canvasName of canvasNames)
      await writeFile(join(directory, canvasName), canvasWithTarget("Target"))
    const search = createSearchIndex(":memory:", undefined, undefined, { fileToolsEnabled: true })
    const rebuilt = await search.rebuildFromVault({ vaultPath: directory }, logger)
    await rebuilt.embedding
    expect(rebuilt.count).toBe(2)
    expect(scans).toHaveBeenCalledTimes(1)
    expect(search.getBacklinks({ path: "Target.md" }, logger).map((link) => link.path)).toEqual(
      canvasNames,
    )
    saveCanvas(search, "Target")
    expect(scans).toHaveBeenCalledTimes(1)
    expect(outgoingPaths(search)).toEqual(["Target.md"])
  })

  it("drops an uncommitted rebuild catalog on a late outer rollback", async () => {
    const scans = observeCatalogScans()
    const directory = await mkdtemp(join(tmpdir(), "canvas-catalog-rollback-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, "Target.md"), "targetamber")
    await writeFile(join(directory, "failed.canvas"), canvasWithTarget("Target"))
    const search = createSearchIndex(":memory:", undefined, undefined, { fileToolsEnabled: true })
    search.upsertNote(
      { filePath: "Existing.md", rawContent: "existingquartz", fileStat: testStat(1000) },
      logger,
    )
    saveCanvas(search, "Existing")
    const failure = new Error("controlled late rebuild rollback")
    const rebuildLogger = logger.child({ operation: "controlled-rebuild" })
    vi.spyOn(rebuildLogger, "debug").mockImplementation((message) => {
      if (message === "indexed file content") throw failure
    })
    vi.spyOn(rebuildLogger, "warn").mockImplementation(() => {
      throw failure
    })
    await expect(search.rebuildFromVault({ vaultPath: directory }, rebuildLogger)).rejects.toThrow(
      failure,
    )
    search.upsertNonMdFile("Target.canvas", 100)
    scans.mockClear()
    saveCanvas(search, "Target")
    expect(scans).toHaveBeenCalledTimes(1)
    expect(outgoingPaths(search)).toEqual(["Target.canvas"])
    const recovered = await search.rebuildFromVault({ vaultPath: directory }, logger)
    await recovered.embedding
    saveCanvas(search, "Target")
    expect(outgoingPaths(search)).toEqual(["Target.md"])
  })
})

describe("canvas file content and links", () => {
  it.each([{ fileToolsEnabled: true }, { fileToolsEnabled: false }])(
    "resolves canvas links to existing notes and assets with file tools $fileToolsEnabled",
    ({ fileToolsEnabled }) => {
      const canvasIndex = createSearchIndex(":memory:", undefined, undefined, { fileToolsEnabled })
      for (const notePath of ["Notes/Plan.md", "Notes/Route.md", "deep/Plan.md"]) {
        canvasIndex.upsertNote(
          { filePath: notePath, rawContent: "targetamber", fileStat: testStat(1000) },
          logger,
        )
      }
      for (const assetPath of [
        "photos/Sunset.png",
        "photo.png.canvas",
        "a/photo.png",
        "Route.canvas",
        "assets/map.canvas",
      ]) {
        canvasIndex.upsertNonMdFile(assetPath, 42)
      }
      canvasIndex.upsertNonMdFile("Boards/source.canvas", 100)
      const targets = [
        "../Notes/Plan.md",
        "Sunset.png",
        "sunset.png",
        "photo.png",
        "Route",
        "../assets/map.canvas",
        "missing.png",
      ]
      const canvasContent = JSON.stringify({
        nodes: targets.map((file, position) => ({
          id: `file-${position}`,
          type: "file",
          x: 0,
          y: position * 100,
          width: 100,
          height: 100,
          file,
        })),
        edges: [],
      })
      canvasIndex.upsertFileContent(
        {
          filePath: "Boards/source.canvas",
          rawContent: canvasContent,
          fileStat: testStat(1000, 100),
        },
        logger,
      )

      expect(
        canvasIndex
          .getOutgoingLinks({ path: "Boards/source.canvas" }, logger)
          .map((link) => ({ path: link.path, exists: link.exists })),
      ).toEqual([
        { path: "Notes/Plan.md", exists: true },
        { path: "Notes/Route.md", exists: true },
        { path: "a/photo.png", exists: true },
        { path: "assets/map.canvas", exists: true },
        { path: "missing.png", exists: false },
        { path: "photos/Sunset.png", exists: true },
      ])
      expect(
        canvasIndex.getBacklinks({ path: "Notes/Plan.md" }, logger).map((link) => link.path),
      ).toEqual(["Boards/source.canvas"])
      expect(
        canvasIndex.getBacklinks({ path: "assets/map.canvas" }, logger).map((link) => link.path),
      ).toEqual(["Boards/source.canvas"])
      expect(canvasIndex.brokenLinkCount({}, logger)).toEqual({
        count: 1,
        excludedFolder: null,
        excludedCount: 0,
      })
      canvasIndex.upsertNonMdFile("other/unchanged.txt", 12)
      expect(canvasIndex.brokenLinkCount({}, logger)).toEqual({
        count: 1,
        excludedFolder: null,
        excludedCount: 0,
      })
    },
  )

  const CANVAS_WITH_FILE_NODES = JSON.stringify({
    nodes: [
      {
        id: "t1",
        type: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        text: "Architecture overview with deployment details",
      },
      {
        id: "f1",
        type: "file",
        x: 300,
        y: 0,
        width: 400,
        height: 200,
        file: "Projects/vault-cortex.md",
      },
      {
        id: "f2",
        type: "file",
        x: 300,
        y: 250,
        width: 400,
        height: 200,
        file: "Notes/design-doc.md",
      },
    ],
    edges: [],
  })

  const CANVAS_TEXT_WITH_WIKILINKS = JSON.stringify({
    nodes: [
      {
        id: "t1",
        type: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        text: "See [[Projects/vault-cortex]] for details",
      },
    ],
    edges: [],
  })

  describe("with fileToolsEnabled", () => {
    it("upsertFileContent indexes canvas content into file_content_fts", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      const { results } = await fileIndex.hybridSearch({ query: "architecture deployment" }, logger)
      const canvasResult = results.find((result) => result.path === "Diagrams/arch.canvas")
      expect(canvasResult).toEqual({
        path: "Diagrams/arch.canvas",
        title: "arch",
        snippet: expect.any(String),
        // Rank-1 RRF (1/61 + 0.05) scaled by the shipped file-leg weight 0.5
        score: 0.0332,
        tags: [],
        folder: "Diagrams",
        type: null,
        kind: "file",
        extension: ".canvas",
        modified: isoFromMillis(5000),
        bytes: 500,
      })
    })

    it("canvas file-node references appear as backlinks", () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNote(
        {
          filePath: "Projects/vault-cortex.md",
          rawContent: "# vault-cortex\n\nMain project note.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      const backlinks = fileIndex.getBacklinks({ path: "Projects/vault-cortex.md" }, logger)
      expect(backlinks.map((backlink) => backlink.path)).toEqual(["Diagrams/arch.canvas"])
    })

    it("canvas outgoing links show file-node targets", () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNote(
        {
          filePath: "Projects/vault-cortex.md",
          rawContent: "# vault-cortex\n\nProject note.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      const outgoing = fileIndex.getOutgoingLinks({ path: "Diagrams/arch.canvas" }, logger)
      const targetPaths = outgoing.map((link) => link.path)
      expect(targetPaths).toEqual(["Notes/design-doc.md", "Projects/vault-cortex.md"])
    })

    it("canvas outgoing link to non-existent file shows exists: false", () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      const outgoing = fileIndex.getOutgoingLinks({ path: "Diagrams/arch.canvas" }, logger)
      const brokenLink = outgoing.find((link) => link.path === "Notes/design-doc.md")
      expect(brokenLink?.exists).toBe(false)
    })

    it("removeFileContent cleans up FTS and links", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNote(
        {
          filePath: "Projects/vault-cortex.md",
          rawContent: "# vault-cortex\n\nProject note.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      fileIndex.removeFileContent({ filePath: "Diagrams/arch.canvas" }, logger)
      const backlinks = fileIndex.getBacklinks({ path: "Projects/vault-cortex.md" }, logger)
      expect(backlinks).toEqual([])
      const { results } = await fileIndex.hybridSearch({ query: "architecture deployment" }, logger)
      const canvasResult = results.find((result) => result.path === "Diagrams/arch.canvas")
      expect(canvasResult).toBeUndefined()
    })
  })

  describe("without fileToolsEnabled", () => {
    it("canvas links are extracted even without fileToolsEnabled", () => {
      index.upsertNote(
        {
          filePath: "Projects/vault-cortex.md",
          rawContent: "# vault-cortex\n\nProject note.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      index.upsertNonMdFile("Diagrams/arch.canvas", 500)
      index.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      const backlinks = index.getBacklinks({ path: "Projects/vault-cortex.md" }, logger)
      expect(backlinks.map((backlink) => backlink.path)).toEqual(["Diagrams/arch.canvas"])
    })

    it("canvas content is NOT indexed into FTS without fileToolsEnabled", async () => {
      index.upsertNonMdFile("Diagrams/arch.canvas", 500)
      index.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      const { results } = await index.hybridSearch({ query: "architecture deployment" }, logger)
      const canvasResult = results.find((result) => result.path === "Diagrams/arch.canvas")
      expect(canvasResult).toBeUndefined()
    })
  })

  describe("mandatory negative: text-node wikilinks", () => {
    it("text-node wikilinks do NOT create backlinks", () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNote(
        {
          filePath: "Projects/vault-cortex.md",
          rawContent: "# vault-cortex\n\nProject note.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      fileIndex.upsertNonMdFile("Diagrams/text-only.canvas", 200)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/text-only.canvas",
          rawContent: CANVAS_TEXT_WITH_WIKILINKS,
          fileStat: testStat(5000, 200),
        },
        logger,
      )
      const backlinks = fileIndex.getBacklinks({ path: "Projects/vault-cortex.md" }, logger)
      expect(backlinks).toEqual([])
    })
  })

  describe("canvas backlinks target acceptance", () => {
    it("getBacklinks accepts .canvas path as target", () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNote(
        {
          filePath: "Notes/overview.md",
          rawContent: "# Overview\n\nSee [[Diagrams/arch.canvas]] for the diagram.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      const backlinks = fileIndex.getBacklinks({ path: "Diagrams/arch.canvas" }, logger)
      expect(backlinks.map((backlink) => backlink.path)).toEqual(["Notes/overview.md"])
    })
  })

  describe("non-canvas files", () => {
    it("indexes non-canvas text file content into FTS without link extraction", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      // Canvas-shaped JSON as .json file content — verifies that
      // non-canvas files get FTS indexed but don't produce graph links
      // (even when the content contains file references).
      const canvasLikeContent = JSON.stringify({
        nodes: [
          {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            text: "Searchable deployment content",
          },
          {
            id: "f1",
            type: "file",
            x: 300,
            y: 0,
            width: 400,
            height: 200,
            file: "Notes/architecture.md",
          },
        ],
        edges: [],
      })
      fileIndex.upsertNote(
        {
          filePath: "Notes/architecture.md",
          rawContent: "# Architecture\n\nOverview.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      fileIndex.upsertNonMdFile("data/export.json", 200)
      fileIndex.upsertFileContent(
        {
          filePath: "data/export.json",
          rawContent: canvasLikeContent,
          fileStat: testStat(5000, 200),
        },
        logger,
      )
      // JSON content IS indexed into FTS — searchable as raw text
      const { results } = await fileIndex.hybridSearch({ query: "searchable deployment" }, logger)
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "data/export.json",
            kind: "file",
            extension: ".json",
          }),
        ]),
      )
      // No graph links created — link extraction is canvas-only
      const backlinks = fileIndex.getBacklinks({ path: "Notes/architecture.md" }, logger)
      expect(backlinks).toEqual([])
    })

    it("indexes plain text file content", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNonMdFile("logs/server.log", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "logs/server.log",
          rawContent: "Connection established to database cluster alpha",
          fileStat: testStat(500),
        },
        logger,
      )
      const { results } = await fileIndex.hybridSearch({ query: "database cluster alpha" }, logger)
      expect(results).toHaveLength(1)
      expect(results[0]).toEqual(
        expect.objectContaining({
          path: "logs/server.log",
          kind: "file",
          extension: ".log",
          title: "server",
        }),
      )
    })

    it("truncates content exceeding MAX_INDEXED_CONTENT_BYTES", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      // Unique phrase at the start (within 100KB cap), filler to push past
      // the cap, then a different unique phrase at the end (beyond 100KB).
      // Truncation means the start phrase is searchable but the end is not.
      const startPhrase = "alphanumeric beginning marker"
      const filler = "x ".repeat(55_000) // ~110KB of filler
      const endPhrase = "zyxwvut ending marker"
      const largeContent = `${startPhrase}\n${filler}\n${endPhrase}`
      fileIndex.upsertNonMdFile("data/big.csv", largeContent.length)
      fileIndex.upsertFileContent(
        {
          filePath: "data/big.csv",
          rawContent: largeContent,
          fileStat: testStat(largeContent.length),
        },
        logger,
      )
      // Content before the cap IS searchable
      const { results: foundResults } = await fileIndex.hybridSearch(
        { query: "alphanumeric beginning marker" },
        logger,
      )
      expect(foundResults).toHaveLength(1)
      expect(foundResults[0]?.path).toBe("data/big.csv")
      // Content beyond the cap is NOT searchable — proves truncation
      const { results: truncatedResults } = await fileIndex.hybridSearch(
        { query: "zyxwvut ending marker" },
        logger,
      )
      expect(truncatedResults).toHaveLength(0)
    })

    it("removeFileContent clears non-canvas file content from FTS", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNonMdFile("logs/app.log", 300)
      fileIndex.upsertFileContent(
        {
          filePath: "logs/app.log",
          rawContent: "removable diagnostics content",
          fileStat: testStat(300),
        },
        logger,
      )
      // Verify it was indexed first — without this, the removal assertion
      // could pass by the content never being indexed (silent no-op).
      const { results: beforeResults } = await fileIndex.hybridSearch(
        { query: "removable diagnostics" },
        logger,
      )
      expect(beforeResults).toHaveLength(1)
      // Remove and verify it's gone
      fileIndex.removeFileContent({ filePath: "logs/app.log" }, logger)
      const { results: afterResults } = await fileIndex.hybridSearch(
        { query: "removable diagnostics" },
        logger,
      )
      expect(afterResults).toHaveLength(0)
    })
  })

  describe("note-specific filter suppression", () => {
    it("hybridSearch excludes file content results when a tag filter is active", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      // Seed a note that matches the tag filter
      fileIndex.upsertNote(
        {
          filePath: "Projects/plan.md",
          rawContent: "---\ntags: [project]\n---\n# Plan\n\nArchitecture overview.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      // Seed a canvas with matching text content
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      // Search with a tag filter — canvas has no tags, so it must be excluded
      const { results } = await fileIndex.hybridSearch(
        { query: "architecture", filters: { tags: ["project"] } },
        logger,
      )
      const paths = results.map((result) => result.path)
      expect(paths).toContain("Projects/plan.md")
      expect(paths).not.toContain("Diagrams/arch.canvas")
    })

    it("hybridSearch excludes file content results when a type filter is active", async () => {
      const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })
      fileIndex.upsertNote(
        {
          filePath: "Projects/plan.md",
          rawContent: "---\ntype: reference\n---\n# Plan\n\nArchitecture overview.\n",
          fileStat: testStat(1000),
        },
        logger,
      )
      fileIndex.upsertNonMdFile("Diagrams/arch.canvas", 500)
      fileIndex.upsertFileContent(
        {
          filePath: "Diagrams/arch.canvas",
          rawContent: CANVAS_WITH_FILE_NODES,
          fileStat: testStat(5000, 500),
        },
        logger,
      )
      const { results } = await fileIndex.hybridSearch(
        { query: "architecture", filters: { type: "reference" } },
        logger,
      )
      const paths = results.map((result) => result.path)
      expect(paths).toContain("Projects/plan.md")
      expect(paths).not.toContain("Diagrams/arch.canvas")
    })
  })
})

// ── File content vector embeddings ────────────────────────────

describe("committed embedding source versions", () => {
  it.each(["note", "file"] as const)(
    "rejects a %s model result after source deletion",
    async (sourceKind) => {
      const fixture = await createEmbeddingRaceIndex(sourceKind)
      const model = Promise.withResolvers<Float32Array>()
      fixture.embedder.embedText.mockImplementationOnce(() => model.promise)
      const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {})
      onTestFinished(() => debugSpy.mockRestore())
      const sourceVersion = fixture.upsert("Old oldquartz")
      const job = fixture.embed("Old oldquartz", sourceVersion)
      expect(fixture.embedder.embedText).toHaveBeenCalledTimes(1)

      fixture.remove()
      expect(fixture.inspect.prepare(`SELECT path FROM ${fixture.sourceTable}`).all()).toEqual([])
      model.resolve(new Float32Array(384).fill(0.1))
      await job

      expect(fixture.chunks()).toEqual([])
      expect(fixture.vectorCount()).toBe(0)
      expect(debugSpy).toHaveBeenCalledWith("skipped obsolete embedding", { path: fixture.path })
    },
  )

  it.each(["note", "file"] as const)(
    "keeps a recreated %s free of stale chunks while its replacement model is held",
    async (sourceKind) => {
      const fixture = await createEmbeddingRaceIndex(sourceKind)
      const oldModel = Promise.withResolvers<Float32Array>()
      const replacementModel = Promise.withResolvers<Float32Array>()
      fixture.embedder.embedText.mockImplementationOnce(() => oldModel.promise)
      fixture.embedder.embedText.mockImplementationOnce(() => replacementModel.promise)
      const originalContent =
        sourceKind === "note" ? "---\ntitle: Old\n---\nOld oldquartz" : "Old oldquartz"
      const replacementContent =
        sourceKind === "note" ? "---\ntitle: New\n---\nNew newcobalt" : "New newcobalt"
      const replacementTitle = sourceKind === "note" ? "New" : "reuse"
      const originalVersion = fixture.upsert(originalContent)
      const oldJob = fixture.embed(originalContent, originalVersion)
      fixture.remove()
      const replacementVersion = fixture.upsert(replacementContent)
      const replacementJob = fixture.embed(replacementContent, replacementVersion)
      expect(fixture.embedder.embedText).toHaveBeenCalledTimes(2)

      oldModel.resolve(new Float32Array(384).fill(0.1))
      await oldJob
      expect(
        fixture.inspect.prepare(`SELECT title, content FROM ${fixture.sourceTable}`).all(),
      ).toEqual([{ title: replacementTitle, content: "New newcobalt" }])
      expect(fixture.chunks()).toEqual([])
      expect(fixture.vectorCount()).toBe(0)

      replacementModel.resolve(new Float32Array(384).fill(0.1))
      await replacementJob
      expect(fixture.chunks()).toEqual([
        { chunk_index: 0, chunk_text: `${replacementTitle}\n\nNew newcobalt` },
      ])
      expect(fixture.vectorCount()).toBe(1)
      const { results } = await fixture.searchIndex.hybridSearch(
        { query: "unmatchedsemanticquery" },
        logger,
      )
      expect(
        results.map((result) => ({
          path: result.path,
          title: result.title,
          snippet: result.snippet,
        })),
      ).toEqual([
        {
          path: fixture.path,
          title: replacementTitle,
          snippet: `${replacementTitle} New newcobalt`,
        },
      ])
    },
  )

  it.each(["note", "file"] as const)(
    "does not let a stale short %s job prune a newer long source's tail",
    async (sourceKind) => {
      const fixture = await createEmbeddingRaceIndex(sourceKind)
      const staleModel = Promise.withResolvers<Float32Array>()
      const shortVersion = fixture.upsert("Short obsolete body.")
      fixture.embedder.embedText.mockImplementationOnce(() => staleModel.promise)
      const staleJob = fixture.embed("Short obsolete body.", shortVersion)
      const longContent = Array.from({ length: 8 }, (_, paragraphIndex) => {
        return `## Section ${String(paragraphIndex)}\n\n${"Current content about cobalt systems. ".repeat(25)}`
      }).join("\n\n")
      const currentVersion = fixture.upsert(longContent)
      await fixture.embed(longContent, currentVersion)
      const currentChunks = fixture.chunks()
      expect(currentChunks.length).toBeGreaterThan(1)
      expect(fixture.vectorCount()).toBe(currentChunks.length)

      staleModel.resolve(new Float32Array(384).fill(0.1))
      await staleJob
      expect(fixture.chunks()).toEqual(currentChunks)
      expect(fixture.vectorCount()).toBe(currentChunks.length)
    },
  )

  it.each(["note", "file"] as const)(
    "preserves a %s source version when its upsert transaction fails",
    async (sourceKind) => {
      const sqlFragment =
        sourceKind === "note" ? "INSERT INTO tasks" : "INSERT INTO file_content_fts"
      const poison = installStatementPoison(sqlFragment)
      const fixture = await createEmbeddingRaceIndex(sourceKind)
      const originalContent = "Original committed content."
      const sourceVersion = fixture.upsert(originalContent)
      poison.arm()
      expect(() => fixture.upsert("Replacement body.\n\n- [ ] trigger task")).toThrow(
        poison.message,
      )
      poison.disarm()

      await fixture.embed(originalContent, sourceVersion)
      expect(fixture.embedder.embedText).toHaveBeenCalledTimes(1)
      expect(fixture.chunks()).toEqual([
        { chunk_index: 0, chunk_text: "reuse\n\nOriginal committed content." },
      ])
      expect(fixture.inspect.prepare(`SELECT content FROM ${fixture.sourceTable}`).all()).toEqual([
        { content: originalContent },
      ])
    },
  )

  it.each(["note", "file"] as const)(
    "preserves a %s source version when its removal transaction fails",
    async (sourceKind) => {
      const sqlFragment =
        sourceKind === "note" ? "DELETE FROM tasks" : "DELETE FROM file_content WHERE"
      const poison = installStatementPoison(sqlFragment)
      const fixture = await createEmbeddingRaceIndex(sourceKind)
      const content = "Original retained source."
      const sourceVersion = fixture.upsert(content)
      poison.arm()
      expect(fixture.remove).toThrow(poison.message)
      poison.disarm()

      await fixture.embed(content, sourceVersion)
      expect(fixture.embedder.embedText).toHaveBeenCalledTimes(1)
      expect(fixture.chunks()).toEqual([
        { chunk_index: 0, chunk_text: "reuse\n\nOriginal retained source." },
      ])
      expect(fixture.inspect.prepare(`SELECT content FROM ${fixture.sourceTable}`).all()).toEqual([
        { content },
      ])
    },
  )

  it("embeds a replacement whose block cannot be read from its body, under the file name", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    const fixture = await createEmbeddingRaceIndex("note")
    const originalContent = "---\ntitle: Old\n---\nOriginal replaced source."
    const originalVersion = fixture.upsert(originalContent)
    const replacementContent = "---\ntitle: [unclosed\n---\nReplacement."
    const replacementVersion = fixture.upsert(replacementContent)

    // The original's job is obsolete: the replacement committed, block or no block
    await fixture.embed(originalContent, originalVersion)
    expect(fixture.chunks()).toEqual([])
    await fixture.embed(replacementContent, replacementVersion)
    expect(fixture.embedder.embedText).toHaveBeenCalledTimes(1)
    expect(fixture.chunks()).toEqual([{ chunk_index: 0, chunk_text: "reuse\n\nReplacement." }])
    expect(fixture.inspect.prepare("SELECT title, content FROM notes").all()).toEqual([
      { title: "reuse", content: "Replacement." },
    ])
  })

  it("skips deleted and same-mtime superseded rebuild snapshots before later model work", async () => {
    const fixture = await createEmbeddingRaceIndex("note")
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
    onTestFinished(() => infoSpy.mockRestore())
    const vaultPath = join(fixture.dir, "vault")
    await mkdir(vaultPath)
    await writeFile(join(vaultPath, "a.md"), "Old blocking snapshot.")
    await writeFile(join(vaultPath, "b.md"), "Old queued snapshot.")
    await writeFile(join(vaultPath, "queued.txt"), "Old file snapshot.")
    const model = Promise.withResolvers<Float32Array>()
    fixture.embedder.embedText.mockImplementationOnce(() => model.promise)
    const { embedding } = await fixture.searchIndex.rebuildFromVault({ vaultPath }, logger)
    expect(fixture.embedder.embedText).toHaveBeenCalledTimes(1)
    const secondMtime = fixture.inspect
      .prepare<[], { mtime: number }>("SELECT mtime FROM notes WHERE path = 'b.md'")
      .get()?.mtime
    const fileMtime = fixture.inspect
      .prepare<[], { mtime: number }>("SELECT mtime FROM file_content WHERE path = 'queued.txt'")
      .get()?.mtime

    if (secondMtime === undefined || fileMtime === undefined)
      throw new Error("rebuild sources missing")
    fixture.searchIndex.removeNote("a.md")
    const noteVersion = fixture.searchIndex.upsertNote(
      { filePath: "b.md", rawContent: "New current note.", fileStat: testStat(secondMtime) },
      logger,
    )
    const fileVersion = fixture.searchIndex.upsertFileContent(
      { filePath: "queued.txt", rawContent: "New current file.", fileStat: testStat(fileMtime) },
      logger,
    )
    await fixture.searchIndex.embedNote(
      { notePath: "b.md", rawContent: "New current note.", sourceVersion: noteVersion },
      logger,
    )
    await fixture.searchIndex.embedFileContent(
      { filePath: "queued.txt", sourceVersion: fileVersion },
      logger,
    )
    model.resolve(new Float32Array(384).fill(0.1))
    await embedding

    expect(fixture.embedder.embedText).toHaveBeenCalledTimes(3)
    expect(
      fixture.inspect
        .prepare("SELECT note_path, chunk_text FROM note_chunks ORDER BY note_path")
        .all(),
    ).toEqual([{ note_path: "b.md", chunk_text: "b\n\nNew current note." }])
    expect(
      fixture.inspect.prepare("SELECT file_path, chunk_text FROM file_content_chunks").all(),
    ).toEqual([{ file_path: "queued.txt", chunk_text: "queued\n\nNew current file." }])
    expect(fixture.vectorCount()).toBe(1)
    expect(infoSpy).toHaveBeenCalledWith("embedding pass complete", { notes: 2, chunksEmbedded: 0 })
    expect(infoSpy).toHaveBeenCalledWith("file content embedding pass complete", {
      files: 1,
      fileChunksEmbedded: 0,
    })
  })

  it("rejects an outer rebuild rollback after a nested upsert without launching models and recovers", async () => {
    const poison = installStatementPoison("DELETE FROM memory_entries WHERE file = ?")
    const dir = await mkdtemp(join(tmpdir(), "embedding-rebuild-rollback-"))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const vaultPath = join(dir, "vault")
    await mkdir(vaultPath)
    await writeFile(join(vaultPath, "new.md"), "New successfully parsed source.")
    const embedder = {
      embedText: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
      embedBatch: vi.fn().mockResolvedValue([]),
    }
    const index = createSearchIndex(join(dir, "index.db"), embedder, undefined, {
      memoryDir: "About Me",
    })
    index.upsertNote(
      {
        filePath: "About Me/Old.md",
        rawContent: "## Practices\n\n- **2026-07-01**: Old memory entry.",
        fileStat: testStat(1000),
      },
      logger,
    )
    const inspect = new Database(join(dir, "index.db"), { readonly: true })
    sqliteVec.load(inspect)
    onTestFinished(() => {
      inspect.close()
    })
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {})
    onTestFinished(() => debugSpy.mockRestore())
    poison.arm()

    await expect(index.rebuildFromVault({ vaultPath }, logger)).rejects.toThrow(poison.message)
    expect(debugSpy).toHaveBeenCalledWith("indexed note", {
      path: "new.md",
      bytes: 31,
      tasksIndexed: 0,
    })
    expect(inspect.prepare("SELECT path FROM notes").all()).toEqual([])
    expect(inspect.prepare("SELECT entry_text FROM memory_entries").all()).toEqual([
      { entry_text: "- **2026-07-01**: Old memory entry." },
    ])
    expect(embedder.embedText).not.toHaveBeenCalled()
    expect(embedder.embedBatch).not.toHaveBeenCalled()

    poison.disarm()
    const recovered = await index.rebuildFromVault({ vaultPath }, logger)
    await recovered.embedding
    expect(recovered.count).toBe(1)
    expect(embedder.embedText).toHaveBeenCalledTimes(1)
    expect(inspect.prepare("SELECT note_path, chunk_text FROM note_chunks").all()).toEqual([
      { note_path: "new.md", chunk_text: "new\n\nNew successfully parsed source." },
    ])
    expect(inspect.prepare("SELECT entry_text FROM memory_entries").all()).toEqual([])
  })

  it("removes only parentless vectors on startup and restores nearest-neighbor capacity idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "embedding-orphan-sweep-"))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const vaultPath = join(dir, "vault")
    await mkdir(join(vaultPath, "About Me"), { recursive: true })
    await writeFile(join(vaultPath, "note.md"), "Current note body.")
    await writeFile(join(vaultPath, "guide.txt"), "Current file body.")
    await writeFile(
      join(vaultPath, "About Me/Practices.md"),
      "## Practices\n\n- **2026-07-01**: Keep current entries.",
    )
    const embedder = {
      embedText: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
      embedBatch: vi
        .fn()
        .mockImplementation((texts: string[]) =>
          Promise.resolve(texts.map(() => new Float32Array(384).fill(0.1))),
        ),
    }
    const dbPath = join(dir, "index.db")
    const index = createSearchIndex(dbPath, embedder, undefined, {
      fileToolsEnabled: true,
      memoryDir: "About Me",
    })
    const initial = await index.rebuildFromVault({ vaultPath }, logger)
    await initial.embedding
    const inspect = new Database(dbPath)
    sqliteVec.load(inspect)
    onTestFinished(() => {
      inspect.close()
    })
    const queryVector = new Float32Array(384)
    queryVector[0] = 1
    const queryBytes = Buffer.from(queryVector.buffer)
    const stores = [
      {
        vectorTable: "note_vectors",
        parentTable: "note_chunks",
        vectorKey: "chunk_id",
        expectedParents: 2,
      },
      {
        vectorTable: "file_content_vectors",
        parentTable: "file_content_chunks",
        vectorKey: "chunk_id",
        expectedParents: 1,
      },
      {
        vectorTable: "memory_entry_vectors",
        parentTable: "memory_entries",
        vectorKey: "entry_id",
        expectedParents: 1,
      },
    ]
    const retainedStores = stores.map((store) => {
      const parents = inspect.prepare(`SELECT * FROM ${store.parentTable} ORDER BY id`).all()
      expect(parents).toHaveLength(store.expectedParents)
      const vectors = inspect
        .prepare(
          `SELECT ${store.vectorKey}, hex(embedding) AS embedding FROM ${store.vectorTable} ORDER BY ${store.vectorKey}`,
        )
        .all()
      const nearestParents = inspect.prepare<[Buffer, number], { id: number }>(
        `SELECT parent.id FROM ${store.vectorTable} vector JOIN ${store.parentTable} parent ON parent.id = vector.${store.vectorKey}
         WHERE vector.embedding MATCH ? AND vector.k = ? ORDER BY vector.distance, parent.id`,
      )
      const expectedHits = nearestParents.all(queryBytes, 2)
      expect(expectedHits).toHaveLength(store.expectedParents)
      const insertOrphan = inspect.prepare(
        `INSERT INTO ${store.vectorTable} (${store.vectorKey}, embedding) VALUES (?, ?)`,
      )
      insertOrphan.run(10000n, queryBytes)
      insertOrphan.run(10001n, queryBytes)
      // Both nearest slots are occupied by vectors whose join has no parent.
      expect(nearestParents.all(queryBytes, 2)).toEqual([])
      return { ...store, parents, vectors, nearestParents, expectedHits }
    })
    embedder.embedText.mockClear()
    embedder.embedBatch.mockClear()
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
    onTestFinished(() => infoSpy.mockRestore())

    const rebuilt = await index.rebuildFromVault({ vaultPath }, logger)
    await rebuilt.embedding
    for (const store of retainedStores) {
      expect(inspect.prepare(`SELECT * FROM ${store.parentTable} ORDER BY id`).all()).toEqual(
        store.parents,
      )
      expect(
        inspect
          .prepare(
            `SELECT ${store.vectorKey}, hex(embedding) AS embedding FROM ${store.vectorTable} ORDER BY ${store.vectorKey}`,
          )
          .all(),
      ).toEqual(store.vectors)
      expect(store.nearestParents.all(queryBytes, 2)).toEqual(store.expectedHits)
    }
    expect(infoSpy).toHaveBeenCalledWith("rebuilt index", {
      count: 2,
      totalBytes: 71,
      orphanNoteVectorsRemoved: 2,
      orphanFileVectorsRemoved: 2,
      orphanMemoryVectorsRemoved: 2,
    })
    expect(embedder.embedText).not.toHaveBeenCalled()
    expect(embedder.embedBatch).not.toHaveBeenCalled()

    infoSpy.mockClear()
    const repeated = await index.rebuildFromVault({ vaultPath }, logger)
    await repeated.embedding
    expect(infoSpy).toHaveBeenCalledWith("rebuilt index", {
      count: 2,
      totalBytes: 71,
      orphanNoteVectorsRemoved: 0,
      orphanFileVectorsRemoved: 0,
      orphanMemoryVectorsRemoved: 0,
    })
    for (const store of retainedStores) {
      expect(
        inspect
          .prepare(
            `SELECT ${store.vectorKey}, hex(embedding) AS embedding FROM ${store.vectorTable} ORDER BY ${store.vectorKey}`,
          )
          .all(),
      ).toEqual(store.vectors)
    }
    expect(embedder.embedText).not.toHaveBeenCalled()
    expect(embedder.embedBatch).not.toHaveBeenCalled()
  })
})

describe("file content vector embeddings", () => {
  const DIMENSIONS = 384
  const createMockEmbedder = () => ({
    embedText: vi.fn().mockResolvedValue(new Float32Array(DIMENSIONS).fill(0.1)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) => {
      return Promise.resolve(texts.map(() => new Float32Array(DIMENSIONS).fill(0.1)))
    }),
  })

  const TEXT_FILE_CONTENT = "System design overview with diagrams and architecture notes."

  describe("embedFileContent", () => {
    it("calls the embedder when file content is in the FTS table", async () => {
      const mockEmbedder = createMockEmbedder()
      const index = createSearchIndex(":memory:", mockEmbedder, undefined, {
        fileToolsEnabled: true,
      })

      index.upsertNonMdFile("docs/overview.txt", 100)
      const sourceVersion = index.upsertFileContent(
        {
          filePath: "docs/overview.txt",
          rawContent: TEXT_FILE_CONTENT,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await index.embedFileContent(
        { sourceVersion: sourceVersion, filePath: "docs/overview.txt" },
        logger,
      )

      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
    })

    it("content-hash gating skips unchanged chunks on re-embed", async () => {
      const mockEmbedder = createMockEmbedder()
      const index = createSearchIndex(":memory:", mockEmbedder, undefined, {
        fileToolsEnabled: true,
      })

      index.upsertNonMdFile("docs/overview.txt", 100)
      const sourceVersion = index.upsertFileContent(
        {
          filePath: "docs/overview.txt",
          rawContent: TEXT_FILE_CONTENT,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await index.embedFileContent(
        { sourceVersion: sourceVersion, filePath: "docs/overview.txt" },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)

      await index.embedFileContent(
        { sourceVersion: sourceVersion, filePath: "docs/overview.txt" },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)
    })

    it("re-embeds when content changes", async () => {
      const mockEmbedder = createMockEmbedder()
      const index = createSearchIndex(":memory:", mockEmbedder, undefined, {
        fileToolsEnabled: true,
      })

      index.upsertNonMdFile("docs/overview.txt", 100)
      const originalSourceVersion = index.upsertFileContent(
        {
          filePath: "docs/overview.txt",
          rawContent: TEXT_FILE_CONTENT,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await index.embedFileContent(
        { sourceVersion: originalSourceVersion, filePath: "docs/overview.txt" },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)

      const updatedSourceVersion = index.upsertFileContent(
        {
          filePath: "docs/overview.txt",
          rawContent: "Completely different content about networking protocols.",
          fileStat: testStat(2000, 100),
        },
        logger,
      )
      await index.embedFileContent(
        { sourceVersion: updatedSourceVersion, filePath: "docs/overview.txt" },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(2)
    })

    it("is a no-op when the captured file source was removed", async () => {
      const fixture = await createEmbeddingRaceIndex("file")
      const sourceVersion = fixture.upsert(TEXT_FILE_CONTENT)
      fixture.remove()
      expect(fixture.inspect.prepare("SELECT path FROM file_content").all()).toEqual([])
      await fixture.embed(TEXT_FILE_CONTENT, sourceVersion)
      expect(fixture.embedder.embedText).not.toHaveBeenCalled()
    })

    it("is a no-op when no embedder is provided", async () => {
      const index = createSearchIndex(":memory:", undefined, undefined, {
        fileToolsEnabled: true,
      })

      index.upsertNonMdFile("docs/overview.txt", 100)
      const sourceVersion = index.upsertFileContent(
        {
          filePath: "docs/overview.txt",
          rawContent: TEXT_FILE_CONTENT,
          fileStat: testStat(1000, 100),
        },
        logger,
      )

      await expect(
        index.embedFileContent(
          { sourceVersion: sourceVersion, filePath: "docs/overview.txt" },
          logger,
        ),
      ).resolves.toBeUndefined()
    })
  })

  describe("removeFileContent cleans up vectors", () => {
    it("deletes chunk and vector rows from the database", async () => {
      const dir = await mkdtemp(join(tmpdir(), "file-chunk-remove-"))
      onTestFinished(() => rm(dir, { recursive: true }))
      const dbPath = join(dir, "search.db")

      const mockEmbedder = createMockEmbedder()
      const index = createSearchIndex(dbPath, mockEmbedder, undefined, {
        fileToolsEnabled: true,
      })

      index.upsertNonMdFile("docs/overview.txt", 100)
      const sourceVersion = index.upsertFileContent(
        {
          filePath: "docs/overview.txt",
          rawContent: TEXT_FILE_CONTENT,
          fileStat: testStat(1000, 100),
        },
        logger,
      )
      await index.embedFileContent(
        { sourceVersion: sourceVersion, filePath: "docs/overview.txt" },
        logger,
      )
      expect(mockEmbedder.embedText).toHaveBeenCalledTimes(1)

      const inspectDb = new Database(dbPath, { readonly: true })
      sqliteVec.load(inspectDb)
      onTestFinished(() => {
        inspectDb.close()
      })

      const chunksBefore = countRow(
        inspectDb
          .prepare("SELECT COUNT(*) as count FROM file_content_chunks WHERE file_path = ?")
          .get("docs/overview.txt"),
      )
      expect(chunksBefore.count).toBe(1)

      index.removeFileContent({ filePath: "docs/overview.txt" }, logger)

      const chunksAfter = countRow(
        inspectDb
          .prepare("SELECT COUNT(*) as count FROM file_content_chunks WHERE file_path = ?")
          .get("docs/overview.txt"),
      )
      expect(chunksAfter.count).toBe(0)

      const vectorsAfter = countRow(
        inspectDb.prepare("SELECT COUNT(*) as count FROM file_content_vectors").get(),
      )
      expect(vectorsAfter.count).toBe(0)
    })
  })

  describe("content shrink produces fewer chunks", () => {
    it("deletes stale chunk and vector rows when content shrinks", async () => {
      const dir = await mkdtemp(join(tmpdir(), "file-chunk-stale-"))
      onTestFinished(() => rm(dir, { recursive: true }))
      const dbPath = join(dir, "search.db")

      const mockEmbedder = createMockEmbedder()
      const index = createSearchIndex(dbPath, mockEmbedder, undefined, {
        fileToolsEnabled: true,
      })

      const longContent = Array.from({ length: 15 }, (_, paragraphIndex) => {
        return (
          `Paragraph ${String(paragraphIndex)} discusses advanced architecture and system design patterns ` +
          `including microservices communication protocols and event-driven messaging architectures ` +
          `with distributed tracing observability and structured logging for production monitoring ` +
          `plus container orchestration deployment strategies and infrastructure provisioning automation.`
        )
      }).join("\n\n")

      index.upsertNonMdFile("docs/long.txt", 2000)
      const originalSourceVersion = index.upsertFileContent(
        {
          filePath: "docs/long.txt",
          rawContent: longContent,
          fileStat: testStat(1000, 2000),
        },
        logger,
      )
      await index.embedFileContent(
        { sourceVersion: originalSourceVersion, filePath: "docs/long.txt" },
        logger,
      )

      // Verify multiple chunks were created via a read-only inspection connection
      const inspectDb = new Database(dbPath, { readonly: true })
      sqliteVec.load(inspectDb)
      onTestFinished(() => {
        inspectDb.close()
      })

      const chunkCountBefore = countRow(
        inspectDb
          .prepare("SELECT COUNT(*) as count FROM file_content_chunks WHERE file_path = ?")
          .get("docs/long.txt"),
      )
      expect(chunkCountBefore.count).toBeGreaterThan(1)

      // Replace with short content — produces exactly 1 chunk
      const updatedSourceVersion = index.upsertFileContent(
        {
          filePath: "docs/long.txt",
          rawContent: "Short content.",
          fileStat: testStat(2000, 100),
        },
        logger,
      )
      await index.embedFileContent(
        { sourceVersion: updatedSourceVersion, filePath: "docs/long.txt" },
        logger,
      )

      const chunkCountAfter = countRow(
        inspectDb
          .prepare("SELECT COUNT(*) as count FROM file_content_chunks WHERE file_path = ?")
          .get("docs/long.txt"),
      )
      expect(chunkCountAfter.count).toBe(1)

      const vectorCount = countRow(
        inspectDb.prepare("SELECT COUNT(*) as count FROM file_content_vectors").get(),
      )
      expect(vectorCount.count).toBe(1)
    })
  })
})

describe("trash entries (retention-sweep bookkeeping)", () => {
  /** A stand-in identity — the store keeps whatever string it is given. */
  const SAMPLE_FILE_IDENTITY = "4096:12:1791557833301645709"

  it("listAllTrashEntries returns every recorded entry", () => {
    const trashIndex = createSearchIndex(":memory:")
    trashIndex.recordTrashEntry({ trashPath: ".trash/a.md", fileIdentity: SAMPLE_FILE_IDENTITY })
    trashIndex.recordTrashEntry({
      trashPath: ".trash/sub/b.md",
      fileIdentity: SAMPLE_FILE_IDENTITY,
    })

    const allEntries = trashIndex.listAllTrashEntries()

    const trashPaths = allEntries.map((entry) => entry.trashPath).toSorted()
    expect(trashPaths).toEqual([".trash/a.md", ".trash/sub/b.md"])
  })

  it("listAllTrashEntries returns an empty array when no entries exist", () => {
    const trashIndex = createSearchIndex(":memory:")

    expect(trashIndex.listAllTrashEntries()).toEqual([])
  })

  it("round-trips a recorded entry, identity included, through get and both lists", () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const trashTime = DateTime.fromISO("2026-01-01T00:00:00Z")
    vi.setSystemTime(trashTime.toMillis())
    const trashIndex = createSearchIndex(":memory:")
    trashIndex.recordTrashEntry({
      trashPath: ".trash/Notes/gone.md",
      fileIdentity: SAMPLE_FILE_IDENTITY,
    })
    const expectedEntry = {
      trashPath: ".trash/Notes/gone.md",
      trashedAt: trashTime.toUnixInteger(),
      fileIdentity: SAMPLE_FILE_IDENTITY,
    }

    expect(trashIndex.getTrashEntry(".trash/Notes/gone.md")).toEqual(expectedEntry)
    expect(trashIndex.listAllTrashEntries()).toEqual([expectedEntry])
    // Every recorded entry is "expired" against a cutoff after its stamp.
    expect(trashIndex.listExpiredTrashEntries(trashTime.toUnixInteger() + 1)).toEqual([
      expectedEntry,
    ])
  })

  it("adds the file_identity column to a pre-existing trash_entries table, leaving old rows without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-db-"))
    onTestFinished(() => rm(dir, { recursive: true }))
    const dbPath = join(dir, "search.db")
    // Simulate a database file created before the file_identity column.
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE trash_entries (
        trash_key TEXT PRIMARY KEY, trash_path TEXT NOT NULL, trashed_at INTEGER NOT NULL
      );
      INSERT INTO trash_entries VALUES ('.trash/old.md', '.trash/Old.md', 1700000000);
    `)
    legacyDb.close()

    const warmIndex = createSearchIndex(dbPath)
    warmIndex.recordTrashEntry({ trashPath: ".trash/new.md", fileIdentity: SAMPLE_FILE_IDENTITY })

    expect(warmIndex.getTrashEntry(".trash/Old.md")).toEqual({
      trashPath: ".trash/Old.md",
      trashedAt: 1700000000,
      fileIdentity: null,
    })
    expect(warmIndex.getTrashEntry(".trash/new.md")?.fileIdentity).toBe(SAMPLE_FILE_IDENTITY)
  })

  it("treats the cutoff as exclusive — a row stamped exactly at the cutoff is not expired", () => {
    const trashIndex = createSearchIndex(":memory:")
    trashIndex.recordTrashEntry({
      trashPath: ".trash/boundary.md",
      fileIdentity: SAMPLE_FILE_IDENTITY,
    })
    const entry = trashIndex.getTrashEntry(".trash/boundary.md")

    if (!entry) throw new Error("entry missing after record")

    expect(trashIndex.listExpiredTrashEntries(entry.trashedAt)).toEqual([])
    expect(
      trashIndex
        .listExpiredTrashEntries(entry.trashedAt + 1)
        .map((listedEntry) => listedEntry.trashPath),
    ).toEqual([".trash/boundary.md"])
  })

  it("re-recording the same path restarts the retention clock and replaces the identity", () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const trashIndex = createSearchIndex(":memory:")
    const firstTrashTime = DateTime.fromISO("2026-01-01T00:00:00Z")
    const secondTrashTime = DateTime.fromISO("2026-03-01T00:00:00Z")

    vi.setSystemTime(firstTrashTime.toMillis())
    trashIndex.recordTrashEntry({ trashPath: ".trash/reused.md", fileIdentity: "100:5:1" })
    const firstEntry = trashIndex.getTrashEntry(".trash/reused.md")

    vi.setSystemTime(secondTrashTime.toMillis())
    trashIndex.recordTrashEntry({ trashPath: ".trash/reused.md", fileIdentity: "200:7:2" })
    const refreshedEntry = trashIndex.getTrashEntry(".trash/reused.md")

    expect(firstEntry).toEqual({
      trashPath: ".trash/reused.md",
      trashedAt: firstTrashTime.toUnixInteger(),
      fileIdentity: "100:5:1",
    })
    expect(refreshedEntry).toEqual({
      trashPath: ".trash/reused.md",
      trashedAt: secondTrashTime.toUnixInteger(),
      fileIdentity: "200:7:2",
    })
  })

  it("a case-alias record replaces the stale row instead of adding a second one", () => {
    // On a case-insensitive bind mount ".trash/Note.md" and ".trash/note.md"
    // are one file — two live rows for it would let a stale expired alias
    // purge the fresh copy. The folded primary key collapses them to one.
    const trashIndex = createSearchIndex(":memory:")
    trashIndex.recordTrashEntry({ trashPath: ".trash/Note.md", fileIdentity: SAMPLE_FILE_IDENTITY })
    trashIndex.recordTrashEntry({ trashPath: ".trash/note.md", fileIdentity: SAMPLE_FILE_IDENTITY })

    const farFutureCutoff = DateTime.now().plus({ days: 1 }).toUnixInteger()
    const listed = trashIndex.listExpiredTrashEntries(farFutureCutoff)
    expect(listed.map((listedEntry) => listedEntry.trashPath)).toEqual([".trash/note.md"])
    // Both spellings resolve to the surviving row.
    expect(trashIndex.getTrashEntry(".trash/Note.md")?.trashPath).toBe(".trash/note.md")
  })

  it("deleteTrashEntry removes the row under any case alias", () => {
    const trashIndex = createSearchIndex(":memory:")
    trashIndex.recordTrashEntry({
      trashPath: ".trash/ToDelete.md",
      fileIdentity: SAMPLE_FILE_IDENTITY,
    })

    trashIndex.deleteTrashEntry(".trash/todelete.md")

    expect(trashIndex.getTrashEntry(".trash/ToDelete.md")).toBeNull()
    const farFutureCutoff = DateTime.now().plus({ days: 1 }).toUnixInteger()
    expect(trashIndex.listExpiredTrashEntries(farFutureCutoff)).toEqual([])
  })

  it("trash entries survive a vault rebuild", async () => {
    const trashIndex = createSearchIndex(":memory:")
    trashIndex.recordTrashEntry({
      trashPath: ".trash/survivor.md",
      fileIdentity: SAMPLE_FILE_IDENTITY,
    })
    const emptyVault = await mkdtemp(join(tmpdir(), "trash-rebuild-"))
    onTestFinished(() => rm(emptyVault, { recursive: true, force: true }))

    await trashIndex.rebuildFromVault({ vaultPath: emptyVault }, logger)

    expect(trashIndex.getTrashEntry(".trash/survivor.md")?.trashPath).toBe(".trash/survivor.md")
  })
})

describe("TOC source-path forwarding at the embed call sites", () => {
  /** The chunker unit tests pass sourcePath by hand, so they cannot see this
   *  wiring — deleting the sourcePath argument at either embed call site must
   *  fail here, or every split TOC chunk silently loses its folder line. */
  it("gives note and file TOC chunks their folder segments end-to-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toc-forwarding-"))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const dbPath = join(dir, "index.db")

    const uniformEmbedder = {
      embedText: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
      embedBatch: vi.fn().mockImplementation((texts: string[]) => {
        return Promise.resolve(texts.map(() => new Float32Array(384).fill(0.1)))
      }),
    }
    const forwardingIndex = createSearchIndex(dbPath, uniformEmbedder, undefined, {
      fileToolsEnabled: true,
    })

    const activeContent = Array.from({ length: 300 }, (_, wordIndex) => `active${wordIndex}`).join(
      " ",
    )
    const doneContent = Array.from({ length: 300 }, (_, wordIndex) => `done${wordIndex}`).join(" ")
    const noteContent = `## Active\n${activeContent}\n\n## Done\n${doneContent}`
    const originalSourceVersion = forwardingIndex.upsertNote(
      {
        filePath: "Folder Alpha/Sub/TASKS.md",
        rawContent: noteContent,
        fileStat: { mtimeMs: 1000, size: 100 },
      },
      logger,
    )
    await forwardingIndex.embedNote(
      {
        sourceVersion: originalSourceVersion,
        notePath: "Folder Alpha/Sub/TASKS.md",
        rawContent: noteContent,
      },
      logger,
    )

    const metricsContent = Array.from(
      { length: 300 },
      (_, wordIndex) => `metrics${wordIndex}`,
    ).join(" ")
    const notesContent = Array.from({ length: 300 }, (_, wordIndex) => `notes${wordIndex}`).join(
      " ",
    )
    forwardingIndex.upsertNonMdFile("Folder Alpha/data.csv", 100)
    const updatedSourceVersion = forwardingIndex.upsertFileContent(
      {
        filePath: "Folder Alpha/data.csv",
        rawContent: `## Metrics\n${metricsContent}\n\n## Notes\n${notesContent}`,
        fileStat: { mtimeMs: 1000, size: 100 },
      },
      logger,
    )
    await forwardingIndex.embedFileContent(
      { sourceVersion: updatedSourceVersion, filePath: "Folder Alpha/data.csv" },
      logger,
    )

    const inspect = new Database(dbPath, { readonly: true })
    onTestFinished(() => {
      inspect.close()
    })
    const noteChunkTexts = inspect
      .prepare<[string], { chunk_text: string }>(
        `SELECT chunk_text FROM note_chunks WHERE note_path = ? ORDER BY chunk_index`,
      )
      .all("Folder Alpha/Sub/TASKS.md")
      .map((chunkRow) => chunkRow.chunk_text)
    const fileChunkTexts = inspect
      .prepare<[string], { chunk_text: string }>(
        `SELECT chunk_text FROM file_content_chunks WHERE file_path = ? ORDER BY chunk_index`,
      )
      .all("Folder Alpha/data.csv")
      .map((chunkRow) => chunkRow.chunk_text)

    expect(noteChunkTexts).toEqual([
      `TASKS\nSection: Active\n\n${activeContent}`,
      `TASKS\nSection: Done\n\n${doneContent}`,
      "Folder Alpha > Sub > TASKS\n\nActive\nDone",
    ])
    expect(fileChunkTexts).toEqual([
      `data\nSection: Metrics\n\n${metricsContent}`,
      `data\nSection: Notes\n\n${notesContent}`,
      "Folder Alpha > data.csv\n\nMetrics\nNotes",
    ])
  })
})

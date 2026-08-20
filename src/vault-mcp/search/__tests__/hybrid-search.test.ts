import { describe, it, expect, vi, onTestFinished } from "vitest"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import { createSearchIndex } from "../search-index.js"
import { logger } from "../../../logger.js"

const testStat = (
  mtimeMs: number,
  size = 100,
): { mtimeMs: number; size: number } => ({
  mtimeMs,
  size,
})

/** Query-side sibling of installStatementPoison (search-index.test.ts):
 *  patches the matching statement's .all (read queries) to throw while armed.
 *  Must likewise be installed BEFORE createSearchIndex — query statements are
 *  prepared at factory scope. */
const installQueryPoison = (sqlFragment: string) => {
  const message = `injected failure on: ${sqlFragment}`
  const realPrepare: (
    this: Database.Database,
    source: string,
  ) => Database.Statement = Database.prototype.prepare
  // Mutable arming flag: the patched .all closes over this object so tests
  // can trigger the failure long after the statement was prepared.
  const poisonState = { armed: false }
  const prepareSpy = vi
    .spyOn(Database.prototype, "prepare")
    .mockImplementation(function (this: Database.Database, source: string) {
      const statement = realPrepare.call(this, source)
      if (source.includes(sqlFragment)) {
        const realAll = statement.all.bind(statement)
        statement.all = (...queryParams: unknown[]) => {
          if (poisonState.armed) throw new Error(message)
          return realAll(...queryParams)
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
  }
}

describe("hybridSearch", () => {
  const EMBEDDING_DIMENSIONS = 384

  /** Creates a mock embedder where all texts get the same embedding (distance 0
   *  between any two notes). For tests that need differentiated distances, override
   *  embedText after creation. */
  const createHybridMockEmbedder = () => ({
    embedText: vi
      .fn()
      .mockResolvedValue(new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    embedBatch: vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)),
        ),
      ),
  })

  /** Generates a unique embedding by setting one dimension to 1.0 based on seed. */
  const seededEmbedding = (seed: number): Float32Array => {
    const embedding = new Float32Array(EMBEDDING_DIMENSIONS).fill(0)
    embedding[seed % EMBEDDING_DIMENSIONS] = 1.0
    return embedding
  }

  const NOTE_A = `---
title: Career Goals
tags: [personal, career]
type: reflection
---

I aspire to build meaningful products and grow as a technical leader.
My targets include shipping a major open source project.
`

  const NOTE_B = `---
title: Project Ideas
tags: [ideas]
type: brainstorm
---

Some project ideas for the next quarter. Build a CLI tool for vault management.
`

  const NOTE_C = `---
title: Meeting Notes
tags: [work, meetings]
type: meeting
related: ["[[Projects/alpha.md]]"]
---

Discussed the deployment timeline and infrastructure costs. Need to follow up on
the Lightsail budget estimates for next quarter.
`

  describe("fallback to FTS-only", () => {
    it("returns FTS results when no embedder is provided", async () => {
      const ftsIndex = createSearchIndex(":memory:")
      ftsIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )

      const { results, search_mode } = await ftsIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["a.md"])
      expect(search_mode).toBe("fts")
    })

    it("returns FTS results when embedder exists but no vectors indexed", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)
      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      // upsertNote doesn't embed — vectors are empty

      const { results, search_mode } = await hybridIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["a.md"])
      expect(search_mode).toBe("fts")
      expect(mockEmbedder.embedText).toHaveBeenCalled()
    })

    it("returns FTS results when embedder fails", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      mockEmbedder.embedText.mockRejectedValue(new Error("model unavailable"))
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)
      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      const warnSpy = vi.spyOn(logger, "warn")
      onTestFinished(() => warnSpy.mockRestore())

      const { results, search_mode } = await hybridIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["a.md"])
      expect(search_mode).toBe("fts")
      expect(warnSpy).toHaveBeenCalledWith(
        "query embedding failed",
        expect.objectContaining({ error: "[Error]: model unavailable" }),
      )
    })
  })

  describe("hybrid ranking", () => {
    it("boosts results that appear in both FTS and vector search", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(1000) },
        logger,
      )

      // Embed both notes (same embedding = both match any query equally)
      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      // Query that matches NOTE_A via FTS ("career goals") and both via vector
      const { results, search_mode } = await hybridIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(search_mode).toBe("hybrid")
      expect(results).toHaveLength(2)
      // a.md appears in both FTS and vector → higher RRF score → ranked first
      expect(results[0]?.path).toBe("a.md")
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0)
    })

    it("includes vector-only results with full metadata", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      // Query that matches b.md via FTS ("project ideas CLI") and both via vector
      const { results } = await hybridIndex.hybridSearch(
        { query: "project ideas CLI" },
        logger,
      )

      expect(results).toHaveLength(2)
      // b.md matches both FTS + vector → ranked first; a.md is vector-only
      expect(results.map((result) => result.path)).toEqual(["b.md", "a.md"])

      // Vector-only result (a.md — no FTS match for "project ideas CLI")
      // should carry full metadata from the notes table
      const vectorOnlyResult = results.find((result) => result.path === "a.md")
      if (!vectorOnlyResult) throw new Error("expected a.md in results")
      expect(vectorOnlyResult).toEqual(
        expect.objectContaining({
          path: "a.md",
          title: "Career Goals",
          tags: ["personal", "career"],
          folder: "",
          type: "reflection",
          bytes: 100,
          modified: DateTime.fromMillis(1000).toISO(),
        }),
      )
      expect(vectorOnlyResult.score).toBeGreaterThan(0)
    })

    it("generates snippets from chunk text for vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      // Embed call 1 (a.md chunk): seed 0
      // Embed call 2 (c.md chunk): seed 1
      // Embed call 3+ (query): seed 0 — matches a.md exactly (distance 0)
      let embedCallIndex = 0
      mockEmbedder.embedText.mockImplementation(() => {
        const seed = embedCallIndex === 1 ? 1 : 0
        embedCallIndex++
        return Promise.resolve(seededEmbedding(seed))
      })

      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      // Query that doesn't match any note via FTS — results are vector-only
      const { results } = await hybridIndex.hybridSearch(
        { query: "zzz_no_fts_match" },
        logger,
      )

      // a.md should appear (closest vector match) with a snippet from its chunk
      const noteA = results.find((result) => result.path === "a.md")
      if (!noteA) throw new Error("expected a.md in results")
      // Default snippet_tokens is 30 — chunk text is title-prefixed body,
      // well under 30 words, so no truncation
      expect(noteA.snippet).toBe(
        "Career Goals I aspire to build meaningful products and grow as a technical leader. My targets include shipping a major open source project.",
      )
    })
  })

  describe("filters", () => {
    it("applies folder filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteInFolder = `---
title: Inside Folder
tags: [test]
---
Content about deployment costs and infrastructure.
`
      const noteOutsideFolder = `---
title: Outside Folder
tags: [test]
---
Content about deployment costs and infrastructure.
`

      hybridIndex.upsertNote(
        {
          filePath: "Work/inside.md",
          rawContent: noteInFolder,
          fileStat: testStat(1000),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "Personal/outside.md",
          rawContent: noteOutsideFolder,
          fileStat: testStat(1000),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "Work/inside.md", rawContent: noteInFolder },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "Personal/outside.md", rawContent: noteOutsideFolder },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment costs", filters: { folder: "Work" } },
        logger,
      )

      // Only the note inside Work/ should appear
      const paths = results.map((result) => result.path)
      expect(paths).toContain("Work/inside.md")
      expect(paths).not.toContain("Personal/outside.md")
    })

    it("applies tag filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment infrastructure", filters: { tags: ["work"] } },
        logger,
      )

      // Only c.md has the "work" tag — a.md (tags: personal, career) excluded
      const paths = results.map((result) => result.path)
      expect(paths).toContain("c.md")
      expect(paths).not.toContain("a.md")
    })

    it("applies type filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment timeline", filters: { type: "meeting" } },
        logger,
      )

      // Only c.md is type "meeting" — a.md (type: reflection) excluded
      const paths = results.map((result) => result.path)
      expect(paths).toContain("c.md")
      expect(paths).not.toContain("a.md")
    })

    it("applies created filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteCreatedOn = (createdDate: string): string => `---
title: Dated
created: ${createdDate}
---
Content about quarterly planning and roadmaps.
`

      hybridIndex.upsertNote(
        {
          filePath: "on-day.md",
          rawContent: noteCreatedOn("2026-03-10"),
          fileStat: testStat(1000),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "other-day.md",
          rawContent: noteCreatedOn("2026-03-11"),
          fileStat: testStat(1000),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "on-day.md", rawContent: noteCreatedOn("2026-03-10") },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "other-day.md", rawContent: noteCreatedOn("2026-03-11") },
        logger,
      )

      // Query with no FTS match — results arrive exclusively via the vector
      // leg, so the TypeScript filter mirror is the only gate
      const { results } = await hybridIndex.hybridSearch(
        {
          query: "zzz_no_fts_match",
          filters: { created: { on: "2026-03-10" } },
        },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["on-day.md"])
    })

    it("applies modified filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteBody = `---
title: Timestamped
---
Content about quarterly planning and roadmaps.
`

      hybridIndex.upsertNote(
        {
          filePath: "during.md",
          rawContent: noteBody,
          fileStat: testStat(
            DateTime.fromISO("2026-06-15T12:00:00").toMillis(),
          ),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "day-after.md",
          rawContent: noteBody,
          fileStat: testStat(
            DateTime.fromISO("2026-06-16T00:30:00").toMillis(),
          ),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "during.md", rawContent: noteBody },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "day-after.md", rawContent: noteBody },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "zzz_no_fts_match",
          filters: { modified: { on: "2026-06-15" } },
        },
        logger,
      )

      expect(results.map((result) => result.path)).toEqual(["during.md"])
    })

    it("rejects a malformed date filter through hybridSearch", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      // The validation throw must escape hybridSearch — not be swallowed by
      // fullTextSearch's DB-error fallback or the FTS-only fallback path
      await expect(
        hybridIndex.hybridSearch(
          { query: "anything", filters: { modified: { on: "bad" } } },
          logger,
        ),
      ).rejects.toThrow(
        'invalid modified.on date: "bad". Use YYYY-MM-DD (e.g. 2026-07-03).',
      )
    })
  })

  describe("limit and deduplication", () => {
    it("respects the user limit after fusion", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "project", filters: { limit: 1 } },
        logger,
      )

      expect(results).toHaveLength(1)
    })

    it("deduplicates to one result per note", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      // A long note produces multiple chunks — each could match in KNN
      const longNote = `---
title: Long Document
tags: [test]
---

## Section One

This section discusses project management and team coordination.
We need to ensure all stakeholders are aligned on the timeline.

## Section Two

This section covers deployment strategies and infrastructure.
The deployment pipeline should be automated for efficiency.

## Section Three

This section is about monitoring and observability patterns.
We should track latency and error rates across all services.
`

      hybridIndex.upsertNote(
        { filePath: "long.md", rawContent: longNote, fileStat: testStat(1000) },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "long.md", rawContent: longNote },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        { query: "deployment" },
        logger,
      )

      // Even with multiple chunks, the note appears only once
      const longNoteResults = results.filter(
        (result) => result.path === "long.md",
      )
      expect(longNoteResults).toHaveLength(1)
    })
  })

  describe("include_leading_callout", () => {
    it("includes leading callout for vector-only results when requested", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteWithCallout = `---
title: Reference Doc
tags: [reference]
---

> [!info] Quick reference
> This is a reference document about API design patterns.

The main content discusses RESTful API design and GraphQL alternatives.
`
      hybridIndex.upsertNote(
        {
          filePath: "ref.md",
          rawContent: noteWithCallout,
          fileStat: testStat(1000),
        },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "ref.md", rawContent: noteWithCallout },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "API design patterns",
          filters: { include_leading_callout: true },
        },
        logger,
      )

      const refResult = results.find((result) => result.path === "ref.md")
      if (!refResult) throw new Error("expected ref.md in results")
      expect(refResult.leading_callout).toEqual({
        type: "info",
        title: "Quick reference",
        body: "This is a reference document about API design patterns.",
      })
    })
  })

  describe("filters — related and properties", () => {
    it("applies related filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      hybridIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      hybridIndex.upsertNote(
        { filePath: "c.md", rawContent: NOTE_C, fileStat: testStat(1000) },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "c.md", rawContent: NOTE_C },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "deployment infrastructure",
          filters: { related: ["[[Projects/alpha.md]]"] },
        },
        logger,
      )

      // Only c.md has the related link — a.md has no related field
      const paths = results.map((result) => result.path)
      expect(paths).toContain("c.md")
      expect(paths).not.toContain("a.md")
    })

    it("applies properties filter to vector-only results", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const noteWithProperty = `---
title: Active Project
tags: [project]
status: active
---

This project is currently in development with active deployment work.
`
      const noteWithoutProperty = `---
title: Archived Project
tags: [project]
status: archived
---

This project is no longer maintained but had deployment infrastructure.
`

      hybridIndex.upsertNote(
        {
          filePath: "active.md",
          rawContent: noteWithProperty,
          fileStat: testStat(1000),
        },
        logger,
      )
      hybridIndex.upsertNote(
        {
          filePath: "archived.md",
          rawContent: noteWithoutProperty,
          fileStat: testStat(1000),
        },
        logger,
      )

      await hybridIndex.embedNote(
        { notePath: "active.md", rawContent: noteWithProperty },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "archived.md", rawContent: noteWithoutProperty },
        logger,
      )

      const { results } = await hybridIndex.hybridSearch(
        {
          query: "deployment",
          filters: { properties: { status: "active" } },
        },
        logger,
      )

      // Only active.md has status: active
      const paths = results.map((result) => result.path)
      expect(paths).toContain("active.md")
      expect(paths).not.toContain("archived.md")
    })
  })

  describe("snippet_tokens", () => {
    it("truncates vector-only snippets to the specified token count", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

      const verboseNote = `---
title: Verbose Note
tags: [test]
---

This is a note with many words that should be truncated when using a small snippet token limit for vector-only results.
`

      hybridIndex.upsertNote(
        {
          filePath: "verbose.md",
          rawContent: verboseNote,
          fileStat: testStat(1000),
        },
        logger,
      )
      await hybridIndex.embedNote(
        { notePath: "verbose.md", rawContent: verboseNote },
        logger,
      )

      // Query that won't match via FTS — forces vector-only result path
      const { results } = await hybridIndex.hybridSearch(
        { query: "zzz_no_fts_match", filters: { snippet_tokens: 5 } },
        logger,
      )

      const verboseResult = results.find(
        (result) => result.path === "verbose.md",
      )
      if (!verboseResult) throw new Error("expected verbose.md in results")
      // buildSnippetFromChunkText takes first 5 words of the chunk text
      // (title-prefixed body) and appends "..."
      expect(verboseResult.snippet).toBe("Verbose Note This is a...")
    })
  })

  describe("reranking", () => {
    const createMockReranker = (scores: number[]) => ({
      rerankPairs: vi.fn().mockResolvedValue(scores),
    })

    it("sets reranked to true when reranker is present and vectors exist", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const mockReranker = createMockReranker([0.9, 0.1])
      const rerankedIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )
      rerankedIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rerankedIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rerankedIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rerankedIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      const { reranked } = await rerankedIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )
      expect(reranked).toBe(true)
    })

    it("sets reranked to false on FTS-only fallback", async () => {
      const noEmbedIndex = createSearchIndex(":memory:")
      noEmbedIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )

      const { reranked, search_mode } = await noEmbedIndex.hybridSearch(
        { query: "career" },
        logger,
      )
      expect(search_mode).toBe("fts")
      expect(reranked).toBe(false)
    })

    it("sets reranked to false when embedder exists but no reranker", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const noRerankerIndex = createSearchIndex(":memory:", mockEmbedder)
      noRerankerIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      await noRerankerIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )

      const { reranked } = await noRerankerIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )
      expect(reranked).toBe(false)
    })

    it("falls back gracefully when reranker throws", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const failingReranker = {
        rerankPairs: vi
          .fn()
          .mockRejectedValue(new Error("model failed to load")),
      }
      const failIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        failingReranker,
      )
      failIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      failIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await failIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await failIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      const warnSpy = vi.spyOn(logger, "warn")
      const { results, reranked } = await failIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(reranked).toBe(false)
      expect(results).toHaveLength(2)
      expect(warnSpy).toHaveBeenCalledWith(
        "reranker failed, using RRF-only ordering",
        expect.objectContaining({ error: "[Error]: model failed to load" }),
      )
      warnSpy.mockRestore()
    })

    it("calls rerankPairs with query and document texts", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const mockReranker = createMockReranker([0.9, 0.1])
      const rerankIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )
      rerankIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rerankIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      await rerankIndex.hybridSearch({ query: "career goals" }, logger)

      expect(mockReranker.rerankPairs).toHaveBeenCalledOnce()
      const callArgs = mockReranker.rerankPairs.mock.calls[0]
      expect(callArgs).toBeDefined()
      const [query, documents] = callArgs ?? []
      expect(query).toBe("career goals")
      expect(documents).toHaveLength(2)
      // Each document text should be non-empty (chunk text from vector hits)
      expect(documents.every((document: string) => document.length > 0)).toBe(
        true,
      )
    })

    it("modifies result scores compared to RRF-only ordering", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      // Reranker strongly favors b.md (index 1) over a.md (index 0)
      const mockReranker = createMockReranker([0.1, 0.9])
      const rerankIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )
      rerankIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rerankIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rerankIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      // Get RRF-only scores (no reranker)
      const rrfOnlyIndex = createSearchIndex(":memory:", mockEmbedder)
      rrfOnlyIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      rrfOnlyIndex.upsertNote(
        { filePath: "b.md", rawContent: NOTE_B, fileStat: testStat(2000) },
        logger,
      )
      await rrfOnlyIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )
      await rrfOnlyIndex.embedNote(
        { notePath: "b.md", rawContent: NOTE_B },
        logger,
      )

      const { results: rrfResults } = await rrfOnlyIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )
      const { results: rerankedResults, reranked } =
        await rerankIndex.hybridSearch({ query: "career goals" }, logger)

      expect(reranked).toBe(true)

      // Reranking must produce different scores from RRF-only — proves
      // tryRerank actually modified the results, not just set the flag
      const rrfScoreForA = rrfResults.find(
        (result) => result.path === "a.md",
      )?.score
      const rerankedScoreForA = rerankedResults.find(
        (result) => result.path === "a.md",
      )?.score
      expect(rerankedScoreForA).not.toBe(rrfScoreForA)
    })

    it("skips reranking when only one result in merged set", async () => {
      const mockEmbedder = createHybridMockEmbedder()
      const mockReranker = createMockReranker([0.9])
      const singleResultIndex = createSearchIndex(
        ":memory:",
        mockEmbedder,
        mockReranker,
      )

      // Only index one note so only one result can appear
      singleResultIndex.upsertNote(
        { filePath: "a.md", rawContent: NOTE_A, fileStat: testStat(1000) },
        logger,
      )
      await singleResultIndex.embedNote(
        { notePath: "a.md", rawContent: NOTE_A },
        logger,
      )

      const { reranked, results } = await singleResultIndex.hybridSearch(
        { query: "career goals" },
        logger,
      )

      expect(results).toHaveLength(1)
      expect(reranked).toBe(false)
      // The reranker should not have been called — mergedResults.length <= 1
      expect(mockReranker.rerankPairs).not.toHaveBeenCalled()
    })
  })
})

// ── hybridSearch — file content vector search integration ─────

describe("hybridSearch — file content vector search", () => {
  const EMBEDDING_DIMENSIONS = 384

  const createHybridMockEmbedder = () => ({
    embedText: vi
      .fn()
      .mockResolvedValue(new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    embedBatch: vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)),
        ),
      ),
  })

  it("includes file content vector hits in hybrid results", async () => {
    const mockEmbedder = createHybridMockEmbedder()
    const fileIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
      fileToolsEnabled: true,
    })

    // Seed a note (FTS + vector) and a text file (FTS + vector)
    fileIndex.upsertNote(
      {
        filePath: "notes/career.md",
        rawContent:
          "---\ntitle: Career\ntags: [personal]\n---\n\nCareer goals and aspirations.\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    await fileIndex.embedNote(
      {
        notePath: "notes/career.md",
        rawContent:
          "---\ntitle: Career\ntags: [personal]\n---\n\nCareer goals and aspirations.\n",
      },
      logger,
    )

    fileIndex.upsertNonMdFile("docs/guide.txt", 200)
    fileIndex.upsertFileContent(
      {
        filePath: "docs/guide.txt",
        rawContent:
          "Comprehensive deployment guide covering infrastructure and monitoring setup.",
        fileStat: testStat(2000, 200),
      },
      logger,
    )
    await fileIndex.embedFileContent({ filePath: "docs/guide.txt" }, logger)

    // Query that matches the text file via FTS ("deployment guide") and both
    // items via vector (all embeddings are identical)
    const { results, search_mode } = await fileIndex.hybridSearch(
      { query: "deployment guide" },
      logger,
    )

    expect(search_mode).toBe("hybrid")
    // Both should appear — guide.txt via FTS+file vector, career.md via note vector
    expect(results.map((result) => result.path)).toEqual([
      "docs/guide.txt",
      "notes/career.md",
    ])
    expect(results[0]?.kind).toBe("file")
    expect(results[0]?.extension).toBe(".txt")
  })

  it("file-only vector hit appears with metadata when no FTS match exists", async () => {
    const mockEmbedder = createHybridMockEmbedder()
    const fileIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
      fileToolsEnabled: true,
    })

    // Seed ONLY a text file with no lexical overlap with the query
    fileIndex.upsertNonMdFile("specs/api-spec.yaml", 300)
    fileIndex.upsertFileContent(
      {
        filePath: "specs/api-spec.yaml",
        rawContent:
          "openapi: 3.0.0\npaths:\n  /accounts:\n    get:\n      summary: List ledger entries",
        fileStat: testStat(3000, 300),
      },
      logger,
    )
    await fileIndex.embedFileContent(
      { filePath: "specs/api-spec.yaml" },
      logger,
    )

    // Query shares no stems with the file content — FTS returns nothing,
    // but the mock embedder returns identical embeddings so KNN matches
    const { results, search_mode } = await fileIndex.hybridSearch(
      { query: "quarterly budget forecast" },
      logger,
    )

    // Exactly one result — the file via vector-only (no FTS match)
    expect(search_mode).toBe("hybrid")
    expect(results.map((result) => result.path)).toEqual([
      "specs/api-spec.yaml",
    ])
    expect(results[0]?.kind).toBe("file")
    expect(results[0]?.extension).toBe(".yaml")
    expect(results[0]?.folder).toBe("specs")
  })

  it("returns note results when the file content KNN query throws", async () => {
    const knnPoison = installQueryPoison("FROM file_content_vectors")
    const mockEmbedder = createHybridMockEmbedder()
    const fileIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
      fileToolsEnabled: true,
    })

    fileIndex.upsertNote(
      {
        filePath: "notes/career.md",
        rawContent:
          "---\ntitle: Career\n---\n\nCareer goals and aspirations.\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    await fileIndex.embedNote(
      {
        notePath: "notes/career.md",
        rawContent:
          "---\ntitle: Career\n---\n\nCareer goals and aspirations.\n",
      },
      logger,
    )
    fileIndex.upsertNonMdFile("docs/guide.txt", 200)
    fileIndex.upsertFileContent(
      {
        filePath: "docs/guide.txt",
        rawContent: "Deployment guide covering infrastructure setup.",
        fileStat: testStat(2000, 200),
      },
      logger,
    )
    await fileIndex.embedFileContent({ filePath: "docs/guide.txt" }, logger)

    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())
    knnPoison.arm()

    const { results } = await fileIndex.hybridSearch(
      { query: "career goals" },
      logger,
    )

    // The file KNN throw is caught (warn logged), the file leg contributes
    // nothing, and note results still come back instead of an error
    expect(warnSpy).toHaveBeenCalledWith(
      "file content vector search failed",
      expect.objectContaining({ error: `[Error]: ${knnPoison.message}` }),
    )
    expect(results.map((result) => result.path)).toEqual(["notes/career.md"])
  })

  it("falls back to FTS ordering when the note KNN query throws", async () => {
    const knnPoison = installQueryPoison("FROM note_vectors")
    const mockEmbedder = createHybridMockEmbedder()
    const hybridIndex = createSearchIndex(":memory:", mockEmbedder)

    hybridIndex.upsertNote(
      {
        filePath: "notes/career.md",
        rawContent:
          "---\ntitle: Career\n---\n\nCareer goals and aspirations.\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    await hybridIndex.embedNote(
      {
        notePath: "notes/career.md",
        rawContent:
          "---\ntitle: Career\n---\n\nCareer goals and aspirations.\n",
      },
      logger,
    )

    const warnSpy = vi.spyOn(logger, "warn")
    onTestFinished(() => warnSpy.mockRestore())
    knnPoison.arm()

    const { results, search_mode } = await hybridIndex.hybridSearch(
      { query: "career goals" },
      logger,
    )

    // The note KNN throw is caught (warn logged) and the search degrades to
    // FTS-only ordering instead of propagating the error
    expect(warnSpy).toHaveBeenCalledWith(
      "vector search failed, falling back to FTS-only",
      expect.objectContaining({ error: `[Error]: ${knnPoison.message}` }),
    )
    expect(search_mode).toBe("fts")
    expect(results.map((result) => result.path)).toEqual(["notes/career.md"])
  })

  it("applies the folder filter to file-content vector-only hits at segment boundaries", async () => {
    const mockEmbedder = createHybridMockEmbedder()
    const fileIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
      fileToolsEnabled: true,
    })

    fileIndex.upsertNonMdFile("Docs/inside.txt", 100)
    fileIndex.upsertFileContent(
      {
        filePath: "Docs/inside.txt",
        rawContent: "Weekly operations checklist for the deployment crew.",
        fileStat: testStat(1000, 100),
      },
      logger,
    )
    await fileIndex.embedFileContent({ filePath: "Docs/inside.txt" }, logger)

    // "Docs2" starts with "Docs" as a bare string — only a segment-boundary
    // check (folder + "/") keeps it out of a "Docs" filter
    fileIndex.upsertNonMdFile("Docs2/outside.txt", 100)
    fileIndex.upsertFileContent(
      {
        filePath: "Docs2/outside.txt",
        rawContent: "Weekly operations checklist for the deployment crew.",
        fileStat: testStat(1000, 100),
      },
      logger,
    )
    await fileIndex.embedFileContent({ filePath: "Docs2/outside.txt" }, logger)

    // No lexical overlap with the seeded content — both files can only
    // surface through the vector leg (identical mock embeddings), so the
    // folder filter on vector-only hits is the behavior under test
    const { results } = await fileIndex.hybridSearch(
      { query: "quarterly budget forecast", filters: { folder: "Docs" } },
      logger,
    )

    expect(results.map((result) => result.path)).toEqual(["Docs/inside.txt"])
  })

  it("skips file content vector search when note-specific filters are active", async () => {
    const mockEmbedder = createHybridMockEmbedder()
    const fileIndex = createSearchIndex(":memory:", mockEmbedder, undefined, {
      fileToolsEnabled: true,
    })

    fileIndex.upsertNote(
      {
        filePath: "notes/tagged.md",
        rawContent:
          "---\ntitle: Tagged\ntags: [important]\n---\n\nTagged content here.\n",
        fileStat: testStat(1000),
      },
      logger,
    )
    await fileIndex.embedNote(
      {
        notePath: "notes/tagged.md",
        rawContent:
          "---\ntitle: Tagged\ntags: [important]\n---\n\nTagged content here.\n",
      },
      logger,
    )

    fileIndex.upsertNonMdFile("data/report.csv", 100)
    fileIndex.upsertFileContent(
      {
        filePath: "data/report.csv",
        rawContent: "tagged content in a file",
        fileStat: testStat(2000, 100),
      },
      logger,
    )
    await fileIndex.embedFileContent({ filePath: "data/report.csv" }, logger)

    // Tag filter is note-specific — file content (FTS and vector) should be excluded
    const { results } = await fileIndex.hybridSearch(
      { query: "tagged content", filters: { tags: ["important"] } },
      logger,
    )

    // Exactly the tagged note — the file is excluded from both the FTS and
    // vector legs, and nothing else was seeded
    expect(results.map((result) => result.path)).toEqual(["notes/tagged.md"])
  })
})

// ── hybridSearch — file content FTS folder filter ─────────────

describe("hybridSearch — file content FTS folder filter", () => {
  /** Seeds one indexed text file with the given content. */
  const seedTextFile = (
    fileIndex: ReturnType<typeof createSearchIndex>,
    filePath: string,
    rawContent: string,
  ): void => {
    fileIndex.upsertNonMdFile(filePath, rawContent.length)
    fileIndex.upsertFileContent(
      { filePath, rawContent, fileStat: testStat(1000, rawContent.length) },
      logger,
    )
  }

  it("returns in-folder files that rank below the vault-wide candidate window", async () => {
    const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })

    // limit 1 → candidateLimit 3. Ten short out-of-folder matches outrank the
    // one in-folder match (bm25 favors short documents), so a folder filter
    // applied after the SQL LIMIT would never see the in-folder file.
    for (const fileNumber of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      seedTextFile(
        fileIndex,
        `Archive/outside-${fileNumber}.txt`,
        "deployment notes",
      )
    }
    seedTextFile(
      fileIndex,
      "Docs/inside.txt",
      "A much longer runbook that mentions the deployment exactly once among many other unrelated operational words about logging, backups, rotation, and alerts.",
    )

    const { results, search_mode } = await fileIndex.hybridSearch(
      { query: "deployment", filters: { folder: "Docs", limit: 1 } },
      logger,
    )

    expect(search_mode).toBe("fts")
    expect(results.map((result) => result.path)).toEqual(["Docs/inside.txt"])
  })

  it("applies the folder filter to file-content FTS hits at segment boundaries", async () => {
    const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })

    seedTextFile(fileIndex, "Docs/inside.txt", "deployment notes")
    // "Docs2" starts with "Docs" as a bare string — only a segment-boundary
    // pattern ("Docs/%") keeps it out of a "Docs" filter
    seedTextFile(fileIndex, "Docs2/outside.txt", "deployment notes")

    const { results } = await fileIndex.hybridSearch(
      { query: "deployment", filters: { folder: "Docs" } },
      logger,
    )

    expect(results.map((result) => result.path)).toEqual(["Docs/inside.txt"])
  })

  it("treats LIKE wildcards in the folder name as literal characters", async () => {
    const fileIndex = createSearchIndex(":memory:", undefined, undefined, {
      fileToolsEnabled: true,
    })

    seedTextFile(fileIndex, "Pro_ects/inside.txt", "deployment notes")
    // Without escaping, LIKE 'Pro_ects/%' would also match this file — the
    // "_" wildcard matches the "j" in "Projects".
    seedTextFile(fileIndex, "Projects/outside.txt", "deployment notes")

    const { results } = await fileIndex.hybridSearch(
      { query: "deployment", filters: { folder: "Pro_ects" } },
      logger,
    )

    expect(results.map((result) => result.path)).toEqual([
      "Pro_ects/inside.txt",
    ])
  })
})

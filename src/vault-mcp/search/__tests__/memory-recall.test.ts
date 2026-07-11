import { describe, it, expect, vi } from "vitest"
vi.mock("sqlite-vec", { spy: true })
import { createSearchIndex } from "../search-index.js"
import type { Reranker } from "../reranker.js"
import { logger } from "../../../logger.js"

const DIMENSIONS = 384

/** One-hot embedding — entries/queries sharing a seed have cosine distance
 *  0 to each other and 1 to every other seed. */
const seededEmbedding = (seed: number): Float32Array => {
  const embedding = new Float32Array(DIMENSIONS).fill(0)
  embedding[seed % DIMENSIONS] = 1.0
  return embedding
}

/** Topic seed by content: the pacing/recovery topic shares one dimension
 *  (so drifted phrasings are semantic neighbors), testing gets another, and
 *  everything else lands orthogonal to both. "testing" is checked FIRST so a
 *  testing entry that mentions pacing words stays on the testing dimension —
 *  the lexical-hit-with-distant-vector case needs that separation. */
const topicSeedFor = (text: string): number => {
  const lowered = text.toLowerCase()
  if (lowered.includes("testing")) return 2
  if (
    lowered.includes("pacing") ||
    lowered.includes("recovery") ||
    lowered.includes("sustainable")
  ) {
    return 1
  }
  return 3
}

/** Content-aware mock embedder — same topic → identical vector. */
const createTopicMockEmbedder = () => ({
  embedText: vi
    .fn()
    .mockImplementation((text: string) =>
      Promise.resolve(seededEmbedding(topicSeedFor(text))),
    ),
  embedBatch: vi
    .fn()
    .mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map((text) => seededEmbedding(topicSeedFor(text)))),
    ),
})

/** Mock cross-encoder: for an on-topic query, on-topic documents get a
 *  strongly positive logit and the "walk" entry sits just above the p=0.05
 *  cutoff; everything else — including every document under an off-topic
 *  query — is confidently irrelevant. */
const createTopicMockReranker = (): Reranker => ({
  rerankPairs: vi
    .fn()
    .mockImplementation((query: string, documents: string[]) => {
      const loweredQuery = query.toLowerCase()
      const queryIsOnTopic =
        loweredQuery.includes("pacing") || loweredQuery.includes("recovery")
      return Promise.resolve(
        documents.map((document) => {
          if (!queryIsOnTopic) return -8
          const lowered = document.toLowerCase()
          if (lowered.includes("walk")) return -1 // sigmoid ≈ 0.27 — kept, least relevant
          const documentIsOnTopic =
            lowered.includes("pacing") ||
            lowered.includes("recovery") ||
            lowered.includes("rest blocks")
          return documentIsOnTopic ? 6 : -8 // -8: sigmoid ≈ 0.0003 — dropped
        }),
      )
    }),
})

/** Fresh index with the given memory files upserted and embedded. */
const createRecallIndex = async (options?: {
  reranker?: Reranker | undefined
  withEmbedder?: boolean
  files?: Record<string, string>
}) => {
  const embedder =
    (options?.withEmbedder ?? true) ? createTopicMockEmbedder() : undefined
  const index = createSearchIndex(":memory:", embedder, options?.reranker, {
    memoryDir: "About Me",
  })
  const files = options?.files ?? DEFAULT_FILES
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = `About Me/${fileName}.md`
    index.upsertNote(
      { filePath, rawContent: content, fileStat: { mtimeMs: 1000, size: 100 } },
      logger,
    )
    await index.embedNote({ notePath: filePath, rawContent: content }, logger)
  }
  return index
}

const OPINIONS_FIXTURE = `# Opinions

## Working style (newest first)

- **2026-07-02**: Pacing beats crunch; protect the recovery window.
- **2026-06-20**: Sustainable rhythm means rest blocks between sprints.

## Code patterns (newest first)

- **2026-05-07**: Table-driven testing keeps specs readable.
`

const ROUTINES_FIXTURE = `# Routines

## Daily rhythm (newest first)

- **2026-07-10**: Recovery walk every afternoon keeps pacing sane.
`

const DEFAULT_FILES = {
  Opinions: OPINIONS_FIXTURE,
  Routines: ROUTINES_FIXTURE,
}

describe("memoryRecall", () => {
  it("returns a semantic-only match that shares no query keywords", async () => {
    const index = await createRecallIndex()
    // "rest blocks between sprints" phrases the topic with no stem overlap
    // with the query — FTS cannot match it, only the vector leg can.
    const { entries, search_mode } = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    expect(search_mode).toBe("hybrid")
    expect(entries.map((entry) => entry.date)).toContain("2026-06-20")
  })

  it("keeps a lexical hit whose vector is distant from the query", async () => {
    const index = await createRecallIndex({
      files: {
        Opinions: `# Opinions

## Working style (newest first)

- **2026-07-02**: Pacing beats crunch; protect the recovery window.

## Code patterns (newest first)

- **2026-05-07**: Mutation testing proves pacing of recovery in test suites.
`,
      },
    })
    // The testing entry embeds on the testing topic (distance 1 from the
    // query, far outside best + 0.15) but matches both query words lexically
    // — the FTS-unconditional rule must keep it.
    const { entries } = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    expect(entries.map((entry) => entry.date)).toEqual([
      "2026-05-07",
      "2026-07-02",
    ])
  })

  it("returns the evidence set ascending by date across files", async () => {
    const index = await createRecallIndex()
    const { entries } = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    // Files store newest-first; output must read oldest-first, cross-file.
    expect(entries.map((entry) => [entry.date, entry.file])).toEqual([
      ["2026-06-20", "Opinions"],
      ["2026-07-02", "Opinions"],
      ["2026-07-10", "Routines"],
    ])
  })

  it("orders same-date entries by file then document position", async () => {
    const index = await createRecallIndex({
      files: {
        Zeta: `# Zeta

## Topic (newest first)

- **2026-06-01**: Recovery pacing note in Zeta.
`,
        Alpha: `# Alpha

## Topic (newest first)

- **2026-06-01**: Recovery pacing note two in Alpha.
- **2026-06-01**: Recovery pacing note one in Alpha.
`,
      },
    })
    const { entries } = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    expect(
      entries.map((entry) => [entry.file, entry.text.includes("note one")]),
    ).toEqual([
      ["Alpha", false],
      ["Alpha", true],
      ["Zeta", false],
    ])
  })

  it("drops candidates below the cross-encoder probability floor", async () => {
    const index = await createRecallIndex({
      reranker: createTopicMockReranker(),
      files: {
        Opinions: `# Opinions

## Working style (newest first)

- **2026-07-02**: Pacing beats crunch; protect the recovery window.

## Logistics (newest first)

- **2026-03-01**: Sustainable packaging chosen for the move.
`,
      },
    })
    // "Sustainable packaging" is a semantic neighbor (same topic seed via
    // "sustainable") and no lexical hit — exactly the plausible-but-wrong
    // candidate only cross-attention can reject (mock logit -8).
    const { entries, reranked } = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    expect(reranked).toBe(true)
    expect(entries.map((entry) => entry.date)).toEqual(["2026-07-02"])
  })

  it("falls back to the distance-margin cut when the reranker throws", async () => {
    const throwingReranker: Reranker = {
      rerankPairs: vi.fn().mockRejectedValue(new Error("model load failed")),
    }
    const index = await createRecallIndex({
      reranker: throwingReranker,
      files: {
        Opinions: `# Opinions

## Working style (newest first)

- **2026-07-02**: Pacing beats crunch; protect the recovery window.

## Logistics (newest first)

- **2026-03-01**: Sustainable packaging chosen for the move.
`,
      },
    })
    const { entries, reranked, search_mode } = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    // The margin cut keeps the semantic neighbor the reranker would have
    // dropped — proof the fallback path ran, not a silently-empty rerank.
    expect(reranked).toBe(false)
    expect(search_mode).toBe("hybrid")
    expect(entries.map((entry) => entry.date)).toEqual([
      "2026-03-01",
      "2026-07-02",
    ])
  })

  it("truncates the least-relevant entries first and reports the full total", async () => {
    const index = await createRecallIndex({
      reranker: createTopicMockReranker(),
    })
    // Mock logits: crunch/blocks entries score 6; the walk entry scores -1 —
    // kept by the cut (sigmoid ≈ 0.27) but least relevant, so max_results: 2
    // drops it even though it is the NEWEST entry — truncation follows
    // relevance, never a date end.
    const { entries, total, truncated } = await index.memoryRecall(
      { query: "pacing recovery", maxResults: 2 },
      logger,
    )
    expect(total).toBe(3)
    expect(truncated).toBe(true)
    expect(entries.map((entry) => entry.date)).toEqual([
      "2026-06-20",
      "2026-07-02",
    ])
  })

  it("restricts recall to one file when file is given", async () => {
    const index = await createRecallIndex()
    // Both files contain matches — the filter must exclude, not just include.
    const { entries } = await index.memoryRecall(
      { query: "pacing recovery", file: "Routines" },
      logger,
    )
    expect(entries.map((entry) => [entry.file, entry.date])).toEqual([
      ["Routines", "2026-07-10"],
    ])
  })

  it("returns an empty result rather than an error when nothing matches", async () => {
    const index = await createRecallIndex({
      reranker: createTopicMockReranker(),
    })
    const result = await index.memoryRecall(
      { query: "quantum chromodynamics" },
      logger,
    )
    expect(result.entries).toEqual([])
    expect(result.total).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it("does not throw on FTS metacharacters in the query", async () => {
    const index = await createRecallIndex()
    const result = await index.memoryRecall(
      { query: 'pacing") AND (recovery OR NEAR' },
      logger,
    )
    expect(result.search_mode).toBe("hybrid")
  })

  it("serves lexical-only recall with search_mode fts when no embedder exists", async () => {
    const index = await createRecallIndex({ withEmbedder: false })
    const { entries, search_mode, reranked } = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    expect(search_mode).toBe("fts")
    expect(reranked).toBe(false)
    // Lexical matches only — the drifted-vocabulary entry (2026-06-20,
    // "rest blocks") is invisible without vectors, the documented cost of
    // embeddings-off mode.
    expect(entries.map((entry) => entry.date)).toEqual([
      "2026-07-02",
      "2026-07-10",
    ])
  })

  it("rejects with a remediation message when no memory dir is configured", async () => {
    const index = createSearchIndex(":memory:")
    await expect(
      index.memoryRecall({ query: "anything" }, logger),
    ).rejects.toThrow(
      "memory recall is not available: the memory layer is disabled (MEMORY_ENABLED=false)",
    )
  })
})

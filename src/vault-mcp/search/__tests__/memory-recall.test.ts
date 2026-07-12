import { describe, it, expect, vi, onTestFinished } from "vitest"
vi.mock("sqlite-vec", { spy: true })
import { createSearchIndex } from "../search-index.js"
import { sigmoid, type Reranker } from "../reranker.js"
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
 *  strongly positive logit and the "walk" entry sits above the adaptive
 *  floor; everything else — including every document under an off-topic
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
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())
    const result = await index.memoryRecall(
      { query: "quantum chromodynamics of the vacuum" },
      logger,
    )
    // No content word appears anywhere and the stopwords ("of", "the" — both
    // present in fixture entries) are dropped from the rescue, so the
    // any-term rescue also finds nothing — a genuine no-match keeps the
    // pre-rescue wire shape and never logs the rescue fingerprint.
    expect(result.entries).toEqual([])
    expect(result.total).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.search_mode).toBe("hybrid")
    expect(result.reranked).toBe(true)
    const rescueLogCalls = infoSpy.mock.calls.filter(
      ([, data]) => data !== undefined && Object.hasOwn(data, "anyTermRescue"),
    )
    expect(rescueLogCalls).toEqual([])
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

  it("degrades to fts mode when the embedder fails during the query", async () => {
    const failingEmbedder = createTopicMockEmbedder()
    const index = createSearchIndex(":memory:", failingEmbedder, undefined, {
      memoryDir: "About Me",
    })
    // Seed both files so we have vector-only AND lexical entries
    for (const [fileName, content] of Object.entries(DEFAULT_FILES)) {
      const filePath = `About Me/${fileName}.md`
      index.upsertNote(
        {
          filePath,
          rawContent: content,
          fileStat: { mtimeMs: 1000, size: 100 },
        },
        logger,
      )
      await index.embedNote({ notePath: filePath, rawContent: content }, logger)
    }

    // Break the embedder for the recall query — memoryVectorSearch catches
    // the error and returns [], triggering the lexical-only early return.
    failingEmbedder.embedText.mockRejectedValue(new Error("ONNX runtime error"))

    const result = await index.memoryRecall(
      { query: "pacing recovery" },
      logger,
    )
    expect(result.search_mode).toBe("fts")
    expect(result.reranked).toBe(false)
    // Only keyword hits survive — the semantic-only entry (2026-06-20,
    // "rest blocks") is invisible without vectors, same as embeddings-off.
    expect(result.entries.map((entry) => entry.date)).toEqual([
      "2026-07-02",
      "2026-07-10",
    ])
  })

  it("floors maxResults to 1 so the result is never artificially empty", async () => {
    const index = await createRecallIndex()
    const result = await index.memoryRecall(
      { query: "pacing recovery", maxResults: 0 },
      logger,
    )
    // Three entries match but maxResults: 0 floors to 1 — exactly 1 survives.
    expect(result.entries).toHaveLength(1)
    expect(result.total).toBe(3)
    expect(result.truncated).toBe(true)
  })

  it("rejects with a remediation message when no memory dir is configured", async () => {
    const index = createSearchIndex(":memory:")
    await expect(
      index.memoryRecall({ query: "anything" }, logger),
    ).rejects.toThrow(
      "memory recall is not available: the memory layer is disabled (MEMORY_ENABLED=false)",
    )
  })

  it("rescues a meta-phrased query with any-term matching when the rerank cut rejects every candidate", async () => {
    const reranker = createTopicMockReranker()
    const index = await createRecallIndex({ reranker })
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())
    // "opinions on testing" has no all-terms lexical match (no entry contains
    // all three stems) and the off-topic mock reranker rejects every vector
    // candidate — exactly the live zero-result defect. The any-term rescue
    // must surface the entry matching "testing".
    const result = await index.memoryRecall(
      { query: "opinions on testing" },
      logger,
    )
    // rerankPairs ran once: proof the hybrid rerank path rejected the
    // candidates — not the vector-empty early return producing "fts" mode.
    expect(vi.mocked(reranker.rerankPairs)).toHaveBeenCalledTimes(1)
    expect(result.entries).toEqual([
      {
        file: "Opinions",
        section: "Code patterns (newest first)",
        date: "2026-05-07",
        text: "- **2026-05-07**: Table-driven testing keeps specs readable.",
      },
    ])
    expect(result.total).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.search_mode).toBe("fts")
    expect(result.reranked).toBe(false)
    // The ops fingerprint: exactly one log line carries anyTermRescue, with
    // the full rescue shape — monitoring keys on this flag.
    const rescueLogCalls = infoSpy.mock.calls.filter(
      ([, data]) => data !== undefined && Object.hasOwn(data, "anyTermRescue"),
    )
    expect(rescueLogCalls).toEqual([
      [
        "memory recall",
        {
          query: "opinions on testing",
          searchMode: "fts",
          reranked: false,
          ftsHits: 0,
          vectorHits: 4,
          matched: 1,
          returned: 1,
          anyTermRescue: true,
        },
      ],
    ])
  })

  it("keeps a borderline entry that the absolute floor would cut when the best probability is moderate", async () => {
    // Custom reranker: moderate best logit (-1 → sigmoid ≈ 0.27), a
    // borderline logit (-3 → sigmoid ≈ 0.047, below the old absolute
    // 0.05), and an irrelevant logit (-8). The adaptive floor lowers to
    // ~0.027 (10% of 0.27), rescuing the borderline entry.
    const moderateReranker: Reranker = {
      rerankPairs: vi
        .fn()
        .mockImplementation((_query: string, documents: string[]) =>
          Promise.resolve(
            documents.map((document) => {
              const lowered = document.toLowerCase()
              if (lowered.includes("direct")) return -1
              if (lowered.includes("structured")) return -3
              return -8
            }),
          ),
        ),
    }
    const index = await createRecallIndex({
      reranker: moderateReranker,
      files: {
        Communication: `# Communication

## Style (newest first)

- **2026-07-01**: Direct feedback preferred over diplomatic hedging.
- **2026-06-15**: Structured status updates help me track progress.

## Unrelated (newest first)

- **2026-03-01**: Office supplies were restocked on schedule.
`,
      },
    })
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())
    const { entries, reranked } = await index.memoryRecall(
      { query: "how I like agents to communicate with me" },
      logger,
    )
    expect(reranked).toBe(true)
    // Verify the adaptive floor computed correctly — not just that entries
    // survived. Without this, the test would also pass if the computation
    // degenerated to the sanity floor (0.001).
    const rerankLogCalls = infoSpy.mock.calls.filter(
      ([message]) => message === "memory recall rerank",
    )
    expect(rerankLogCalls).toEqual([
      [
        "memory recall rerank",
        {
          bestProbability: sigmoid(-1),
          effectiveFloor: sigmoid(-1) * 0.1,
        },
      ],
    ])
    // Both communication entries survive: "structured" at sigmoid(-3) ≈ 0.047
    // would be cut by the old absolute floor (0.05) but the adaptive floor
    // lowers to ~0.027 when the best probability is only ~0.27.
    expect(entries.map((entry) => entry.date)).toEqual([
      "2026-06-15",
      "2026-07-01",
    ])
    // The reranker must receive file-prefixed documents matching the
    // embedding format — a regression that drops the file name from
    // the reranker input silently degrades relevance scoring.
    const rerankerDocuments = vi.mocked(moderateReranker.rerankPairs).mock
      .calls[0]?.[1]
    expect(rerankerDocuments).toBeDefined()
    for (const document of rerankerDocuments ?? []) {
      expect(document).toMatch(/^Communication > /)
    }
  })

  it("boosts entries from a file whose name matches the query topic", async () => {
    // Two files with identically-worded entries about the same topic —
    // the ONLY distinguishing signal is the file name. The reranker
    // scores "Agents > ..." higher than "Opinions > ..." when the
    // query mentions "agents", proving the file name prefix is the
    // relevance differentiator, not the entry text.
    const fileNameAwareReranker: Reranker = {
      rerankPairs: vi
        .fn()
        .mockImplementation((_query: string, documents: string[]) =>
          Promise.resolve(
            documents.map((document) => {
              if (document.startsWith("Agents > ")) return 2
              return -4
            }),
          ),
        ),
    }
    const index = await createRecallIndex({
      reranker: fileNameAwareReranker,
      files: {
        Agents: `# Agents

## Communication (newest first)

- **2026-07-01**: Prefer terse responses over verbose explanations.
`,
        Opinions: `# Opinions

## Communication preferences (newest first)

- **2026-06-15**: Prefer terse responses over verbose explanations.
`,
      },
    })
    const { entries, reranked } = await index.memoryRecall(
      { query: "how agents should communicate" },
      logger,
    )
    expect(reranked).toBe(true)
    // Only the Agents entry survives — the Opinions entry has identical
    // text but scores below the floor because its file name doesn't
    // match the query topic. Without the file name prefix, both entries
    // would receive the same logit and both would survive or both be cut.
    expect(entries).toEqual([
      {
        file: "Agents",
        section: "Communication (newest first)",
        date: "2026-07-01",
        text: "- **2026-07-01**: Prefer terse responses over verbose explanations.",
      },
    ])
  })

  it("clips the adaptive floor to the max floor for high-confidence queries", async () => {
    // When the best probability is high (sigmoid(3) ≈ 0.95), the relative
    // threshold (0.095) exceeds MAX_FLOOR (0.05) — the ceiling must bind
    // so good queries behave identically to the old absolute cutoff.
    const confidentReranker: Reranker = {
      rerankPairs: vi
        .fn()
        .mockImplementation((_query: string, documents: string[]) =>
          Promise.resolve(
            documents.map((document) => {
              const lowered = document.toLowerCase()
              if (lowered.includes("focused")) return 3
              if (lowered.includes("borderline")) return -3
              return -8
            }),
          ),
        ),
    }
    const index = await createRecallIndex({
      reranker: confidentReranker,
      files: {
        Principles: `# Principles

## Working style (newest first)

- **2026-07-02**: Focused deep work in the morning is non-negotiable.
- **2026-06-15**: Borderline distractions get cut after the first hour.

## Unrelated (newest first)

- **2026-03-01**: Office supplies were restocked on schedule.
`,
      },
    })
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())
    const { entries, reranked } = await index.memoryRecall(
      { query: "deep work and focus habits" },
      logger,
    )
    expect(reranked).toBe(true)
    // "borderline" at sigmoid(-3) ≈ 0.047 is below MAX_FLOOR (0.05) — the
    // ceiling binds, so the entry is cut just as it would be under the old
    // absolute floor. Only the strong "focused" entry survives.
    expect(entries.map((entry) => entry.date)).toEqual(["2026-07-02"])
    const rerankLogCalls = infoSpy.mock.calls.filter(
      ([message]) => message === "memory recall rerank",
    )
    expect(rerankLogCalls).toEqual([
      [
        "memory recall rerank",
        {
          bestProbability: sigmoid(3),
          effectiveFloor: 0.05,
        },
      ],
    ])
  })

  it("does not degrade to any-term matching when the rerank cut keeps a candidate", async () => {
    // Inline reranker: only documents mentioning "recovery" are relevant —
    // the decoy entry stays a vector candidate (it embeds on the pacing
    // topic) but gets cut.
    const recoveryOnlyReranker: Reranker = {
      rerankPairs: vi
        .fn()
        .mockImplementation((_query: string, documents: string[]) =>
          Promise.resolve(
            documents.map((document) =>
              document.toLowerCase().includes("recovery") ? 6 : -8,
            ),
          ),
        ),
    }
    const index = await createRecallIndex({
      reranker: recoveryOnlyReranker,
      files: {
        Opinions: `# Opinions

## Working style (newest first)

- **2026-07-02**: Pacing beats crunch; protect the recovery window.
- **2026-06-15**: Meeting pacing notes for the retro.
`,
      },
    })
    // "recuperation" appears in no entry, so the all-terms leg is empty —
    // but the rerank cut keeps the recovery entry, so the rescue must NOT
    // fire: the decoy is an any-term hit on "pacing" and would appear if it
    // did.
    const result = await index.memoryRecall(
      { query: "pacing recuperation" },
      logger,
    )
    expect(result.entries.map((entry) => entry.date)).toEqual(["2026-07-02"])
    expect(result.search_mode).toBe("hybrid")
    expect(result.reranked).toBe(true)
  })

  it("restricts the any-term rescue to one file when file is given", async () => {
    const index = await createRecallIndex({
      reranker: createTopicMockReranker(),
      files: {
        Alpha: `# Alpha

## Code patterns (newest first)

- **2026-05-01**: Unit testing keeps specs readable in Alpha.
`,
        Beta: `# Beta

## Code patterns (newest first)

- **2026-05-02**: Integration testing habits differ in Beta.
`,
      },
    })
    // Both files hold an any-term hit on "testing" — the filter must
    // exclude Beta, not just include Alpha.
    const result = await index.memoryRecall(
      { query: "opinions on testing", file: "Alpha" },
      logger,
    )
    expect(result.entries.map((entry) => [entry.file, entry.date])).toEqual([
      ["Alpha", "2026-05-01"],
    ])
    expect(result.total).toBe(1)
    expect(result.search_mode).toBe("fts")
  })

  it("stays empty without the rescue fingerprint when any-term hits exist only in excluded files", async () => {
    const index = await createRecallIndex({
      reranker: createTopicMockReranker(),
      files: {
        // Alpha shares no stem with the query — its entry can never be an
        // any-term hit.
        Alpha: `# Alpha

## Code patterns (newest first)

- **2026-05-01**: Tooling choices differ here.
`,
        // Beta holds the only any-term hit ("testing") — excluded by file.
        Beta: `# Beta

## Code patterns (newest first)

- **2026-05-02**: Integration testing habits differ in Beta.
`,
      },
    })
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())
    const result = await index.memoryRecall(
      { query: "opinions on testing", file: "Alpha" },
      logger,
    )
    // The filter empties the rescue set — a filtered-to-empty result keeps
    // the genuine no-match shape and never logs the rescue fingerprint.
    expect(result.entries).toEqual([])
    expect(result.total).toBe(0)
    expect(result.search_mode).toBe("hybrid")
    expect(result.reranked).toBe(true)
    const rescueLogCalls = infoSpy.mock.calls.filter(
      ([, data]) => data !== undefined && Object.hasOwn(data, "anyTermRescue"),
    )
    expect(rescueLogCalls).toEqual([])
  })

  it("rescues a meta-phrased query in lexical-only mode when no embedder exists", async () => {
    const index = await createRecallIndex({ withEmbedder: false })
    const infoSpy = vi.spyOn(logger, "info")
    onTestFinished(() => infoSpy.mockRestore())
    // Without vectors the all-terms leg is the only leg — an empty result
    // there must degrade to any-term matching too.
    const result = await index.memoryRecall(
      { query: "opinions on testing" },
      logger,
    )
    expect(result.entries).toEqual([
      {
        file: "Opinions",
        section: "Code patterns (newest first)",
        date: "2026-05-07",
        text: "- **2026-05-07**: Table-driven testing keeps specs readable.",
      },
    ])
    expect(result.search_mode).toBe("fts")
    expect(result.reranked).toBe(false)
    // The lexical-only path emits the same ops fingerprint as the hybrid one.
    const rescueLogCalls = infoSpy.mock.calls.filter(
      ([, data]) => data !== undefined && Object.hasOwn(data, "anyTermRescue"),
    )
    expect(rescueLogCalls).toEqual([
      [
        "memory recall",
        {
          query: "opinions on testing",
          searchMode: "fts",
          reranked: false,
          ftsHits: 0,
          vectorHits: 0,
          matched: 1,
          returned: 1,
          anyTermRescue: true,
        },
      ],
    ])
  })
})

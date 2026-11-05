import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import {
  assertHealthyEvalResult,
  countUnexpectedFilesInWindow,
  judgmentFileSchema,
  rankOfFirstExpected,
  resolveEvalRunPlan,
} from "../search-eval-plan.js"
import type { JudgmentQuery } from "../search-eval-plan.js"
import type { HybridSearchResult, SearchResult } from "../../src/vault-mcp/search/search-index.js"

// Test-owned copy of the marker name the snapshot module writes.
const SNAPSHOT_MARKER = ".search-eval-snapshot"

const createWorkDir = (): string => {
  const workDir = mkdtempSync(join(tmpdir(), "search-eval-plan-"))
  onTestFinished(() => rmSync(workDir, { recursive: true, force: true }))
  return workDir
}

const createHarnessSnapshot = (workDir: string): string => {
  const snapshotDir = join(workDir, "vault-snapshot")
  mkdirSync(snapshotDir, { recursive: true })
  writeFileSync(join(snapshotDir, SNAPSHOT_MARKER), "")
  return snapshotDir
}

const baseCliArgs = {
  judgment: "judgment.json",
  "file-leg-weight": undefined,
  limits: "20,5,3",
  "work-dir": undefined,
  "enrich-metadata": false,
  "reuse-snapshot": false,
  "reuse-index": false,
}

describe("resolveEvalRunPlan", () => {
  it("rejects a missing --judgment", () => {
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, judgment: undefined })
    }).toThrow(
      new Error("--judgment <path> is required (a local judgment JSON — see the file header)"),
    )
  })

  it("parses positive integer limits in their requested order", () => {
    const workDir = createWorkDir()
    const plan = resolveEvalRunPlan({ ...baseCliArgs, "work-dir": workDir })
    expect(plan.limits).toEqual([20, 5, 3])
  })

  it.each([
    { label: "a non-integer entry", limits: "20,two", invalidEntry: "two" },
    { label: "zero", limits: "0", invalidEntry: "0" },
  ])("rejects $label in --limits", ({ limits, invalidEntry }) => {
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, limits })
    }).toThrow(new Error(`--limits entries must be positive integers: ${invalidEntry}`))
  })

  it.each([
    { label: "zero", rawWeight: "0", expectedWeight: 0 },
    { label: "a fractional number", rawWeight: "0.4", expectedWeight: 0.4 },
  ])("accepts $label for --file-leg-weight", ({ rawWeight, expectedWeight }) => {
    const workDir = createWorkDir()
    const plan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "file-leg-weight": rawWeight,
    })
    expect(plan.fileLegWeight).toBe(expectedWeight)
  })

  it.each([
    { label: "non-numeric text", rawWeight: "abc" },
    { label: "a negative number", rawWeight: "-1" },
    // An unset shell interpolation must not silently select the shipped default.
    { label: "an empty value", rawWeight: "" },
    { label: "Infinity", rawWeight: "Infinity" },
    { label: "numeric overflow", rawWeight: "1e400" },
    // Number(" ") coerces to zero, which would silently disable the file legs.
    { label: "whitespace", rawWeight: " " },
  ])("rejects $label for --file-leg-weight", ({ rawWeight }) => {
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, "file-leg-weight": rawWeight })
    }).toThrow(new Error("--file-leg-weight must be a finite number >= 0"))
  })

  it("rejects --reuse-index without --reuse-snapshot", () => {
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, "reuse-index": true })
    }).toThrow(new Error("--reuse-index requires --reuse-snapshot"))
  })

  it("rejects --reuse-index when no harness snapshot exists to pair with", () => {
    const workDir = createWorkDir()
    expect(() => {
      resolveEvalRunPlan({
        ...baseCliArgs,
        "work-dir": workDir,
        "reuse-snapshot": true,
        "reuse-index": true,
      })
    }).toThrow(
      new Error(
        "--reuse-index requires the snapshot it was built from, but the snapshot would be rebuilt this run — re-run without --reuse-index",
      ),
    )
  })

  it("does not adopt a vault-snapshot directory that lacks the harness marker", () => {
    const workDir = createWorkDir()
    mkdirSync(join(workDir, "vault-snapshot"), { recursive: true })

    const plan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "reuse-snapshot": true,
    })
    expect(plan.snapshotReused).toBe(false)
  })

  it("reuses a marked snapshot and an existing index together", () => {
    const workDir = createWorkDir()
    createHarnessSnapshot(workDir)
    writeFileSync(join(workDir, "search-eval.db"), "")

    const plan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "reuse-snapshot": true,
      "reuse-index": true,
    })
    expect({ snapshotReused: plan.snapshotReused, indexReused: plan.indexReused }).toEqual({
      snapshotReused: true,
      indexReused: true,
    })
  })

  it("rebuilds a missing index even when --reuse-index is set", () => {
    const workDir = createWorkDir()
    createHarnessSnapshot(workDir)

    const plan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "reuse-snapshot": true,
      "reuse-index": true,
    })
    expect({ snapshotReused: plan.snapshotReused, indexReused: plan.indexReused }).toEqual({
      snapshotReused: true,
      indexReused: false,
    })
  })

  it("gives the enriched index its own database file", () => {
    const workDir = createWorkDir()
    const plainPlan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
    })
    const enrichedPlan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "enrich-metadata": true,
    })
    expect(plainPlan.indexDbPath).toBe(join(workDir, "search-eval.db"))
    expect(enrichedPlan.indexDbPath).toBe(join(workDir, "search-eval-enriched.db"))
  })
})

describe("judgmentFileSchema", () => {
  const baseJudgment = {
    vault_path: "/vault",
    exclude_paths: [],
    exclude_prefixes: [],
  }

  it("rejects a query that declares no expected result", () => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [{ id: "q1", class: "recall", query: "some text" }],
    })

    if (parsed.success) throw new Error("expected judgment validation to fail")
    expect(parsed.error.issues).toEqual([
      {
        code: "custom",
        path: ["queries", 0],
        message: "each query needs expected_any or expected_prefix",
      },
    ])
  })

  it("preserves expected_any, expected_prefix, and a filtered query with filters", () => {
    const judgment = {
      ...baseJudgment,
      queries: [
        {
          id: "q1",
          class: "recall",
          query: "some text",
          expected_any: ["Notes/plan.md"],
        },
        {
          id: "q2",
          class: "sentinel",
          query: "other text",
          expected_prefix: "docs/",
        },
        {
          id: "q3",
          class: "filtered",
          query: "budget",
          expected_any: ["Notes/budget.md"],
          filters: { folder: "Journal" },
        },
      ],
    }
    expect(judgmentFileSchema.parse(judgment)).toEqual(judgment)
  })

  const filteredQuery = {
    id: "filtered",
    class: "filtered",
    query: "naming rules",
    expected_any: ["Reference/standards.md"],
  }

  it("preserves every supported filter field and property value type", () => {
    const judgment = {
      ...baseJudgment,
      queries: [
        {
          ...filteredQuery,
          filters: {
            folder: "Reference/",
            tags: ["code-standards", "Development/TypeScript"],
            related: ["[[Reference/Guide|Guide]]"],
            type: "reference",
            properties: { "literal.key": "4", count: 4.5, enabled: false, zero: 0, blank: "" },
            created: { before: "2026-11-04", on: "2026-11-03", after: "2026-11-02" },
            modified: { before: "2026-11-06", on: "2026-11-05", after: "2026-11-04" },
          },
        },
      ],
    }
    expect(judgmentFileSchema.parse(judgment)).toEqual(judgment)
  })

  it.each([
    { label: "folder", filters: { folder: "Reference" } },
    { label: "tags", filters: { tags: ["code-standards"] } },
    { label: "related", filters: { related: ["[[Reference/Guide]]"] } },
    { label: "type", filters: { type: "reference" } },
    { label: "false property", filters: { properties: { enabled: false } } },
    { label: "zero property", filters: { properties: { count: 0 } } },
    { label: "empty string property", filters: { properties: { blank: "" } } },
    { label: "created.before", filters: { created: { before: "2026-11-04" } } },
    { label: "created.on", filters: { created: { on: "2026-11-04" } } },
    { label: "created.after", filters: { created: { after: "2026-11-04" } } },
    { label: "modified.before", filters: { modified: { before: "2026-11-04" } } },
    { label: "modified.on", filters: { modified: { on: "2026-11-04" } } },
    { label: "modified.after", filters: { modified: { after: "2026-11-04" } } },
  ])("accepts $label as the only effective filter", ({ filters }) => {
    const judgment = { ...baseJudgment, queries: [{ ...filteredQuery, filters }] }
    expect(judgmentFileSchema.parse(judgment)).toEqual(judgment)
  })

  it.each([
    { label: "empty object", filters: {} },
    { label: "empty folder", filters: { folder: "" } },
    { label: "empty tags", filters: { tags: [] } },
    { label: "empty related", filters: { related: [] } },
    { label: "empty type", filters: { type: "" } },
    { label: "empty properties", filters: { properties: {} } },
    { label: "empty created bounds", filters: { created: {} } },
    { label: "empty modified bounds", filters: { modified: {} } },
    {
      label: "combined no-op fields",
      filters: {
        folder: "",
        tags: [],
        related: [],
        type: "",
        properties: {},
        created: {},
        modified: {},
      },
    },
  ])("rejects a filtered query with $label", ({ filters }) => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [{ ...filteredQuery, filters }],
    })

    if (parsed.success) throw new Error("expected ineffective filters to be rejected")

    expect(parsed.error.issues).toEqual([
      {
        code: "custom",
        path: ["queries", 0],
        message: "a filtered query needs at least one effective filter",
      },
    ])
  })

  it.each([
    {
      label: "filter",
      filters: { folder: "Reference", tag: ["typo"] },
      path: ["queries", 0, "filters"],
      key: "tag",
    },
    {
      label: "created",
      filters: { created: { on: "2026-11-04", since: "2026-11-03" } },
      path: ["queries", 0, "filters", "created"],
      key: "since",
    },
    {
      label: "modified",
      filters: { modified: { on: "2026-11-04", since: "2026-11-03" } },
      path: ["queries", 0, "filters", "modified"],
      key: "since",
    },
  ])("rejects an unknown $label key instead of dropping it", ({ filters, path, key }) => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [{ ...filteredQuery, filters }],
    })

    if (parsed.success) throw new Error("expected unknown filter key to be rejected")

    expect(parsed.error.issues).toEqual([
      {
        code: "unrecognized_keys",
        keys: [key],
        path,
        message: `Unrecognized key: "${key}"`,
      },
    ])
  })

  it("rejects an empty expected_any list", () => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [{ id: "q1", class: "recall", query: "some text", expected_any: [] }],
    })

    if (parsed.success) throw new Error("expected judgment validation to fail")

    expect(parsed.error.issues).toEqual([
      {
        origin: "array",
        code: "too_small",
        minimum: 1,
        inclusive: true,
        path: ["queries", 0, "expected_any"],
        message: "Too small: expected array to have >=1 items",
      },
    ])
  })

  it("rejects an unknown key on a query so a typoed filter cannot score unfiltered", () => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [
        {
          id: "q1",
          class: "recall",
          query: "some text",
          expected_any: ["Notes/plan.md"],
          filter: { folder: "Journal" },
        },
      ],
    })

    if (parsed.success) throw new Error("expected judgment validation to fail")

    expect(parsed.error.issues).toEqual([
      {
        code: "unrecognized_keys",
        keys: ["filter"],
        path: ["queries", 0],
        message: 'Unrecognized key: "filter"',
      },
    ])
  })

  it("rejects a filtered-class query that declares no filters", () => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [
        {
          id: "q1",
          class: "filtered",
          query: "some text",
          expected_any: ["Notes/plan.md"],
        },
      ],
    })

    if (parsed.success) throw new Error("expected judgment validation to fail")
    expect(parsed.error.issues).toEqual([
      {
        code: "custom",
        path: ["queries", 0],
        message: "a filtered query needs at least one effective filter",
      },
    ])
  })

  it("rejects an unknown key at the file level", () => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      excluded_paths: ["typo.md"],
      queries: [
        {
          id: "q1",
          class: "recall",
          query: "some text",
          expected_any: ["Notes/plan.md"],
        },
      ],
    })

    if (parsed.success) throw new Error("expected judgment validation to fail")

    expect(parsed.error.issues).toEqual([
      {
        code: "unrecognized_keys",
        keys: ["excluded_paths"],
        path: [],
        message: 'Unrecognized key: "excluded_paths"',
      },
    ])
  })
})

// Only path and kind drive the scoring helpers — the rest is fixed filler.
const searchResultAt = (path: string, kind: "note" | "file"): SearchResult => {
  return {
    path,
    title: path,
    snippet: "",
    score: 1,
    tags: [],
    folder: "",
    type: null,
    modified: "2026-01-01T00:00:00Z",
    bytes: 100,
    kind,
  }
}

describe("assertHealthyEvalResult", () => {
  const firstResult = searchResultAt("Reference/first.md", "note")
  const secondResult = searchResultAt("Reference/second.md", "note")

  it.each([
    {
      label: "empty hybrid",
      searchResult: { results: [], search_mode: "hybrid", reranked: false },
    },
    { label: "empty FTS", searchResult: { results: [], search_mode: "fts", reranked: false } },
    {
      label: "singleton hybrid",
      searchResult: { results: [firstResult], search_mode: "hybrid", reranked: false },
    },
    {
      label: "reranked hybrid",
      searchResult: { results: [firstResult, secondResult], search_mode: "hybrid", reranked: true },
    },
  ] satisfies ReadonlyArray<{ label: string; searchResult: HybridSearchResult }>)(
    "accepts a healthy $label result",
    ({ searchResult }) => {
      expect(assertHealthyEvalResult({ queryId: "q1", searchResult, problems: [] })).toBeUndefined()
    },
  )

  it("rejects a nonempty FTS fallback even for a singleton", () => {
    expect(() =>
      assertHealthyEvalResult({
        queryId: "q1",
        searchResult: { results: [firstResult], search_mode: "fts", reranked: false },
        problems: [],
      }),
    ).toThrow(new Error("query q1 ran search_mode=fts — expected hybrid for nonempty results"))
  })

  it("rejects multiple results that bypassed reranking without logging a problem", () => {
    expect(() =>
      assertHealthyEvalResult({
        queryId: "q1",
        searchResult: {
          results: [firstResult, secondResult],
          search_mode: "hybrid",
          reranked: false,
        },
        problems: [],
      }),
    ).toThrow(new Error("query q1 ran reranked=false — expected reranking for multiple results"))
  })

  it("rejects a warning even when an empty result needs no reranking", () => {
    expect(() =>
      assertHealthyEvalResult({
        queryId: "q1",
        searchResult: { results: [], search_mode: "fts", reranked: false },
        problems: [{ level: "warn", message: "reranker returned no scores" }],
      }),
    ).toThrow(new Error("query q1 logged problem(s): [warn] reranker returned no scores"))
  })

  it("rejects a logged failure even when results report a healthy pipeline", () => {
    expect(() =>
      assertHealthyEvalResult({
        queryId: "q1",
        searchResult: {
          results: [firstResult, secondResult],
          search_mode: "hybrid",
          reranked: true,
        },
        problems: [{ level: "error", message: "reranker inference failed" }],
      }),
    ).toThrow(new Error("query q1 logged problem(s): [error] reranker inference failed"))
  })
})

describe("rankOfFirstExpected", () => {
  const expectedByPrefix: JudgmentQuery = {
    id: "q1",
    class: "sentinel",
    query: "deployment guide",
    expected_prefix: "docs/",
  }

  it("returns the 1-based rank of the first result matching the prefix", () => {
    const results = [
      searchResultAt("notes/career.md", "note"),
      searchResultAt("docs/guide.txt", "file"),
      searchResultAt("docs/other.txt", "file"),
    ]
    expect(rankOfFirstExpected(results, expectedByPrefix)).toBe(2)
  })

  it("returns null when no result matches", () => {
    const results = [searchResultAt("notes/career.md", "note")]
    expect(rankOfFirstExpected(results, expectedByPrefix)).toBeNull()
  })

  it("matches a prefix whose case differs from the result path", () => {
    // On a case-insensitive vault mount the on-disk folder can be "Docs/"
    // while the judgment file says "docs" — the snapshot exclusions fold
    // case, so expectation matching must too, or the query reads as MISS.
    const results = [searchResultAt("Docs/guide.txt", "file")]
    expect(rankOfFirstExpected(results, expectedByPrefix)).toBe(1)
  })

  it("matches an expected_any entry whose case differs from the result path", () => {
    const expectedExactly: JudgmentQuery = {
      id: "q4",
      class: "sentinel",
      query: "deployment guide",
      expected_any: ["docs/Guide.txt"],
    }
    const results = [searchResultAt("Docs/guide.txt", "file")]
    expect(rankOfFirstExpected(results, expectedExactly)).toBe(1)
  })
})

describe("countUnexpectedFilesInWindow", () => {
  const expectsOneFile: JudgmentQuery = {
    id: "q1",
    class: "precision",
    query: "budget planning",
    expected_any: ["docs/budget.txt"],
  }

  it("counts only unexpected files inside the window", () => {
    const results = [
      searchResultAt("docs/budget.txt", "file"), // expected — not pollution
      searchResultAt("notes/plan.md", "note"), // note — never pollution
      searchResultAt("docs/noise.txt", "file"), // pollution, in window
      searchResultAt("docs/late-noise.txt", "file"), // outside the window
    ]
    expect(countUnexpectedFilesInWindow(results, expectsOneFile, 3)).toBe(1)
  })

  it("matches a slashless prefix at a path-segment boundary only", () => {
    const expectsFolder: JudgmentQuery = {
      id: "q3",
      class: "sentinel",
      query: "deployment guide",
      expected_prefix: "docs",
    }
    const results = [
      searchResultAt("docs2/noise.txt", "file"),
      searchResultAt("docs/guide.txt", "file"),
    ]
    // "docs" must not swallow the docs2/ sibling — the expected result is
    // the rank-2 file inside docs/, and the sibling counts as pollution.
    expect(rankOfFirstExpected(results, expectsFolder)).toBe(2)
    expect(countUnexpectedFilesInWindow(results, expectsFolder, 5)).toBe(1)
  })

  it("treats a prefix-expected file as expected, not pollution", () => {
    const expectsPrefix: JudgmentQuery = {
      id: "q2",
      class: "sentinel",
      query: "deployment guide",
      expected_prefix: "docs/",
    }
    const results = [
      searchResultAt("docs/guide.txt", "file"),
      searchResultAt("assets/photo-notes.txt", "file"),
    ]
    expect(countUnexpectedFilesInWindow(results, expectsPrefix, 5)).toBe(1)
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  countUnexpectedFilesInWindow,
  judgmentFileSchema,
  rankOfFirstExpected,
  resolveEvalRunPlan,
} from "../search-eval-plan.js";
import type { JudgmentQuery } from "../search-eval-plan.js";
import type { SearchResult } from "../../src/vault-mcp/search/search-index.js";

// Test-owned copy of the marker name the snapshot module writes.
const SNAPSHOT_MARKER = ".search-eval-snapshot";

const createWorkDir = (): string => {
  const workDir = mkdtempSync(join(tmpdir(), "search-eval-plan-"));
  onTestFinished(() => rmSync(workDir, { recursive: true, force: true }));
  return workDir;
};

const createHarnessSnapshot = (workDir: string): string => {
  const snapshotDir = join(workDir, "vault-snapshot");
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, SNAPSHOT_MARKER), "");
  return snapshotDir;
};

const baseCliArgs = {
  judgment: "judgment.json",
  "file-leg-weight": undefined,
  limits: "20,5,3",
  "work-dir": undefined,
  "enrich-metadata": false,
  "reuse-snapshot": false,
  "reuse-index": false,
};

describe("resolveEvalRunPlan", () => {
  it("rejects a missing --judgment", () => {
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, judgment: undefined });
    }).toThrow("--judgment <path> is required (a local judgment JSON — see the file header)");
  });

  it("parses --limits and rejects a non-integer entry", () => {
    const workDir = createWorkDir();
    const plan = resolveEvalRunPlan({ ...baseCliArgs, "work-dir": workDir });
    expect(plan.limits).toEqual([20, 5, 3]);

    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, limits: "20,two" });
    }).toThrow("--limits entries must be positive integers: two");
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, limits: "0" });
    }).toThrow("--limits entries must be positive integers: 0");
  });

  it("accepts weight 0, parses a numeric weight, and rejects a non-number", () => {
    const workDir = createWorkDir();
    const zeroWeightPlan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "file-leg-weight": "0",
    });
    expect(zeroWeightPlan.fileLegWeight).toBe(0);

    const weightedPlan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "file-leg-weight": "0.4",
    });
    expect(weightedPlan.fileLegWeight).toBe(0.4);

    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, "file-leg-weight": "abc" });
    }).toThrow("--file-leg-weight must be a number >= 0");
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, "file-leg-weight": "-1" });
    }).toThrow("--file-leg-weight must be a number >= 0");
    // An unset shell variable interpolates to --file-leg-weight= — that
    // must reject, not silently run the shipped default.
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, "file-leg-weight": "" });
    }).toThrow("--file-leg-weight must be a number >= 0");
  });

  it("rejects --reuse-index without --reuse-snapshot", () => {
    expect(() => {
      resolveEvalRunPlan({ ...baseCliArgs, "reuse-index": true });
    }).toThrow("--reuse-index requires --reuse-snapshot");
  });

  it("rejects --reuse-index when no harness snapshot exists to pair with", () => {
    const workDir = createWorkDir();
    expect(() => {
      resolveEvalRunPlan({
        ...baseCliArgs,
        "work-dir": workDir,
        "reuse-snapshot": true,
        "reuse-index": true,
      });
    }).toThrow(
      "--reuse-index requires the snapshot it was built from, but the snapshot would be rebuilt this run — re-run without --reuse-index",
    );
  });

  it("does not adopt a vault-snapshot directory that lacks the harness marker", () => {
    const workDir = createWorkDir();
    mkdirSync(join(workDir, "vault-snapshot"), { recursive: true });

    const plan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "reuse-snapshot": true,
    });
    expect(plan.snapshotReused).toBe(false);
  });

  it("reuses a marked snapshot and an existing index together", () => {
    const workDir = createWorkDir();
    createHarnessSnapshot(workDir);
    writeFileSync(join(workDir, "search-eval.db"), "");

    const plan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "reuse-snapshot": true,
      "reuse-index": true,
    });
    expect(plan.snapshotReused).toBe(true);
    expect(plan.indexReused).toBe(true);
  });

  it("rebuilds a missing index even when --reuse-index is set", () => {
    const workDir = createWorkDir();
    createHarnessSnapshot(workDir);

    const plan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "reuse-snapshot": true,
      "reuse-index": true,
    });
    expect(plan.snapshotReused).toBe(true);
    expect(plan.indexReused).toBe(false);
  });

  it("gives the enriched index its own database file", () => {
    const workDir = createWorkDir();
    const plainPlan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
    });
    const enrichedPlan = resolveEvalRunPlan({
      ...baseCliArgs,
      "work-dir": workDir,
      "enrich-metadata": true,
    });
    expect(plainPlan.indexDbPath).toBe(join(workDir, "search-eval.db"));
    expect(enrichedPlan.indexDbPath).toBe(join(workDir, "search-eval-enriched.db"));
  });
});

describe("judgmentFileSchema", () => {
  const baseJudgment = {
    vault_path: "/vault",
    exclude_paths: [],
    exclude_prefixes: [],
  };

  it("rejects a query that declares no expected result", () => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [{ id: "q1", class: "recall", query: "some text" }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toEqual([
      "each query needs expected_any or expected_prefix",
    ]);
  });

  it("accepts expected_any, expected_prefix, and a filtered query with filters", () => {
    const parsed = judgmentFileSchema.safeParse({
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
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty expected_any list", () => {
    const parsed = judgmentFileSchema.safeParse({
      ...baseJudgment,
      queries: [{ id: "q1", class: "recall", query: "some text", expected_any: [] }],
    });
    expect(parsed.success).toBe(false);
  });

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
    });
    expect(parsed.success).toBe(false);
  });

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
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toEqual(["a filtered query needs filters.folder"]);
  });

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
    });
    expect(parsed.success).toBe(false);
  });
});

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
  };
};

describe("rankOfFirstExpected", () => {
  const expectedByPrefix: JudgmentQuery = {
    id: "q1",
    class: "sentinel",
    query: "deployment guide",
    expected_prefix: "docs/",
  };

  it("returns the 1-based rank of the first result matching the prefix", () => {
    const results = [
      searchResultAt("notes/career.md", "note"),
      searchResultAt("docs/guide.txt", "file"),
      searchResultAt("docs/other.txt", "file"),
    ];
    expect(rankOfFirstExpected(results, expectedByPrefix)).toBe(2);
  });

  it("returns null when no result matches", () => {
    const results = [searchResultAt("notes/career.md", "note")];
    expect(rankOfFirstExpected(results, expectedByPrefix)).toBeNull();
  });
});

describe("countUnexpectedFilesInWindow", () => {
  const expectsOneFile: JudgmentQuery = {
    id: "q1",
    class: "precision",
    query: "budget planning",
    expected_any: ["docs/budget.txt"],
  };

  it("counts only unexpected files inside the window", () => {
    const results = [
      searchResultAt("docs/budget.txt", "file"), // expected — not pollution
      searchResultAt("notes/plan.md", "note"), // note — never pollution
      searchResultAt("docs/noise.txt", "file"), // pollution, in window
      searchResultAt("docs/late-noise.txt", "file"), // outside the window
    ];
    expect(countUnexpectedFilesInWindow(results, expectsOneFile, 3)).toBe(1);
  });

  it("matches a slashless prefix at a path-segment boundary only", () => {
    const expectsFolder: JudgmentQuery = {
      id: "q3",
      class: "sentinel",
      query: "deployment guide",
      expected_prefix: "docs",
    };
    const results = [searchResultAt("docs2/noise.txt", "file"), searchResultAt("docs/guide.txt", "file")];
    // "docs" must not swallow the docs2/ sibling — the expected result is
    // the rank-2 file inside docs/, and the sibling counts as pollution.
    expect(rankOfFirstExpected(results, expectsFolder)).toBe(2);
    expect(countUnexpectedFilesInWindow(results, expectsFolder, 5)).toBe(1);
  });

  it("treats a prefix-expected file as expected, not pollution", () => {
    const expectsPrefix: JudgmentQuery = {
      id: "q2",
      class: "sentinel",
      query: "deployment guide",
      expected_prefix: "docs/",
    };
    const results = [searchResultAt("docs/guide.txt", "file"), searchResultAt("assets/photo-notes.txt", "file")];
    expect(countUnexpectedFilesInWindow(results, expectsPrefix, 5)).toBe(1);
  });
});

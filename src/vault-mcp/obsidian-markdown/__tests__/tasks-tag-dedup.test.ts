import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { DateTime } from "luxon"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { tasks } from "../tasks.js"
import {
  CHILD_DEADLINE_MS,
  CHILD_TEST_TIMEOUT_MS,
  LINEAR_GROWTH_ALLOWANCE,
} from "./helpers/linear-timing.js"

/**
 * Below this many milliseconds a median is mostly scheduling noise, so it sets
 * no tighter growth bound. It is lower than the 25 ms in tasks-linear and
 * tasks-clear-linear, because a 25 ms floor would barely catch a quadratic
 * slowdown:
 * - This fixture's smallest median sits near 14 ms on a fast laptop.
 * - A 25 ms floor would set the bound at 200 ms, only about 10% under a
 *   quadratic slowdown's 224 ms, so scheduling noise could let the slowdown pass.
 * - This floor sets the bound at about half of 224 ms.
 */
const TIMING_FLOOR_MS = 10

type Deduplication = ReturnType<typeof tasks.deduplicateDescriptionTags>

/** Freezes the original per-tag search while sharing the separately verified boundary parser. */
const readLegacyDeduplication = (): ((taskLine: string) => Deduplication) => {
  const source = readFileSync(new URL("../tasks.ts", import.meta.url), "utf8")
  const syntax = ts.createSourceFile("tasks.ts", source, ts.ScriptTarget.Latest, true)
  /** Matches the export modifier on top-level declarations. */
  const exportModifier = /^export /u
  const declarations = syntax.statements
    .filter(ts.isVariableStatement)
    .map((statement) => statement.getText(syntax).replace(exportModifier, ""))
    .join("\n")
  const legacy = `(taskLine) => {
    const parts = splitTaskLine(taskLine);
    if (!parts || !parts.metadata) return {taskLine, deduplicatedTags: []};
    const descriptionTrailingTags = extractTrailingTags(parts.description);
    let metadata = parts.metadata;
    const deduplicatedTags = [];
    for (const tag of descriptionTrailingTags) {
      const pattern = new RegExp('(^|\\\\s)' + RegExp.escape(tag) + '(?=\\\\s|$)');
      if (pattern.test(metadata)) {
        metadata = metadata.replace(pattern, '').trim();
        deduplicatedTags.push(tag);
      }
    }
    if (deduplicatedTags.length === 0) return {taskLine, deduplicatedTags};
    return {taskLine: joinTaskLine({...parts, metadata}), deduplicatedTags};
  }`
  const compiled = ts.transpileModule(`${declarations}\n;(${legacy})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText
  const loaded: unknown = runInNewContext(compiled, { DateTime })

  if (typeof loaded !== "function") throw new Error("legacy tag deduplication did not load")
  return (taskLine) => loaded(taskLine)
}

describe("task description tag deduplication", () => {
  it("preserves sequential removals that expose a tag containing whitespace", () => {
    expect(tasks.deduplicateDescriptionTags("- [ ] Work #x #a\tb 📅 2026-01-01 #a\t#x\tb")).toEqual(
      {
        taskLine: "- [ ] Work #x #a\tb 📅 2026-01-01",
        deduplicatedTags: ["#x", "#a\tb"],
      },
    )
  })

  it("matches the original removal order over generated tag and whitespace variants", () => {
    const legacyDeduplication = readLegacyDeduplication()
    const tags = ["#a", "#b", "#a/b", "#a\tb", "#a\u00a0b", "#😀", "#a-b"]
    const separators = [" ", "  ", "\t", "\u00a0", " \t"]
    // The generator advances once per draw so each mismatch is reproducible.
    let state = 753
    const draw = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % bound
    }
    const tagRun = (): string => {
      return Array.from({ length: draw(40) }, () => {
        return `${tags[draw(tags.length)]}${separators[draw(separators.length)]}`
      }).join("")
    }

    for (let index = 0; index < 2000; index++) {
      const taskLine = `- [ ] Work ${tagRun()}📅 2026-01-02 ${tagRun()}🆔 abc`

      expect({ taskLine, result: tasks.deduplicateDescriptionTags(taskLine) }).toEqual({
        taskLine,
        result: legacyDeduplication(taskLine),
      })
    }
  }, 30_000)

  it(
    "bounds distinct description tags against a long metadata tail in a child process",
    () => {
      const parserUrl = new URL("../tasks.ts", import.meta.url).href
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `
        import assert from 'node:assert/strict';
        import { tasks } from ${JSON.stringify(parserUrl)};
        const sizes = [20000,40000,80000];
        const medians = [];
        for (const size of sizes) {
          const tags = Array.from({length:size},(_,index)=>'#t'+index).join(' ');
          const taskLine = '- [ ] '+tags+' 📅2026-01-02 🆔'+'x'.repeat(size);
          const check = () => assert.deepEqual(tasks.deduplicateDescriptionTags(taskLine),{taskLine,deduplicatedTags:[]});
          check();
          const samples = Array.from({length:5},()=>{const start=performance.now();check();return performance.now()-start;}).toSorted((a,b)=>a-b);
          medians.push(samples[2]);
        }
        assert.ok(medians.at(-1)<=Math.max(${TIMING_FLOOR_MS},medians[0])*(sizes.at(-1)/sizes[0])*${LINEAR_GROWTH_ALLOWANCE},'description tag searches scaled superlinearly '+medians);
        process.stdout.write(JSON.stringify({sizes,medians}));
        `,
        ],
        { encoding: "utf8", timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" },
      )

      expect(JSON.parse(output)).toEqual({
        sizes: [20000, 40000, 80000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      })
      process.stdout.write(`Distinct description tag timings ${output}\n`)
    },
    CHILD_TEST_TIMEOUT_MS,
  )
})

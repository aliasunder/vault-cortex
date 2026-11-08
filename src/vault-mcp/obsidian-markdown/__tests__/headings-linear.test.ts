import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { parseHeadings, type HeadingInfo } from "../headings.js"
import * as lineParsers from "../lines.js"
import { tasks } from "../tasks.js"

type HeadingParser = (lines: readonly string[]) => HeadingInfo[]

/** Keeps the former suffix and boundary rules as a small-input oracle. */
const readLegacyHeadings = (
  source = readFileSync(new URL("../headings.ts", import.meta.url), "utf8"),
): HeadingParser => {
  const boundaryStart = source.indexOf("  const completedHeadings =")
  const boundaryEnd = source.indexOf("\n}", boundaryStart)

  if (boundaryStart < 0 || boundaryEnd < 0)
    throw new Error("heading boundary oracle anchor missing")
  const legacyPass = `return collectedHeadings.map((heading, index) => {
    const nextSameOrHigher = collectedHeadings.slice(index + 1).find(next => next.level <= heading.level);
    return { ...heading, bodyEndLine: nextSameOrHigher?.startLine ?? Math.max(heading.bodyStartLine, trailingCommentBlockStart) };
  });`
  const legacySource = source.slice(0, boundaryStart) + legacyPass + source.slice(boundaryEnd)
  const closingSource = legacySource.replace(
    "stripClosingHashes(matchedText)",
    'matchedText.replace(/(?:^|[ \\t]+)#+[ \\t]*$/, "")',
  )

  if (closingSource === legacySource) throw new Error("closing-hash oracle anchor missing")
  const compiled = ts.transpileModule(closingSource, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText
  const result: unknown = runInNewContext(`${compiled}\n;exports.parseHeadings`, {
    exports: {},
    require: () => lineParsers,
  })

  if (typeof result !== "function") throw new Error("legacy heading parser could not be loaded")
  return (lines) => result(lines)
}

describe("heading traversal compatibility", () => {
  it("refuses to compare closing hashes when the frozen oracle substitution misses", () => {
    const source = readFileSync(new URL("../headings.ts", import.meta.url), "utf8")
    const missingAnchor = source.replace("stripClosingHashes(matchedText)", "matchedText")

    expect(missingAnchor).not.toBe(source)
    expect(() => readLegacyHeadings(missingAnchor)).toThrow(
      new Error("closing-hash oracle anchor missing"),
    )
  })

  it("preserves full heading ranges and task attribution over fixed-seed documents", () => {
    const legacy = readLegacyHeadings()
    // The generator advances one deterministic state for every choice.
    let state = 0x73a82f19
    const draw = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % bound
    }
    const choices = [
      "# A",
      "## B ##",
      "###",
      "#### C #",
      "## Equal",
      "Title",
      "===",
      "---",
      "",
      "```",
      "~~~",
      "%%",
      "%% inline %%",
      "- [ ] Work",
      "- [ ] Other 📅 2026-01-02",
      "text",
      "# x\rtext",
      "# x\u2028text",
      "# 😀",
    ]
    const count = Number(process.env.PARSER_CORPUS_CASES ?? 10_000)

    for (let index = 0; index < count; index += 1) {
      const lines = Array.from({ length: draw(24) }, () => choices[draw(choices.length)] ?? "")
      const expectedHeadings = legacy(lines)
      expect(parseHeadings(lines)).toEqual(expectedHeadings)
      const note = lines.join(index % 2 === 0 ? "\n" : "\r\n")
      const extracted = tasks.extractTasksFromBody(note)

      for (const task of extracted) {
        const expectedHeading = expectedHeadings.findLast(
          (heading) => heading.startLine < task.line - 1,
        )
        const sourceLine = lines[task.line - 1] ?? ""
        const standaloneTask = tasks.extractTasksFromBody(sourceLine)[0]

        expect(task).toEqual({
          ...standaloneTask,
          line: task.line,
          heading: expectedHeading?.text ?? null,
        })
      }
    }
  })

  it("preserves empty, nested, setext, fence and comment boundaries exactly", () => {
    const lines = [
      "- [ ] Before",
      "# A",
      "- [ ] Under A",
      "Child",
      "---",
      "- [ ] Under Child",
      "```",
      "# hidden",
      "```",
      "##",
      "- [ ] Under empty",
      "# Last ##",
      "- [ ] Last task",
      "",
      "%% settings",
      "config",
      "%%",
      "",
    ]

    expect(parseHeadings(lines)).toEqual([
      { text: "A", level: 1, startLine: 1, bodyStartLine: 2, bodyEndLine: 11 },
      { text: "Child", level: 2, startLine: 3, bodyStartLine: 5, bodyEndLine: 9 },
      { text: "", level: 2, startLine: 9, bodyStartLine: 10, bodyEndLine: 11 },
      { text: "Last", level: 1, startLine: 11, bodyStartLine: 12, bodyEndLine: 13 },
    ])
    expect(
      tasks.extractTasksFromBody(lines.join("\n")).map(({ line, heading }) => ({ line, heading })),
    ).toEqual([
      { line: 1, heading: null },
      { line: 3, heading: "A" },
      { line: 6, heading: "Child" },
      { line: 11, heading: "" },
      { line: 13, heading: "Last" },
    ])
  })

  it("bounds closing-hash and complete heading-task traversal adversaries in a child", () => {
    const headingsUrl = new URL("../headings.ts", import.meta.url).href
    const tasksUrl = new URL("../tasks.ts", import.meta.url).href
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
      import assert from 'node:assert/strict';
      import { parseHeadings } from ${JSON.stringify(headingsUrl)};
      import { tasks } from ${JSON.stringify(tasksUrl)};
      const measurements=[];
      for (const variant of ['closing','traversal']) {
        const sizes = variant === 'closing' ? [25000,50000,100000] : [16000,32000,64000];
        const medians=[];
        for (const size of sizes) {
          const input = variant === 'closing' ? '# x' + ' '.repeat(size) : '# a\\n'.repeat(size);
          const check = () => {
            const headings=parseHeadings(input.split('\\n'));
            if(variant === 'closing') assert.deepEqual(headings,[{text:'x',level:1,startLine:0,bodyStartLine:1,bodyEndLine:1}]);
            else assert.deepEqual(headings,Array.from({length:size},(_,index)=>({text:'a',level:1,startLine:index,bodyStartLine:index+1,bodyEndLine:index+1 === size ? size+1 : index+1})));
            assert.deepEqual(tasks.extractTasksFromBody(input), []);
          };
          check();
          const samples=Array.from({length:5},()=>{const start=performance.now();check();return performance.now()-start}).toSorted((a,b)=>a-b);
          medians.push(samples[2]);
        }
        assert.ok(medians.every(value=>value<1000),variant+' exceeded ceiling '+medians);
        for(let index=1;index<medians.length;index++) if(medians[index-1]>10) assert.ok(medians[index]<=medians[index-1]*3,variant+' scaled superlinearly '+medians);
        measurements.push({variant,sizes,medians});
      }
      process.stdout.write(JSON.stringify(measurements));
    `,
      ],
      { encoding: "utf8", timeout: 30_000 },
    )

    expect(
      JSON.parse(output).map((measurement: { variant: string }) => measurement.variant),
    ).toEqual(["closing", "traversal"])
    process.stdout.write(`Heading parser timings ${output}\n`)
  }, 35_000)
})

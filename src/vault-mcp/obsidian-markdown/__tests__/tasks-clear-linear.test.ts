import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  CHILD_DEADLINE_MS,
  CHILD_TEST_TIMEOUT_MS,
  LINEAR_GROWTH_ALLOWANCE,
} from "./helpers/linear-timing.js"

/** Below this many milliseconds a median is mostly scheduling noise, so it sets no tighter growth bound. */
const TIMING_FLOOR_MS = 25

type RemovalGrammar = {
  clear: (text: string, index: number) => string
  legacy: (text: string, index: number) => string
  count: number
}

const isRemovalGrammar = (value: unknown): value is RemovalGrammar => {
  return (
    typeof value === "object" &&
    value !== null &&
    "clear" in value &&
    typeof value.clear === "function" &&
    "legacy" in value &&
    typeof value.legacy === "function" &&
    "count" in value &&
    typeof value.count === "number"
  )
}

/** Matches the export modifier on a top-level constant declaration. */
const EXPORT_MODIFIER_RE = /^export /u

/** Keeps private declarations accessible without adding production test seams. */
const compileRemovalGrammar = (): string => {
  const source = readFileSync(new URL("../tasks.ts", import.meta.url), "utf8")
  const syntax = ts.createSourceFile("tasks.ts", source, ts.ScriptTarget.Latest, true)
  const program = syntax.statements
    .filter(ts.isVariableStatement)
    .map((statement) => statement.getText(syntax).replace(EXPORT_MODIFIER_RE, ""))
    .join("\n")
  return ts.transpileModule(
    `${program}
    const legacy = (metadata, regex) => {
      const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
      const matches = [...metadata.matchAll(new RegExp(regex.source, flags))];
      const last = matches.at(-1);
      if (!last) return metadata;
      const stripped = (metadata.slice(0,last.index) + metadata.slice(last.index + last[0].length)).replace(/ {2,}/g," ").trim();
      return stripped === metadata ? metadata : legacy(stripped, regex);
    };
    ({
      clear: (text,index) => removeAllMetadataMatches(text,METADATA_REMOVAL_GRAMMARS[index].regex),
      legacy: (text,index) => legacy(text,METADATA_REMOVAL_GRAMMARS[index].regex),
      count: METADATA_REMOVAL_GRAMMARS.length
    })`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  ).outputText
}

/** Freezes the original recursive removal as the compatibility oracle. */
const readRemovalGrammar = (): RemovalGrammar => {
  const grammar: unknown = runInNewContext(compileRemovalGrammar())

  if (!isRemovalGrammar(grammar)) throw new Error("private metadata removers could not be loaded")
  return grammar
}

describe("task metadata clear compatibility", () => {
  it("preserves recursive removal over generated mixed, malformed and newly exposed fields", () => {
    const grammar = readRemovalGrammar()
    const fragments = [
      "a",
      " ",
      "  ",
      "\t",
      "\n",
      "\u00a0",
      "#",
      "[",
      "(",
      "]",
      ")",
      ",",
      "️",
      "📅2026-01-02",
      "📆2026-01-02",
      "🗓2026-01-02",
      "✅2026-01-02",
      "❌2026-01-02",
      "➕2026-01-02",
      "🛫2026-01-02",
      "⏳2026-01-02",
      "⌛2026-01-02",
      "⏫",
      "🔺️",
      "🔁every day",
      "🏁keep",
      "🆔abc",
      "⛔abc , def",
      "[due::2026-01-02]",
      "(priority::high)",
      "[repeat::every day]",
      "[onCompletion::keep)",
      "[id::abc]",
      "(dependsOn::abc , def)",
    ]
    // Fixed state makes every generated failure reproducible.
    let state = 0x753c1ea
    const draw = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % bound
    }
    const generated = Array.from({ length: 6000 }, () => {
      return Array.from({ length: 1 + draw(14) }, () => fragments[draw(fragments.length)]).join("")
    })
    const exposed = [
      "\uD83D⏫\uDD3A",
      "\uD83D📅2026-01-02\uDCC52026-01-02",
      "📅20📅2026-01-0226-01-02",
      "[due::[due::2026-01-02]2026-01-02]",
      "[priority::[priority::high]high]",
      "🔁 [repeat::a] ",
      "🔁 [repeat::a]\t",
      "🆔a🆔b c",
      "⛔a,⛔b c",
      "  plain   text  ",
      "🔁   ",
      "🔁\t⏫  ",
    ]

    for (let index = 0; index < grammar.count; index += 1) {
      for (const text of [...exposed, ...generated]) {
        expect({ text, index, result: grammar.clear(text, index) }).toEqual({
          text,
          index,
          result: grammar.legacy(text, index),
        })
      }
    }
  }, 20_000)

  it(
    "clears twenty to eighty thousand priority fields within a child deadline",
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
      import { tasks, DEFAULT_STATUS_REGISTRY } from ${JSON.stringify(parserUrl)};
      const config={taskFormat:'emoji',setDoneDate:true,setCancelledDate:true,setCreatedDate:false,recurrenceOnNextLine:false,removeScheduledDateOnRecurrence:false,statusRegistry:DEFAULT_STATUS_REGISTRY};
      const sizes=[20000,40000,80000];
      const medians=[];
      for (const size of sizes) {
        const taskLine='- [ ] ⏫ #'+ '⏫'.repeat(size);
        const check=()=>assert.equal(tasks.updateTaskLinePriority({taskLine,newPriority:null,config}),'- [ ] #');
        check();
        const samples=Array.from({length:5},()=>{const start=performance.now();check();return performance.now()-start;}).toSorted((a,b)=>a-b);
        medians.push(samples[2]);
      }
      assert.ok(medians.at(-1)<=Math.max(${TIMING_FLOOR_MS},medians[0])*(sizes.at(-1)/sizes[0])*${LINEAR_GROWTH_ALLOWANCE},'metadata clear scaled superlinearly '+medians);
      process.stdout.write(JSON.stringify({sizes,medians}));
    `,
        ],
        { encoding: "utf8", timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" },
      )

      expect(JSON.parse(output)).toEqual({
        sizes: [20000, 40000, 80000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      })
      process.stdout.write(`Metadata clear timings ${output}\n`)
    },
    CHILD_TEST_TIMEOUT_MS,
  )

  it(
    "bounds every field grammar and newly exposed nested fields at increasing sizes",
    () => {
      const compiled = compileRemovalGrammar()
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
      import assert from 'node:assert/strict';
      import { runInThisContext } from 'node:vm';
      const grammar=runInThisContext(${JSON.stringify(compiled)});
      const fields=[
        ['✅2026-01-02','[completion::2026-01-02]'],
        ['❌2026-01-02','[cancelled::2026-01-02]'],
        ['📅2026-01-02','[due::2026-01-02]'],
        ['⏳2026-01-02','[scheduled::2026-01-02]'],
        ['🛫2026-01-02','[start::2026-01-02]'],
        ['➕2026-01-02','[created::2026-01-02]'],
        ['⏫','[priority::high]'],
        ['🆔abc','[id::abc]'],
        ['⛔abc,def','[dependsOn::abc,def]'],
        ['🔁every day','[repeat::every day]'],
        ['🏁keep','[onCompletion::keep]']
      ];
      assert.equal(fields.length,grammar.count);
      const sizes=[10000,20000,40000];
      const timings=[];
      const checkFixture=(name,index,makeText)=>{
        const medians=[];
        for(const size of sizes) {
          const text=makeText(size);
          const check=()=>assert.equal(grammar.clear(text,index),'#',name+' output');
          check();
          const samples=Array.from({length:5},()=>{const start=performance.now();check();return performance.now()-start;}).toSorted((a,b)=>a-b);
          medians.push(samples[2]);
        }
        assert.ok(medians.at(-1)<=Math.max(${TIMING_FLOOR_MS},medians[0])*(sizes.at(-1)/sizes[0])*${LINEAR_GROWTH_ALLOWANCE},name+' scaled superlinearly '+medians);
        timings.push({name,medians});
      };
      fields.forEach((formats,index)=>formats.forEach((field,format)=>checkFixture(index+'-'+format,index,size=>'#'+field.repeat(size))));
      checkFixture('nested-emoji-date',2,size=>'#'+'📅20'.repeat(size)+'📅2026-01-02'+'26-01-02'.repeat(size));
      checkFixture('nested-dataview-date',2,size=>'#'+'[due::'.repeat(size)+'2026-01-02'+']2026-01-02'.repeat(size-1)+']');
      process.stdout.write(JSON.stringify({sizes,timings}));
    `,
        ],
        { encoding: "utf8", timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" },
      )

      const result: unknown = JSON.parse(output)

      // The child times each of the eleven fields in emoji format (suffix 0) and Dataview format
      // (suffix 1), then the two nested fixtures.
      const fixtureNames = [
        ...Array.from({ length: 11 }, (_, fieldIndex) => [
          `${fieldIndex}-0`,
          `${fieldIndex}-1`,
        ]).flat(),
        "nested-emoji-date",
        "nested-dataview-date",
      ]

      expect(result).toEqual({
        sizes: [10000, 20000, 40000],
        timings: fixtureNames.map((name) => ({
          name,
          medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
        })),
      })
      process.stdout.write(`All metadata grammar timings ${output}\n`)
    },
    CHILD_TEST_TIMEOUT_MS,
  )

  it(
    "clears duplicate completion stamps through status mutations within a child deadline",
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
      import { tasks, DEFAULT_STATUS_REGISTRY } from ${JSON.stringify(parserUrl)};
      const config={taskFormat:'emoji',setDoneDate:true,setCancelledDate:true,setCreatedDate:false,recurrenceOnNextLine:false,removeScheduledDateOnRecurrence:false,statusRegistry:DEFAULT_STATUS_REGISTRY};
      const sizes=[20000,40000,80000];
      const medians=[];
      for(const size of sizes) {
        const taskLine='- [x] ✅2026-01-02 ❌2026-01-03 #'+ '✅2026-01-02❌2026-01-03'.repeat(size);
        const check=()=>assert.equal(tasks.updateTaskLineStatus({taskLine,newStatus:'todo',today:'2026-01-04',config}),'- [ ] #');
        check();
        const samples=Array.from({length:5},()=>{const start=performance.now();check();return performance.now()-start;}).toSorted((a,b)=>a-b);
        medians.push(samples[2]);
      }
      assert.ok(medians.at(-1)<=Math.max(${TIMING_FLOOR_MS},medians[0])*(sizes.at(-1)/sizes[0])*${LINEAR_GROWTH_ALLOWANCE},'status stamp clear scaled superlinearly '+medians);
      process.stdout.write(JSON.stringify({sizes,medians}));
    `,
        ],
        { encoding: "utf8", timeout: CHILD_DEADLINE_MS, killSignal: "SIGKILL" },
      )

      expect(JSON.parse(output)).toEqual({
        sizes: [20000, 40000, 80000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      })
    },
    CHILD_TEST_TIMEOUT_MS,
  )
})

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { tasks } from "../tasks.js"

type Matcher = { exec: (input: string) => RegExpExecArray | null }
type Grammar = {
  taskLine: Matcher
  dataview: (inner: string) => Matcher
  emoji: Matcher
  repeat: Matcher
}

const isGrammar = (value: unknown): value is Grammar => {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskLine" in value &&
    "dataview" in value &&
    typeof value.dataview === "function" &&
    "emoji" in value &&
    "repeat" in value
  )
}

/** Loads the private recognizers without adding test-only production exports. */
const readGrammar = (): Grammar => {
  const source = readFileSync(new URL("../tasks.ts", import.meta.url), "utf8")
  const syntax = ts.createSourceFile("tasks.ts", source, ts.ScriptTarget.Latest, true)
  const names = new Set([
    "TASK_LINE_RE",
    "dataviewField",
    "EMOJI_RECURRENCE_RE",
    "DATAVIEW_RECURRENCE_RE",
  ])
  const declarations = syntax.statements.filter((statement) => {
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((declaration) =>
        names.has(declaration.name.getText(syntax)),
      )
    )
  })
  const program = declarations.map((statement) => statement.getText(syntax)).join("\n")
  const compiled = ts.transpileModule(
    `${program}\n;({ taskLine: TASK_LINE_RE, dataview: dataviewField, emoji: EMOJI_RECURRENCE_RE, repeat: DATAVIEW_RECURRENCE_RE })`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  ).outputText
  const grammar: unknown = runInNewContext(compiled)

  if (!isGrammar(grammar)) throw new Error("private task grammar could not be loaded")
  return grammar
}

/** Freezes the suffix grammar used before the delimiter scan. */
const legacyDataview = (inner: string): RegExp =>
  new RegExp(`(?:(?=[^\\]]+\\])\\[|(?=[^)]+\\))\\() *${inner} *[)\\]](?: *,)?$`)

const consumedMatch = (match: RegExpExecArray | null): unknown => {
  if (!match) return null
  return { index: match.index, text: match[0], value: (match[1] ?? match[2])?.trim() }
}

describe("task recognizer compatibility", () => {
  it("preserves spans and consumed captures over fixed-seed field variants", () => {
    const grammar = readGrammar()
    /** The generator's state advances once per draw, making failures reproducible. */
    let state = 0x739afb02
    const draw = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % bound
    }
    const variants = [
      { inner: "completion:: *(\\d{4}-\\d{2}-\\d{2})", value: "2026-01-02" },
      { inner: "cancelled:: *(\\d{4}-\\d{2}-\\d{2})", value: "2026-01-02" },
      { inner: "due:: *(\\d{4}-\\d{2}-\\d{2})", value: "2026-01-02" },
      { inner: "scheduled:: *(\\d{4}-\\d{2}-\\d{2})", value: "2026-01-02" },
      { inner: "start:: *(\\d{4}-\\d{2}-\\d{2})", value: "2026-01-02" },
      { inner: "created:: *(\\d{4}-\\d{2}-\\d{2})", value: "2026-01-02" },
      { inner: "priority:: *(highest|high|medium|low|lowest)", value: "highest" },
      { inner: "repeat:: *([a-zA-Z0-9, !]+)", value: "every week !" },
      { inner: "onCompletion:: *([a-zA-Z]+)", value: "delete" },
      { inner: "id:: *([a-zA-Z0-9_-]+)", value: "task_01" },
      {
        inner: "dependsOn:: *([a-zA-Z0-9_-]+(?:(?: *, *[a-zA-Z0-9_-]+)+ *)?)",
        value: "a , b  , c ",
      },
    ]
    const alphabet = [
      "[",
      "(",
      "]",
      ")",
      " ",
      "!",
      "a",
      ":",
      "0",
      ",",
      "\n",
      "\r",
      "\u2028",
      "\u2029",
      "😀",
      "\\",
      "\t",
    ]
    const count = Number(process.env.PARSER_CORPUS_CASES ?? 10_000)

    for (const variant of variants) {
      const oldPattern = legacyDataview(variant.inner)
      const matcher = variant.inner.startsWith("repeat::")
        ? grammar.repeat
        : grammar.dataview(variant.inner)
      const key = variant.inner.slice(0, variant.inner.indexOf("::") + 2)

      for (let index = 0; index < count; index += 1) {
        const payload = Array.from(
          { length: draw(70) },
          () => alphabet[draw(alphabet.length)],
        ).join("")
        const open = index % 2 === 0 ? "[" : "("
        const close = open === "[" ? "]" : ")"
        const value = index % 3 === 0 ? variant.value : payload
        const input =
          index % 5 === 0
            ? payload
            : `${payload}${open} ${key}${" ".repeat(draw(4))}${value}${close}${index % 4 === 0 ? " ," : ""}`

        expect({ input, match: consumedMatch(matcher.exec(input)) }).toEqual({
          input,
          match: consumedMatch(oldPattern.exec(input)),
        })
      }
    }
    /** Matches the emoji recurrence suffix, with the whitespace outside its value capture. */
    const oldEmoji = /🔁\uFE0F? *([a-zA-Z0-9, !]+)$/

    for (let index = 0; index < count; index += 1) {
      const payload = Array.from({ length: draw(90) }, () => alphabet[draw(alphabet.length)]).join(
        "",
      )
      const input = `text 🔁${index % 2 === 0 ? "\uFE0F" : ""}${" ".repeat(draw(8))}${index % 3 === 0 ? "every week" : payload}`
      expect(consumedMatch(grammar.emoji.exec(input))).toEqual(consumedMatch(oldEmoji.exec(input)))
    }
  })

  it("preserves the body capture after removing only its leading ASCII spaces", () => {
    const grammar = readGrammar()
    /** Matches the complete task line and consumes ASCII spaces before capturing its body. */
    const legacy = /^[\s>]*(?:[-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u
    const bodies = [
      "",
      "   ",
      "   text",
      "\ttext",
      " text",
      "😀",
      "x\rtext",
      "x\u2028text",
      "x\u2029text",
      "text\n",
      "text\r\n",
    ]

    for (const prefix of ["- [ ]", "  > 1) [x]", "+ [/]", "* [😀]"]) {
      for (const body of bodies) {
        const input = prefix + body
        const oldMatch = legacy.exec(input)
        const match = grammar.taskLine.exec(input)
        const actual = match && {
          text: match[0],
          status: match[1],
          body: match[2]?.replace(/^ +/, ""),
        }
        const expected = oldMatch && { text: oldMatch[0], status: oldMatch[1], body: oldMatch[2] }
        expect(actual).toEqual(expected)
      }
    }
  })

  it("keeps fields left of recurrence and reads both Dataview captures", () => {
    for (const recurrence of [
      "🔁   every week",
      "[repeat::   every week ]",
      "(repeat::   every week )",
    ]) {
      const input = `- [ ]   Work 📅 2026-01-02 ${recurrence} ^work`
      expect(tasks.describeTaskLine(input)).toBe("Work")
      expect(
        tasks.extractTasks(input).map(({ description, recurrence, dueDate, blockId }) => ({
          description,
          recurrence,
          dueDate,
          blockId,
        })),
      ).toEqual([
        { description: "Work", recurrence: "every week", dueDate: "2026-01-02", blockId: "work" },
      ])
      expect(
        tasks.diffTaskRoundTrip({ taskLine: input, priorTaskLine: input, submitted: {} }),
      ).toEqual([])
    }
  })

  it("bounds task, recurrence and Dataview adversaries in a child process", () => {
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
      const fixtures = [
        { name: 'task-u2028', sizes: [10000,20000,40000], input: n => '- [ ]' + ' '.repeat(n) + '\\u2028x', rejected: true },
        { name: 'task-u2029', sizes: [10000,20000,40000], input: n => '- [ ]' + ' '.repeat(n) + '\\u2029x', rejected: true },
        { name: 'emoji-recurrence', sizes: [20000,40000,80000], input: n => '- [ ] x 🔁' + ' '.repeat(n) + '?', rejected: false },
        { name: 'dataview-recurrence', sizes: [1000,2000,4000], input: n => '- [ ] x [repeat::' + ' '.repeat(n) + '?]', rejected: false },
        { name: 'dataview-lookahead', sizes: [25000,50000,100000], input: n => '- [ ] ' + '('.repeat(n), rejected: false }
      ];
      const measurements = [];
      for (const fixture of fixtures) {
        const medians = [];
        for (const size of fixture.sizes) {
          const input = fixture.input(size);
          const check = () => {
            const result = tasks.extractTasks(input);
            assert.deepEqual(result.map(task => task.description), fixture.rejected ? [] : [input.slice(6)]);
            assert.equal(tasks.describeTaskLine(input), fixture.rejected ? input : input.slice(6));
            assert.deepEqual(tasks.diffTaskRoundTrip({taskLine:input, priorTaskLine:input, submitted:{}}), []);
          };
          check();
          const samples = Array.from({length:5}, () => { const start=performance.now(); check(); return performance.now()-start; }).sort((a,b)=>a-b);
          medians.push(samples[2]);
        }
        assert.ok(medians.every(value => value < 250), fixture.name + ' exceeded 250ms ' + medians);
        for(let index=1;index<medians.length;index++) if(medians[index-1]>10) assert.ok(medians[index] <= medians[index-1]*3, fixture.name + ' scaled superlinearly ' + medians);
        measurements.push({name:fixture.name,sizes:fixture.sizes,medians});
      }
      process.stdout.write(JSON.stringify(measurements));
    `,
      ],
      { encoding: "utf8", timeout: 30_000 },
    )
    const measurements: unknown = JSON.parse(output)

    expect(Array.isArray(measurements)).toBe(true)
    process.stdout.write(`Task parser timings ${output}\n`)
  }, 35_000)
})

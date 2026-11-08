import { execFileSync } from "node:child_process"
import { globSync, readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { DateTime } from "luxon"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { tasks } from "../tasks.js"
import { createScannerDocuments } from "./link-scanner-corpus.js"

type Matcher = { exec: (input: string) => RegExpExecArray | null }
type Grammar = {
  taskLine: Matcher
  dataview: (params: { key: string; valuePattern: string }) => Matcher
  emoji: Matcher
  repeat: Matcher
  dependencies: Matcher
  metadataStart: (body: string) => number
  legacyMetadataStart: (body: string) => number
  withoutBlockLink: (body: string) => string
  trailingTags: (text: string) => readonly string[]
  legacyTrailingTags: (text: string) => readonly string[]
}

const isGrammar = (value: unknown): value is Grammar => {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskLine" in value &&
    "dataview" in value &&
    typeof value.dataview === "function" &&
    "emoji" in value &&
    "repeat" in value &&
    "dependencies" in value &&
    "metadataStart" in value &&
    typeof value.metadataStart === "function" &&
    "legacyMetadataStart" in value &&
    typeof value.legacyMetadataStart === "function" &&
    "withoutBlockLink" in value &&
    typeof value.withoutBlockLink === "function" &&
    "trailingTags" in value &&
    typeof value.trailingTags === "function" &&
    "legacyTrailingTags" in value &&
    typeof value.legacyTrailingTags === "function"
  )
}

/** Loads the private recognizers without adding test-only production exports. */
const readGrammar = (): Grammar => {
  const source = readFileSync(new URL("../tasks.ts", import.meta.url), "utf8")
  const syntax = ts.createSourceFile("tasks.ts", source, ts.ScriptTarget.Latest, true)
  const declarations = syntax.statements.filter(ts.isVariableStatement)
  /** Matches the export modifier on a top-level constant declaration. */
  const exportModifier = /^export /u
  const program = declarations
    .map((statement) => statement.getText(syntax).replace(exportModifier, ""))
    .join("\n")
  const compiled = ts.transpileModule(
    `${program}\n;({
      taskLine: TASK_LINE_RE,
      dataview: dataviewField,
      emoji: EMOJI_RECURRENCE_RE,
      repeat: DATAVIEW_RECURRENCE_RE,
      dependencies: DATAVIEW_DEPENDS_ON_RE,
      metadataStart: findMetadataStart,
      withoutBlockLink: (body) => splitTrailingBlockLink(body).body,
      trailingTags: extractTrailingTags,
      legacyTrailingTags: (text) => {
        const tags = [];
        let remaining = text;
        let match = HASHTAG_FROM_END_RE.exec(remaining);
        while (match) {
          tags.unshift(match[0].trim());
          remaining = remaining.slice(0,match.index).trim();
          match = HASHTAG_FROM_END_RE.exec(remaining);
        }
        return tags;
      },
      // Freeze the unbounded search while sharing the unchanged metadata parser.
      legacyMetadataStart: (taskBody) => {
        for (const candidate of taskBody.matchAll(new RegExp(FIRST_METADATA_SIGNIFIER_RE.source, "gu"))) {
          const tail = parseTaskMetadata(taskBody.slice(candidate.index));
          const tailDescription = tail.description.replace(HASHTAG_RE, "").trim();
          if (tailDescription === "") return candidate.index;
        }
        return -1;
      }
    })`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  ).outputText
  const grammar: unknown = runInNewContext(compiled, { DateTime })

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
  it("preserves trailing tags over fixed-seed punctuation and whitespace variants", () => {
    const grammar = readGrammar()
    const alphabet = [
      "#",
      "a",
      "b",
      " ",
      "\t",
      "\r",
      "\n",
      "\u2028",
      "\u2029",
      "\u00a0",
      "[",
      "]",
      "(",
      ")",
      "!",
      "_",
      "/",
      ":",
      ".",
      "😀",
    ]
    const documents = createScannerDocuments(alphabet, 10_000)
    const boundaryCases = [
      "#a\t#b",
      "#a\n#b",
      "#a ",
      "#a\t",
      "#a\tcontent",
      "before #a\t#b",
      "##a",
      "#a ! #b",
      "#a #a",
      "#😀/nested",
    ]

    for (const text of [...boundaryCases, ...documents]) {
      expect({ text, tags: grammar.trailingTags(text) }).toEqual({
        text,
        tags: grammar.legacyTrailingTags(text),
      })
    }
    expect(grammar.trailingTags("#a\t#b #a")).toEqual(["#a", "#b", "#a"])
  })

  it("bounds deduplication with tens of thousands of trailing description tags", () => {
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
      const sizes=[20000,40000];
      const medians=[];
      for (const size of sizes) {
        const taskLine='- [ ] '+'#a '.repeat(size)+'📅 2026-01-02';
        const check=()=>assert.deepEqual(tasks.deduplicateDescriptionTags(taskLine),{taskLine,deduplicatedTags:[]});
        check();
        const samples=Array.from({length:3},()=>{const start=performance.now();check();return performance.now()-start;}).toSorted((a,b)=>a-b);
        medians.push(samples[1]);
      }
      assert.ok(medians.every(value=>value<500),'trailing tag deduplication exceeded ceiling '+medians);
      if(medians[0]>10) assert.ok(medians[1]<medians[0]*3,'trailing tag deduplication scaled superlinearly '+medians);
      process.stdout.write(JSON.stringify({sizes,medians}));
    `,
      ],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    )

    expect(JSON.parse(output)).toEqual({
      sizes: [20000, 40000],
      medians: [expect.any(Number), expect.any(Number)],
    })
    process.stdout.write(`Trailing tag deduplication timings ${output}\n`)
  }, 15_000)

  it("preserves metadata boundaries over fixed-seed bodies and every literal task fixture", () => {
    const grammar = readGrammar()
    // The generator advances once per draw so a failure has a reproducible body.
    let state = 0x7535eed
    const draw = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state % bound
    }
    const fragments = [
      "Work",
      "Prefer ⏫ arrows in prose",
      "📅 tomorrow",
      "#tag",
      "#⏫⏫",
      "#📅📅📅",
      "#🆔a",
      "#⛔a",
      "#📅2026-01-02",
      "#⏫\t🆔abc",
      "#x[priority::high]",
      "[ priority:: high]",
      "⏫",
      "🔺️",
      "🔁 every week",
      "🏁 keep",
      "🆔 abc",
      "⛔ a,b",
      "➕2026-01-02",
      "🛫2026-01-02",
      "⏳2026-01-02",
      "📅2026-01-02",
      "✅2026-01-02",
      "❌2026-99-99",
      "[priority:: high]",
      "(repeat:: every day)",
      "[onCompletion:: delete]",
      "[id:: abc]",
      "(dependsOn:: a,b)",
      "[created:: 2026-01-02]",
      "(start:: 2026-01-02)",
      "[scheduled:: 2026-01-02]",
      "[due:: 2026-01-02]",
      "[completion:: 2026-01-02]",
      "(cancelled:: 2026-01-02)",
      "[due:: bad)",
      "⏫".repeat(40),
    ]
    const randomBodies = Array.from({ length: 1000 }, () => {
      const pieces = Array.from({ length: 1 + draw(16) }, () => fragments[draw(fragments.length)])
      return pieces.join(draw(2) === 0 ? " " : "")
    })
    const adjacentDataviewBodies = [
      "work #tag[id:: a]",
      "work #tag(id:: a)",
      "work #tag[due:: 2026-01-02]",
      "work #tag(due:: 2026-01-02)",
      "work #tag[priority:: high]",
      "work #tag(priority:: high)",
    ]
    const denseBodies = [20, 21, 22, 482, 483, 484, 600].flatMap((size) => [
      "⏫".repeat(size),
      `⏫ #${"⏫".repeat(size)}`,
      `#${"⏫".repeat(size)}`,
      `⏫ #${"⏫".repeat(size)} [due:: 2026-01-02]`,
      `🆔abc ${"#⏫ ".repeat(size)}`,
    ])
    const packedHashtagBodies = [1, 2, 20, 21, 22].flatMap((size) => [
      Array.from({ length: size }, () => `#${"📅".repeat(size)}`).join(" "),
      Array.from({ length: size }, () => `#${"⏫".repeat(size)}`).join(" "),
      `⏫ ${"#📅 ".repeat(size)}`,
      `#📅2026-01-02 ${"(repeat:: every day) ".repeat(size)}[id:: abc]`,
      `#⏫\t🆔abc ${"[ priority:: high] ".repeat(size)}`,
    ])
    // Reverse extraction order permits every matcher to consume a field in each pass.
    const fullPass = [
      "[dependsOn:: a]",
      "⛔ a",
      "[id:: a]",
      "🆔 a",
      "#tag",
      "[onCompletion:: keep]",
      "🏁 keep",
      "[repeat:: daily]",
      "🔁 daily",
      "[created:: 2026-01-02]",
      "➕2026-01-02",
      "[start:: 2026-01-02]",
      "🛫2026-01-02",
      "[scheduled:: 2026-01-02]",
      "⏳2026-01-02",
      "[due:: 2026-01-02]",
      "📅2026-01-02",
      "[cancelled:: 2026-01-02]",
      "❌2026-01-02",
      "[completion:: 2026-01-02]",
      "✅2026-01-02",
      "[priority:: high]",
      "⏫",
    ].join(" ")
    const fullTail = Array.from({ length: 21 }, () => fullPass).join(" ")

    expect(grammar.legacyMetadataStart(fullTail)).toBe(0)
    expect(grammar.metadataStart(fullTail)).toBe(0)
    // AST traversal accumulates fixtures from all task-related parser and mutation tests.
    const fixtureBodies: string[] = []
    const fixtureFolders = [
      new URL("./", import.meta.url),
      new URL("../../vault-operations/__tests__/", import.meta.url),
    ]
    const fixtureUrls = fixtureFolders.flatMap((folder) => {
      return globSync("*task*.test.ts", { cwd: folder }).map(
        (filename) => new URL(filename, folder),
      )
    })

    for (const fixtureUrl of fixtureUrls) {
      const source = readFileSync(fixtureUrl, "utf8")
      const syntax = ts.createSourceFile(fixtureUrl.pathname, source, ts.ScriptTarget.Latest, true)
      const collectTaskLines = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) {
          for (const line of node.text.split("\n")) {
            const body = grammar.taskLine.exec(line)?.[2]

            if (body !== undefined) fixtureBodies.push(grammar.withoutBlockLink(body))
          }
        }
        ts.forEachChild(node, collectTaskLines)
      }
      collectTaskLines(syntax)
    }

    expect(fixtureBodies.length).toBeGreaterThan(300)
    const bodies = [
      ...randomBodies,
      ...denseBodies,
      ...packedHashtagBodies,
      ...adjacentDataviewBodies,
      fullTail,
      ...fixtureBodies,
    ]

    for (const body of bodies) {
      expect({ body, boundary: grammar.metadataStart(body) }).toEqual({
        body,
        boundary: grammar.legacyMetadataStart(body),
      })
    }
    process.stdout.write(
      `Metadata boundary corpus ${JSON.stringify({ random: randomBodies.length, dense: denseBodies.length, fixtures: fixtureBodies.length })}\n`,
    )
  }, 30_000)

  it("keeps a valid boundary before an invalid signifier inside a later hashtag", () => {
    const grammar = readGrammar()

    expect(grammar.metadataStart("⏫ #📅")).toBe(0)
    expect(grammar.metadataStart("📅")).toBe(-1)
    expect(grammar.metadataStart("#📅2026-01-02 (repeat:: every day)")).toBe(1)
  })

  it("bounds task edits whose hashtags each pack hundreds of signifiers", () => {
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
        const config = {taskFormat:'emoji',setDoneDate:true,setCancelledDate:true};
        const sizes = [120,240,480];
        const medians = [];
        for (const size of sizes) {
          const taskLine = '- [ ] ' + Array.from({length:size},()=> '#'+ '📅'.repeat(size+2)).join(' ');
          const check = () => {
            assert.equal(tasks.updateTaskLineTaskId({taskLine,taskId:'probe',config}),taskLine+' 🆔 probe');
            assert.deepEqual(tasks.diffTaskRoundTrip({taskLine,priorTaskLine:taskLine,submitted:{}}),[]);
          };
          check();
          const samples = Array.from({length:3},()=>{const start=performance.now();check();return performance.now()-start;}).toSorted((a,b)=>a-b);
          medians.push(samples[1]);
        }
        assert.ok(medians.every(value=>value<1000),'packed hashtag edits exceeded ceiling '+medians);
        process.stdout.write(JSON.stringify({sizes,medians}));
        `,
      ],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    )

    expect(JSON.parse(output)).toEqual({
      sizes: [120, 240, 480],
      medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
    })
    process.stdout.write(`Packed hashtag edit timings ${output}\n`)
  }, 15_000)

  it("bounds signifier-dense task edits and their growth in a child process", () => {
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
        const config = {taskFormat:'emoji',setDoneDate:true,setCancelledDate:true};
        const sizes = [1000,2000,4000,5000];
        const medians = [];
        for (const size of sizes) {
          const taskLine = '- [ ] ' + '⏫'.repeat(size);
          const expected = '- [ ] ' + '⏫'.repeat(size-21) + ' ' + '⏫'.repeat(21) + ' 🆔 probe';
          const check = () => {
            assert.equal(tasks.updateTaskLineTaskId({taskLine,taskId:'probe',config}), expected);
            assert.deepEqual(tasks.diffTaskRoundTrip({taskLine,priorTaskLine:taskLine,submitted:{}}), []);
          };
          check();
          const samples = Array.from({length:5}, () => {const start=performance.now();check();return performance.now()-start;}).toSorted((first,second)=>first-second);
          medians.push(samples[2]);
        }
        assert.ok(medians.every(value => value < 250), 'dense edits exceeded 250ms ' + medians);
        for (let index=1;index<medians.length;index++) {
          const linearGrowth = sizes[index]/sizes[index-1];
          assert.ok(medians[index] <= Math.max(10,medians[index-1])*linearGrowth*1.5, 'dense edits scaled superlinearly ' + medians);
        }
        process.stdout.write(JSON.stringify({sizes,medians}));
      `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
    const measurements: unknown = JSON.parse(output)

    expect(measurements).toEqual({
      sizes: [1000, 2000, 4000, 5000],
      medians: [expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)],
    })
    process.stdout.write(`Task metadata edit timings ${output}\n`)
  }, 15_000)

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
      const keyEnd = variant.inner.indexOf("::")
      const key = variant.inner.slice(0, keyEnd + 2)
      const fieldGrammar = {
        key: variant.inner.slice(0, keyEnd),
        valuePattern: variant.inner.slice(keyEnd + ":: *".length),
      }
      const matcher = variant.inner.startsWith("repeat::")
        ? grammar.repeat
        : grammar.dataview(fieldGrammar)

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

  it("compares real Dataview dependency fields with the frozen suffix grammar", () => {
    const grammar = readGrammar()
    const legacy = legacyDataview("dependsOn:: *([a-zA-Z0-9_-]+( *, *[a-zA-Z0-9_-]+ *)*)")
    const values = ["a", "a,b", "a , b  , c ", "db-setup, cache_setup", "", "a!", "a,,b"]

    for (const value of values) {
      for (const delimiters of [
        { open: "[", close: "]" },
        { open: "(", close: ")" },
      ]) {
        for (const suffix of ["", ",", " ,", ", ", ",]", ")"]) {
          const input = `- [ ] x ${delimiters.open}dependsOn:: ${value}${delimiters.close}${suffix}`

          expect({ input, match: consumedMatch(grammar.dependencies.exec(input)) }).toEqual({
            input,
            match: consumedMatch(legacy.exec(input)),
          })
        }
      }
    }
    expect(consumedMatch(grammar.dependencies.exec("- [ ] x (dependsOn:: a),"))).toEqual({
      index: 8,
      text: "(dependsOn:: a),",
      value: "a",
    })
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

    expect(measurements).toEqual([
      {
        name: "task-u2028",
        sizes: [10_000, 20_000, 40_000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      },
      {
        name: "task-u2029",
        sizes: [10_000, 20_000, 40_000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      },
      {
        name: "emoji-recurrence",
        sizes: [20_000, 40_000, 80_000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      },
      {
        name: "dataview-recurrence",
        sizes: [1_000, 2_000, 4_000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      },
      {
        name: "dataview-lookahead",
        sizes: [25_000, 50_000, 100_000],
        medians: [expect.any(Number), expect.any(Number), expect.any(Number)],
      },
    ])
    process.stdout.write(`Task parser timings ${output}\n`)
  }, 35_000)
})

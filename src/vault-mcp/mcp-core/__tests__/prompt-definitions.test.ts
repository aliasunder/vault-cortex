import { describe, it, expect, vi, onTestFinished, afterEach } from "vitest"
import { DateTime } from "luxon"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { registerPrompts, PROMPT_NAMES } from "../prompt-definitions.js"
import { loadConfig } from "../../config.js"
import {
  createSearchIndex,
  type SearchIndex,
} from "../../search/search-index.js"
import { getCompleter } from "@modelcontextprotocol/sdk/server/completable.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { logger, type Logger } from "../../../logger.js"

const ALL_PROMPT_NAMES = Object.values(PROMPT_NAMES)

// A captured registerPrompt(name, config, handler) call. The handler arity
// varies: vault-orientation is (extra) =>, the others are (args, extra) =>.
// Both params are optional so a single capture type covers both shapes.
type PromptConfig = {
  title?: string
  description?: string
  argsSchema?: Record<string, unknown>
}
type PromptResult = {
  messages: Array<{ role: string; content: { type: string; text: string } }>
}
type PromptExtra = { requestId?: string }
type PromptHandler = (
  argsOrExtra?: Record<string, unknown> | PromptExtra,
  extra?: PromptExtra,
) => Promise<PromptResult>
type RegisterPromptCall = [
  name: string,
  config: PromptConfig,
  handler: PromptHandler,
]

const fakeExtra: PromptExtra = { requestId: "1" }

// A logger that records every call into a sink, merging child props the way the
// real logger does — so tests can assert on emitted events and their level.
type LogCall = {
  level: "debug" | "info" | "warn" | "error"
  message: string
  data: Record<string, unknown>
}
const recordingLogger = (sink: LogCall[]): Logger => {
  const make = (props: Record<string, unknown>): Logger => ({
    debug: (message, data = {}) =>
      sink.push({ level: "debug", message, data: { ...props, ...data } }),
    info: (message, data = {}) =>
      sink.push({ level: "info", message, data: { ...props, ...data } }),
    warn: (message, data = {}) =>
      sink.push({ level: "warn", message, data: { ...props, ...data } }),
    error: (message, data = {}) =>
      sink.push({ level: "error", message, data: { ...props, ...data } }),
    child: (childProps) => make({ ...props, ...childProps }),
  })
  return make({})
}

// ── Fixtures ─────────────────────────────────────────────────────

// Indexed notes in distinct folders so folder derivation, tags, property
// keys, and recent-notes all have something to surface.
const FIXTURE_NOTES: ReadonlyArray<{
  path: string
  content: string
  mtime: number
}> = [
  {
    path: "Projects/alpha.md",
    content: `---\ntitle: Alpha\ntype: project\ntags:\n  - project\nstatus: active\n---\n# Alpha\n\nProject alpha notes.\n`,
    mtime: 3000,
  },
  {
    path: "Reference/bravo.md",
    content: `---\ntitle: Bravo\ntype: reference\ntags:\n  - reference\n---\n# Bravo\n\nReference bravo notes.\n`,
    mtime: 2000,
  },
]

const PRINCIPLES_MD = `---\ntitle: Principles\ntype: profile\ntags:\n  - memory\n  - principles\n---\n\n# Principles\n\n## Decision heuristics (newest first)\n- **2026-05-06**: Secrets invisible at every layer\n- **2026-04-22**: Earlier heuristic worth keeping\n`

const OPINIONS_MD = `---\ntitle: Opinions\ntype: profile\ntags:\n  - memory\n  - opinions\n---\n\n# Opinions\n\n## Tools and workflows (newest first)\n- **2026-05-07**: Research current docs before configuring\n`

// ── Harnesses ────────────────────────────────────────────────────

/** Registers the prompts against a stub server, capturing the calls.
 *  No vault or index access happens at registration time, so dummies suffice. */
const captureRegistration = (config = loadConfig({})): RegisterPromptCall[] => {
  const calls: RegisterPromptCall[] = []
  const server = {
    registerPrompt: vi.fn((...args: unknown[]) =>
      calls.push(args as RegisterPromptCall),
    ),
  }
  registerPrompts({
    server: server as unknown as McpServer,
    vaultPath: "/test-vault",
    search: {} as SearchIndex,
    logger,
    config,
  })
  return calls
}

/** Builds a temp vault with fixture notes + memory files, a real in-memory
 *  search index populated from the same notes, and the captured prompt calls. */
const setupVault = async (
  options: {
    config?: ReturnType<typeof loadConfig>
    indexNotes?: boolean
    memoryFiles?: boolean
    logger?: Logger
  } = {},
): Promise<{
  vault: string
  search: SearchIndex
  calls: RegisterPromptCall[]
}> => {
  const config = options.config ?? loadConfig({})
  const indexNotes = options.indexNotes ?? true
  const memoryFiles = options.memoryFiles ?? true
  const log = options.logger ?? logger

  const vault = await mkdtemp(join(tmpdir(), "prompt-test-"))
  onTestFinished(async () => {
    await rm(vault, { recursive: true, force: true })
  })

  const search = createSearchIndex(":memory:")

  if (indexNotes) {
    for (const note of FIXTURE_NOTES) {
      const fullPath = join(vault, note.path)
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, note.content, "utf8")
      search.upsertNote(
        {
          filePath: note.path,
          rawContent: note.content,
          fileStat: {
            mtimeMs: note.mtime,
            size: Buffer.byteLength(note.content, "utf8"),
          },
        },
        log,
      )
    }
  }

  if (memoryFiles) {
    const memoryDirPath = join(vault, config.memoryDir)
    await mkdir(memoryDirPath, { recursive: true })
    await writeFile(join(memoryDirPath, "Principles.md"), PRINCIPLES_MD, "utf8")
    await writeFile(join(memoryDirPath, "Opinions.md"), OPINIONS_MD, "utf8")
  }

  const calls: RegisterPromptCall[] = []
  const server = {
    registerPrompt: vi.fn((...args: unknown[]) =>
      calls.push(args as RegisterPromptCall),
    ),
  }
  registerPrompts({
    server: server as unknown as McpServer,
    vaultPath: vault,
    search,
    logger: log,
    config,
  })

  return { vault, search, calls }
}

/** Registers the prompts against a real vault path and a caller-supplied
 *  search (used to inject failures), capturing the calls. */
const registerWithSearch = (
  vaultPath: string,
  search: SearchIndex,
  log: Logger = logger,
): RegisterPromptCall[] => {
  const calls: RegisterPromptCall[] = []
  const server = {
    registerPrompt: vi.fn((...args: unknown[]) =>
      calls.push(args as RegisterPromptCall),
    ),
  }
  registerPrompts({
    server: server as unknown as McpServer,
    vaultPath,
    search,
    logger: log,
    config: loadConfig({}),
  })
  return calls
}

const findCall = (
  calls: RegisterPromptCall[],
  name: string,
): RegisterPromptCall =>
  calls.find((call) => call[0] === name) ??
  (() => {
    throw new Error(`prompt not registered: ${name}`)
  })()

const textOf = (result: PromptResult): string =>
  result.messages[0]!.content.text

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Registration ─────────────────────────────────────────────────

describe("registerPrompts — registration", () => {
  it(`registers exactly ${ALL_PROMPT_NAMES.length} prompts`, () => {
    const calls = captureRegistration()
    expect(calls).toHaveLength(ALL_PROMPT_NAMES.length)
  })

  it.each(ALL_PROMPT_NAMES)("registers %s", (name) => {
    const calls = captureRegistration()
    expect(calls.find((call) => call[0] === name)).toBeDefined()
  })

  it("every prompt has a non-empty title", () => {
    const calls = captureRegistration()
    for (const call of calls) {
      expect(call[1].title).toBeDefined()
      expect(call[1].title!.length).toBeGreaterThan(0)
    }
  })

  it("every prompt has a non-empty description", () => {
    const calls = captureRegistration()
    for (const call of calls) {
      expect(call[1].description).toBeDefined()
      expect(call[1].description!.length).toBeGreaterThan(0)
    }
  })

  it("vault-orientation is registered with no argsSchema (zero-arg)", () => {
    const calls = captureRegistration()
    const call = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    expect(call[1].argsSchema).toBeUndefined()
  })

  it("memory-review and daily-review expose an argsSchema", () => {
    const calls = captureRegistration()
    expect(
      findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[1].argsSchema,
    ).toBeDefined()
    expect(
      findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[1].argsSchema,
    ).toBeDefined()
  })

  it("memory-review and daily-review accept an optional max_chars argument", () => {
    const calls = captureRegistration()
    expect(
      findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[1].argsSchema,
    ).toHaveProperty("max_chars")
    expect(
      findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[1].argsSchema,
    ).toHaveProperty("max_chars")
  })
})

// ── Genericness (works for any vault via MEMORY_DIR) ─────────────

describe("registerPrompts — genericness", () => {
  it("descriptions interpolate a custom MEMORY_DIR and never hardcode 'About Me/'", () => {
    const calls = captureRegistration(loadConfig({ MEMORY_DIR: "Profile" }))
    for (const name of [
      PROMPT_NAMES.VAULT_ORIENTATION,
      PROMPT_NAMES.MEMORY_REVIEW,
      PROMPT_NAMES.DAILY_REVIEW,
    ]) {
      const description = findCall(calls, name)[1].description!
      expect(description).toContain("Profile/")
      expect(description).not.toContain("About Me/")
    }
  })

  it("vault-orientation surfaces a custom MEMORY_DIR's memory files at the handler level", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ MEMORY_DIR: "Profile" }),
    })
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))
    expect(text).toContain("## Memory (Profile/)")
    expect(text).toContain("Principles")
    expect(text).not.toContain("About Me/")
  })
})

// ── vault-orientation handler ────────────────────────────────────

describe("vault-orientation handler", () => {
  // Exact assembled output is asserted in "full prompt output"; the cases below
  // cover sentinels and degradation.
  it("returns sentinels and never throws on an empty vault", async () => {
    const config = loadConfig({})
    const { calls } = await setupVault({
      config,
      indexNotes: false,
      memoryFiles: false,
    })
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("No tags yet.")
    expect(text).toContain("No frontmatter properties yet.")
    expect(text).toContain(`the ${config.memoryDir}/ layer is empty`)
  })
})

// ── memory-review handler ────────────────────────────────────────

describe("memory-review handler", () => {
  it("includes every memory file when no file is given", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]
    const text = textOf(await handler({}, fakeExtra))

    expect(text).toContain("# Principles")
    expect(text).toContain("# Opinions")
    expect(text).toContain("Secrets invisible at every layer")
  })

  it("scopes to the requested file, excluding the others", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]
    const text = textOf(await handler({ file: "Principles" }, fakeExtra))

    expect(text).toContain("# Principles")
    expect(text).not.toContain("# Opinions")
  })

  it("explains how to start when memory is empty (not an error)", async () => {
    const { calls } = await setupVault({ memoryFiles: false })
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]
    const text = textOf(await handler({}, fakeExtra))

    expect(text).toContain("memory layer is empty")
    expect(text).toContain("vault_update_memory")
  })

  it("lists valid file names when given an unknown file", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]
    const text = textOf(await handler({ file: "Nope" }, fakeExtra))

    expect(text).toContain('No memory file named "Nope"')
    expect(text).toContain("Available files:")
    expect(text).toContain("Opinions")
    expect(text).toContain("Principles")
  })

  it("frames the review as an append-only evolution, never a prune", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]
    const text = textOf(await handler({}, fakeExtra))

    // The corrected philosophy, encoded as a regression guard:
    expect(text).toMatch(/read it as an evolution/i)
    expect(text).toMatch(/append-with-dates/i)
    expect(text).toMatch(/never delete an entry just for being old/i)
    // Explicitly instructs against the supersession misreading.
    expect(text).toMatch(
      /do \*?\*?not\*?\*? treat a newer entry as.*(overriding|superseding)/i,
    )
    // No "prune stale entries" directive.
    expect(text.toLowerCase()).not.toContain("stale")
  })

  it("completes file names by prefix (case-insensitive)", async () => {
    const { calls } = await setupVault()
    const argsSchema = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[1]
      .argsSchema as { file: unknown }
    const complete = getCompleter(argsSchema.file as never) as unknown as (
      value: string,
      context?: unknown,
    ) => Promise<string[]>

    const all = (await complete("", {})) as string[]
    expect(all).toEqual(["Opinions", "Principles"])

    const filtered = (await complete("pr", {})) as string[]
    expect(filtered).toEqual(["Principles"])
  })

  it("truncates memory content with a marker when max_chars is passed", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]
    const text = textOf(await handler({ max_chars: "40" }, fakeExtra))

    expect(text).toContain("truncated at 40 characters")
    expect(text).toContain("vault_get_memory")
    // Content past the 40-char budget must not appear verbatim.
    expect(text).not.toContain("Research current docs before configuring")
  })

  it("returns full memory content when max_chars is omitted", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]
    const text = textOf(await handler({}, fakeExtra))

    expect(text).not.toContain("truncated at")
    expect(text).toContain("Research current docs before configuring")
  })
})

// ── daily-review handler ─────────────────────────────────────────

describe("daily-review handler", () => {
  // Exact assembled output (note + recent notes) is asserted in "full prompt
  // output"; the cases below cover the missing-note and default-date branches.
  it("offers to create a missing note and still lists recent notes", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[2]
    const text = textOf(await handler({ date: "2020-01-01" }, fakeExtra))

    expect(text).toContain("No daily note found")
    expect(text).toContain("Daily Notes/2020-01-01.md")
    expect(text).toContain("Projects/alpha.md") // recent notes still shown
  })

  it("defaults to today when no date is given", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(DateTime.fromISO("2026-06-16T12:00:00Z").toJSDate())
    onTestFinished(() => {
      vi.useRealTimers()
    })

    const { vault, calls } = await setupVault()
    await mkdir(join(vault, "Daily Notes"), { recursive: true })
    await writeFile(
      join(vault, "Daily Notes", "2026-06-16.md"),
      "# Today\n\nToday's log.\n",
      "utf8",
    )
    const handler = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[2]
    const text = textOf(await handler({}, fakeExtra))

    expect(text).toContain("Daily Notes/2026-06-16.md")
    expect(text).toContain("Today's log.")
  })

  it("truncates a long daily note with a marker when max_chars is passed", async () => {
    const { vault, calls } = await setupVault()
    await mkdir(join(vault, "Daily Notes"), { recursive: true })
    await writeFile(
      join(vault, "Daily Notes", "2026-06-16.md"),
      "# 2026-06-16\n\nA very long journal entry that runs well past the cap.\n",
      "utf8",
    )
    const handler = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[2]
    const text = textOf(
      await handler({ date: "2026-06-16", max_chars: "30" }, fakeExtra),
    )

    expect(text).toContain("truncated at 30 characters")
    expect(text).toContain("vault_get_daily_note")
    expect(text).not.toContain("runs well past the cap")
  })
})

// ── Error degradation (handlers must degrade, never throw) ────────

describe("handler error degradation", () => {
  // A fresh empty temp vault, auto-cleaned when the test finishes.
  const makeVault = async (): Promise<string> => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-err-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    return vault
  }

  it("vault-orientation returns a fallback (no throw) when the index fails", async () => {
    const vault = await makeVault()
    const throwingSearch = {
      listAllTags: () => {
        throw new Error("index unavailable")
      },
    } as unknown as SearchIndex
    const calls = registerWithSearch(vault, throwingSearch)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]

    const text = textOf(await handler(fakeExtra))
    expect(text).toContain("index unavailable")
    expect(text).toContain("vault_list_tags")
  })

  it("daily-review returns a fallback (no throw) when a lookup fails", async () => {
    const vault = await makeVault()
    const throwingSearch = {
      recentNotes: () => {
        throw new Error("index unavailable")
      },
    } as unknown as SearchIndex
    const calls = registerWithSearch(vault, throwingSearch)
    const handler = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[2]

    const text = textOf(await handler({}, fakeExtra))
    expect(text).toContain("vault_get_daily_note")
  })

  it("memory-review returns a fallback (no throw) when the memory store fails", async () => {
    const vault = await makeVault()
    // Make the memory dir a file so readdir fails with ENOTDIR (not ENOENT),
    // which listMemoryFiles re-throws — exercising the handler's catch path.
    await writeFile(join(vault, "About Me"), "not a directory", "utf8")
    const calls = registerWithSearch(vault, {} as SearchIndex)
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]

    const text = textOf(await handler({}, fakeExtra))
    expect(text).toContain("vault_list_memory_files")
  })

  it("memory-review completion returns [] when listing names fails", async () => {
    const vault = await makeVault()
    await writeFile(join(vault, "About Me"), "not a directory", "utf8")
    const calls = registerWithSearch(vault, {} as SearchIndex)
    const argsSchema = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[1]
      .argsSchema as { file: unknown }
    const complete = getCompleter(argsSchema.file as never) as unknown as (
      value: string,
      context?: unknown,
    ) => Promise<string[]>

    expect(await complete("", {})).toEqual([])
  })
})

// ── Logging (usage + error signal) ───────────────────────────────

describe("prompt logging", () => {
  const makeVault = async (): Promise<string> => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-log-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    return vault
  }

  it("logs prompt_result on a successful memory-review, with the truncated flag", async () => {
    const logs: LogCall[] = []
    const { calls } = await setupVault({ logger: recordingLogger(logs) })
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]

    await handler({ max_chars: "40" }, fakeExtra)
    const result = logs.find((call) => call.message === "prompt_result")
    expect(result?.level).toBe("info")
    expect(result?.data.outcome).toBe("ok")
    expect(result?.data.truncated).toBe(true)
    expect(result?.data.prompt).toBe("memory-review")
  })

  it("does not flag truncation when max_chars is omitted", async () => {
    const logs: LogCall[] = []
    const { calls } = await setupVault({ logger: recordingLogger(logs) })
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]

    await handler({}, fakeExtra)
    const result = logs.find((call) => call.message === "prompt_result")
    expect(result?.data.truncated).toBe(false)
  })

  it("warns (not errors) when memory-review gets an unknown file", async () => {
    const logs: LogCall[] = []
    const { calls } = await setupVault({ logger: recordingLogger(logs) })
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]

    await handler({ file: "Nope" }, fakeExtra)
    const warn = logs.find((call) => call.message === "prompt_bad_argument")
    expect(warn?.level).toBe("warn")
    expect(warn?.data.argument).toBe("file")
    expect(warn?.data.value).toBe("Nope")
  })

  it("logs prompt_error at error level when a handler fails unexpectedly", async () => {
    const logs: LogCall[] = []
    const vault = await makeVault()
    const throwingSearch = {
      listAllTags: () => {
        throw new Error("index unavailable")
      },
    } as unknown as SearchIndex
    const calls = registerWithSearch(
      vault,
      throwingSearch,
      recordingLogger(logs),
    )
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]

    await handler(fakeExtra)
    const err = logs.find((call) => call.message === "prompt_error")
    expect(err?.level).toBe("error")
  })

  it("warns when the memory-review completion callback fails", async () => {
    const logs: LogCall[] = []
    const vault = await makeVault()
    await writeFile(join(vault, "About Me"), "not a directory", "utf8")
    const calls = registerWithSearch(
      vault,
      {} as SearchIndex,
      recordingLogger(logs),
    )
    const argsSchema = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[1]
      .argsSchema as { file: unknown }
    const complete = getCompleter(argsSchema.file as never) as unknown as (
      value: string,
      context?: unknown,
    ) => Promise<string[]>

    await complete("", {})
    const warn = logs.find(
      (call) => call.message === "prompt_completion_failed",
    )
    expect(warn?.level).toBe("warn")
    expect(warn?.data.prompt).toBe("memory-review")
  })
})

// ── Full output (exact assertions on controlled fixtures) ────────
// Minimal, fully-deterministic fixtures so each prompt's complete assembled
// message can be asserted character-for-character — not just `contains`.

describe("full prompt output", () => {
  const MEM_MD =
    "---\ntitle: Mem\ntype: profile\n---\n\n# Mem\n\n## Notes (newest first)\n- **2026-05-06**: Keep it simple\n"
  const ALPHA_MD = "---\ntitle: Alpha\n---\n# Alpha\n\nbody\n"

  const freshVault = async (): Promise<string> => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-exact-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    return vault
  }

  it("memory-review assembles the exact message for a single file", async () => {
    const vault = await freshVault()
    await mkdir(join(vault, "About Me"), { recursive: true })
    await writeFile(join(vault, "About Me", "Mem.md"), MEM_MD, "utf8")
    const calls = registerWithSearch(vault, {} as SearchIndex)
    const handler = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)[2]

    const text = textOf(await handler({ file: "Mem" }, fakeExtra))
    expect(text).toBe(
      [
        "# Memory review — Mem",
        "",
        "Below is the current content of the About Me/Mem memory file. It is an **append-with-dates, newest-first** record: each dated entry was true when it was written, and the timeline read top-to-bottom *is* the meaning.",
        "",
        "## Current memory",
        "",
        "# Mem",
        "",
        "## Notes (newest first)",
        "- **2026-05-06**: Keep it simple",
        "",
        "## How to reflect",
        "",
        '1. **Read it as an evolution.** Summarize the current picture (the newest entries) *and* the trajectory that led there. Earlier entries aren\'t wrong — they\'re how things got here. Do **not** treat a newer entry as "overriding" or "superseding" an older one, and do **not** flag beliefs that changed over time as contradictions to reconcile — that misreads the system.',
        "2. **Scope-fit.** Note any entry that seems to belong in a different file or section, based on each file's declared scope (respect a scope header if the file states one; don't assume one otherwise).",
        "3. **Backfill gaps.** Point out durable facts that are implied but not yet captured, and propose them as dated append entries (bullet + target file + section).",
        "4. **Corrections (rare, separate).** Only a fact that is mis-recorded or now genuinely incorrect — not one that simply changed over time — warrants a fix. Prefer an appended dated correction that preserves the old entry (history matters); reserve vault_delete_memory for genuinely wrong facts.",
        "",
        "Propose every change as an explicit vault_update_memory call (newest-first; the server stamps the date) and **confirm with me before writing anything**. Never delete an entry just for being old.",
      ].join("\n"),
    )
  })

  it("vault-orientation assembles the exact message", async () => {
    const vault = await freshVault()
    await mkdir(join(vault, "Notes"), { recursive: true })
    await mkdir(join(vault, "About Me"), { recursive: true })
    await writeFile(join(vault, "Notes", "alpha.md"), ALPHA_MD, "utf8")
    await writeFile(join(vault, "About Me", "Mem.md"), MEM_MD, "utf8")
    const search = createSearchIndex(":memory:")
    // Only alpha.md is indexed, so tags/properties/recent are deterministic.
    search.upsertNote(
      {
        filePath: "Notes/alpha.md",
        rawContent: ALPHA_MD,
        fileStat: { mtimeMs: 1000, size: 100 },
      },
      logger,
    )
    const calls = registerWithSearch(vault, search)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]

    const text = textOf(await handler(fakeExtra))
    expect(text).toBe(
      [
        "# Vault orientation",
        "",
        "This vault is a structured, convention-driven Obsidian system. Survey its actual conventions below, then use the `vault_*` tools to go deeper.",
        "",
        "## Folders",
        "- About Me",
        "- Notes",
        "",
        "## Tags",
        "No tags yet.",
        "",
        "## Property keys",
        "- title (1) — e.g. Alpha",
        "",
        "## Recently modified",
        "- Notes/alpha.md — Alpha",
        "",
        "## Memory (About Me/)",
        "- Mem",
        "  - Notes (newest first) (1)",
        "",
        "---",
        "Go deeper with the vault tools: `vault_search` (full-text), `vault_search_by_tag`, `vault_list_property_values`, `vault_get_memory`, and `vault_read_note`.",
      ].join("\n"),
    )
  })

  it("daily-review assembles the exact message when the note exists", async () => {
    const vault = await freshVault()
    await mkdir(join(vault, "Daily Notes"), { recursive: true })
    await writeFile(
      join(vault, "Daily Notes", "2026-06-16.md"),
      "# 2026-06-16\n\nShipped the prompts.\n",
      "utf8",
    )
    const search = createSearchIndex(":memory:")
    search.upsertNote(
      {
        filePath: "Log/note.md",
        rawContent: "---\ntitle: Note One\n---\nbody\n",
        fileStat: { mtimeMs: 1000, size: 100 },
      },
      logger,
    )
    const calls = registerWithSearch(vault, search)
    const handler = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[2]

    const text = textOf(await handler({ date: "2026-06-16" }, fakeExtra))
    expect(text).toBe(
      [
        "# Daily review",
        "",
        "Daily note: `Daily Notes/2026-06-16.md`",
        "",
        "## Daily note",
        "",
        "# 2026-06-16",
        "",
        "Shipped the prompts.",
        "",
        "## Recently modified notes",
        "",
        "- Log/note.md — Note One",
        "",
        "## How to review",
        "",
        "1. **Reconcile the day** — what got done, what's still open, what changed — cross-referencing the recent notes above.",
        "2. **Capture follow-ups** as concrete next actions; with my OK, append them to the daily note with vault_patch_note.",
        "3. **Surface durable facts** — any preference, decision, or fact worth remembering long-term — and propose saving it to About Me/ memory via vault_update_memory (append-with-dates, newest-first). Confirm before writing.",
      ].join("\n"),
    )
  })
})

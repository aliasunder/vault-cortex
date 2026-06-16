import { describe, it, expect, vi, onTestFinished, afterEach } from "vitest"
import { DateTime } from "luxon"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { registerPrompts, PROMPT_NAMES } from "../prompt-definitions.js"
import { loadConfig } from "../config.js"
import { createSearchIndex, type SearchIndex } from "../search/search-index.js"
import { getCompleter } from "@modelcontextprotocol/sdk/server/completable.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { logger } from "../../logger.js"

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
  } = {},
): Promise<{
  vault: string
  search: SearchIndex
  calls: RegisterPromptCall[]
}> => {
  const config = options.config ?? loadConfig({})
  const indexNotes = options.indexNotes ?? true
  const memoryFiles = options.memoryFiles ?? true

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
      search.upsertNote(note.path, note.content, note.mtime)
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
    logger,
    config,
  })

  return { vault, search, calls }
}

/** Registers the prompts against a real vault path and a caller-supplied
 *  search (used to inject failures), capturing the calls. */
const registerWithSearch = (
  vaultPath: string,
  search: SearchIndex,
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
    logger,
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
  it("surveys folders, tags, property keys, recent notes, and memory", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("Projects") // derived folder
    expect(text).toContain("#project") // a tag
    expect(text).toContain("status") // a property key
    expect(text).toContain("Projects/alpha.md") // a recent note
    expect(text).toContain("Principles") // a memory file
  })

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

  it("scopes to a single file when file is given", async () => {
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
  it("returns the daily note path and content when it exists", async () => {
    const { vault, calls } = await setupVault()
    await mkdir(join(vault, "Daily Notes"), { recursive: true })
    await writeFile(
      join(vault, "Daily Notes", "2026-06-16.md"),
      "# 2026-06-16\n\nWorked on the prompts feature.\n",
      "utf8",
    )
    const handler = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)[2]
    const text = textOf(await handler({ date: "2026-06-16" }, fakeExtra))

    expect(text).toContain("Daily Notes/2026-06-16.md")
    expect(text).toContain("Worked on the prompts feature.")
  })

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

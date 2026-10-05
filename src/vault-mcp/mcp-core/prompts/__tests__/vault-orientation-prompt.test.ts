import { describe, it, expect, vi, onTestFinished, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerPrompts } from "../../prompt-definitions.js"
import { readDailyNotesConfig } from "../../../vault-operations/daily-notes.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  type RegisterPromptCall,
  fakeExtra,
  recordingLogger,
  type LogCall,
  setupVault,
  registerWithSearch,
  findCall,
  textOf,
  PROMPT_NAMES,
  loadConfig,
  createSearchIndex,
  type SearchIndex,
  logger,
} from "./prompt-test-harness.js"

vi.mock("../../../vault-operations/daily-notes.js", { spy: true })

afterEach(() => {
  vi.restoreAllMocks()
})

// ── vault-orientation handler ────────────────────────────────────

describe("vault-orientation live orphan folders", () => {
  const setupOrphanPrompt = async (
    options: {
      settings?: string
      env?: Record<string, string>
      paths?: readonly string[]
    } = {},
  ) => {
    const vault = await mkdtemp(join(tmpdir(), "orientation-orphans-"))
    onTestFinished(() => rm(vault, { recursive: true, force: true }))
    await mkdir(join(vault, ".obsidian"))
    const settingsPath = join(vault, ".obsidian/daily-notes.json")

    if (options.settings !== undefined) await writeFile(settingsPath, options.settings)

    const search = createSearchIndex(":memory:")
    const paths = options.paths ?? [
      "Journal/daily.md",
      "Journal/nested/daily.md",
      "JournalOld/note.md",
      "ordinary.md",
      "Daily Notes/daily.md",
      "Templates/template.md",
      "Profile/memory.md",
      "Archive/note.md",
    ]
    paths.forEach((filePath, index) => {
      search.upsertNote(
        { filePath, rawContent: "", fileStat: { mtimeMs: 10000 - index, size: 0 } },
        logger,
      )
    })
    const logCalls: LogCall[] = []
    const config = loadConfig({ MEMORY_ENABLED: "false", MEMORY_DIR: "Profile", ...options.env })
    const calls = registerWithSearch(vault, search, recordingLogger(logCalls), config)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const orphanSection = async () => {
      const text = textOf(await handler(fakeExtra))
      const section = text.split("## Orphans\n")[1]?.split("\n\n---")[0]?.split("\n\n## ")[0]

      if (!section) throw new Error("prompt has no orphan section")
      return section
    }
    return { settingsPath, orphanSection, logCalls, config }
  }

  it("excludes file-configured daily notes and descendants while retaining sibling folders", async () => {
    const { orphanSection } = await setupOrphanPrompt({ settings: '{"folder":"Journal"}' })
    expect(await orphanSection()).toBe(
      "4 orphan notes (no incoming links):\n- JournalOld/note.md — note\n- ordinary.md — ordinary\n- Daily Notes/daily.md — daily\n- Archive/note.md — note",
    )
  })

  it("keeps ordinary orphans visible behind more than five newer excluded daily candidates", async () => {
    const dailyPaths = Array.from({ length: 7 }, (_, index) => `Journal/nested/day-${index}.md`)
    const { orphanSection } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      paths: [...dailyPaths, "ordinary.md", "JournalOld/note.md"],
    })
    expect(await orphanSection()).toBe(
      "2 orphan notes (no incoming links):\n- ordinary.md — ordinary\n- JournalOld/note.md — note",
    )
  })

  it("describes an empty filtered result without claiming excluded notes are linked", async () => {
    const { orphanSection } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      paths: ["Journal/daily.md"],
    })
    expect(await orphanSection()).toBe("No orphans found after folder exclusions.")
  })

  it("lets explicit environment folders replace all defaults", async () => {
    const { orphanSection } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      env: { ORPHAN_EXCLUDE_FOLDERS: "Archive" },
      paths: [
        "Journal/daily.md",
        "Daily Notes/daily.md",
        "Templates/template.md",
        "Profile/memory.md",
        "Archive/note.md",
      ],
    })
    expect(await orphanSection()).toBe(
      "4 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- Daily Notes/daily.md — daily\n- Templates/template.md — template\n- Profile/memory.md — memory",
    )
  })

  it("uses the environment daily folder over the file folder", async () => {
    const { orphanSection } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      env: { DAILY_NOTES_FOLDER: "Env/Daily" },
      paths: [
        "Env/Daily/daily.md",
        "Env/Daily/nested/daily.md",
        "Journal/daily.md",
        "ordinary.md",
        "Templates/template.md",
        "Profile/memory.md",
      ],
    })
    expect(await orphanSection()).toBe(
      "2 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- ordinary.md — ordinary",
    )
  })

  it("honors an empty environment list and still reads daily settings once for broken links", async () => {
    const { orphanSection, config } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      env: { ORPHAN_EXCLUDE_FOLDERS: ", ," },
      paths: [
        "Journal/daily.md",
        "Daily Notes/daily.md",
        "Templates/template.md",
        "Profile/memory.md",
      ],
    })
    vi.mocked(readDailyNotesConfig).mockClear()
    expect(await orphanSection()).toBe(
      "4 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- Daily Notes/daily.md — daily\n- Templates/template.md — template\n- Profile/memory.md — memory",
    )
    expect(vi.mocked(readDailyNotesConfig)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(readDailyNotesConfig)).toHaveBeenCalledWith(
      {
        vaultPath: expect.any(String),
        envSettings: { folder: config.dailyNotesFolder, format: config.dailyNotesFormat },
      },
      expect.any(Object),
    )
  })

  it("uses the same single daily settings read for default exclusions and broken links", async () => {
    const { orphanSection } = await setupOrphanPrompt({ settings: '{"folder":"Journal"}' })
    vi.mocked(readDailyNotesConfig).mockClear()
    expect(await orphanSection()).toBe(
      "4 orphan notes (no incoming links):\n- JournalOld/note.md — note\n- ordinary.md — ordinary\n- Daily Notes/daily.md — daily\n- Archive/note.md — note",
    )
    expect(vi.mocked(readDailyNotesConfig)).toHaveBeenCalledTimes(1)
  })

  it("changes folder exclusions on the next invocation without registering again", async () => {
    const { orphanSection, settingsPath } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      paths: ["Journal/daily.md", "Planner/Daily/daily.md", "ordinary.md"],
    })
    expect(await orphanSection()).toBe(
      "2 orphan notes (no incoming links):\n- Planner/Daily/daily.md — daily\n- ordinary.md — ordinary",
    )
    await writeFile(settingsPath, '{"folder":"Planner/Daily"}')
    expect(await orphanSection()).toBe(
      "2 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- ordinary.md — ordinary",
    )
  })

  it("falls back with a warning for malformed settings and uses a repaired file on the next call", async () => {
    const { orphanSection, settingsPath, logCalls } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      paths: ["Journal/daily.md", "Daily Notes/daily.md", "Planner/Daily/daily.md", "ordinary.md"],
    })
    expect(await orphanSection()).toBe(
      "3 orphan notes (no incoming links):\n- Daily Notes/daily.md — daily\n- Planner/Daily/daily.md — daily\n- ordinary.md — ordinary",
    )
    await writeFile(settingsPath, "broken")
    expect(await orphanSection()).toBe(
      "3 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- Planner/Daily/daily.md — daily\n- ordinary.md — ordinary",
    )
    expect(logCalls.filter((entry) => entry.level === "warn")).toEqual([
      {
        level: "warn",
        message: "cannot read daily notes config, using defaults",
        data: { requestId: "1", prompt: "vault-orientation", error: expect.any(String) },
      },
    ])
    await writeFile(settingsPath, '{"folder":"Planner/Daily"}')
    expect(await orphanSection()).toBe(
      "3 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- Daily Notes/daily.md — daily\n- ordinary.md — ordinary",
    )
  })

  it("uses file settings that arrive after prompt registration", async () => {
    const { orphanSection, settingsPath } = await setupOrphanPrompt({
      paths: ["Journal/daily.md", "Daily Notes/daily.md", "ordinary.md"],
    })
    expect(await orphanSection()).toBe(
      "2 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- ordinary.md — ordinary",
    )
    await writeFile(settingsPath, '{"folder":"Journal"}')
    expect(await orphanSection()).toBe(
      "2 orphan notes (no incoming links):\n- Daily Notes/daily.md — daily\n- ordinary.md — ordinary",
    )
  })
})

describe("vault-orientation handler", () => {
  it("returns sentinels and never throws on an empty vault", async () => {
    const config = loadConfig({})
    const { calls } = await setupVault({
      config,
      indexNotes: false,
      memoryFiles: false,
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("No tags yet.")
    expect(text).toContain("No frontmatter properties yet.")
    expect(text).toContain(`the ${config.memoryDir}/ layer is empty`)
    expect(text).toContain("No orphans found")
  })

  it("shows vault stats header with note count", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("## Vault stats")
    // 2 indexed notes; 3 folders on disk (About Me, Projects, Reference)
    expect(text).toContain("2 notes across")
    expect(text).toContain("3 folders")
  })

  it("shows folder note counts instead of bare names", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("- Projects (1)")
    expect(text).toContain("- Reference (1)")
  })

  it("orders the folder listing by code units, not locale collation", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-folder-order-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    await mkdir(join(vault, "About Me"), { recursive: true })
    // "Zeta" and "alpha" disagree between code-unit order (Z 0x5A before
    // a 0x61) and en-US locale collation (alpha before Zeta) — the listing
    // must not follow the runtime's locale.
    await mkdir(join(vault, "alpha"))
    await mkdir(join(vault, "Zeta"))
    await writeFile(join(vault, "alpha", "one.md"), "# One\n")
    await writeFile(join(vault, "Zeta", "two.md"), "# Two\n")
    const calls = registerWithSearch(vault, createSearchIndex(":memory:"))
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("## Folders\n- Zeta (1)\n- alpha (1)")
  })

  it("shows orphan count and sample when orphans exist", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    // Both fixture notes are orphans (no incoming links between them)
    expect(text).toContain("## Orphans")
    expect(text).toContain("orphan notes (no incoming links)")
    expect(text).toContain("Projects/alpha.md")
  })

  it("shows no-orphans message when all notes are linked", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-linked-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    await mkdir(join(vault, "About Me"), { recursive: true })
    const search = createSearchIndex(":memory:")
    // Two notes that link to each other — no orphans
    search.upsertNote(
      {
        filePath: "a.md",
        rawContent: "# A\n\n[[b]].\n",
        fileStat: { mtimeMs: 1000, size: 50 },
      },
      logger,
    )
    search.upsertNote(
      {
        filePath: "b.md",
        rawContent: "# B\n\n[[a]].\n",
        fileStat: { mtimeMs: 2000, size: 50 },
      },
      logger,
    )
    const calls = registerWithSearch(vault, search)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    const orphanSection = text.split("## Orphans\n")[1]?.split("\n\n## Memory")[0]
    expect(orphanSection).toBe("No orphans found after folder exclusions.")
  })

  it("shows property adoption rates with count/total format", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    // Both fixture notes have "title", "type", and "tags" properties
    expect(text).toMatch(/- title \(2\/2 — 100%\)/)
  })

  it("flags low-adoption properties", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-adoption-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    await mkdir(join(vault, "About Me"), { recursive: true })
    const search = createSearchIndex(":memory:")
    // 21 notes total, 1 with "rare" property → 1/21 < 5% threshold
    for (let noteIndex = 0; noteIndex < 21; noteIndex++) {
      const extra = noteIndex === 0 ? "rare: yes\n" : ""
      search.upsertNote(
        {
          filePath: `note-${noteIndex}.md`,
          rawContent: `---\ntitle: Note ${noteIndex}\n${extra}---\n# Note\n`,
          fileStat: { mtimeMs: noteIndex * 1000, size: 50 },
        },
        logger,
      )
    }
    const calls = registerWithSearch(vault, search)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("rare (1/21")
    expect(text).toContain("(low adoption)")
  })

  it("suggests vault_find_orphans in footer when orphans exist", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("vault_find_orphans")
  })

  it("omits vault_find_orphans from footer when no orphans", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-noorphan-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    await mkdir(join(vault, "About Me"), { recursive: true })
    const search = createSearchIndex(":memory:")
    search.upsertNote(
      {
        filePath: "a.md",
        rawContent: "# A\n\n[[b]].\n",
        fileStat: { mtimeMs: 1000, size: 50 },
      },
      logger,
    )
    search.upsertNote(
      {
        filePath: "b.md",
        rawContent: "# B\n\n[[a]].\n",
        fileStat: { mtimeMs: 2000, size: 50 },
      },
      logger,
    )
    const calls = registerWithSearch(vault, search)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).not.toContain("vault_find_orphans")
  })

  it("shows broken link count in stats when broken links exist", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-broken-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    await mkdir(join(vault, "About Me"), { recursive: true })
    const search = createSearchIndex(":memory:")
    search.upsertNote(
      {
        filePath: "note.md",
        rawContent: "# Note\n\n[[missing]] and [[also-missing]].\n",
        fileStat: { mtimeMs: 1000, size: 50 },
      },
      logger,
    )
    const calls = registerWithSearch(vault, search)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("2 broken links.")
  })
})

// ── Error degradation ────────────────────────────────────────────

describe("vault-orientation error degradation", () => {
  it("returns a fallback (no throw) when the index fails", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-err-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
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
})

// ── Logging ──────────────────────────────────────────────────────

describe("vault-orientation logging", () => {
  it("logs prompt_error at error level when the handler fails unexpectedly", async () => {
    const logs: LogCall[] = []
    const vault = await mkdtemp(join(tmpdir(), "prompt-log-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    const throwingSearch = {
      listAllTags: () => {
        throw new Error("index unavailable")
      },
    } as unknown as SearchIndex
    const calls = registerWithSearch(vault, throwingSearch, recordingLogger(logs))
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]

    await handler(fakeExtra)
    const err = logs.find((call) => call.message === "prompt_error")
    expect(err?.level).toBe("error")
  })
})

// ── Full output ──────────────────────────────────────────────────

describe("vault-orientation full prompt output", () => {
  const MEM_MD =
    "---\ntitle: Mem\ntype: profile\n---\n\n# Mem\n\n## Notes (newest first)\n- **2026-05-06**: Keep it simple\n"
  const ALPHA_MD = "---\ntitle: Alpha\n---\n# Alpha\n\nbody\n"

  it("assembles the exact message", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-exact-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
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
        "This vault is a structured, convention-driven Obsidian system. Survey its structure and health below, then use the vault tools to go deeper.",
        "",
        "## Vault stats",
        "1 notes across 2 folders, 0 tags, 1 property keys. 1 untagged.",
        "",
        "## Folders",
        "- About Me (1)",
        "- Notes (1)",
        "",
        "## Tags",
        "No tags yet.",
        "",
        "## Property keys",
        "- title (1/1 — 100%) — e.g. Alpha",
        "",
        "## Recently modified",
        "- Notes/alpha.md — Alpha",
        "",
        "## Orphans",
        "1 orphan notes (no incoming links):",
        "- Notes/alpha.md — Alpha",
        "",
        "## Memory (About Me/)",
        "- Mem",
        "  - Notes (newest first) (1)",
        "",
        "---",
        "Go deeper with the vault tools:",
        "- `vault_search` — hybrid search across all notes",
        "- `vault_search_by_tag` — explore notes by tag",
        "- `vault_list_property_values` — explore values for any property key",
        "- `vault_find_orphans` — full orphan list with exclusion control",
        "- `vault_get_memory` — read memory files in detail",
        "- `vault_read_note` — read any note's full content",
        "- `vault_list_files` — browse non-markdown files (images, canvases, data files)",
      ].join("\n"),
    )
  })
})

// ── MEMORY_ENABLED=false ────────────────────────────────────────

describe("vault-orientation with MEMORY_ENABLED=false", () => {
  const disabledConfig = loadConfig({ MEMORY_ENABLED: "false" })

  it("omits the Memory section", async () => {
    const { calls } = await setupVault({ config: disabledConfig })
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("## Folders")
    expect(text).not.toContain("## Memory")
    expect(text).not.toContain("vault_get_memory")
  })

  it("error fallback omits vault_list_memory_files", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-mem-disabled-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    const throwingSearch = {
      listAllTags: () => {
        throw new Error("index unavailable")
      },
    } as unknown as SearchIndex
    const calls: RegisterPromptCall[] = []
    const server = {
      registerPrompt: vi.fn((...args: unknown[]) => calls.push(args as RegisterPromptCall)),
    }
    registerPrompts({
      server: server as unknown as McpServer,
      vaultPath: vault,
      search: throwingSearch,
      logger,
      config: disabledConfig,
    })
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("Could not fully survey the vault")
    expect(text).not.toContain("vault_list_memory_files")
  })
})

// ── FILE_TOOLS_ENABLED=false ──────────────────────────────────

describe("vault-orientation with FILE_TOOLS_ENABLED=false", () => {
  const disabledConfig = loadConfig({ FILE_TOOLS_ENABLED: "false" })

  it("omits vault_list_files from the go-deeper tools", async () => {
    const { calls } = await setupVault({ config: disabledConfig })
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).not.toContain("vault_list_files")
    expect(text).toContain("vault_read_note")
  })
})

// ── READONLY_MODE=true ──────────────────────────────────────────

describe("vault-orientation with READONLY_MODE=true", () => {
  it("empty-memory fallback omits the vault_update_memory suggestion", async () => {
    const config = loadConfig({ READONLY_MODE: "true" })
    const { calls } = await setupVault({
      config,
      indexNotes: false,
      memoryFiles: false,
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    // Guard against a silent no-op: the empty-memory sentinel is present,
    // only the write-tool suggestion is dropped.
    expect(text).toContain(`No memory files yet — the ${config.memoryDir}/ layer is empty.`)
    expect(text).not.toContain("vault_update_memory")
  })
})

// ── Genericness ─────────────────────────────────────────────────

describe("vault-orientation genericness", () => {
  it("surfaces a custom MEMORY_DIR's memory files at the handler level", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ MEMORY_DIR: "Profile" }),
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))
    expect(text).toContain("## Memory (Profile/)")
    expect(text).toContain("Principles")
    expect(text).not.toContain("About Me/")
  })
})

// ── DISABLED_TOOLS ──────────────────────────────────────────────

// The survey's "go deeper" list is a menu of calls to make, so each line has
// to track its own tool — not the group flag it used to key on.
describe("vault-orientation with DISABLED_TOOLS", () => {
  it("empty-memory fallback omits the suggestion when vault_update_memory is disabled", async () => {
    const config = loadConfig({ DISABLED_TOOLS: "vault_update_memory" })
    const { calls } = await setupVault({
      config,
      indexNotes: false,
      memoryFiles: false,
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain(`No memory files yet — the ${config.memoryDir}/ layer is empty.`)
    expect(text).not.toContain("vault_update_memory")
  })

  it("drops only the disabled tool from the go-deeper menu", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ DISABLED_TOOLS: "vault_get_memory" }),
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(text).not.toContain("vault_get_memory")
    // The rest of the menu survives — the memory group is still enabled.
    expect(text).toContain("- `vault_read_note` — read any note's full content")
    expect(text).toContain(
      "- `vault_list_files` — browse non-markdown files (images, canvases, data files)",
    )
  })

  it("drops the search line when vault_search is disabled", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ DISABLED_TOOLS: "vault_search" }),
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(text).toContain("Go deeper with the vault tools:")
    expect(text).not.toContain("vault_search`")
    expect(text).toContain("- `vault_search_by_tag` — explore notes by tag")
  })
})

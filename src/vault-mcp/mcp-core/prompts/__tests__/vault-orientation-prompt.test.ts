import { describe, it, expect, vi, onTestFinished, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readDailyNotesConfig } from "../../../vault-operations/daily-notes.js"
import {
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
  logger,
} from "./prompt-test-harness.js"

vi.mock("../../../vault-operations/daily-notes.js", { spy: true })

afterEach(() => {
  vi.restoreAllMocks()
})

// ── vault-orientation handler ────────────────────────────────────

describe("vault-orientation live orphan folders", () => {
  const dailyForwardReferences =
    "[[Journal/2026-10-06]] [[Journal/2026-10-07]] [[Daily Notes/2026-10-06]] [[missing]]"

  const setupOrphanPrompt = async (
    options: {
      settings?: string
      env?: Record<string, string>
      paths?: readonly string[]
      noteContents?: Readonly<Record<string, string>>
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
      const rawContent = options.noteContents?.[filePath] ?? ""
      search.upsertNote(
        {
          filePath,
          rawContent,
          fileStat: { mtimeMs: 10000 - index, size: Buffer.byteLength(rawContent) },
        },
        logger,
      )
    })
    const logCalls: LogCall[] = []
    const config = loadConfig({ MEMORY_ENABLED: "false", MEMORY_DIR: "Profile", ...options.env })
    const calls = registerWithSearch(vault, search, recordingLogger(logCalls), config)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const readSurveySections = async () => {
      const text = textOf(await handler(fakeExtra))
      const orphans = text.split("## Orphans\n")[1]?.split("\n\n---")[0]?.split("\n\n## ")[0]
      const stats = text.split("## Vault stats\n")[1]?.split("\n\n## Folders")[0]

      if (!orphans || !stats) throw new Error("prompt has no orphan or stats section")
      return { orphans, stats }
    }
    const orphanSection = async () => (await readSurveySections()).orphans
    return { vault, settingsPath, orphanSection, readSurveySections, logCalls, config }
  }

  it("excludes file-configured daily notes and descendants while retaining sibling folders", async () => {
    const { orphanSection } = await setupOrphanPrompt({ settings: '{"folder":"Journal"}' })
    expect(await orphanSection()).toBe(
      "4 orphan notes (no incoming links):\n- JournalOld/note.md — note\n- ordinary.md — ordinary\n- Daily Notes/daily.md — daily\n- Archive/note.md — note",
    )
  })

  it.each(["Journal/", "Journal///"])(
    "renders one trailing separator for the excluded daily folder %s",
    async (dailyNotesFolder) => {
      const { readSurveySections } = await setupOrphanPrompt({
        settings: JSON.stringify({ folder: dailyNotesFolder }),
        paths: ["source.md", "other.md"],
        noteContents: { "source.md": dailyForwardReferences },
      })

      expect((await readSurveySections()).stats).toBe(
        "2 notes across 0 folders, 0 tags, 0 property keys. 2 untagged. 2 without properties. 2 broken links (excludes 2 forward-refs in Journal/).",
      )
    },
  )

  it("counts one broken link and one excluded forward-ref in the singular", async () => {
    const { readSurveySections } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      paths: ["source.md", "other.md"],
      noteContents: { "source.md": "[[Journal/2026-10-06]] [[missing]]" },
    })

    expect((await readSurveySections()).stats).toBe(
      "2 notes across 0 folders, 0 tags, 0 property keys. 2 untagged. 2 without properties. 1 broken link (excludes 1 forward-ref in Journal/).",
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
    const { vault, readSurveySections, config } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      env: { ORPHAN_EXCLUDE_FOLDERS: ", ," },
      noteContents: { "Journal/daily.md": dailyForwardReferences },
      paths: [
        "Journal/daily.md",
        "Daily Notes/daily.md",
        "Templates/template.md",
        "Profile/memory.md",
      ],
    })
    vi.mocked(readDailyNotesConfig).mockClear()
    expect(await readSurveySections()).toEqual({
      orphans:
        "4 orphan notes (no incoming links):\n- Journal/daily.md — daily\n- Daily Notes/daily.md — daily\n- Templates/template.md — template\n- Profile/memory.md — memory",
      stats:
        "4 notes across 0 folders, 0 tags, 0 property keys. 4 untagged. 4 without properties. 2 broken links (excludes 2 forward-refs in Journal/).",
    })
    expect(vi.mocked(readDailyNotesConfig)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(readDailyNotesConfig)).toHaveBeenCalledWith(
      {
        vaultPath: vault,
        envSettings: { folder: config.dailyNotesFolder, format: config.dailyNotesFormat },
      },
      expect.any(Object),
    )
  })

  it("uses the same single daily settings read for default exclusions and broken links", async () => {
    const { readSurveySections } = await setupOrphanPrompt({
      settings: '{"folder":"Journal"}',
      noteContents: { "ordinary.md": dailyForwardReferences },
    })
    vi.mocked(readDailyNotesConfig).mockClear()
    expect(await readSurveySections()).toEqual({
      orphans:
        "4 orphan notes (no incoming links):\n- JournalOld/note.md — note\n- ordinary.md — ordinary\n- Daily Notes/daily.md — daily\n- Archive/note.md — note",
      stats:
        "8 notes across 0 folders, 0 tags, 0 property keys. 8 untagged. 8 without properties. 2 broken links (excludes 2 forward-refs in Journal/).",
    })
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

// ── Expected survey text ─────────────────────────────────────────

/** Matches the blank line that ends a survey section, together with the next
 *  section's `## ` or the footer's `---` rule that follows it. */
const SECTION_END = /\n\n(?:## |---\n)/

/** One `## heading` section's body: the lines between its heading and the
 *  next section or the footer. */
const surveySection = (text: string, heading: string): string => {
  const sectionBody = text.split(`\n## ${heading}\n`)[1]?.split(SECTION_END)[0]

  if (!sectionBody) throw new Error(`survey has no "${heading}" section`)
  return sectionBody
}

/** Everything below the survey's closing `---` rule: the lead-in line and the go-deeper menu. */
const surveyFooter = (text: string): string => {
  const footer = text.split("\n\n---\n")[1]

  if (!footer) throw new Error("survey has no footer rule")
  return footer
}

/** Go-deeper menu lines under the default config, where EMBEDDING_ENABLED
 *  makes vault_search "hybrid". Each test lists the lines its setup serves. */
const MENU_LINE = {
  search: "- `vault_search` — hybrid search across all notes",
  searchByTag: "- `vault_search_by_tag` — explore notes by tag",
  listPropertyValues: "- `vault_list_property_values` — explore values for any property key",
  findOrphans: "- `vault_find_orphans` — full orphan list with exclusion control",
  getMemory: "- `vault_get_memory` — read memory files in detail",
  readNote: "- `vault_read_note` — read any note's full content",
  listFiles: "- `vault_list_files` — browse non-markdown files (images, canvases, data files)",
} as const

const expectedFooter = (menuLines: readonly string[]): string => {
  return ["Go deeper with the vault tools:", ...menuLines].join("\n")
}

/** Sections for setupVault()'s default fixture: Projects/alpha.md (mtime 3000;
 *  title, type, tags, status) and Reference/bravo.md (mtime 2000; title, type,
 *  tags) indexed with no links between them, plus Opinions.md and Principles.md
 *  written to the memory folder on disk but not indexed. */
const DEFAULT_FIXTURE_SECTIONS = {
  // Folders come from every note on disk, so the unindexed memory folder counts
  stats: "2 notes across 3 folders, 2 tags, 4 property keys.",
  folders: "- About Me (2)\n- Projects (1)\n- Reference (1)",
  tags: "- #project (1)\n- #reference (1)",
  // Keys by note count, then name; samples by occurrence count, then value
  propertyKeys: [
    "- tags (2/2 — 100%) — e.g. project, reference",
    "- title (2/2 — 100%) — e.g. Alpha, Bravo",
    "- type (2/2 — 100%) — e.g. project, reference",
    "- status (1/2 — 50%) — e.g. active",
  ].join("\n"),
  recent: "- Projects/alpha.md — Alpha\n- Reference/bravo.md — Bravo",
  orphans: [
    "2 orphan notes (no incoming links):",
    "- Projects/alpha.md — Alpha",
    "- Reference/bravo.md — Bravo",
  ].join("\n"),
}

/** The default fixture's memory files with their H2 sections and entry counts. */
const DEFAULT_FIXTURE_MEMORY_OUTLINE = [
  "- Opinions",
  "  - Tools and workflows (newest first) (1)",
  "- Principles",
  "  - Decision heuristics (newest first) (2)",
].join("\n")

/** The whole survey in the prompt's section order. `memory` is absent when
 *  MEMORY_ENABLED=false drops the section. */
const buildExpectedSurvey = (survey: {
  stats: string
  folders: string
  tags: string
  propertyKeys: string
  recent: string
  orphans: string
  memory?: { memoryDir: string; outline: string }
  menuLines: readonly string[]
}): string => {
  const memoryLines = survey.memory
    ? ["", `## Memory (${survey.memory.memoryDir}/)`, survey.memory.outline]
    : []

  return [
    "# Vault orientation",
    "",
    "This vault is a structured, convention-driven Obsidian system. Survey its structure and health below, then use the vault tools to go deeper.",
    "",
    "## Vault stats",
    survey.stats,
    "",
    "## Folders",
    survey.folders,
    "",
    "## Tags",
    survey.tags,
    "",
    "## Property keys",
    survey.propertyKeys,
    "",
    "## Recently modified",
    survey.recent,
    "",
    "## Orphans",
    survey.orphans,
    ...memoryLines,
    "",
    "---",
    expectedFooter(survey.menuLines),
  ].join("\n")
}

describe("vault-orientation handler", () => {
  it("returns sentinels and never throws on an empty vault", async () => {
    const { calls } = await setupVault({
      config: loadConfig({}),
      indexNotes: false,
      memoryFiles: false,
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(text).toBe(
      buildExpectedSurvey({
        stats: "0 notes across 0 folders, 0 tags, 0 property keys.",
        folders: "No folders yet — notes live at the vault root.",
        tags: "No tags yet.",
        propertyKeys: "No frontmatter properties yet.",
        recent: "No notes yet.",
        orphans: "No orphans found after folder exclusions.",
        memory: {
          memoryDir: "About Me",
          outline:
            "No memory files yet — the About Me/ layer is empty. Use vault_update_memory to start it.",
        },
        // No orphans, so no vault_find_orphans line
        menuLines: [
          MENU_LINE.search,
          MENU_LINE.searchByTag,
          MENU_LINE.listPropertyValues,
          MENU_LINE.getMemory,
          MENU_LINE.readNote,
          MENU_LINE.listFiles,
        ],
      }),
    )
  })

  it("shows the stats line with note, folder, tag, and property key counts", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(surveySection(text, "Vault stats")).toBe(DEFAULT_FIXTURE_SECTIONS.stats)
  })

  it("shows folder note counts instead of bare names", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(surveySection(text, "Folders")).toBe(DEFAULT_FIXTURE_SECTIONS.folders)
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

    // The empty About Me folder holds no notes, so it is not listed
    expect(surveySection(text, "Folders")).toBe("- Zeta (1)\n- alpha (1)")
  })

  it("shows orphan count and sample when orphans exist", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(surveySection(text, "Orphans")).toBe(DEFAULT_FIXTURE_SECTIONS.orphans)
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

    expect(surveySection(text, "Orphans")).toBe("No orphans found after folder exclusions.")
  })

  it("shows each property key's adoption as count/total with sample values", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(surveySection(text, "Property keys")).toBe(DEFAULT_FIXTURE_SECTIONS.propertyKeys)
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

    // 1/21 rounds to 5% yet sits under the 5% threshold. Every title value
    // occurs once, so the three samples are the first in text order.
    expect(surveySection(text, "Property keys")).toBe(
      [
        "- title (21/21 — 100%) — e.g. Note 0, Note 1, Note 10",
        "- rare (1/21 — 5%) — e.g. yes (low adoption)",
      ].join("\n"),
    )
  })

  it("suggests vault_find_orphans in footer when orphans exist", async () => {
    const { calls } = await setupVault()
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(surveyFooter(text)).toBe(
      expectedFooter([
        MENU_LINE.search,
        MENU_LINE.searchByTag,
        MENU_LINE.listPropertyValues,
        MENU_LINE.findOrphans,
        MENU_LINE.getMemory,
        MENU_LINE.readNote,
        MENU_LINE.listFiles,
      ]),
    )
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

    expect(surveyFooter(text)).toBe(
      expectedFooter([
        MENU_LINE.search,
        MENU_LINE.searchByTag,
        MENU_LINE.listPropertyValues,
        MENU_LINE.getMemory,
        MENU_LINE.readNote,
        MENU_LINE.listFiles,
      ]),
    )
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

    expect(surveySection(text, "Vault stats")).toBe(
      "1 notes across 0 folders, 0 tags, 0 property keys. 1 untagged. 1 without properties. 2 broken links.",
    )
  })
})

// ── Error degradation ────────────────────────────────────────────

describe("vault-orientation error degradation", () => {
  it("returns a fallback (no throw) when the index fails", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-err-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    const throwingSearch = createSearchIndex(":memory:")
    vi.spyOn(throwingSearch, "listAllTags").mockImplementation(() => {
      throw new Error("index unavailable")
    })
    const calls = registerWithSearch(vault, throwingSearch)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]

    const text = textOf(await handler(fakeExtra))
    expect(text).toBe(
      "Could not fully survey the vault ([Error]: index unavailable). You can still explore it directly with the vault tools — try vault_list_tags, vault_list_property_keys, vault_find_orphans, or vault_list_memory_files.",
    )
  })

  it("names a file a filesystem error quotes vault-relative in the fallback", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-err-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    const throwingSearch = createSearchIndex(":memory:")
    vi.spyOn(throwingSearch, "listAllTags").mockImplementation(() => {
      throw Object.assign(
        new Error(`EACCES: permission denied, open '${vault}/Projects/plan.md'`),
        { code: "EACCES" },
      )
    })
    const calls = registerWithSearch(vault, throwingSearch)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]

    const text = textOf(await handler(fakeExtra))
    expect(text).toBe(
      "Could not fully survey the vault ([Error]: EACCES: permission denied, open 'Projects/plan.md'). You can still explore it directly with the vault tools — try vault_list_tags, vault_list_property_keys, vault_find_orphans, or vault_list_memory_files.",
    )
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
    const throwingSearch = createSearchIndex(":memory:")
    vi.spyOn(throwingSearch, "listAllTags").mockImplementation(() => {
      throw new Error("index unavailable")
    })
    const calls = registerWithSearch(vault, throwingSearch, recordingLogger(logs))
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]

    await handler(fakeExtra)
    expect(logs.filter((call) => call.message === "prompt_error")).toEqual([
      {
        level: "error",
        message: "prompt_error",
        data: { requestId: "1", prompt: "vault-orientation", error: "[Error]: index unavailable" },
      },
    ])
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

  it("omits the Memory section and the vault_get_memory suggestion", async () => {
    const { calls } = await setupVault({ config: disabledConfig })
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    // The memory files stay on disk, so their folder is still counted
    expect(text).toBe(
      buildExpectedSurvey({
        ...DEFAULT_FIXTURE_SECTIONS,
        menuLines: [
          MENU_LINE.search,
          MENU_LINE.searchByTag,
          MENU_LINE.listPropertyValues,
          MENU_LINE.findOrphans,
          MENU_LINE.readNote,
          MENU_LINE.listFiles,
        ],
      }),
    )
  })

  it("error fallback omits vault_list_memory_files", async () => {
    const vault = await mkdtemp(join(tmpdir(), "prompt-mem-disabled-"))
    onTestFinished(async () => {
      await rm(vault, { recursive: true, force: true })
    })
    const throwingSearch = createSearchIndex(":memory:")
    vi.spyOn(throwingSearch, "listAllTags").mockImplementation(() => {
      throw new Error("index unavailable")
    })
    const calls = registerWithSearch(vault, throwingSearch, logger, disabledConfig)
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(text).toBe(
      "Could not fully survey the vault ([Error]: index unavailable). You can still explore it directly with the vault tools — try vault_list_tags, vault_list_property_keys, or vault_find_orphans.",
    )
  })
})

// ── FILE_TOOLS_ENABLED=false ──────────────────────────────────

describe("vault-orientation with FILE_TOOLS_ENABLED=false", () => {
  const disabledConfig = loadConfig({ FILE_TOOLS_ENABLED: "false" })

  it("omits vault_list_files from the go-deeper tools", async () => {
    const { calls } = await setupVault({ config: disabledConfig })
    const handler = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)[2]
    const text = textOf(await handler(fakeExtra))

    expect(surveyFooter(text)).toBe(
      expectedFooter([
        MENU_LINE.search,
        MENU_LINE.searchByTag,
        MENU_LINE.listPropertyValues,
        MENU_LINE.findOrphans,
        MENU_LINE.getMemory,
        MENU_LINE.readNote,
      ]),
    )
  })
})

// ── READONLY_MODE=true ──────────────────────────────────────────

describe("vault-orientation with READONLY_MODE=true", () => {
  it("empty-memory fallback omits the vault_update_memory suggestion", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ READONLY_MODE: "true" }),
      indexNotes: false,
      memoryFiles: false,
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    // The empty-memory sentinel is present, so the fallback ran; only the
    // write-tool suggestion is dropped.
    expect(surveySection(text, "Memory (About Me/)")).toBe(
      "No memory files yet — the About Me/ layer is empty.",
    )
  })
})

// ── Genericness ─────────────────────────────────────────────────

describe("vault-orientation genericness", () => {
  it("surfaces a custom MEMORY_DIR's memory files and never names About Me", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ MEMORY_DIR: "Profile" }),
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(text).toBe(
      buildExpectedSurvey({
        ...DEFAULT_FIXTURE_SECTIONS,
        folders: "- Profile (2)\n- Projects (1)\n- Reference (1)",
        memory: { memoryDir: "Profile", outline: DEFAULT_FIXTURE_MEMORY_OUTLINE },
        menuLines: [
          MENU_LINE.search,
          MENU_LINE.searchByTag,
          MENU_LINE.listPropertyValues,
          MENU_LINE.findOrphans,
          MENU_LINE.getMemory,
          MENU_LINE.readNote,
          MENU_LINE.listFiles,
        ],
      }),
    )
  })
})

// ── DISABLED_TOOLS ──────────────────────────────────────────────

// The survey's "go deeper" list is a menu of calls to make, so each line is
// gated on its own tool, not on its tool group's flag.
describe("vault-orientation with DISABLED_TOOLS", () => {
  it("empty-memory fallback omits the suggestion when vault_update_memory is disabled", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ DISABLED_TOOLS: "vault_update_memory" }),
      indexNotes: false,
      memoryFiles: false,
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(surveySection(text, "Memory (About Me/)")).toBe(
      "No memory files yet — the About Me/ layer is empty.",
    )
  })

  it("drops only the disabled tool from the go-deeper menu", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ DISABLED_TOOLS: "vault_get_memory" }),
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    // The rest of the menu survives — the memory group is still enabled.
    expect(surveyFooter(text)).toBe(
      expectedFooter([
        MENU_LINE.search,
        MENU_LINE.searchByTag,
        MENU_LINE.listPropertyValues,
        MENU_LINE.findOrphans,
        MENU_LINE.readNote,
        MENU_LINE.listFiles,
      ]),
    )
  })

  it("drops the search line when vault_search is disabled", async () => {
    const { calls } = await setupVault({
      config: loadConfig({ DISABLED_TOOLS: "vault_search" }),
    })
    const [, , handler] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    const text = textOf(await handler(fakeExtra))

    expect(surveyFooter(text)).toBe(
      expectedFooter([
        MENU_LINE.searchByTag,
        MENU_LINE.listPropertyValues,
        MENU_LINE.findOrphans,
        MENU_LINE.getMemory,
        MENU_LINE.readNote,
        MENU_LINE.listFiles,
      ]),
    )
  })
})

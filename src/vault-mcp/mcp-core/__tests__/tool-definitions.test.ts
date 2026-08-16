import { describe, it, expect, beforeEach, vi, onTestFinished } from "vitest"
import sharp from "sharp"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { z } from "zod"
import { computeEnabledToolNames, registerTools } from "../tool-definitions.js"
import { TOOL_NAMES, TOOL_REGISTRY } from "../tool-registry.js"
import { loadConfig } from "../../config.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createSearchIndex } from "../../search/search-index.js"
import type { SearchIndex } from "../../search/search-index.js"
import { logger } from "../../../logger.js"

const ALL_TOOL_NAMES = Object.values(TOOL_NAMES)

// Expected sets derive from the registry so a new tool joins them
// automatically; the literal spot-checks in tool-registry.test.ts anchor the
// classification itself, so a registry typo cannot self-certify here.
const READ_ONLY_TOOLS = TOOL_REGISTRY.filter(
  (entry) => entry.annotations.readOnlyHint,
).map((entry) => entry.name)

const DESTRUCTIVE_TOOLS = TOOL_REGISTRY.filter(
  (entry) => entry.annotations.destructiveHint,
).map((entry) => entry.name)

// Writers that only add to the vault — never overwrite or delete existing
// content — so destructiveHint must be false even though readOnlyHint is too.
const ADDITIVE_WRITE_TOOLS = TOOL_REGISTRY.filter(
  (entry) =>
    !entry.annotations.readOnlyHint && !entry.annotations.destructiveHint,
).map((entry) => entry.name)

const WRITE_TOOLS = [
  TOOL_NAMES.VAULT_WRITE_NOTE,
  TOOL_NAMES.VAULT_PATCH_NOTE,
  TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
  TOOL_NAMES.VAULT_MOVE_NOTE,
  TOOL_NAMES.VAULT_UPDATE_MEMORY,
  TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
] as const

type RegisterToolCall = [
  name: string,
  config: {
    title?: string
    description?: string
    inputSchema?: Record<string, z.ZodType>
    annotations?: Record<string, boolean>
  },
  handler: (...args: unknown[]) => Promise<unknown>,
]

let mockServer: { registerTool: ReturnType<typeof vi.fn> }
let calls: RegisterToolCall[]

beforeEach(() => {
  mockServer = { registerTool: vi.fn() }
  registerTools({
    server: mockServer as unknown as McpServer,
    vaultPath: "/test-vault",
    search: {} as SearchIndex,
    logger,
    config: loadConfig({}),
  })
  calls = mockServer.registerTool.mock.calls as RegisterToolCall[]
})

const findCall = (name: string): RegisterToolCall | undefined =>
  calls.find(([toolName]) => toolName === name)

/** findCall for tests that assume the tool is registered — throws instead of
 *  returning undefined so call sites need no non-null assertion. */
const requireCall = (name: string): RegisterToolCall => {
  const call = findCall(name)
  if (!call) throw new Error(`tool not registered: ${name}`)
  return call
}

describe("registerTools", () => {
  it(`registers exactly ${ALL_TOOL_NAMES.length} tools`, () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(ALL_TOOL_NAMES.length)
  })

  it("registered tools and TOOL_REGISTRY entries are the same set", () => {
    const registeredNames = calls.map(([toolName]) => toolName).toSorted()
    const registryNames = TOOL_REGISTRY.map((entry) => entry.name).toSorted()
    expect(registeredNames).toEqual(registryNames)
  })

  it.each(ALL_TOOL_NAMES)("registers %s", (name) => {
    expect(findCall(name)).toBeDefined()
  })

  it("every tool has a non-empty title", () => {
    for (const [, config] of calls) {
      expect(typeof config.title).toBe("string")
      expect(config.title).not.toBe("")
    }
  })

  it("every tool has a non-empty description", () => {
    for (const [, config] of calls) {
      expect(typeof config.description).toBe("string")
      expect(config.description).not.toBe("")
    }
  })

  it("every tool description includes an example", () => {
    for (const [, config] of calls) {
      expect(config.description).toContain("Example:")
    }
  })

  it("every tool description includes when to use guidance", () => {
    for (const [, config] of calls) {
      expect(config.description).toContain("When to use")
    }
  })

  it("every tool description includes a returns section", () => {
    for (const [, config] of calls) {
      expect(config.description).toContain("Returns:")
    }
  })

  it.each(WRITE_TOOLS)(
    "%s description includes Obsidian syntax guidance",
    (name) => {
      const [, config] = requireCall(name)
      expect(config.description).toContain("Obsidian syntax:")
    },
  )

  it("vault_replace_in_note description clarifies in-place scope", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_REPLACE_IN_NOTE)
    expect(config.description).toContain("in place")
    expect(config.description).toContain("vault_read_note")
  })

  it("vault_patch_note description includes cross-section move guidance", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_PATCH_NOTE)
    expect(config.description).toContain("Cross-section move")
  })

  it("vault_read_note description documents the outline's leading_content field", () => {
    // The only guard against this drifting from the actual response shape.
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    expect(config.description).toContain(
      "Outline shape: { leading_callout?, leading_content?, headings }",
    )
  })

  it("vault_patch_note description routes a section-above-first-heading insert to insert_before", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_PATCH_NOTE)
    expect(config.description).toContain(
      "To start a new section above the note's current first heading, use insert_before on that heading, not a no-heading prepend.",
    )
  })

  it("vault_patch_note description does not list the displacement advisory as an error", () => {
    // Agents treat Errors: as failure modes — a successful write described
    // there would prompt a needless retry or abort.
    const [, config] = requireCall(TOOL_NAMES.VAULT_PATCH_NOTE)
    const description = config.description ?? ""
    const errorsSection = description.slice(
      description.indexOf("Errors:"),
      description.indexOf("Obsidian syntax:"),
    )
    expect(errorsSection).not.toContain("becomes the new section's body")
    expect(description).toContain("becomes the new section's body")
  })

  it.each([TOOL_NAMES.VAULT_UPDATE_MEMORY, TOOL_NAMES.VAULT_DELETE_MEMORY])(
    "%s description documents the shrink-guard error",
    (name) => {
      const [, config] = requireCall(name)
      expect(config.description).toContain("Errors:")
      expect(config.description).toContain("refusing memory write")
    },
  )

  it("vault_update_memory description documents the duplicate no-op contract", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_UPDATE_MEMORY)
    // Assert the full contract fragment — a bare "idempotent" check would
    // also pass on a reworded "not idempotent" description.
    expect(config.description).toContain(
      "Idempotent — an exact duplicate (same date + text in the same section) is a no-op",
    )
  })

  it("memory tool descriptions document the entry-policy contract", () => {
    // Append-only is the default; the living opt-in must be discoverable from
    // the tools that write, delete, and list memory — not only from templates.
    const [, updateConfig] = requireCall(TOOL_NAMES.VAULT_UPDATE_MEMORY)
    expect(updateConfig.description).toContain("entry-policy: living")
    const [, deleteConfig] = requireCall(TOOL_NAMES.VAULT_DELETE_MEMORY)
    expect(deleteConfig.description).toContain("entry-policy: living")
    const [, listConfig] = requireCall(TOOL_NAMES.VAULT_LIST_MEMORY_FILES)
    expect(listConfig.description).toContain(
      'entry_policy is "append-only" (the default',
    )
  })

  it("vault_delete_memory description documents duplicate-entry remediation", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_DELETE_MEMORY)
    expect(config.description).toContain("ambiguous")
    expect(config.description).toContain(
      "vault_update_memory refuses to write exact duplicates",
    )
  })

  it("vault_update_properties description documents null-deletes-key contract", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_UPDATE_PROPERTIES)
    expect(config.description).toContain("null deletes a key")
  })

  it("vault_write_note description documents null-deletes-key contract", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_WRITE_NOTE)
    expect(config.description).toContain("keys set to null removed")
  })

  it("vault_write_note description documents the already-exists error", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_WRITE_NOTE)
    expect(config.description).toContain("note already exists")
  })

  it("vault_write_note exposes an optional overwrite boolean in its schema", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_WRITE_NOTE)
    const overwriteSchema = config.inputSchema?.overwrite
    expect(overwriteSchema).toBeDefined()
    expect(overwriteSchema?.safeParse(true).success).toBe(true)
    expect(overwriteSchema?.safeParse(undefined).success).toBe(true)
  })

  it("vault_recent_notes description documents sorting behavior", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_RECENT_NOTES)
    expect(config.description).toContain("filesystem mtime")
    expect(config.description).toContain("sort last")
  })

  it("vault_read_note description cross-references graph tools", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    expect(config.description).toContain("vault_get_backlinks")
    expect(config.description).toContain("vault_get_outgoing_links")
  })

  it("vault_search_by_property parameters cross-reference discovery tools", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY)
    expect(config.description).toContain("vault_list_property_keys")
    expect(config.description).toContain("vault_list_property_values")
  })

  it("vault_list_notes description cross-references vault_read_note", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_LIST_NOTES)
    expect(config.description).toContain("vault_read_note")
  })

  it("vault_get_daily_note description cross-references vault_recent_notes", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_GET_DAILY_NOTE)
    expect(config.description).toContain("vault_recent_notes")
  })

  it("vault_list_tags description documents frontmatter-only tag counting", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_LIST_TAGS)
    expect(config.description).toContain("frontmatter tags")
    expect(config.description).toContain("unique notes")
  })

  it("vault_get_daily_note description documents future date support", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_GET_DAILY_NOTE)
    expect(config.description).toContain("future dates")
  })

  it("vault_list_notes description includes empty-result contract", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_LIST_NOTES)
    expect(config.description).toContain("Errors:")
    expect(config.description).toContain("empty array, not an error")
  })

  it("vault_search_by_folder description cross-references graph tools", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_SEARCH_BY_FOLDER)
    expect(config.description).toContain("vault_get_backlinks")
  })

  it("vault_read_file description cross-references discovery and note tools", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_FILE)
    expect(config.description).toContain("vault_list_files")
    expect(config.description).toContain("vault_get_outgoing_links")
    expect(config.description).toContain("vault_read_note")
  })

  it("vault_read_file description documents the line-paging error contracts", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_FILE)
    expect(config.description).toContain('"start line past the end"')
    expect(config.description).toContain('"line range is not available"')
    expect(config.description).toContain("page it with start_line and limit")
  })

  it("vault_list_files description cross-references vault_read_file", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_LIST_FILES)
    expect(config.description).toContain("vault_read_file")
  })

  it("vault_read_note description routes non-md paths to vault_read_file", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    expect(config.description).toContain("vault_read_file")
  })

  it("vault_get_outgoing_links description cross-references vault_read_file", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_GET_OUTGOING_LINKS)
    expect(config.description).toContain("vault_read_file")
  })

  it("every tool has all 4 annotation hints", () => {
    for (const [, config] of calls) {
      const annotations = config.annotations!
      expect(annotations).toHaveProperty("readOnlyHint")
      expect(annotations).toHaveProperty("destructiveHint")
      expect(annotations).toHaveProperty("idempotentHint")
      expect(annotations).toHaveProperty("openWorldHint")
    }
  })
})

describe("annotations", () => {
  it.each(READ_ONLY_TOOLS)("%s has readOnlyHint: true", (name) => {
    const [, config] = requireCall(name)
    expect(config.annotations?.readOnlyHint).toBe(true)
    expect(config.annotations?.destructiveHint).toBe(false)
  })

  it.each(DESTRUCTIVE_TOOLS)("%s has destructiveHint: true", (name) => {
    const [, config] = requireCall(name)
    expect(config.annotations?.destructiveHint).toBe(true)
    expect(config.annotations?.readOnlyHint).toBe(false)
  })

  it.each(ADDITIVE_WRITE_TOOLS)("%s is a non-destructive write", (name) => {
    const [, config] = requireCall(name)
    expect(config.annotations?.readOnlyHint).toBe(false)
    expect(config.annotations?.destructiveHint).toBe(false)
  })

  it("vault_update_memory has idempotentHint: true (exact duplicates are no-ops)", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_UPDATE_MEMORY)
    expect(config.annotations?.idempotentHint).toBe(true)
  })

  it("vault_write_note has idempotentHint: false (create-only default errors on retry)", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_WRITE_NOTE)
    expect(config.annotations?.idempotentHint).toBe(false)
  })

  it("all tools have openWorldHint: false", () => {
    for (const [, config] of calls) {
      expect(config.annotations?.openWorldHint).toBe(false)
    }
  })
})

describe("config interpolation in descriptions", () => {
  const CUSTOM_MEMORY_DIR = "Profile"
  const customConfig = loadConfig({ MEMORY_DIR: CUSTOM_MEMORY_DIR })
  const customCalls = (() => {
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: customConfig,
    })
    return server.registerTool.mock.calls as RegisterToolCall[]
  })()

  /** Like requireCall, but over the custom-config registration — throws
   *  instead of returning undefined so call sites need no non-null assertion. */
  const requireCustomCall = (name: string): RegisterToolCall => {
    const call = customCalls.find(([toolName]) => toolName === name)
    if (!call) throw new Error(`tool not registered: ${name}`)
    return call
  }

  const DEFAULT_MEMORY_REF = "About Me/"

  const memoryDirTools = [
    { name: "vault_get_memory", toolName: TOOL_NAMES.VAULT_GET_MEMORY },
    { name: "vault_update_memory", toolName: TOOL_NAMES.VAULT_UPDATE_MEMORY },
    {
      name: "vault_list_memory_files",
      toolName: TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    },
    { name: "vault_delete_memory", toolName: TOOL_NAMES.VAULT_DELETE_MEMORY },
    { name: "vault_memory_recall", toolName: TOOL_NAMES.VAULT_MEMORY_RECALL },
    { name: "vault_read_note", toolName: TOOL_NAMES.VAULT_READ_NOTE },
  ] as const

  it.each(memoryDirTools)(
    "$name description references the configured memory dir",
    ({ toolName }) => {
      const [, config] = requireCustomCall(toolName)
      expect(config.description).toContain(`${CUSTOM_MEMORY_DIR}/`)
      expect(config.description).not.toContain(DEFAULT_MEMORY_REF)
    },
  )

  it("vault_delete_note description lists configured protected paths", () => {
    const [, config] = requireCustomCall(TOOL_NAMES.VAULT_DELETE_NOTE)
    expect(config.description).toContain("Profile/")
    expect(config.description).not.toContain("About Me/")
  })

  it("vault_delete_note description includes memory hint when memory is enabled", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_DELETE_NOTE)
    expect(config.description).toContain(
      "use vault_delete_memory for memory entries",
    )
  })

  it("vault_find_orphans description references configured exclusion folders", () => {
    const [, config] = requireCustomCall(TOOL_NAMES.VAULT_FIND_ORPHANS)
    expect(config.description).toContain(CUSTOM_MEMORY_DIR)
    expect(config.description).not.toContain("About Me")
  })
})

describe("error handling", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  it("vault_read_note handler returns isError on failure", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      '[Error]: note not found: "nonexistent.md"',
    )
  })

  it("error text does not contain stack traces", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0]?.text).not.toContain("    at ")
    expect(result.content[0]?.text).not.toContain("node:internal")
  })

  it("vault_get_memory rejects section without file", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_GET_MEMORY)
    const result = (await handler(
      { file: undefined, section: "Decision heuristics" },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("section requires a file")
  })

  it("vault_get_memory handler returns isError on failure", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_GET_MEMORY)
    const result = (await handler(
      { file: "Nonexistent", section: undefined },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      '[Error]: memory file not found: "About Me/Nonexistent.md"',
    )
  })

  it("vault_read_note rejects combining outline with heading", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler(
      { path: "note.md", outline: true, heading: "Active" },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      "outline, heading, and properties_only are mutually exclusive — set at most one",
    )
  })

  it("vault_read_note rejects heading_level without a heading", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler(
      { path: "note.md", heading_level: 2 },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("heading_level requires a heading")
  })
})

describe("vault_read_note line paging", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  const createPagedNoteFixture = async () => {
    const tempVault = await mkdtemp(join(tmpdir(), "tool-defs-note-paging-"))
    onTestFinished(() => rm(tempVault, { recursive: true, force: true }))
    await writeFile(
      join(tempVault, "paged.md"),
      "---\ntitle: Paged\n---\nline1\nline2\nline3\nline4\n",
      "utf8",
    )
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: tempVault,
      search: {} as SearchIndex,
      logger,
      config: loadConfig({}),
    })
    const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
    const readCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE,
    )
    if (!readCall) throw new Error("vault_read_note not registered")
    return { handler: readCall[2], tempVault }
  }

  it("pages a full note and prepends the window metadata block", async () => {
    const { handler } = await createPagedNoteFixture()
    const result = (await handler(
      { path: "paged.md", start_line: 2, limit: 2 },
      mockExtra,
    )) as { content: Array<{ type: string; text: string }> }

    expect(result.content).toEqual([
      {
        type: "text",
        text: "paged.md — lines 2–3 of 7 (continue with start_line: 4)",
      },
      { type: "text", text: "title: Paged\n---" },
    ])
  })

  it("reports end of file on the final window", async () => {
    const { handler } = await createPagedNoteFixture()
    const result = (await handler(
      { path: "paged.md", start_line: 6, limit: 10 },
      mockExtra,
    )) as { content: Array<{ type: string; text: string }> }

    expect(result.content).toEqual([
      { type: "text", text: "paged.md — lines 6–7 of 7 (end of file)" },
      { type: "text", text: "line3\nline4" },
    ])
  })

  it("pages a heading section", async () => {
    const { handler, tempVault } = await createPagedNoteFixture()
    await writeFile(
      join(tempVault, "sectioned.md"),
      "---\ntitle: Sectioned\n---\n## Active\nalpha\nbeta\ngamma\ndelta\n## Done\nfin\n",
      "utf8",
    )
    const result = (await handler(
      { path: "sectioned.md", heading: "Active", start_line: 1, limit: 2 },
      mockExtra,
    )) as { content: Array<{ type: string; text: string }> }

    expect(result.content).toEqual([
      {
        type: "text",
        text: "sectioned.md — lines 1–2 of 5 (continue with start_line: 3)",
      },
      { type: "text", text: "## Active\nalpha" },
    ])
  })

  it("reports a zero-line window for an empty note", async () => {
    const { handler, tempVault } = await createPagedNoteFixture()
    await writeFile(join(tempVault, "empty.md"), "", "utf8")
    const result = (await handler(
      { path: "empty.md", start_line: 1 },
      mockExtra,
    )) as { content: Array<{ type: string; text: string }> }

    expect(result.content).toEqual([
      { type: "text", text: "empty.md — 0 lines (end of file)" },
      { type: "text", text: "" },
    ])
  })

  it("rejects start_line past the end of the note", async () => {
    const { handler } = await createPagedNoteFixture()
    const result = (await handler(
      { path: "paged.md", start_line: 99 },
      mockExtra,
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean }

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '[Error]: start line past the end: "paged.md" renders to 7 lines',
        },
      ],
    })
  })

  it("rejects paging with outline mode", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler(
      { path: "note.md", outline: true, start_line: 1 },
      mockExtra,
    )) as { content: Array<{ text: string }>; isError?: boolean }

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      "line paging is not available in outline mode",
    )
  })

  it("rejects paging with properties_only mode", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler(
      { path: "note.md", properties_only: true, limit: 5 },
      mockExtra,
    )) as { content: Array<{ text: string }>; isError?: boolean }

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      "line paging is not available in properties_only mode",
    )
  })

  it("returns byte-identical content without paging params", async () => {
    const { handler } = await createPagedNoteFixture()
    const result = (await handler({ path: "paged.md" }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
    }

    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.text).toBe(
      "---\ntitle: Paged\n---\nline1\nline2\nline3\nline4\n",
    )
  })

  it("description documents the paging error contracts", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    expect(config.description).toContain("start line past the end")
    expect(config.description).toContain(
      "line paging is not available in outline mode",
    )
    expect(config.description).toContain("properties_only mode")
  })
})

describe("vault_update_memory input schema", () => {
  // Rich validation (single-line entries, calendar-valid dates) lives in the
  // data layer, where failures flow through safeHandler as structured tool
  // errors — by convention tool schemas stay at min(1). These tests catch an
  // empty-string guard being dropped (an empty file name would silently
  // create "About Me/.md").
  const requireUpdateMemorySchema = (): Record<string, z.ZodType> => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_UPDATE_MEMORY)
    if (!config.inputSchema) {
      throw new Error("vault_update_memory has no input schema")
    }
    return config.inputSchema
  }

  it.each([
    { field: "file", validValue: "Principles" },
    { field: "section", validValue: "Decision heuristics (newest first)" },
    { field: "entry", validValue: "a single-line entry" },
  ])(
    "$field rejects an empty string and accepts a non-empty one",
    ({ field, validValue }) => {
      const schema = requireUpdateMemorySchema()
      expect(schema[field]?.safeParse("").success).toBe(false)
      expect(schema[field]?.safeParse(validValue).success).toBe(true)
    },
  )

  it("options.date rejects an empty string and accepts a date", () => {
    const schema = requireUpdateMemorySchema()
    expect(schema.options?.safeParse({ date: "" }).success).toBe(false)
    expect(schema.options?.safeParse({ date: "2026-07-02" }).success).toBe(true)
  })
})

describe("vault_update_memory handler", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  it("reports the duplicate no-op instead of the append confirmation when retried", async () => {
    // A real temp vault so the handler exercises the actual memory store —
    // the global harness registers against a nonexistent path.
    const tempVault = await mkdtemp(join(tmpdir(), "tool-definitions-memory-"))
    onTestFinished(() => rm(tempVault, { recursive: true, force: true }))
    await mkdir(join(tempVault, "About Me"), { recursive: true })
    await writeFile(
      join(tempVault, "About Me/Principles.md"),
      "# Principles\n\n## Decision heuristics (newest first)\n- **2026-05-06**: seeded entry\n",
      "utf8",
    )
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: tempVault,
      search: {} as SearchIndex,
      logger,
      config: loadConfig({}),
    })
    const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
    const updateMemoryCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_UPDATE_MEMORY,
    )
    if (!updateMemoryCall) throw new Error("vault_update_memory not registered")
    const [, , handler] = updateMemoryCall

    const args = {
      file: "Principles",
      section: "Decision heuristics (newest first)",
      entry: "retry entry",
      options: { date: "2026-07-02" },
    }

    // First call appends and confirms — proves the entry actually landed
    // before the retry, so the no-op can't be a silent failure.
    const firstResult = (await handler(args, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(firstResult.isError).toBeUndefined()
    expect(firstResult.content[0]?.text).toBe(
      "Added entry to About Me/Principles.md → ## Decision heuristics (newest first)",
    )

    // Identical retry succeeds but reports the no-op instead of "Added entry".
    const retryResult = (await handler(args, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(retryResult.isError).toBeUndefined()
    expect(retryResult.content[0]?.text).toBe(
      "Entry already exists in About Me/Principles.md → ## Decision heuristics (newest first) — nothing was written.",
    )
  })
})

describe("vault_patch_note handler", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  /** A real temp vault seeded with one note, plus the registered patch handler —
   *  the global harness registers against a nonexistent path. */
  const setupPatchHandler = async (
    noteName: string,
    body: string,
  ): Promise<{
    handler: RegisterToolCall[2]
    readNote: () => Promise<string>
  }> => {
    const tempVault = await mkdtemp(join(tmpdir(), "tool-definitions-patch-"))
    onTestFinished(() => rm(tempVault, { recursive: true, force: true }))
    await writeFile(join(tempVault, noteName), body, "utf8")
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: tempVault,
      search: {} as SearchIndex,
      logger,
      config: loadConfig({}),
    })
    const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
    const patchCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_PATCH_NOTE,
    )
    if (!patchCall) throw new Error("vault_patch_note not registered")
    return {
      handler: patchCall[2],
      readNote: () => readFile(join(tempVault, noteName), "utf8"),
    }
  }

  it("appends an advisory naming the first heading and still writes the note", async () => {
    const { handler, readNote } = await setupPatchHandler(
      "intro.md",
      "Intro prose.\n\n## Section\n\nbody\n",
    )

    const result = await handler(
      {
        path: "intro.md",
        operation: "prepend",
        content: "## New Section\n- entry",
      },
      mockExtra,
    )

    // The heading is named by its bare text — that is what the `heading` param
    // matches, so a "## Section" form here would send the agent into
    // "heading not found".
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Applied prepend to intro.md → file body. The 12 bytes of pre-existing content above the note\'s first heading are now nested under the inserted heading. To add a section above the first heading without pulling existing content into it, use operation "insert_before" with heading "Section" (H2).',
        },
      ],
    })
    expect(await readNote()).toBe(
      "## New Section\n- entry\nIntro prose.\n\n## Section\n\nbody\n",
    )
  })

  it("recommends append when the note had no heading to insert before", async () => {
    const { handler, readNote } = await setupPatchHandler(
      "flat.md",
      "Just prose.\n",
    )

    const result = await handler(
      { path: "flat.md", operation: "prepend", content: "## New Section" },
      mockExtra,
    )

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Applied prepend to flat.md → file body. The note\'s entire pre-existing body (11 bytes) is now nested under the inserted heading — the note has no other headings to end the new section. To add a section below existing content instead, use operation "append".',
        },
      ],
    })
    expect(await readNote()).toBe("## New Section\nJust prose.\n")
  })

  it("returns the plain confirmation when nothing is displaced", async () => {
    // Without this, a handler that always appends the advisory would pass.
    const { handler, readNote } = await setupPatchHandler(
      "titled.md",
      "# Title\n\nIntro.\n\n## Section\n",
    )

    const result = await handler(
      { path: "titled.md", operation: "prepend", content: "## New Section" },
      mockExtra,
    )

    expect(result).toEqual({
      content: [
        { type: "text", text: "Applied prepend to titled.md → file body" },
      ],
    })
    expect(await readNote()).toBe(
      "## New Section\n# Title\n\nIntro.\n\n## Section\n",
    )
  })
})

describe("vault_read_note outline mode", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  it("serializes leading_callout, leading_content, and headings in that order", async () => {
    const tempVault = await mkdtemp(join(tmpdir(), "tool-definitions-outline-"))
    onTestFinished(() => rm(tempVault, { recursive: true, force: true }))
    await writeFile(
      join(tempVault, "both.md"),
      "> [!info] Scope\n> the callout body\n\nProse after the callout.\n\n## Section\n",
      "utf8",
    )
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: tempVault,
      search: {} as SearchIndex,
      logger,
      config: loadConfig({}),
    })
    const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
    const readCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE,
    )
    if (!readCall) throw new Error("vault_read_note not registered")

    const result = await readCall[2](
      { path: "both.md", outline: true },
      mockExtra,
    )

    // Exact JSON pins key order, which the conditional spreads determine.
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: '{"leading_callout":{"type":"info","title":"Scope","body":"the callout body"},"leading_content":"Prose after the callout.","headings":[{"level":2,"text":"Section","bytes":11}]}',
        },
      ],
    })
  })
})

describe("vault_search description reflects EMBEDDING_ENABLED", () => {
  const registerWithConfig = (
    env: Record<string, string>,
  ): RegisterToolCall[] => {
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: loadConfig(env),
    })
    const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
    return registeredCalls
  }

  const findSearchDescription = (
    registeredCalls: RegisterToolCall[],
  ): string => {
    const searchCall = registeredCalls.find(
      ([name]) => name === TOOL_NAMES.VAULT_SEARCH,
    )
    if (!searchCall) throw new Error("vault_search not registered")
    const description = searchCall[1].description
    if (!description) throw new Error("vault_search has no description")
    return description
  }

  it("describes hybrid search when EMBEDDING_ENABLED=true", () => {
    const description = findSearchDescription(registerWithConfig({}))
    expect(description).toContain("Hybrid search")
    expect(description).toContain("Reciprocal Rank Fusion")
    expect(description).toContain("semantic")
    expect(description).toContain("career aspirations")
    expect(description).toContain("search_mode")
  })

  it("describes keyword-only search when EMBEDDING_ENABLED=false", () => {
    const description = findSearchDescription(
      registerWithConfig({ EMBEDDING_ENABLED: "false" }),
    )
    expect(description).toContain("Full-text search")
    expect(description).not.toContain("Hybrid")
    expect(description).not.toContain("Reciprocal Rank Fusion")
    expect(description).not.toContain("semantic")
    expect(description).not.toContain("career aspirations")
    expect(description).toContain("search_mode")
  })
})

describe("vault_memory_recall description reflects EMBEDDING_ENABLED", () => {
  const registerWithConfig = (
    env: Record<string, string>,
  ): RegisterToolCall[] => {
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: loadConfig(env),
    })
    return server.registerTool.mock.calls as RegisterToolCall[]
  }

  const findRecallDescription = (
    registeredCalls: RegisterToolCall[],
  ): string => {
    const recallCall = registeredCalls.find(
      ([name]) => name === TOOL_NAMES.VAULT_MEMORY_RECALL,
    )
    if (!recallCall) throw new Error("vault_memory_recall not registered")
    const description = recallCall[1].description
    if (!description) throw new Error("vault_memory_recall has no description")
    return description
  }

  it("describes hybrid recall when EMBEDDING_ENABLED=true", () => {
    const description = findRecallDescription(registerWithConfig({}))
    expect(description).toContain("hybrid (keyword + semantic)")
    expect(description).toContain("oldest-first")
    expect(description).toContain("recall over precision")
    expect(description).toContain("truncated")
  })

  it("describes keyword-only recall when EMBEDDING_ENABLED=false", () => {
    const description = findRecallDescription(
      registerWithConfig({ EMBEDDING_ENABLED: "false" }),
    )
    expect(description).toContain("keyword retrieval")
    expect(description).toContain("re-query with synonyms")
    expect(description).not.toContain("hybrid")
    expect(description).toContain('search_mode is always "fts"')
  })
})

describe("MEMORY_ENABLED=false", () => {
  const MEMORY_TOOLS = [
    TOOL_NAMES.VAULT_GET_MEMORY,
    TOOL_NAMES.VAULT_UPDATE_MEMORY,
    TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    TOOL_NAMES.VAULT_DELETE_MEMORY,
    TOOL_NAMES.VAULT_MEMORY_RECALL,
  ] as const

  const NON_MEMORY_TOOL_COUNT = ALL_TOOL_NAMES.length - MEMORY_TOOLS.length

  const registerWithDisabledMemory = (): RegisterToolCall[] => {
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: loadConfig({ MEMORY_ENABLED: "false" }),
    })
    return server.registerTool.mock.calls as RegisterToolCall[]
  }

  it("does not register memory tools", () => {
    const disabledCalls = registerWithDisabledMemory()
    const registeredNames = disabledCalls.map(([toolName]) => toolName)
    for (const memoryTool of MEMORY_TOOLS) {
      expect(registeredNames).not.toContain(memoryTool)
    }
  })

  it(`registers all ${NON_MEMORY_TOOL_COUNT} non-memory tools`, () => {
    const disabledCalls = registerWithDisabledMemory()
    expect(disabledCalls).toHaveLength(NON_MEMORY_TOOL_COUNT)
  })

  it("non-memory tool descriptions do not reference memory tools", () => {
    const disabledCalls = registerWithDisabledMemory()
    const memoryToolReferences = [
      TOOL_NAMES.VAULT_GET_MEMORY,
      TOOL_NAMES.VAULT_UPDATE_MEMORY,
      TOOL_NAMES.VAULT_DELETE_MEMORY,
    ]
    for (const [, config] of disabledCalls) {
      const description = config.description!
      for (const memoryToolName of memoryToolReferences) {
        expect(description).not.toContain(memoryToolName)
      }
    }
  })
})

describe("FILE_TOOLS_ENABLED=false", () => {
  const FILE_TOOLS = [
    TOOL_NAMES.VAULT_READ_FILE,
    TOOL_NAMES.VAULT_LIST_FILES,
  ] as const

  const FILE_TOOL_SET = new Set<string>(FILE_TOOLS)
  const EXPECTED_NON_FILE_TOOLS = ALL_TOOL_NAMES.filter(
    (toolName) => !FILE_TOOL_SET.has(toolName),
  )

  const registerWithDisabledFileTools = (): RegisterToolCall[] => {
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: loadConfig({ FILE_TOOLS_ENABLED: "false" }),
    })
    return server.registerTool.mock.calls as RegisterToolCall[]
  }

  it("does not register file tools", () => {
    const disabledCalls = registerWithDisabledFileTools()
    const registeredNames = disabledCalls.map(([toolName]) => toolName)
    for (const fileTool of FILE_TOOLS) {
      expect(registeredNames).not.toContain(fileTool)
    }
  })

  it("registers exactly the non-file tools", () => {
    const disabledCalls = registerWithDisabledFileTools()
    const registeredNames = disabledCalls.map(([toolName]) => toolName)
    expect(new Set(registeredNames)).toEqual(new Set(EXPECTED_NON_FILE_TOOLS))
    expect(registeredNames).toHaveLength(EXPECTED_NON_FILE_TOOLS.length)
  })

  it("non-file tool descriptions do not reference file tools", () => {
    const disabledCalls = registerWithDisabledFileTools()
    for (const [, toolConfig] of disabledCalls) {
      expect(toolConfig.description).toBeDefined()
      for (const fileToolName of FILE_TOOLS) {
        expect(toolConfig.description).not.toContain(fileToolName)
      }
    }
  })
})

describe("READONLY_MODE=true", () => {
  const MUTATING_TOOLS = TOOL_REGISTRY.filter(
    (entry) => !entry.annotations.readOnlyHint,
  ).map((entry) => entry.name)

  const registerReadOnly = (
    extraEnv: Record<string, string> = {},
  ): RegisterToolCall[] => {
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: loadConfig({ READONLY_MODE: "true", ...extraEnv }),
    })
    return server.registerTool.mock.calls as RegisterToolCall[]
  }

  it("does not register mutating tools", () => {
    const readOnlyCalls = registerReadOnly()
    const registeredNames = readOnlyCalls.map(([toolName]) => toolName)
    for (const mutatingTool of MUTATING_TOOLS) {
      expect(registeredNames).not.toContain(mutatingTool)
    }
  })

  it(`registers exactly the ${READ_ONLY_TOOLS.length} read-only tools`, () => {
    const readOnlyCalls = registerReadOnly()
    const registeredNames = readOnlyCalls.map(([toolName]) => toolName)
    expect(new Set(registeredNames)).toEqual(new Set(READ_ONLY_TOOLS))
    expect(registeredNames).toHaveLength(READ_ONLY_TOOLS.length)
  })

  it("surviving tool descriptions do not reference mutating tools", () => {
    const readOnlyCalls = registerReadOnly()
    for (const [, toolConfig] of readOnlyCalls) {
      expect(toolConfig.description).toBeDefined()
      for (const mutatingToolName of MUTATING_TOOLS) {
        expect(toolConfig.description).not.toContain(mutatingToolName)
      }
    }
  })

  it("with MEMORY_ENABLED=false registers the read-only tools minus memory reads", () => {
    const readOnlyCalls = registerReadOnly({ MEMORY_ENABLED: "false" })
    const registeredNames = readOnlyCalls.map(([toolName]) => toolName)
    const memoryReadTools = new Set<string>([
      TOOL_NAMES.VAULT_GET_MEMORY,
      TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
      TOOL_NAMES.VAULT_MEMORY_RECALL,
    ])
    const expectedTools = READ_ONLY_TOOLS.filter(
      (toolName) => !memoryReadTools.has(toolName),
    )
    expect(new Set(registeredNames)).toEqual(new Set(expectedTools))
    expect(registeredNames).toHaveLength(expectedTools.length)
  })

  it("with FILE_TOOLS_ENABLED=false registers the read-only tools minus file tools", () => {
    const readOnlyCalls = registerReadOnly({ FILE_TOOLS_ENABLED: "false" })
    const registeredNames = readOnlyCalls.map(([toolName]) => toolName)
    const fileTools = new Set<string>([
      TOOL_NAMES.VAULT_READ_FILE,
      TOOL_NAMES.VAULT_LIST_FILES,
    ])
    const expectedTools = READ_ONLY_TOOLS.filter(
      (toolName) => !fileTools.has(toolName),
    )
    expect(new Set(registeredNames)).toEqual(new Set(expectedTools))
    expect(registeredNames).toHaveLength(expectedTools.length)
  })
})

describe("vault_memory_recall handler", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  /** Registers tools against a real in-memory index (no embedder — recall
   *  serves its lexical leg) seeded with one memory file, so handler tests
   *  exercise the actual query path including snake_case param mapping. */
  const registerWithMemoryIndex = (): RegisterToolCall => {
    const searchIndex = createSearchIndex(":memory:", undefined, undefined, {
      memoryDir: "About Me",
    })
    searchIndex.upsertNote(
      {
        filePath: "About Me/Opinions.md",
        rawContent: [
          "# Opinions",
          "",
          "## Code patterns (newest first)",
          "",
          "- **2026-07-02**: Mutation checks catch weak tests.",
          "- **2026-06-20**: Mutation of accumulators hides intent.",
          "- **2026-05-07**: Mutation testing proves the fix matters.",
        ].join("\n"),
        fileStat: { mtimeMs: 1000, size: 100 },
      },
      logger,
    )
    const memoryMockServer = { registerTool: vi.fn() }
    registerTools({
      server: memoryMockServer as unknown as McpServer,
      vaultPath: "/test-vault",
      search: searchIndex,
      logger,
      config: loadConfig({}),
    })
    const memoryCalls = memoryMockServer.registerTool.mock
      .calls as RegisterToolCall[]
    const call = memoryCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_MEMORY_RECALL,
    )
    if (!call) throw new Error("vault_memory_recall not registered")
    return call
  }

  it("maps max_results to the query layer and reports truncation", async () => {
    const [, , handler] = registerWithMemoryIndex()
    const result = (await handler(
      { query: "mutation", max_results: 2 },
      mockExtra,
    )) as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]?.text ?? "") as {
      entries: Array<{ file: string; date: string }>
      total: number
      truncated: boolean
      search_mode: string
    }
    // Three entries match "mutation"; max_results: 2 must reach the query
    // layer (the truncation is only observable if the mapping worked).
    expect(payload.total).toBe(3)
    expect(payload.truncated).toBe(true)
    expect(payload.entries).toHaveLength(2)
    expect(payload.search_mode).toBe("fts")
  })

  it("returns an empty evidence set for a no-match query, not an error", async () => {
    const [, , handler] = registerWithMemoryIndex()
    const result = (await handler(
      { query: "quantum chromodynamics" },
      mockExtra,
    )) as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]?.text ?? "") as {
      entries: unknown[]
      total: number
      truncated: boolean
    }
    expect(payload.entries).toEqual([])
    expect(payload.total).toBe(0)
    expect(payload.truncated).toBe(false)
  })
})

describe("vault_list_tasks handler", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  /** Registers tools against a real in-memory search index seeded with one
   *  task-bearing board (or caller-provided note content), so handler tests
   *  exercise the actual query path. */
  const registerWithTaskIndex = (
    rawContent = [
      "## Active",
      "",
      "- [ ] Open card ➕ 2026-06-20 📅 2026-07-01",
      "- [x] Done card ✅ 2026-06-28",
    ].join("\n"),
  ): RegisterToolCall => {
    const searchIndex = createSearchIndex(":memory:")
    searchIndex.upsertNote(
      {
        filePath: "Projects/board.md",
        rawContent,
        fileStat: { mtimeMs: 1000, size: 100 },
      },
      logger,
    )
    const taskMockServer = { registerTool: vi.fn() }
    registerTools({
      server: taskMockServer as unknown as McpServer,
      vaultPath: "/test-vault",
      search: searchIndex,
      logger,
      config: loadConfig({}),
    })
    const taskCalls = taskMockServer.registerTool.mock
      .calls as RegisterToolCall[]
    const call = taskCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_LIST_TASKS,
    )
    if (!call) throw new Error("vault_list_tasks not registered")
    return call
  }

  it("returns { total, tasks } with null and empty fields omitted", async () => {
    const [, , handler] = registerWithTaskIndex()
    const result = (await handler({}, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]?.text ?? "") as {
      total: number
      tasks: Array<Record<string, unknown>>
    }
    expect(payload.total).toBe(1)
    expect(payload.tasks[0]).toEqual({
      path: "Projects/board.md",
      line: 3,
      status: "todo",
      status_char: " ",
      description: "Open card",
      heading: "Active",
      folder: "Projects",
      created: "2026-06-20",
      due: "2026-07-01",
    })
  })

  it("keeps non-empty tags and depends_on arrays in the response", async () => {
    const [, , handler] = registerWithTaskIndex(
      "- [ ] Errand run #errand ⛔ dep-1, dep-2",
    )
    const result = (await handler({}, mockExtra)) as {
      content: Array<{ text: string }>
    }
    const payload = JSON.parse(result.content[0]?.text ?? "") as {
      tasks: Array<Record<string, unknown>>
    }
    // The whole-object match proves the empty/null-field filter drops only
    // null fields and empty arrays — populated arrays survive intact.
    expect(payload.tasks).toEqual([
      {
        path: "Projects/board.md",
        line: 1,
        status: "todo",
        status_char: " ",
        description: "Errand run #errand",
        folder: "Projects",
        depends_on: ["dep-1", "dep-2"],
        tags: ["errand"],
      },
    ])
  })

  it("maps sort_by and sort_direction through to the query", async () => {
    const [, , handler] = registerWithTaskIndex()
    const result = (await handler(
      { status: "all", sort_by: "done", sort_direction: "desc" },
      mockExtra,
    )) as { content: Array<{ text: string }> }
    const payload = JSON.parse(result.content[0]?.text ?? "") as {
      tasks: Array<{ description: string }>
    }
    // done DESC with dateless last: the completed card leads.
    expect(payload.tasks.map((task) => task.description)).toEqual([
      "Done card",
      "Open card",
    ])
  })

  it("returns isError with remediation text for a malformed date filter", async () => {
    const [, , handler] = registerWithTaskIndex()
    const result = (await handler(
      { due: { before: "not-a-date" } },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      '[Error]: invalid due.before date: "not-a-date". Use YYYY-MM-DD (e.g. 2026-07-03).',
    )
  })

  it("returns { total: 0, tasks: [] } for no matches, not an error", async () => {
    const [, , handler] = registerWithTaskIndex()
    const result = (await handler({ tag: "no-such-tag" }, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      total: 0,
      tasks: [],
    })
  })
})

describe("file tool handlers", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  type HandlerResult = {
    content: Array<{
      type: string
      text?: string
      data?: string
      mimeType?: string
    }>
    isError?: boolean
  }

  /** Registers against a real temp vault and returns the two file handlers —
   *  the global harness registers against a nonexistent path. */
  const setupAssetHarness = async (): Promise<{
    vault: string
    readAsset: (args: unknown) => Promise<HandlerResult>
    listAssets: (args: unknown) => Promise<HandlerResult>
  }> => {
    const tempVault = await mkdtemp(join(tmpdir(), "tool-definitions-assets-"))
    onTestFinished(() => rm(tempVault, { recursive: true, force: true }))
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: tempVault,
      search: {} as SearchIndex,
      logger,
      config: loadConfig({}),
    })
    const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
    const handlerFor = (
      name: string,
    ): ((args: unknown) => Promise<HandlerResult>) => {
      const call = registeredCalls.find(([toolName]) => toolName === name)
      if (!call) throw new Error(`tool not registered: ${name}`)
      const [, , handler] = call
      return async (args: unknown) =>
        (await handler(args, mockExtra)) as HandlerResult
    }
    return {
      vault: tempVault,
      readAsset: handlerFor(TOOL_NAMES.VAULT_READ_FILE),
      listAssets: handlerFor(TOOL_NAMES.VAULT_LIST_FILES),
    }
  }

  it("returns a .canvas file as its linearized rendition", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(
      join(vault, "Board.canvas"),
      JSON.stringify({
        nodes: [
          {
            id: "a",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            text: "hello",
          },
        ],
        edges: [],
      }),
      "utf8",
    )
    const result = await readAsset({ path: "Board.canvas" })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([
      { type: "text", text: "# Canvas: 1 node, 0 edges\n\n[text]\nhello" },
    ])
  })

  it.each([
    { extension: "json", content: '{"key": "value"}' },
    { extension: "svg", content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    { extension: "csv", content: "a,b\n1,2\n" },
    { extension: "txt", content: "plain text\n" },
    { extension: "xml", content: "<root/>" },
    { extension: "log", content: "line one\nline two\n" },
    { extension: "base", content: "views:\n  - type: table\n" },
  ])(
    "returns a .$extension file verbatim as text",
    async ({ extension, content }) => {
      const { vault, readAsset } = await setupAssetHarness()
      await writeFile(join(vault, `file.${extension}`), content, "utf8")
      const result = await readAsset({ path: `file.${extension}` })
      expect(result.isError).toBeUndefined()
      expect(result.content).toEqual([{ type: "text", text: content }])
    },
  )

  it("pages a text file and prepends the window metadata block", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "data.csv"), "l1\nl2\nl3\nl4\n", "utf8")
    const result = await readAsset({
      path: "data.csv",
      start_line: 2,
      limit: 2,
    })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "data.csv — lines 2–3 of 4 (continue with start_line: 4)",
        },
        { type: "text", text: "l2\nl3" },
      ],
    })
  })

  it("reports end of file on the final window", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "data.csv"), "l1\nl2\nl3\nl4\n", "utf8")
    const result = await readAsset({
      path: "data.csv",
      start_line: 3,
      limit: 5,
    })
    expect(result).toEqual({
      content: [
        { type: "text", text: "data.csv — lines 3–4 of 4 (end of file)" },
        { type: "text", text: "l3\nl4" },
      ],
    })
  })

  it("reports a zero-line window for a paged empty file", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "empty.log"), "", "utf8")
    const result = await readAsset({ path: "empty.log", start_line: 1 })
    expect(result).toEqual({
      content: [
        { type: "text", text: "empty.log — 0 lines (end of file)" },
        { type: "text", text: "" },
      ],
    })
  })

  it("rejects a start line past the end of the file", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "data.csv"), "l1\nl2\nl3\nl4\n", "utf8")
    const result = await readAsset({ path: "data.csv", start_line: 9 })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '[Error]: start line past the end: "data.csv" renders to 4 lines',
        },
      ],
    })
  })

  it("rejects paging for an image", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "pic.png"), Buffer.from([0x89, 0x50]))
    const result = await readAsset({ path: "pic.png", limit: 5 })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text:
            '[Error]: line range is not available for images: "pic.png" is ' +
            "binary — its image block is the delivered form",
        },
      ],
    })
  })

  it("returns a small PNG as an image block with a metadata text line", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 255, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer()
    await writeFile(join(vault, "tiny.png"), png)
    const result = await readAsset({ path: "tiny.png" })
    expect(result).toEqual({
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        {
          type: "text",
          text: `tiny.png — image/png, 4×4, ${png.length} bytes (original file, not recompressed)`,
        },
      ],
    })
  })

  it("returns the exact canvas JSON source when raw is set", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    const canvasSource = JSON.stringify({
      nodes: [
        {
          id: "a",
          type: "text",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          text: "hello",
        },
      ],
      edges: [],
    })
    await writeFile(join(vault, "Board.canvas"), canvasSource, "utf8")
    const result = await readAsset({ path: "Board.canvas", raw: true })
    expect(result).toEqual({
      content: [{ type: "text", text: canvasSource }],
    })
  })

  it("rejects raw for an image", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 255, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer()
    await writeFile(join(vault, "tiny.png"), png)
    const result = await readAsset({ path: "tiny.png", raw: true })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '[Error]: raw source is not available for images: "tiny.png" is binary — its image block is the delivered form',
        },
      ],
    })
  })

  it("returns a text format's source unchanged when raw is set", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "data.json"), '{"key": "value"}', "utf8")
    const result = await readAsset({ path: "data.json", raw: true })
    expect(result).toEqual({
      content: [{ type: "text", text: '{"key": "value"}' }],
    })
  })

  it("returns structured markdown from a valid PDF", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    const { buildMinimalPdf } =
      await import("../../obsidian-markdown/__tests__/pdf-fixture.js")
    await writeFile(join(vault, "doc.pdf"), buildMinimalPdf())
    const result = await readAsset({ path: "doc.pdf" })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringMatching(
            /^Title: \(untitled\) \| Pages: 1\n\n[\s\S]*Hello PDF/,
          ),
        },
      ],
    })
  })

  it("rejects an unsupported extension naming the readable types", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "song.mp3"), "xxxx", "utf8")
    const result = await readAsset({ path: "song.mp3" })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '[Error]: unsupported file type ".mp3": "song.mp3" exists (4 bytes). Readable types: images (.png/.jpg/.jpeg/.gif/.webp), .canvas, .pdf, and text formats (.svg/.json/.txt/.csv/.xml/.log/.yaml/.yml/.base)',
        },
      ],
    })
  })

  it("rejects a .md path without touching the note", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "note.md"), "# A note\n", "utf8")
    const result = await readAsset({ path: "note.md" })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '[Error]: not a file: "note.md" is a markdown note',
        },
      ],
    })
  })

  it("rejects a missing file with file not found", async () => {
    const { readAsset } = await setupAssetHarness()
    const result = await readAsset({ path: "ghost.png" })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '[Error]: file not found: "ghost.png"',
        },
      ],
    })
  })

  it("rejects a non-UTF-8 text file instead of corrupting it", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    // 0xFF is never valid in UTF-8 — the default decoder would silently
    // substitute U+FFFD; the tool must refuse instead.
    await writeFile(join(vault, "latin1.txt"), Buffer.from([0x68, 0x69, 0xff]))
    const result = await readAsset({ path: "latin1.txt" })
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: '[Error]: not valid UTF-8: "latin1.txt" cannot be returned as text',
        },
      ],
    })
  })

  it("rejects an oversized text file instead of truncating it", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    const oversized = "x".repeat(102_401)
    await writeFile(join(vault, "big.txt"), oversized, "utf8")
    const result = await readAsset({ path: "big.txt" })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      '[Error]: text output too large: "big.txt" renders to 102401 bytes (cap 102400 bytes)',
    )
  })

  it("lists a folder's files with bytes and counts, excluding other folders and notes", async () => {
    const { vault, listAssets } = await setupAssetHarness()
    await mkdir(join(vault, "media"), { recursive: true })
    await mkdir(join(vault, "elsewhere"), { recursive: true })
    await writeFile(join(vault, "media/a.png"), "12345", "utf8")
    await writeFile(join(vault, "media/b.canvas"), "{}", "utf8")
    await writeFile(join(vault, "media/note.md"), "# not an asset", "utf8")
    await writeFile(join(vault, "elsewhere/c.png"), "999", "utf8")
    const result = await listAssets({ folder: "media" })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      files: [
        { path: "media/a.png", extension: ".png", bytes: 5 },
        { path: "media/b.canvas", extension: ".canvas", bytes: 2 },
      ],
      extension_counts: { ".png": 1, ".canvas": 1 },
      total: 2,
      truncated: false,
    })
  })

  it.each(["PNG", ".PNG"])(
    "filters by extension case-insensitively for %s",
    async (extensionSpelling) => {
      const { vault, listAssets } = await setupAssetHarness()
      await writeFile(join(vault, "a.png"), "12345", "utf8")
      await writeFile(join(vault, "b.jpg"), "12", "utf8")
      const result = await listAssets({ extensions: [extensionSpelling] })
      expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
        files: [{ path: "a.png", extension: ".png", bytes: 5 }],
        extension_counts: { ".png": 1 },
        total: 1,
        truncated: false,
      })
    },
  )

  it("pages with limit while counts and total cover the full filtered set", async () => {
    const { vault, listAssets } = await setupAssetHarness()
    await writeFile(join(vault, "a.png"), "1", "utf8")
    await writeFile(join(vault, "b.png"), "22", "utf8")
    await writeFile(join(vault, "c.jpg"), "333", "utf8")
    const result = await listAssets({ limit: 1 })
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      files: [{ path: "a.png", extension: ".png", bytes: 1 }],
      extension_counts: { ".png": 2, ".jpg": 1 },
      total: 3,
      truncated: true,
    })
  })
})

describe("DISABLED_TOOLS", () => {
  const registerWithConfig = (
    env: Record<string, string>,
  ): RegisterToolCall[] => {
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: loadConfig(env),
    })
    return server.registerTool.mock.calls as RegisterToolCall[]
  }

  it("hides exactly the named tools and keeps every other tool", () => {
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_write_note,vault_find_orphans",
    })
    const registeredNames = registeredCalls.map(([toolName]) => toolName)
    const expectedNames = ALL_TOOL_NAMES.filter(
      (toolName) =>
        toolName !== TOOL_NAMES.VAULT_WRITE_NOTE &&
        toolName !== TOOL_NAMES.VAULT_FIND_ORPHANS,
    )
    expect(new Set(registeredNames)).toEqual(new Set(expectedNames))
    expect(registeredNames).toHaveLength(expectedNames.length)
  })

  it("cannot resurrect a tool another flag already hides", () => {
    const registeredCalls = registerWithConfig({
      MEMORY_ENABLED: "false",
      DISABLED_TOOLS: "vault_get_memory",
    })
    const registeredNames = registeredCalls.map(([toolName]) => toolName)
    expect(registeredNames).not.toContain(TOOL_NAMES.VAULT_GET_MEMORY)
    // The whole 5-tool memory group is flag-hidden; the overlap adds nothing.
    expect(registeredCalls).toHaveLength(ALL_TOOL_NAMES.length - 5)
  })

  it("composes with READONLY_MODE — subtracts a read tool from the read-only surface", () => {
    const readOnlyCalls = registerWithConfig({ READONLY_MODE: "true" })
    const subtractedCalls = registerWithConfig({
      READONLY_MODE: "true",
      DISABLED_TOOLS: "vault_search",
    })
    const subtractedNames = subtractedCalls.map(([toolName]) => toolName)
    expect(subtractedNames).not.toContain(TOOL_NAMES.VAULT_SEARCH)
    expect(subtractedCalls).toHaveLength(readOnlyCalls.length - 1)
  })

  it("disabling every tool of a group registers none of that group", () => {
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_read_file,vault_list_files",
    })
    const registeredNames = registeredCalls.map(([toolName]) => toolName)
    expect(registeredNames).not.toContain(TOOL_NAMES.VAULT_READ_FILE)
    expect(registeredNames).not.toContain(TOOL_NAMES.VAULT_LIST_FILES)
    expect(registeredCalls).toHaveLength(ALL_TOOL_NAMES.length - 2)
  })

  it("a disabled tool disappears from availability-keyed cross-references", () => {
    // vault_read_note's edit guidance is an availability-keyed reference:
    // it names vault_patch_note only while that tool is served. (Mentions in
    // prose that was never flag-conditional — e.g. vault_write_note's
    // partial-edit error remediation — deliberately stay; DISABLED_TOOLS is
    // an escape hatch, and re-templating every sibling mention isn't worth
    // the description churn.)
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_patch_note",
    })
    const readNoteCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE,
    )
    expect(readNoteCall?.[1].description).not.toContain(
      TOOL_NAMES.VAULT_PATCH_NOTE,
    )
    // Guard against a vacuous pass: with nothing disabled, the reference IS
    // present.
    const enabledCalls = registerWithConfig({})
    const enabledReadNoteCall = enabledCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE,
    )
    expect(enabledReadNoteCall?.[1].description).toContain(
      TOOL_NAMES.VAULT_PATCH_NOTE,
    )
  })

  it("disabling the memory write tools trims them from memory read-tool descriptions", () => {
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_update_memory,vault_delete_memory",
    })
    const listFilesCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    )
    const description = listFilesCall?.[1].description
    expect(description).toContain("BEFORE calling vault_get_memory.")
    expect(description).not.toContain("vault_update_memory")
    expect(description).not.toContain("pruning entries")
  })

  // vault_get_memory is itself disableable, so the follow-up list can empty
  // out entirely — the sentence has to lose the clause, not render a dangling
  // "BEFORE calling .".
  it("drops the follow-up clause when every memory follow-up tool is disabled", () => {
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS:
        "vault_get_memory,vault_update_memory,vault_delete_memory",
    })
    const listFilesCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    )
    const description = listFilesCall?.[1].description

    expect(description).toContain(
      "When to use: Discovering what memory files and sections exist — and what each file is for. Always call this first",
    )
    expect(description).not.toContain("BEFORE calling")
  })

  it("drops the recall consumer clause when both consumer tools are disabled", () => {
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_get_memory,vault_delete_memory",
    })
    const recallCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_MEMORY_RECALL,
    )
    const description = recallCall?.[1].description

    expect(description).toContain(
      "text is the raw entry markdown (wikilinks intact, continuation lines included). entries ascend by date",
    )
    expect(description).not.toContain("feed directly into")
  })

  it("names only the surviving consumer when vault_get_memory alone is disabled", () => {
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_get_memory",
    })
    const recallCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_MEMORY_RECALL,
    )

    expect(recallCall?.[1].description).toContain(
      "file and section feed directly into vault_delete_memory.",
    )
  })
})

describe("flag-combination matrix", () => {
  const BOOL_VALUES = ["false", "true"] as const
  const flagCombos = BOOL_VALUES.flatMap((readonlyValue) =>
    BOOL_VALUES.flatMap((memoryValue) =>
      BOOL_VALUES.flatMap((fileValue) =>
        BOOL_VALUES.map((embeddingValue) => ({
          READONLY_MODE: readonlyValue,
          MEMORY_ENABLED: memoryValue,
          FILE_TOOLS_ENABLED: fileValue,
          EMBEDDING_ENABLED: embeddingValue,
        })),
      ),
    ),
  )
  const disabledToolsCombos = [
    { DISABLED_TOOLS: "vault_search" },
    { READONLY_MODE: "true", DISABLED_TOOLS: "vault_get_daily_note" },
    { MEMORY_ENABLED: "false", DISABLED_TOOLS: "vault_write_note" },
  ]

  it.each([...flagCombos, ...disabledToolsCombos])(
    "registration matches computeEnabledToolNames for %o",
    (env) => {
      const server = { registerTool: vi.fn() }
      const config = loadConfig(env)
      registerTools({
        server: server as unknown as McpServer,
        vaultPath: "/test-vault",
        search: {} as SearchIndex,
        logger,
        config,
      })
      const registeredCalls = server.registerTool.mock
        .calls as RegisterToolCall[]
      const registeredNames = registeredCalls.map(([toolName]) => toolName)
      expect(new Set(registeredNames)).toEqual(computeEnabledToolNames(config))
      expect(registeredNames).toHaveLength(computeEnabledToolNames(config).size)
    },
  )
})

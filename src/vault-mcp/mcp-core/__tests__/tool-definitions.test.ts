import { describe, it, expect, beforeEach, vi, onTestFinished } from "vitest"
import sharp from "sharp"
import { mkdtemp, rm, writeFile, mkdir, readFile, utimes } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DateTime } from "luxon"
import { z } from "zod"
import { computeEnabledToolNames, registerTools } from "../tool-definitions.js"
import { TOOL_NAMES, TOOL_REGISTRY } from "../tool-registry.js"
import { loadConfig } from "../../config.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createSearchIndex } from "../../search/search-index.js"
import type { SearchIndex } from "../../search/search-index.js"
import { logger, type Logger } from "../../../logger.js"

const ALL_TOOL_NAMES = Object.values(TOOL_NAMES)

// Expected sets derive from the registry so a new tool joins them
// automatically; the literal spot-checks in tool-registry.test.ts anchor the
// classification itself, so a registry typo cannot self-certify here.
const READ_ONLY_TOOLS = TOOL_REGISTRY.filter((entry) => entry.annotations.readOnlyHint).map(
  (entry) => entry.name,
)

const DESTRUCTIVE_TOOLS = TOOL_REGISTRY.filter((entry) => entry.annotations.destructiveHint).map(
  (entry) => entry.name,
)

// Writers that only add to the vault — never overwrite or delete existing
// content — so destructiveHint must be false even though readOnlyHint is too.
const ADDITIVE_WRITE_TOOLS = TOOL_REGISTRY.filter(
  (entry) => !entry.annotations.readOnlyHint && !entry.annotations.destructiveHint,
).map((entry) => entry.name)

const WRITE_TOOLS = [
  TOOL_NAMES.VAULT_WRITE_NOTE,
  TOOL_NAMES.VAULT_PATCH_NOTE,
  TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
  TOOL_NAMES.VAULT_REPLACE_SPAN,
  TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
  TOOL_NAMES.VAULT_MOVE_NOTE,
  TOOL_NAMES.VAULT_UPDATE_MEMORY,
  TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
  TOOL_NAMES.VAULT_CREATE_TASK,
  TOOL_NAMES.VAULT_UPDATE_TASK,
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

/** The registerTool calls a server makes under the config this env produces. */
const registerWithConfig = (
  env: Record<string, string>,
  context: { vaultPath?: string; search?: SearchIndex; logger?: Logger } = {},
): RegisterToolCall[] => {
  const server = { registerTool: vi.fn() }
  registerTools({
    server: server as unknown as McpServer,
    vaultPath: context.vaultPath ?? "/test-vault",
    search: context.search ?? ({} as SearchIndex),
    logger: context.logger ?? logger,
    config: loadConfig(env),
  })
  return server.registerTool.mock.calls as RegisterToolCall[]
}

const findCall = (name: string): RegisterToolCall | undefined => {
  return calls.find(([toolName]) => toolName === name)
}

/** The text of a tool result's first content block, failing loudly when the
 *  result carries none instead of parsing an empty string. */
const requireTextContent = (result: { content: Array<{ text?: string }> }): string => {
  const text = result.content[0]?.text

  if (text === undefined) throw new Error("result has no text content")
  return text
}

/** findCall for tests that assume the tool is registered — throws instead of
 *  returning undefined so call sites need no non-null assertion. */
const requireCall = (name: string): RegisterToolCall => {
  const call = findCall(name)

  if (!call) throw new Error(`tool not registered: ${name}`)
  return call
}

/** A registered tool's description, throwing a failure that names the tool —
 *  a direct toContain over a missing description reads as a reference-list
 *  problem instead of the registration bug that dropped it. */
const requireDescription = (
  toolConfig: { description?: string | undefined },
  toolName: string,
): string => {
  if (!toolConfig.description) {
    throw new Error(`tool ${toolName} registered without a description`)
  }
  return toolConfig.description
}

/** The part of a tool's description from startMarker up to (not including)
 *  endMarker — one section, so a test can assert it whole. */
const extractDescriptionSection = (params: {
  registeredCalls: RegisterToolCall[]
  toolName: string
  startMarker: string
  endMarker: string
}): string => {
  const toolCall = params.registeredCalls.find(([toolName]) => toolName === params.toolName)
  const description = toolCall?.[1].description

  if (!description) {
    throw new Error(`${params.toolName} is not registered or has no description`)
  }

  const sectionStart = description.indexOf(params.startMarker)
  const sectionEnd = description.indexOf(params.endMarker, sectionStart)

  if (sectionStart === -1 || sectionEnd === -1) {
    throw new Error(`${params.toolName} description has no "${params.startMarker}" section`)
  }
  return description.slice(sectionStart, sectionEnd)
}

/** The first line of a tool's description that starts with linePrefix, or
 *  undefined when the tool is not registered or no line matches. */
const findDescriptionLine = (params: {
  registeredCalls: readonly RegisterToolCall[]
  toolName: string
  linePrefix: string
}): string | undefined => {
  const toolCall = params.registeredCalls.find(([toolName]) => toolName === params.toolName)
  const descriptionLines = toolCall?.[1].description?.split("\n")

  return descriptionLines?.find((line) => line.startsWith(params.linePrefix))
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
    expect(findCall(name)?.[0]).toBe(name)
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

  it.each(WRITE_TOOLS)("%s description includes Obsidian syntax guidance", (name) => {
    const [, config] = requireCall(name)
    expect(config.description).toContain("Obsidian syntax:")
  })

  it("vault_replace_in_note description clarifies in-place scope", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_REPLACE_IN_NOTE)
    expect(config.description).toContain("in place")
    expect(config.description).toContain("vault_read_note")
  })

  it("vault_read_note documents the outline response on the outline parameter", () => {
    // The only guard against this drifting from the actual response shape.
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    expect(config.inputSchema?.outline?.description).toBe(
      "If true, returns { bytes, modified, leading_callout?, leading_content?, headings } as JSON instead of body content — a cheap structure fetch for large notes. headings: [{ level, text, bytes }]; leading_callout: { type, title, body } when the note has a top-of-file callout; leading_content: the rest of the body text above the first heading (callout lines excluded) when the note has any.",
    )
  })

  it("vault_patch_note's examples edit notes that are not task boards", () => {
    // Task boards belong to vault_create_task and vault_update_task, so an
    // example that appends a card would steer agents to the wrong tool.
    const examples = extractDescriptionSection({
      registeredCalls: calls,
      toolName: TOOL_NAMES.VAULT_PATCH_NOTE,
      startMarker: "Example: vault_patch_note",
      endMarker: "\n\nWhen to use:",
    })
    expect(examples).toBe(
      [
        'Example: vault_patch_note({ path: "Projects/plan.md", operation: "append", heading: "Open questions", content: "- Which region hosts the backup?" })',
        'Example: vault_patch_note({ path: "Notes/Plan.md", operation: "replace", heading: "Status", content: "On track for launch.\\n" })',
        'Example: vault_patch_note({ path: "Notes/Plan.md", operation: "insert_before", heading: "Phase 2", content: "## Phase 1\\nDone.\\n" })',
        'Example: vault_patch_note({ path: "Notes/Plan.md", operation: "prepend", content: "> [!info] Draft\\n> Not reviewed yet.\\n" })',
      ].join("\n"),
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
    const description = requireDescription(config, TOOL_NAMES.VAULT_PATCH_NOTE)
    const errorsSection = extractDescriptionSection({
      registeredCalls: calls,
      toolName: TOOL_NAMES.VAULT_PATCH_NOTE,
      startMarker: "Errors:",
      endMarker: "Obsidian syntax:",
    })
    expect(errorsSection).not.toContain("becomes the new section's body")
    expect(description).toContain("becomes the new section's body")
  })

  it("vault_update_task description does not list the no-next-occurrence advisory as an error", () => {
    // The completion succeeds, and agents treat Errors: as failure modes.
    const [, config] = requireCall(TOOL_NAMES.VAULT_UPDATE_TASK)
    const description = requireDescription(config, TOOL_NAMES.VAULT_UPDATE_TASK)
    const errorsSection = extractDescriptionSection({
      registeredCalls: calls,
      toolName: TOOL_NAMES.VAULT_UPDATE_TASK,
      startMarker: "Errors:",
      endMarker: "Obsidian syntax:",
    })
    expect(errorsSection).not.toContain("yields no next occurrence")
    expect(description).toContain("yields no next occurrence")
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
    expect(listConfig.description).toContain('entry_policy is "append-only" (the default')
  })

  it("vault_delete_memory description documents duplicate-entry remediation", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_DELETE_MEMORY)
    expect(config.description).toContain("ambiguous")
    expect(config.description).toContain("vault_update_memory refuses to write exact duplicates")
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
    expect(overwriteSchema?.safeParse(true).success).toBe(true)
    expect(overwriteSchema?.safeParse(false).success).toBe(true)
    expect(overwriteSchema?.safeParse("yes").success).toBe(false)
    expect(overwriteSchema?.safeParse(undefined).success).toBe(true)
  })

  it("vault_recent_notes description documents sorting behavior", () => {
    const sortLine = findDescriptionLine({
      registeredCalls: [requireCall(TOOL_NAMES.VAULT_RECENT_NOTES)],
      toolName: TOOL_NAMES.VAULT_RECENT_NOTES,
      linePrefix: "- sort_by + limit interact",
    })
    expect(sortLine).toBe(
      '- sort_by + limit interact: "modified" (default) uses filesystem mtime, which every note has. "created" uses the frontmatter created property; notes without a valid one sort after every dated note, so a small limit can leave them out — use "modified" to see them.',
    )
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
      const annotations = config.annotations

      if (!annotations) throw new Error("registered tool has no annotations")
      expect(Object.keys(annotations).toSorted()).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
      ])
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
  const customCalls = registerWithConfig({ MEMORY_DIR: CUSTOM_MEMORY_DIR })

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

  it("vault_delete_note lists the configured memory dir among its protected paths", () => {
    const linksEntry = findDescriptionLine({
      registeredCalls: customCalls,
      toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
      linePrefix: "- Links to the note",
    })
    expect(linksEntry).toBe(
      "- Links to the note from other notes become broken; list them first with vault_get_backlinks. Protected paths are refused: Profile/ and the daily notes folder (read from DAILY_NOTES_FOLDER or .obsidian/daily-notes.json, defaulting to Daily Notes/).",
    )
  })

  it("vault_delete_note lists PROTECTED_PATHS folders in place of the default protected paths", () => {
    const linksEntry = findDescriptionLine({
      registeredCalls: registerWithConfig({ PROTECTED_PATHS: "Private,Work/Clients" }),
      toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
      linePrefix: "- Links to the note",
    })
    expect(linksEntry).toBe(
      "- Links to the note from other notes become broken; list them first with vault_get_backlinks. Protected paths are refused: Private/, Work/Clients/.",
    )
  })

  it("vault_delete_note description includes memory hint when memory is enabled", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_DELETE_NOTE)
    expect(config.description).toContain("use vault_delete_memory for memory entries")
  })

  it("vault_find_orphans schema references configured exclusion folders", () => {
    const [, config] = requireCustomCall(TOOL_NAMES.VAULT_FIND_ORPHANS)
    const exclusionDescription = config.inputSchema?.exclude_folders?.description

    expect(exclusionDescription).toBe(
      'Folder paths to exclude (e.g. Projects; default: the daily notes folder, "Templates", "Profile")',
    )
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
    expect(result.content[0]?.text).toBe('[Error]: note not found: "nonexistent.md"')
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
    const result = (await handler({ file: "Nonexistent", section: undefined }, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      '[Error]: memory file not found: "About Me/Nonexistent.md"',
    )
  })

  it.each([
    { label: "outline + heading", modes: { outline: true, heading: "Active" } },
    {
      label: "outline + properties_only",
      modes: { outline: true, properties_only: true },
    },
    {
      label: "heading + properties_only",
      modes: { heading: "Active", properties_only: true },
    },
  ])("vault_read_note rejects $label", async ({ modes }) => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler({ path: "note.md", ...modes }, mockExtra)) as {
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
    const result = (await handler({ path: "note.md", heading_level: 2 }, mockExtra)) as {
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
    const readCall = registeredCalls.find(([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE)

    if (!readCall) throw new Error("vault_read_note not registered")
    return { handler: readCall[2], tempVault }
  }

  it("pages a full note and prepends the window metadata block", async () => {
    const { handler } = await createPagedNoteFixture()
    const result = (await handler({ path: "paged.md", start_line: 2, limit: 2 }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
    }

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
    const result = (await handler({ path: "paged.md", start_line: 6, limit: 10 }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
    }

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
    )) as {
      content: Array<{ type: string; text: string }>
    }

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
    const result = (await handler({ path: "empty.md", start_line: 1 }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
    }

    expect(result.content).toEqual([
      { type: "text", text: "empty.md — 0 lines (end of file)" },
      { type: "text", text: "" },
    ])
  })

  it("rejects start_line past the end of the note", async () => {
    const { handler } = await createPagedNoteFixture()
    const result = (await handler({ path: "paged.md", start_line: 99 }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }

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
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("line paging is not available in outline mode")
  })

  it("rejects paging with properties_only mode", async () => {
    const [, , handler] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    const result = (await handler(
      { path: "note.md", properties_only: true, limit: 5 },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("line paging is not available in properties_only mode")
  })

  it("returns byte-identical content without paging params", async () => {
    const { handler } = await createPagedNoteFixture()
    const result = (await handler({ path: "paged.md" }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
    }

    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.text).toBe("---\ntitle: Paged\n---\nline1\nline2\nline3\nline4\n")
  })

  it("description documents the paging error contracts", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_READ_NOTE)
    expect(config.description).toContain("start line past the end")
    expect(config.description).toContain("line paging is not available in outline mode")
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
  ])("$field rejects an empty string and accepts a non-empty one", ({ field, validValue }) => {
    const schema = requireUpdateMemorySchema()
    expect(schema[field]?.safeParse("").success).toBe(false)
    expect(schema[field]?.safeParse(validValue).success).toBe(true)
  })

  it("options.date rejects an empty string and accepts a date", () => {
    const schema = requireUpdateMemorySchema()
    expect(schema.options?.safeParse({ date: "" }).success).toBe(false)
    expect(schema.options?.safeParse({ date: "2026-07-02" }).success).toBe(true)
  })
})

describe("vault_delete_memory input schema", () => {
  // The server never writes an empty entry (vault_update_memory rejects one),
  // so an empty match key can only be a caller mistake.
  it("entry rejects an empty string and accepts a non-empty one", () => {
    const [, config] = requireCall(TOOL_NAMES.VAULT_DELETE_MEMORY)
    const entrySchema = config.inputSchema?.entry
    expect(entrySchema?.safeParse("").success).toBe(false)
    expect(entrySchema?.safeParse("Prefer X over Y").success).toBe(true)
  })
})

describe("optional selector params reject an empty string", () => {
  // Without min(1), an empty folder or glob lists the whole vault and an empty
  // date reads today's note — a different request than the caller sent.
  it.each([
    { tool: TOOL_NAMES.VAULT_LIST_NOTES, field: "folder", validValue: "Projects" },
    { tool: TOOL_NAMES.VAULT_LIST_NOTES, field: "glob", validValue: "*.md" },
    { tool: TOOL_NAMES.VAULT_GET_DAILY_NOTE, field: "date", validValue: "2026-05-13" },
  ])("$tool $field rejects an empty string and accepts a value", ({ tool, field, validValue }) => {
    const [, config] = requireCall(tool)
    const fieldSchema = config.inputSchema?.[field]
    expect(fieldSchema?.safeParse("").success).toBe(false)
    expect(fieldSchema?.safeParse(validValue).success).toBe(true)
    expect(fieldSchema?.safeParse(undefined).success).toBe(true)
  })
})

describe("optional filter lists reject an empty array", () => {
  // - A "match any of these" list (the four below) selects nothing when empty,
  //   so an empty one is a caller mistake. Without min(1) the call succeeds
  //   and the empty or unfiltered result reads as a real answer.
  // - A "require all of these" list (vault_search's tags and related) stays
  //   valid when empty, because requiring no tags is no constraint.
  it.each([
    { tool: TOOL_NAMES.VAULT_LIST_FILES, field: "extensions", validValue: [".png"] },
    { tool: TOOL_NAMES.VAULT_LIST_TASKS, field: "priority", validValue: ["high"] },
    { tool: TOOL_NAMES.VAULT_LIST_TASKS, field: "status", validValue: ["todo"] },
    { tool: TOOL_NAMES.VAULT_LIST_TASKS, field: "heading", validValue: ["Active"] },
  ])("$tool $field rejects [] and accepts a list or no value", ({ tool, field, validValue }) => {
    const [, config] = requireCall(tool)
    const fieldSchema = config.inputSchema?.[field]
    expect(fieldSchema?.safeParse([]).success).toBe(false)
    expect(fieldSchema?.safeParse(validValue).success).toBe(true)
    expect(fieldSchema?.safeParse(undefined).success).toBe(true)
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
    const patchCall = registeredCalls.find(([toolName]) => toolName === TOOL_NAMES.VAULT_PATCH_NOTE)

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
    expect(await readNote()).toBe("## New Section\n- entry\nIntro prose.\n\n## Section\n\nbody\n")
  })

  it("recommends append when the note had no heading to insert before", async () => {
    const { handler, readNote } = await setupPatchHandler("flat.md", "Just prose.\n")

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
      content: [{ type: "text", text: "Applied prepend to titled.md → file body" }],
    })
    expect(await readNote()).toBe("## New Section\n# Title\n\nIntro.\n\n## Section\n")
  })
})

describe("vault_read_note outline mode", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  it("serializes file metadata, leading content, and headings in that order", async () => {
    const tempVault = await mkdtemp(join(tmpdir(), "tool-definitions-outline-"))
    onTestFinished(() => rm(tempVault, { recursive: true, force: true }))
    const content =
      "> [!info] Scope\n> the callout body\n\nProse after the callout.\n\n## Section\n"
    const modifiedAt = DateTime.fromISO("2026-09-17T14:30:00.000Z")

    if (!modifiedAt.isValid) throw new Error("invalid test timestamp")
    await writeFile(join(tempVault, "both.md"), content, "utf8")
    await utimes(join(tempVault, "both.md"), modifiedAt.toSeconds(), modifiedAt.toSeconds())
    const server = { registerTool: vi.fn() }
    registerTools({
      server: server as unknown as McpServer,
      vaultPath: tempVault,
      search: {} as SearchIndex,
      logger,
      config: loadConfig({}),
    })
    const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
    const readCall = registeredCalls.find(([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE)

    if (!readCall) throw new Error("vault_read_note not registered")

    const result = await readCall[2]({ path: "both.md", outline: true }, mockExtra)

    const expectedOutline = JSON.stringify({
      bytes: Buffer.byteLength(content, "utf8"),
      modified: modifiedAt.toLocal().toISO(),
      leading_callout: {
        type: "info",
        title: "Scope",
        body: "the callout body",
      },
      leading_content: "Prose after the callout.",
      headings: [{ level: 2, text: "Section", bytes: 11 }],
    })

    // Exact JSON pins key order, which the conditional spreads determine.
    expect(result).toEqual({
      content: [{ type: "text", text: expectedOutline }],
    })
  })
})

describe("vault_search description reflects EMBEDDING_ENABLED", () => {
  const findSearchDescription = (registeredCalls: RegisterToolCall[]): string => {
    const searchCall = registeredCalls.find(([name]) => name === TOOL_NAMES.VAULT_SEARCH)

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
    const description = findSearchDescription(registerWithConfig({ EMBEDDING_ENABLED: "false" }))
    expect(description).toContain("Full-text search")
    expect(description).not.toContain("Hybrid")
    expect(description).not.toContain("Reciprocal Rank Fusion")
    expect(description).not.toContain("semantic")
    expect(description).not.toContain("career aspirations")
    expect(description).toContain("search_mode")
  })
})

describe("vault_delete_note description reflects OBSIDIAN_SYNC", () => {
  const deleteNoteErrors = (env: Record<string, string>): string => {
    return extractDescriptionSection({
      registeredCalls: registerWithConfig(env),
      toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
      startMarker: "Errors:",
      endMarker: "\n\nReturns:",
    })
  }
  const PATH_AND_LOOKUP_ERROR_ENTRIES = [
    '- "cannot delete protected path" — the path sits under a protected folder; use vault_delete_memory for memory entries',
    '- "path must end in …" — add the .md extension',
    '- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it',
    '- "concurrent write in progress" — another write to this note is in flight; retry',
    '- "note not found: …" — verify path with vault_list_notes',
  ]
  const OTHER_DELETE_ERROR_ENTRY =
    '- "cannot delete …" (other than a protected path) — the note stays put; ask the vault owner to fix the cause (e.g. permissions), then retry'
  const DAILY_NOTES_CONFIG_ERROR_ENTRY =
    '- "cannot read daily notes config from .obsidian/daily-notes.json" — the file exists but is unreadable, so the daily notes folder to protect is unknown; ask the vault owner to repair it, or the server operator to set DAILY_NOTES_FOLDER or PROTECTED_PATHS, then retry'

  it("lists the trash-move and trash-setting errors when the server does not sync", () => {
    expect(deleteNoteErrors({})).toBe(
      [
        "Errors:",
        ...PATH_AND_LOOKUP_ERROR_ENTRIES,
        '- "cannot move to trash … — 100 collisions in .trash/" — .trash/ holds this name and 100 numbered copies ("Plan 1.md" … "Plan 100.md"); ask the vault owner to clear old copies, then retry',
        '- any other "cannot move to trash …" — the note stays put; ask the vault owner to fix .trash/ (e.g. a plain file blocks a needed folder), then retry',
        OTHER_DELETE_ERROR_ENTRY,
        "- \"cannot read trash config from .obsidian/app.json\" — the file exists but can't be read or parsed, and guessing the setting could let the server's trash cleanup delete a note Obsidian keeps forever; ask the vault owner to repair it, then retry",
        DAILY_NOTES_CONFIG_ERROR_ENTRY,
      ].join("\n"),
    )
  })

  it("leaves the trash-move and trash-setting errors out under OBSIDIAN_SYNC=true", () => {
    expect(deleteNoteErrors({ OBSIDIAN_SYNC: "true" })).toBe(
      [
        "Errors:",
        ...PATH_AND_LOOKUP_ERROR_ENTRIES,
        OTHER_DELETE_ERROR_ENTRY,
        DAILY_NOTES_CONFIG_ERROR_ENTRY,
      ].join("\n"),
    )
  })

  const deleteNoteOpener = (env: Record<string, string>): string | undefined => {
    const deleteNoteCall = registerWithConfig(env).find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_DELETE_NOTE,
    )
    return deleteNoteCall?.[1].description?.split("\n")[0]
  }
  const deleteNoteBehavior = (env: Record<string, string>): string => {
    return extractDescriptionSection({
      registeredCalls: registerWithConfig(env),
      toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
      startMarker: "Behavior:",
      endMarker: "\n\nParameters:",
    })
  }
  const LINKS_AND_PROTECTED_PATHS_ENTRY =
    "- Links to the note from other notes become broken; list them first with vault_get_backlinks. Protected paths are refused: About Me/ and the daily notes folder (read from DAILY_NOTES_FOLDER or .obsidian/daily-notes.json, defaulting to Daily Notes/)."

  it("describes the Deleted files outcomes when the server does not sync", () => {
    expect(deleteNoteOpener({})).toBe(
      "Delete a markdown note, moving it to the vault's .trash/ folder or removing it for good as the vault's Obsidian \"Deleted files\" setting directs.",
    )
    expect(deleteNoteBehavior({})).toBe(
      [
        "Behavior:",
        '- The "Deleted files" setting (`trashOption` in `.obsidian/app.json`) decides the outcome:',
        '  - "Move to system trash" (`system`, also what an absent setting means) moves the note to `.trash/`, since the server has no system trash. Notes this server moved there are deleted after its retention period (TRASH_RETENTION_DAYS: 30 days by default, never when set to none); notes Obsidian itself trashed are never touched.',
        '  - "Move to Obsidian trash" (`local`) moves the note to `.trash/` and keeps it forever.',
        '  - "Permanently delete" (`none`) removes the note for good.',
        "- The caller can't choose or see the outcome in advance; the returned message says which happened.",
        LINKS_AND_PROTECTED_PATHS_ENTRY,
      ].join("\n"),
    )
  })

  it("describes permanent deletion and Sync recovery under OBSIDIAN_SYNC=true", () => {
    expect(deleteNoteOpener({ OBSIDIAN_SYNC: "true" })).toBe(
      "Delete a markdown note for good: this server syncs through Obsidian Sync, so it bypasses the vault's \"Deleted files\" setting; recover a deleted note from Sync's version history (1 month on Standard, 12 months on Plus).",
    )
    expect(deleteNoteBehavior({ OBSIDIAN_SYNC: "true" })).toBe(
      `Behavior:\n${LINKS_AND_PROTECTED_PATHS_ENTRY}`,
    )
  })

  it("names the trash outcome in Returns only when the server does not sync", () => {
    const returnsLine = (env: Record<string, string>): string | undefined => {
      return findDescriptionLine({
        registeredCalls: registerWithConfig(env),
        toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
        linePrefix: "Returns:",
      })
    }
    const PRUNED_FOLDERS_SENTENCE = " Notes how many empty folders were pruned when any were."

    expect(returnsLine({})).toBe(
      `Returns: Confirmation message naming the outcome — "Deleted <path>" for permanent removal, "Moved <path> to trash (<.trash/ path>)" when the note landed in .trash/.${PRUNED_FOLDERS_SENTENCE}`,
    )
    expect(returnsLine({ OBSIDIAN_SYNC: "true" })).toBe(
      `Returns: Confirmation message — "Deleted <path>".${PRUNED_FOLDERS_SENTENCE}`,
    )
  })
})

describe("vault_memory_recall description reflects EMBEDDING_ENABLED", () => {
  const findRecallDescription = (registeredCalls: RegisterToolCall[]): string => {
    const recallCall = registeredCalls.find(([name]) => name === TOOL_NAMES.VAULT_MEMORY_RECALL)

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
    const description = findRecallDescription(registerWithConfig({ EMBEDDING_ENABLED: "false" }))
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
    return registerWithConfig({ MEMORY_ENABLED: "false" })
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
    for (const [name, config] of disabledCalls) {
      const description = requireDescription(config, name)
      for (const memoryToolName of memoryToolReferences) {
        expect(description).not.toContain(memoryToolName)
      }
    }
  })
})

describe("FILE_TOOLS_ENABLED=false", () => {
  const FILE_TOOLS = [TOOL_NAMES.VAULT_READ_FILE, TOOL_NAMES.VAULT_LIST_FILES] as const

  const FILE_TOOL_SET = new Set<string>(FILE_TOOLS)
  const EXPECTED_NON_FILE_TOOLS = ALL_TOOL_NAMES.filter((toolName) => !FILE_TOOL_SET.has(toolName))

  const registerWithDisabledFileTools = (): RegisterToolCall[] => {
    return registerWithConfig({ FILE_TOOLS_ENABLED: "false" })
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
    for (const [toolName, toolConfig] of disabledCalls) {
      const description = requireDescription(toolConfig, toolName)
      for (const fileToolName of FILE_TOOLS) {
        expect(description).not.toContain(fileToolName)
      }
    }
  })
})

describe("READONLY_MODE=true", () => {
  const MUTATING_TOOLS = TOOL_REGISTRY.filter((entry) => !entry.annotations.readOnlyHint).map(
    (entry) => entry.name,
  )

  const registerReadOnly = (extraEnv: Record<string, string> = {}): RegisterToolCall[] => {
    return registerWithConfig({ READONLY_MODE: "true", ...extraEnv })
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
    for (const [toolName, toolConfig] of readOnlyCalls) {
      const description = requireDescription(toolConfig, toolName)
      for (const mutatingToolName of MUTATING_TOOLS) {
        expect(description).not.toContain(mutatingToolName)
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
    const expectedTools = READ_ONLY_TOOLS.filter((toolName) => !memoryReadTools.has(toolName))
    expect(new Set(registeredNames)).toEqual(new Set(expectedTools))
    expect(registeredNames).toHaveLength(expectedTools.length)
  })

  it("with FILE_TOOLS_ENABLED=false registers the read-only tools minus file tools", () => {
    const readOnlyCalls = registerReadOnly({ FILE_TOOLS_ENABLED: "false" })
    const registeredNames = readOnlyCalls.map(([toolName]) => toolName)
    const fileTools = new Set<string>([TOOL_NAMES.VAULT_READ_FILE, TOOL_NAMES.VAULT_LIST_FILES])
    const expectedTools = READ_ONLY_TOOLS.filter((toolName) => !fileTools.has(toolName))
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
    const memoryCalls = memoryMockServer.registerTool.mock.calls as RegisterToolCall[]
    const call = memoryCalls.find(([toolName]) => toolName === TOOL_NAMES.VAULT_MEMORY_RECALL)

    if (!call) throw new Error("vault_memory_recall not registered")
    return call
  }

  it("maps limit to the query layer and reports truncation", async () => {
    const [, , handler] = registerWithMemoryIndex()
    const result = (await handler({ query: "mutation", limit: 2 }, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(requireTextContent(result)) as {
      entries: Array<{ file: string; date: string }>
      total: number
      truncated: boolean
      search_mode: string
    }
    // Three entries match "mutation"; limit: 2 must reach the query
    // layer (the truncation is only observable if the mapping worked).
    expect(payload.total).toBe(3)
    expect(payload.truncated).toBe(true)
    expect(payload.entries).toHaveLength(2)
    expect(payload.search_mode).toBe("fts")
  })

  it("returns an empty evidence set for a no-match query, not an error", async () => {
    const [, , handler] = registerWithMemoryIndex()
    const result = (await handler({ query: "quantum chromodynamics" }, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(requireTextContent(result)) as {
      entries: unknown[]
      total: number
      truncated: boolean
    }
    expect(payload.entries).toEqual([])
    expect(payload.total).toBe(0)
    expect(payload.truncated).toBe(false)
  })
})

describe("vault_search handler", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  /** Registers tools against a real in-memory index seeded with three notes,
   *  so handler tests can observe the effect of top-level presentation params
   *  (limit, snippet_tokens, include_leading_callout) that were un-nested
   *  from filters in the v1 rename sweep. */
  const registerWithSearchIndex = (): RegisterToolCall => {
    const searchIndex = createSearchIndex(":memory:")
    for (const [filePath, rawContent] of [
      [
        "Projects/alpha.md",
        "---\ntitle: Alpha\ntags: [project]\n---\n# Alpha\n\nFirst project notes.",
      ],
      [
        "Projects/beta.md",
        "---\ntitle: Beta\ntags: [project]\n---\n# Beta\n\nSecond project notes.",
      ],
      [
        "Projects/gamma.md",
        "---\ntitle: Gamma\ntags: [project]\n---\n# Gamma\n\nThird project notes.",
      ],
    ] as const) {
      searchIndex.upsertNote(
        { filePath, rawContent, fileStat: { mtimeMs: 1000, size: 100 } },
        logger,
      )
    }
    const searchMockServer = { registerTool: vi.fn() }
    registerTools({
      server: searchMockServer as unknown as McpServer,
      vaultPath: "/test-vault",
      search: searchIndex,
      logger,
      config: loadConfig({}),
    })
    const searchCalls = searchMockServer.registerTool.mock.calls as RegisterToolCall[]
    const call = searchCalls.find(([toolName]) => toolName === TOOL_NAMES.VAULT_SEARCH)

    if (!call) throw new Error("vault_search not registered")
    return call
  }

  it("maps top-level limit to the search layer", async () => {
    const [, , handler] = registerWithSearchIndex()
    const result = (await handler({ query: "project", limit: 1 }, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    const text = result.content[0]?.text

    if (!text) throw new Error("expected text content from vault_search")
    const payload = JSON.parse(text) as {
      results: Array<{ path: string }>
      total: number
    }
    // Three notes match "project"; limit: 1 at the top level must reach the
    // search layer (the cap is only observable if the merge worked).
    expect(payload.total).toBe(1)
    expect(payload.results).toHaveLength(1)

    // Guard against vacuous pass: without limit, all three appear.
    const unlimitedResult = (await handler({ query: "project" }, mockExtra)) as {
      content: Array<{ text: string }>
    }
    const unlimitedText = unlimitedResult.content[0]?.text

    if (!unlimitedText) throw new Error("expected text content from unlimited vault_search")
    const unlimitedPayload = JSON.parse(unlimitedText) as { total: number }
    expect(unlimitedPayload.total).toBe(3)
  })
})

describe("vault_search_by_tag handler", () => {
  // More tagged notes than the default limit of 20, so the default visibly cuts.
  const PROJECT_NOTE_COUNT = 25

  /** Paths of the project notes, newest first. Stepping by 7 through 25 note
   *  numbers visits each once in an order unrelated to the path, so a sort by
   *  path instead of modified time cannot produce this list. */
  const PROJECT_PATHS_NEWEST_FIRST = Array.from({ length: PROJECT_NOTE_COUNT }, (_, offset) => {
    const noteNumber = String(((offset * 7) % PROJECT_NOTE_COUNT) + 1).padStart(2, "0")
    return `Projects/note-${noteNumber}.md`
  })

  /** Tagged under project rather than with project itself, and newer than every
   *  project note: it leads each prefix-match result, and an exact search returns
   *  it only if exact is ignored. */
  const NESTED_TAG_PATH = "Projects/archive/nested.md"
  const TAGGED_PATHS_NEWEST_FIRST = [NESTED_TAG_PATH, ...PROJECT_PATHS_NEWEST_FIRST]

  /** Calls the tool the way the SDK does, with args parsed by its input schema,
   *  against a real index of the project notes. The decoy is the newest note of
   *  all but carries another tag, so it appears only if the tag filter breaks. */
  const queryTaggedPaths = async (args: {
    tag: string
    exact?: boolean
    limit?: number
  }): Promise<string[]> => {
    const searchIndex = createSearchIndex(":memory:")
    const projectNotes = PROJECT_PATHS_NEWEST_FIRST.map((filePath, offset) => ({
      filePath,
      tag: "project",
      mtimeMs: 2000 - offset,
    }))
    const nestedTagNote = { filePath: NESTED_TAG_PATH, tag: "project/archive", mtimeMs: 2500 }
    const decoyNote = { filePath: "Other/newest.md", tag: "other", mtimeMs: 3000 }
    // Inserted in path order: inserting newest first would let the index's row
    // order stand in for the modified-time sort these tests check.
    const notesInPathOrder = [...projectNotes, nestedTagNote, decoyNote].toSorted((noteA, noteB) =>
      noteA.filePath.localeCompare(noteB.filePath),
    )

    for (const { filePath, tag, mtimeMs } of notesInPathOrder) {
      searchIndex.upsertNote(
        {
          filePath,
          rawContent: `---\ntags: [${tag}]\n---\nBody.`,
          fileStat: { mtimeMs, size: 100 },
        },
        logger,
      )
    }

    const searchByTagCall = registerWithConfig({}, { search: searchIndex }).find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_SEARCH_BY_TAG,
    )

    if (!searchByTagCall?.[1].inputSchema) throw new Error("vault_search_by_tag not registered")

    const parsedArgs = z.object(searchByTagCall[1].inputSchema).parse(args)
    const result = z
      .object({
        content: z.array(z.object({ text: z.string() })),
        isError: z.boolean().optional(),
      })
      .parse(await searchByTagCall[2](parsedArgs, { requestId: "tag-request" }))
    expect(result.isError).toBeUndefined()
    return z
      .array(z.object({ path: z.string() }))
      .parse(JSON.parse(requireTextContent(result)))
      .map((note) => note.path)
  }

  it("returns the 20 most recently modified tagged notes when no limit is passed", async () => {
    expect(await queryTaggedPaths({ tag: "project" })).toEqual(
      TAGGED_PATHS_NEWEST_FIRST.slice(0, 20),
    )
  })

  it("returns every tagged note when limit exceeds their count", async () => {
    expect(await queryTaggedPaths({ tag: "project", limit: 50 })).toEqual(TAGGED_PATHS_NEWEST_FIRST)
  })

  it("returns only the newest tagged notes up to a limit below the default", async () => {
    expect(await queryTaggedPaths({ tag: "project", limit: 3 })).toEqual([
      "Projects/archive/nested.md",
      "Projects/note-01.md",
      "Projects/note-08.md",
    ])
  })

  it("applies limit to an exact-match search, which leaves out nested tags", async () => {
    expect(await queryTaggedPaths({ tag: "project", exact: true, limit: 3 })).toEqual([
      "Projects/note-01.md",
      "Projects/note-08.md",
      "Projects/note-15.md",
    ])
  })
})

describe("vault_find_orphans live folder defaults", () => {
  const setupOrphans = async (
    options: {
      settings?: string
      env?: Record<string, string>
      paths?: readonly string[]
    } = {},
  ) => {
    const vaultPath = await mkdtemp(join(tmpdir(), "orphan-handler-"))
    onTestFinished(() => rm(vaultPath, { recursive: true, force: true }))
    await mkdir(join(vaultPath, ".obsidian"))
    const settingsPath = join(vaultPath, ".obsidian/daily-notes.json")

    if (options.settings !== undefined) await writeFile(settingsPath, options.settings)

    const search = createSearchIndex(":memory:")
    const paths = options.paths ?? [
      "Journal/daily.md",
      "Journal/nested/daily.md",
      "JournalOld/note.md",
      "ordinary.md",
      "Daily Notes/daily.md",
      "Templates/template.md",
      "About Me/memory.md",
      "Archive/note.md",
    ]
    paths.forEach((filePath, index) => {
      search.upsertNote(
        { filePath, rawContent: "# Note\n", fileStat: { mtimeMs: 10000 - index, size: 7 } },
        logger,
      )
    })
    const requestLogger: Logger = { ...logger, warn: vi.fn(), child: () => requestLogger }
    const registeredCalls = registerWithConfig(options.env ?? {}, {
      vaultPath,
      search,
      logger: requestLogger,
    })
    const orphanCall = registeredCalls.find(([name]) => name === TOOL_NAMES.VAULT_FIND_ORPHANS)

    if (!orphanCall) throw new Error("vault_find_orphans not registered")

    const queryPaths = async (args: { exclude_folders?: string[]; limit?: number } = {}) => {
      const result = z
        .object({
          content: z.array(z.object({ text: z.string() })),
          isError: z.boolean().optional(),
        })
        .parse(await orphanCall[2](args, { requestId: "orphan-request" }))
      expect(result.isError).toBeUndefined()
      return z
        .array(z.object({ path: z.string() }))
        .parse(JSON.parse(requireTextContent(result)))
        .map((note) => note.path)
    }
    return { settingsPath, queryPaths, requestLogger, toolConfig: orphanCall[1] }
  }

  it("excludes a file-only daily folder and descendants but keeps sibling decoys", async () => {
    const { queryPaths } = await setupOrphans({ settings: '{"folder":"Journal"}' })
    expect(await queryPaths()).toEqual([
      "JournalOld/note.md",
      "ordinary.md",
      "Daily Notes/daily.md",
      "Archive/note.md",
    ])
  })

  it("excludes daily notes before a limit of one", async () => {
    const { queryPaths } = await setupOrphans({ settings: '{"folder":"Journal"}' })
    expect(await queryPaths({ limit: 1 })).toEqual(["JournalOld/note.md"])
  })

  it("uses the env daily folder over the file folder without reading malformed settings", async () => {
    const { queryPaths, requestLogger } = await setupOrphans({
      settings: "broken",
      env: { DAILY_NOTES_FOLDER: "Journal" },
    })
    expect(await queryPaths()).toEqual([
      "JournalOld/note.md",
      "ordinary.md",
      "Daily Notes/daily.md",
      "Archive/note.md",
    ])
    expect(requestLogger.warn).not.toHaveBeenCalled()
  })

  it("replaces all defaults with the explicit environment list", async () => {
    const { queryPaths, requestLogger } = await setupOrphans({
      settings: "broken",
      env: { ORPHAN_EXCLUDE_FOLDERS: "Archive" },
    })
    expect(await queryPaths()).toEqual([
      "Journal/daily.md",
      "Journal/nested/daily.md",
      "JournalOld/note.md",
      "ordinary.md",
      "Daily Notes/daily.md",
      "Templates/template.md",
      "About Me/memory.md",
    ])
    expect(requestLogger.warn).not.toHaveBeenCalled()
  })

  it("lets a request list replace the environment list", async () => {
    const { queryPaths } = await setupOrphans({ env: { ORPHAN_EXCLUDE_FOLDERS: "Archive" } })
    expect(await queryPaths({ exclude_folders: ["Journal"] })).toEqual([
      "JournalOld/note.md",
      "ordinary.md",
      "Daily Notes/daily.md",
      "Templates/template.md",
      "About Me/memory.md",
      "Archive/note.md",
    ])
  })

  it.each([
    { label: "without an environment override", env: {} },
    { label: "over an environment override", env: { ORPHAN_EXCLUDE_FOLDERS: "Archive" } },
  ])(
    "returns every folder for request [] $label and bypasses malformed settings",
    async ({ env }) => {
      const { queryPaths, requestLogger } = await setupOrphans({
        settings: "broken",
        env,
      })
      expect(await queryPaths({ exclude_folders: [] })).toEqual([
        "Journal/daily.md",
        "Journal/nested/daily.md",
        "JournalOld/note.md",
        "ordinary.md",
        "Daily Notes/daily.md",
        "Templates/template.md",
        "About Me/memory.md",
        "Archive/note.md",
      ])
      expect(requestLogger.warn).not.toHaveBeenCalled()
    },
  )

  it("uses a comma-only environment list as no exclusions", async () => {
    const { queryPaths, requestLogger } = await setupOrphans({
      settings: "broken",
      env: { ORPHAN_EXCLUDE_FOLDERS: ", ," },
    })
    expect(await queryPaths()).toEqual([
      "Journal/daily.md",
      "Journal/nested/daily.md",
      "JournalOld/note.md",
      "ordinary.md",
      "Daily Notes/daily.md",
      "Templates/template.md",
      "About Me/memory.md",
      "Archive/note.md",
    ])
    expect(requestLogger.warn).not.toHaveBeenCalled()
  })

  it("excludes a custom memory directory even when memory is disabled", async () => {
    const { queryPaths } = await setupOrphans({
      env: { MEMORY_DIR: "Profile", MEMORY_ENABLED: "false" },
      paths: ["Profile/memory.md", "Profile/sub/memory.md", "About Me/note.md", "ordinary.md"],
    })
    expect(await queryPaths()).toEqual(["About Me/note.md", "ordinary.md"])
  })

  it("applies file folder changes without registering the handler again", async () => {
    const { queryPaths, settingsPath } = await setupOrphans({
      settings: '{"folder":"Journal"}',
      paths: ["Journal/daily.md", "Planner/Daily/daily.md", "ordinary.md"],
    })
    expect(await queryPaths()).toEqual(["Planner/Daily/daily.md", "ordinary.md"])
    await writeFile(settingsPath, '{"folder":"Planner/Daily"}')
    expect(await queryPaths()).toEqual(["Journal/daily.md", "ordinary.md"])
  })

  it("follows valid, malformed, and repaired settings in the same process", async () => {
    const { queryPaths, settingsPath, requestLogger } = await setupOrphans({
      settings: '{"folder":"Journal"}',
      paths: ["Journal/daily.md", "Daily Notes/daily.md", "Planner/Daily/daily.md", "ordinary.md"],
    })
    expect(await queryPaths()).toEqual([
      "Daily Notes/daily.md",
      "Planner/Daily/daily.md",
      "ordinary.md",
    ])
    await writeFile(settingsPath, "broken")
    expect(await queryPaths()).toEqual([
      "Journal/daily.md",
      "Planner/Daily/daily.md",
      "ordinary.md",
    ])
    expect(requestLogger.warn).toHaveBeenCalledTimes(1)
    expect(requestLogger.warn).toHaveBeenCalledWith(
      "cannot read daily notes config, using defaults",
      { error: expect.any(String) },
    )
    await writeFile(settingsPath, '{"folder":"Planner/Daily"}')
    expect(await queryPaths()).toEqual(["Journal/daily.md", "Daily Notes/daily.md", "ordinary.md"])
  })

  it("uses settings that arrive after handler registration", async () => {
    const { queryPaths, settingsPath } = await setupOrphans({
      paths: ["Journal/daily.md", "Daily Notes/daily.md", "ordinary.md"],
    })
    expect(await queryPaths()).toEqual(["Journal/daily.md", "ordinary.md"])
    await writeFile(settingsPath, '{"folder":"Journal"}')
    expect(await queryPaths()).toEqual(["Daily Notes/daily.md", "ordinary.md"])
  })

  it("describes live sources and states the exclusion default in the schema", async () => {
    const { toolConfig } = await setupOrphans({ settings: '{"folder":"Journal"}' })
    const defaultsLine = toolConfig.description
      ?.split("\n")
      .find((line) => line.startsWith("- With exclude_folders"))
    expect(defaultsLine).toBe(
      '- With exclude_folders omitted, the defaults apply; the daily notes folder among them is re-read on each call: DAILY_NOTES_FOLDER, else .obsidian/daily-notes.json, else "Daily Notes" (also used when that file is unreadable).',
    )
    expect(toolConfig.description).not.toContain("Journal")
    expect(toolConfig.inputSchema?.exclude_folders?.description).toBe(
      'Folder paths to exclude (e.g. Projects; default: the daily notes folder, "Templates", "About Me")',
    )
  })

  it("describes an explicit environment list instead of implicit default sources", async () => {
    const { toolConfig } = await setupOrphans({
      env: { ORPHAN_EXCLUDE_FOLDERS: "Archive,Scratch" },
    })
    const defaultsLine = toolConfig.description
      ?.split("\n")
      .find((line) => line.startsWith("- With exclude_folders"))
    expect(defaultsLine).toBe(
      "- With exclude_folders omitted, the server's configured list (the schema default) is used.",
    )
    expect(toolConfig.inputSchema?.exclude_folders?.description).toBe(
      'Folder paths to exclude (e.g. Projects; default: ["Archive","Scratch"])',
    )
  })

  it("leaves the daily-note hint out under an environment list, though vault_get_daily_note is served", async () => {
    const { toolConfig } = await setupOrphans({
      env: { ORPHAN_EXCLUDE_FOLDERS: "Archive,Scratch" },
    })
    const excludeFoldersLine = toolConfig.description
      ?.split("\n")
      .find((line) => line.startsWith("- exclude_folders replaces the defaults"))
    expect(excludeFoldersLine).toBe(
      '- exclude_folders replaces the defaults, it does not add to them — list a default yourself to keep it. Pass [] for no exclusions. Each entry names a whole folder, subfolders included ("Projects" also excludes "Projects/Archive" but not "ProjectsOld/"), ignoring ASCII letter case.',
    )
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
    filePath = "Projects/board.md",
  ): RegisterToolCall => {
    const searchIndex = createSearchIndex(":memory:")
    searchIndex.upsertNote(
      {
        filePath,
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
    const taskCalls = taskMockServer.registerTool.mock.calls as RegisterToolCall[]
    const call = taskCalls.find(([toolName]) => toolName === TOOL_NAMES.VAULT_LIST_TASKS)

    if (!call) throw new Error("vault_list_tasks not registered")
    return call
  }

  it("returns { total, tasks } with absent metadata omitted and structural fields present", async () => {
    const [, , handler] = registerWithTaskIndex()
    const result = (await handler({}, mockExtra)) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(requireTextContent(result)) as {
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
      depends_on: [],
      tags: [],
      depth: 0,
      is_kanban_task: false,
    })
  })

  it("returns folder as an empty string for a task in a root-level note", async () => {
    const [, , handler] = registerWithTaskIndex("- [ ] Root errand", "inbox.md")
    const result = (await handler({}, mockExtra)) as {
      content: Array<{ text: string }>
    }
    const payload = JSON.parse(requireTextContent(result)) as {
      tasks: Array<Record<string, unknown>>
    }
    expect(payload.tasks).toEqual([
      {
        path: "inbox.md",
        line: 1,
        status: "todo",
        status_char: " ",
        description: "Root errand",
        folder: "",
        depends_on: [],
        tags: [],
        depth: 0,
        is_kanban_task: false,
      },
    ])
  })

  it("keeps non-empty tags and depends_on arrays in the response", async () => {
    const [, , handler] = registerWithTaskIndex("- [ ] Errand run #errand ⛔ dep-1, dep-2")
    const result = (await handler({}, mockExtra)) as {
      content: Array<{ text: string }>
    }
    const payload = JSON.parse(requireTextContent(result)) as {
      tasks: Array<Record<string, unknown>>
    }
    // The whole-object match pins the wire shape: parsed arrays survive
    // intact and no absent-metadata key leaks through as null.
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
        depth: 0,
        is_kanban_task: false,
      },
    ])
  })

  it("maps sort_by and sort_direction through to the query", async () => {
    const [, , handler] = registerWithTaskIndex()
    const result = (await handler(
      { status: "all", sort_by: "done", sort_direction: "desc" },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
    }
    const payload = JSON.parse(requireTextContent(result)) as {
      tasks: Array<{ description: string }>
    }
    // done DESC with dateless last: the completed card leads.
    expect(payload.tasks.map((task) => task.description)).toEqual(["Done card", "Open card"])
  })

  it("returns isError with remediation text for a malformed date filter", async () => {
    const [, , handler] = registerWithTaskIndex()
    const result = (await handler({ due: { before: "not-a-date" } }, mockExtra)) as {
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
    expect(JSON.parse(requireTextContent(result))).toEqual({
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
    const handlerFor = (name: string): ((args: unknown) => Promise<HandlerResult>) => {
      const call = registeredCalls.find(([toolName]) => toolName === name)

      if (!call) throw new Error(`tool not registered: ${name}`)
      const [, , handler] = call
      return async (args: unknown) => (await handler(args, mockExtra)) as HandlerResult
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
  ])("returns a .$extension file verbatim as text", async ({ extension, content }) => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, `file.${extension}`), content, "utf8")
    const result = await readAsset({ path: `file.${extension}` })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: "text", text: content }])
  })

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

  it("returns the source of a canvas that is not valid JSON when raw is true", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    await writeFile(join(vault, "Broken.canvas"), "{ not json", "utf8")
    const result = await readAsset({ path: "Broken.canvas", raw: true })
    expect(result).toEqual({
      content: [{ type: "text", text: "{ not json" }],
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
    const { buildMinimalPdf } = await import("../../obsidian-markdown/__tests__/pdf-fixture.js")
    await writeFile(join(vault, "doc.pdf"), buildMinimalPdf())
    const result = await readAsset({ path: "doc.pdf" })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringMatching(/^Title: \(untitled\) \| Pages: 1\n\n[\s\S]*Hello PDF/),
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

  it("pages a text file whose whole content exceeds the output cap", async () => {
    const { vault, readAsset } = await setupAssetHarness()
    // 2,000 lines of 100 bytes each: 200 KB in total, well past the cap, while
    // any small window stays under it.
    const lines = Array.from({ length: 2000 }, (_, lineIndex) => {
      return `line ${String(lineIndex + 1).padStart(4, "0")} `.padEnd(99, "x")
    })
    await mkdir(join(vault, "logs"), { recursive: true })
    await writeFile(join(vault, "logs/big.log"), `${lines.join("\n")}\n`, "utf8")
    const result = await readAsset({ path: "logs/big.log", start_line: 1001, limit: 2 })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "logs/big.log — lines 1001–1002 of 2000 (continue with start_line: 1003)",
        },
        { type: "text", text: `${lines[1000]}\n${lines[1001]}` },
      ],
    })
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
    expect(JSON.parse(requireTextContent(result))).toEqual({
      files: [
        { path: "media/a.png", extension: ".png", bytes: 5 },
        { path: "media/b.canvas", extension: ".canvas", bytes: 2 },
      ],
      extension_counts: { ".png": 1, ".canvas": 1 },
      total: 2,
      truncated: false,
    })
  })

  it("lists a file without an extension under the (none) marker", async () => {
    const { vault, listAssets } = await setupAssetHarness()
    await writeFile(join(vault, "license"), "12345", "utf8")
    await writeFile(join(vault, "photo.png"), "12", "utf8")
    const result = await listAssets({})
    expect(JSON.parse(requireTextContent(result))).toEqual({
      files: [
        { path: "license", extension: "(none)", bytes: 5 },
        { path: "photo.png", extension: ".png", bytes: 2 },
      ],
      extension_counts: { "(none)": 1, ".png": 1 },
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
      expect(JSON.parse(requireTextContent(result))).toEqual({
        files: [{ path: "a.png", extension: ".png", bytes: 5 }],
        extension_counts: { ".png": 1 },
        total: 1,
        truncated: false,
      })
    },
  )

  it("matches a file whose own extension is uppercase against a lowercase filter", async () => {
    const { vault, listAssets } = await setupAssetHarness()
    await writeFile(join(vault, "Scan.PNG"), "12345", "utf8")
    await writeFile(join(vault, "b.jpg"), "12", "utf8")
    const result = await listAssets({ extensions: ["png"] })
    expect(JSON.parse(requireTextContent(result))).toEqual({
      files: [{ path: "Scan.PNG", extension: ".png", bytes: 5 }],
      extension_counts: { ".png": 1 },
      total: 1,
      truncated: false,
    })
  })

  it("pages with limit while counts and total cover the full filtered set", async () => {
    const { vault, listAssets } = await setupAssetHarness()
    await writeFile(join(vault, "a.png"), "1", "utf8")
    await writeFile(join(vault, "b.png"), "22", "utf8")
    await writeFile(join(vault, "c.jpg"), "333", "utf8")
    const result = await listAssets({ limit: 1 })
    expect(JSON.parse(requireTextContent(result))).toEqual({
      files: [{ path: "a.png", extension: ".png", bytes: 1 }],
      extension_counts: { ".png": 2, ".jpg": 1 },
      total: 3,
      truncated: true,
    })
  })
})

describe("DISABLED_TOOLS", () => {
  it("hides exactly the named tools and keeps every other tool", () => {
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_write_note,vault_find_orphans",
    })
    const registeredNames = registeredCalls.map(([toolName]) => toolName)
    const expectedNames = ALL_TOOL_NAMES.filter((toolName) => {
      return toolName !== TOOL_NAMES.VAULT_WRITE_NOTE && toolName !== TOOL_NAMES.VAULT_FIND_ORPHANS
    })
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
    // it names vault_patch_note only while that tool is served. Sibling
    // tools (vault_write_note, vault_replace_in_note, vault_move_note) gate
    // their vault_patch_note mentions the same way.
    const registeredCalls = registerWithConfig({
      DISABLED_TOOLS: "vault_patch_note",
    })
    const readNoteCall = registeredCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE,
    )
    expect(readNoteCall?.[1].description).not.toContain(TOOL_NAMES.VAULT_PATCH_NOTE)
    // Guard against a vacuous pass: with nothing disabled, the reference IS
    // present.
    const enabledCalls = registerWithConfig({})
    const enabledReadNoteCall = enabledCalls.find(
      ([toolName]) => toolName === TOOL_NAMES.VAULT_READ_NOTE,
    )
    expect(enabledReadNoteCall?.[1].description).toContain(TOOL_NAMES.VAULT_PATCH_NOTE)
  })

  it("vault_read_note's board guidance names vault_list_tasks only while that tool is served", () => {
    const readNoteRoutingLine = (disabledTools: string): string => {
      return extractDescriptionSection({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
        toolName: TOOL_NAMES.VAULT_READ_NOTE,
        startMarker: "Prefer vault_search",
        endMarker: "\n\nSection boundaries:",
      })
    }
    const ROUTING_LINE_START = "Prefer vault_search when you don't know the path."
    const ROUTING_LINE_END =
      " Prefer vault_get_memory for About Me/ files (returns content without properties). To edit a section you've read, use vault_patch_note. To explore what links to this note or what it links to, use vault_get_backlinks and vault_get_outgoing_links."

    expect(readNoteRoutingLine("")).toBe(
      `${ROUTING_LINE_START} For task status or order on a board, prefer vault_list_tasks; heading mode returns a lane's verbatim Markdown.${ROUTING_LINE_END}`,
    )
    expect(readNoteRoutingLine("vault_list_tasks")).toBe(`${ROUTING_LINE_START}${ROUTING_LINE_END}`)
  })

  it("vault_list_tasks' lane guidance names vault_read_note only while that tool is served", () => {
    const listTasksRoutingLines = (disabledTools: string): string => {
      return extractDescriptionSection({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
        toolName: TOOL_NAMES.VAULT_LIST_TASKS,
        startMarker: "in one call instead of per-board reads.",
        endMarker: "\n\nBehavior:",
      })
    }
    const TRIAGE_LINE_END = "in one call instead of per-board reads.\n"
    const SEARCH_ROUTING = "Prefer vault_search for full-text queries over note content."

    expect(listTasksRoutingLines("")).toBe(
      `${TRIAGE_LINE_END}Prefer vault_read_note (heading mode) only when you need a lane's verbatim Markdown or a task's state right after a write. ${SEARCH_ROUTING}`,
    )
    expect(listTasksRoutingLines("vault_read_note")).toBe(`${TRIAGE_LINE_END}${SEARCH_ROUTING}`)
  })

  it("vault_delete_note's not-found entry keeps a remedy when vault_list_notes is disabled", () => {
    const notFoundEntry = (disabledTools: string): string | undefined => {
      return findDescriptionLine({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
        toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
        linePrefix: '- "note not found',
      })
    }

    expect(notFoundEntry("")).toBe('- "note not found: …" — verify path with vault_list_notes')
    expect(notFoundEntry("vault_list_notes")).toBe(
      `- "note not found: …" — check the path's spelling and letter case`,
    )
  })

  it("vault_get_backlinks' empty-result remedy names only served path-finding tools", () => {
    const emptyResultEntry = (disabledTools: string): string | undefined => {
      return findDescriptionLine({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
        toolName: TOOL_NAMES.VAULT_GET_BACKLINKS,
        linePrefix: "- A path nothing links to",
      })
    }
    const ENTRY_START =
      "- A path nothing links to returns an empty result (count 0), not an error — if you expected links,"

    expect(emptyResultEntry("")).toBe(
      `${ENTRY_START} find valid paths with vault_search, vault_list_notes, or vault_list_files.`,
    )
    expect(emptyResultEntry("vault_search,vault_list_files")).toBe(
      `${ENTRY_START} find valid paths with vault_list_notes.`,
    )
    expect(emptyResultEntry("vault_search,vault_list_notes,vault_list_files")).toBe(
      `${ENTRY_START} check the path's spelling and letter case.`,
    )
  })

  it("vault_delete_note's broken-links entry names vault_get_backlinks only while that tool is served", () => {
    const linksEntry = (disabledTools: string): string | undefined => {
      return findDescriptionLine({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
        toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
        linePrefix: "- Links to the note",
      })
    }
    const PROTECTED_PATHS_SENTENCE =
      " Protected paths are refused: About Me/ and the daily notes folder (read from DAILY_NOTES_FOLDER or .obsidian/daily-notes.json, defaulting to Daily Notes/)."

    expect(linksEntry("")).toBe(
      `- Links to the note from other notes become broken; list them first with vault_get_backlinks.${PROTECTED_PATHS_SENTENCE}`,
    )
    expect(linksEntry("vault_get_backlinks")).toBe(
      `- Links to the note from other notes become broken.${PROTECTED_PATHS_SENTENCE}`,
    )
  })

  it("vault_find_orphans points to vault_get_daily_note for the daily folder only while that tool is served", () => {
    const excludeFoldersEntry = (disabledTools: string): string | undefined => {
      return findDescriptionLine({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
        toolName: TOOL_NAMES.VAULT_FIND_ORPHANS,
        linePrefix: "- exclude_folders replaces the defaults",
      })
    }
    const ENTRY_START =
      "- exclude_folders replaces the defaults, it does not add to them — list a default yourself to keep it"
    const ENTRY_END =
      '. Pass [] for no exclusions. Each entry names a whole folder, subfolders included ("Projects" also excludes "Projects/Archive" but not "ProjectsOld/"), ignoring ASCII letter case.'

    expect(excludeFoldersEntry("")).toBe(
      `${ENTRY_START} (vault_get_daily_note's path starts with the daily notes folder)${ENTRY_END}`,
    )
    expect(excludeFoldersEntry("vault_get_daily_note")).toBe(`${ENTRY_START}${ENTRY_END}`)
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
      DISABLED_TOOLS: "vault_get_memory,vault_update_memory,vault_delete_memory",
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

  const DELETE_NOTE_MEMORY_LINE =
    "Prefer vault_delete_memory for removing individual dated entries from About Me/ memory files."
  const DELETE_NOTE_MOVE_LINE = "To relocate a note, use vault_move_note instead."
  const DELETE_NOTE_WRITE_LINE =
    "To replace a note's content, use vault_write_note with overwrite: true instead."

  it.each([
    {
      label: "names vault_move_note and vault_write_note while both are served",
      disabledTools: "",
      expectedLines: [DELETE_NOTE_MEMORY_LINE, DELETE_NOTE_MOVE_LINE, DELETE_NOTE_WRITE_LINE],
    },
    {
      label: "drops only the vault_move_note line when that tool is disabled",
      disabledTools: "vault_move_note",
      expectedLines: [DELETE_NOTE_MEMORY_LINE, DELETE_NOTE_WRITE_LINE],
    },
    {
      label: "drops only the vault_write_note line when that tool is disabled",
      disabledTools: "vault_write_note",
      expectedLines: [DELETE_NOTE_MEMORY_LINE, DELETE_NOTE_MOVE_LINE],
    },
  ])("vault_delete_note's when-to-use $label", ({ disabledTools, expectedLines }) => {
    const whenToUse = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_DELETE_NOTE,
      startMarker: "When to use:",
      endMarker: "\n\nBehavior:",
    })
    expect(whenToUse).toBe(
      ["When to use: Removing a note you no longer need.", ...expectedLines].join("\n"),
    )
  })

  const TAG_SEARCH_SCOPE_SENTENCE =
    "When to use: Tag-only lookups, for one tag or a whole tag hierarchy, with no text query."
  const TAG_SEARCH_LIST_TAGS_SENTENCE = " Use vault_list_tags first to discover available tags."
  const TAG_SEARCH_SEARCH_LINE = "\nPrefer vault_search when you need text-based relevance ranking."

  it.each([
    {
      label: "names vault_list_tags and vault_search while both are served",
      disabledTools: "",
      expectedSection: `${TAG_SEARCH_SCOPE_SENTENCE}${TAG_SEARCH_LIST_TAGS_SENTENCE}${TAG_SEARCH_SEARCH_LINE}`,
    },
    {
      label: "drops only the vault_list_tags sentence when that tool is disabled",
      disabledTools: "vault_list_tags",
      expectedSection: `${TAG_SEARCH_SCOPE_SENTENCE}${TAG_SEARCH_SEARCH_LINE}`,
    },
    {
      label: "drops only the vault_search line when that tool is disabled",
      disabledTools: "vault_search",
      expectedSection: `${TAG_SEARCH_SCOPE_SENTENCE}${TAG_SEARCH_LIST_TAGS_SENTENCE}`,
    },
    {
      label: "keeps only the scope sentence when both tools are disabled",
      disabledTools: "vault_list_tags,vault_search",
      expectedSection: TAG_SEARCH_SCOPE_SENTENCE,
    },
  ])("vault_search_by_tag's when-to-use $label", ({ disabledTools, expectedSection }) => {
    const whenToUse = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_SEARCH_BY_TAG,
      startMarker: "When to use:",
      endMarker: "\n\nParameters:",
    })
    expect(whenToUse).toBe(expectedSection)
  })

  const PROPERTY_VALUES_CHECKBOX_LINE =
    '- Checkbox values are stored as 1 and 0, so true and false come back as "1" and "0", counted with the numbers 1 and 0.'
  const PROPERTY_VALUES_SEARCH_LINE =
    '- vault_search_by_property matches stored numbers numerically and text exactly; value "1" matches the number 1, the text "1", and a checked checkbox.'
  const PROPERTY_VALUES_NULL_LINE = "- null values are skipped."

  it.each([
    {
      label: "names vault_search_by_property while it is served",
      disabledTools: "",
      expectedLines: [
        PROPERTY_VALUES_CHECKBOX_LINE,
        PROPERTY_VALUES_SEARCH_LINE,
        PROPERTY_VALUES_NULL_LINE,
      ],
    },
    {
      label: "drops the vault_search_by_property line when that tool is disabled",
      disabledTools: "vault_search_by_property",
      expectedLines: [PROPERTY_VALUES_CHECKBOX_LINE, PROPERTY_VALUES_NULL_LINE],
    },
  ])("vault_list_property_values's behavior $label", ({ disabledTools, expectedLines }) => {
    const behaviorTail = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_LIST_PROPERTY_VALUES,
      startMarker: "- Checkbox values",
      endMarker: "\n\nErrors:",
    })
    expect(behaviorTail).toBe(expectedLines.join("\n"))
  })

  it.each([
    {
      label: "names vault_replace_span while it is served",
      disabledTools: "",
      expectedAdvice: "use vault_replace_span (one atomic step)",
    },
    {
      label: "falls back to delete then vault_patch_note when vault_replace_span is disabled",
      disabledTools: "vault_replace_span",
      expectedAdvice: "delete it here, then vault_patch_note to add the new content",
    },
    {
      label: "says only to delete here when vault_replace_span and vault_patch_note are disabled",
      disabledTools: "vault_replace_span,vault_patch_note",
      expectedAdvice: "delete it here",
    },
  ])("vault_delete_span's replace advice $label", ({ disabledTools, expectedAdvice }) => {
    const replaceAdvice = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_DELETE_SPAN,
      startMarker: "To replace a block,",
      endMarker: "\n\nParameters:",
    })
    expect(replaceAdvice).toBe(`To replace a block, ${expectedAdvice}.`)
  })

  it.each([
    {
      label: "names vault_replace_in_note while it is served",
      disabledTools: "",
      expectedLine:
        "Prefer vault_replace_in_note for small in-place edits (this tool only deletes). To replace a block, use vault_replace_span (one atomic step).",
    },
    {
      label: "drops the vault_replace_in_note sentence when that tool is disabled",
      disabledTools: "vault_replace_in_note",
      expectedLine: "To replace a block, use vault_replace_span (one atomic step).",
    },
  ])("vault_delete_span's routing line $label", ({ disabledTools, expectedLine }) => {
    const routingLine = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_DELETE_SPAN,
      startMarker: "the last line for end_anchor.\n",
      endMarker: "\n\nParameters:",
    })
    expect(routingLine).toBe(`the last line for end_anchor.\n${expectedLine}`)
  })

  const FENCED_BLOCK_WARNING =
    "A span that starts at a code block's opening fence can't end at a plain closing fence (```): every fragment of the closing fence also appears in the opening fence, so the end anchor is ambiguous, and first_match: true would end the span at the opening fence"

  it.each([
    {
      label: "vault_delete_span names vault_replace_in_note while it is served",
      toolName: TOOL_NAMES.VAULT_DELETE_SPAN,
      disabledTools: "",
      expectedSentences: `${FENCED_BLOCK_WARNING}; to remove such a block, use vault_replace_in_note with new_text: "".`,
    },
    {
      label: "vault_delete_span keeps only the warning when vault_replace_in_note is disabled",
      toolName: TOOL_NAMES.VAULT_DELETE_SPAN,
      disabledTools: "vault_replace_in_note",
      expectedSentences: `${FENCED_BLOCK_WARNING}.`,
    },
    {
      label: "vault_replace_span names vault_replace_in_note while it is served",
      toolName: TOOL_NAMES.VAULT_REPLACE_SPAN,
      disabledTools: "",
      expectedSentences: `${FENCED_BLOCK_WARNING}; to replace such a block, use vault_replace_in_note.`,
    },
    {
      label: "vault_replace_span keeps only the warning when vault_replace_in_note is disabled",
      toolName: TOOL_NAMES.VAULT_REPLACE_SPAN,
      disabledTools: "vault_replace_in_note",
      expectedSentences: `${FENCED_BLOCK_WARNING}.`,
    },
  ])(
    "fenced-block end-anchor warning: $label",
    ({ toolName, disabledTools, expectedSentences }) => {
      const fencedBlockWarning = extractDescriptionSection({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
        toolName,
        startMarker: "A span that starts at a code block",
        endMarker: "\n- ",
      })
      expect(fencedBlockWarning).toBe(expectedSentences)
    },
  )

  it("vault_replace_in_note drops the vault_delete_span advice when that tool is disabled", () => {
    const whenToUse = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: "vault_delete_span" }),
      toolName: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
      startMarker: "When to use:",
      endMarker: "\n\nParameters:",
    })
    expect(whenToUse).toBe(
      [
        'When to use: Targeted text changes within a single location — fixing typos, updating values, renaming terms, or removing a short line (new_text=""). Replaces text in place; does not move content across sections.',
        'To replace a large block by anchors instead of reproducing the full old_text, use vault_replace_span. To relocate content between headings, use vault_patch_note to add at the target first, then remove from source (new_text="") — add-before-delete, so a failure duplicates the block instead of losing it.',
      ].join("\n"),
    )
  })

  it.each([
    {
      toolName: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
      startMarker: '- "text not found"',
      endMarker: '\n- "absolute path',
      expectedEntry:
        '- "text not found" — old_text does not appear in the note body; check old_text\'s letter case, spacing, and line breaks',
    },
    {
      toolName: TOOL_NAMES.VAULT_DELETE_SPAN,
      startMarker: '- "start anchor not found"',
      endMarker: '\n- "ambiguous',
      expectedEntry:
        '- "start anchor not found" / "end anchor not found" — no line contains the fragment (for end_anchor, none at or after the start line); check the fragment\'s letter case and spacing',
    },
    {
      toolName: TOOL_NAMES.VAULT_REPLACE_SPAN,
      startMarker: '- "start anchor not found"',
      endMarker: '\n- "ambiguous',
      expectedEntry:
        '- "start anchor not found" / "end anchor not found" — no line contains the fragment (for end_anchor, none at or after the start line); check the fragment\'s letter case and spacing',
    },
    {
      toolName: TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
      startMarker: '- "anchor not found"',
      endMarker: '\n- "ambiguous',
      expectedEntry:
        '- "anchor not found" — fragment not on any line; check the fragment\'s letter case and spacing',
    },
  ])(
    "$toolName's not-found entry keeps a remedy without vault_read_note",
    ({ toolName, startMarker, endMarker, expectedEntry }) => {
      const notFoundEntry = extractDescriptionSection({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: "vault_read_note" }),
        toolName,
        startMarker,
        endMarker,
      })
      expect(notFoundEntry).toBe(expectedEntry)
    },
  )

  it.each([
    {
      label: "offers vault_replace_in_note while it is served",
      disabledTools: "",
      expectedEntry:
        '- "ambiguous heading" — multiple headings match; use heading_level to disambiguate, or use vault_replace_in_note to target by text content when headings share the same level',
    },
    {
      label: "offers only heading_level when vault_replace_in_note is disabled",
      disabledTools: "vault_replace_in_note",
      expectedEntry:
        '- "ambiguous heading" — multiple headings match; use heading_level to disambiguate',
    },
  ])("vault_patch_note's ambiguous-heading entry $label", ({ disabledTools, expectedEntry }) => {
    const ambiguousHeadingEntry = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_PATCH_NOTE,
      startMarker: '- "ambiguous heading"',
      endMarker: '\n- "operation',
    })
    expect(ambiguousHeadingEntry).toBe(expectedEntry)
  })

  it.each([
    {
      label: "names both partial-edit tools while they are served",
      disabledTools: "",
      expectedEntry:
        '- "note already exists" — set overwrite: true to replace it, or use vault_patch_note or vault_replace_in_note for partial edits',
    },
    {
      label: "names only vault_patch_note when vault_replace_in_note is disabled",
      disabledTools: "vault_replace_in_note",
      expectedEntry:
        '- "note already exists" — set overwrite: true to replace it, or use vault_patch_note for partial edits',
    },
    {
      label: "names only vault_replace_in_note when vault_patch_note is disabled",
      disabledTools: "vault_patch_note",
      expectedEntry:
        '- "note already exists" — set overwrite: true to replace it, or use vault_replace_in_note for partial edits',
    },
    {
      label: "offers only overwrite when both partial-edit tools are disabled",
      disabledTools: "vault_patch_note,vault_replace_in_note",
      expectedEntry: '- "note already exists" — set overwrite: true to replace it',
    },
  ])("vault_write_note's already-exists entry $label", ({ disabledTools, expectedEntry }) => {
    const alreadyExistsEntry = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_WRITE_NOTE,
      startMarker: '- "note already exists"',
      endMarker: '\n- "path must end',
    })
    expect(alreadyExistsEntry).toBe(expectedEntry)
  })

  it.each([
    {
      label: "names vault_write_note and vault_read_note while they are served",
      disabledTools: "",
      expectedLine:
        "Prefer vault_write_note when creating a new note, or replacing the body (with overwrite: true). Read current properties first with vault_read_note({ properties_only: true }), or the full note when repairing a block. Arrays are replaced entirely, not appended to.",
    },
    {
      label: "drops the vault_write_note sentence when that tool is disabled",
      disabledTools: "vault_write_note",
      expectedLine:
        "Read current properties first with vault_read_note({ properties_only: true }), or the full note when repairing a block. Arrays are replaced entirely, not appended to.",
    },
    {
      label: "drops the vault_read_note sentence when that tool is disabled",
      disabledTools: "vault_read_note",
      expectedLine:
        "Prefer vault_write_note when creating a new note, or replacing the body (with overwrite: true). Arrays are replaced entirely, not appended to.",
    },
  ])("vault_update_properties's routing line $label", ({ disabledTools, expectedLine }) => {
    const routingLine = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
      startMarker: "the full note body.\n",
      endMarker: "\n\nErrors:",
    })
    expect(routingLine).toBe(`the full note body.\n${expectedLine}`)
  })

  const WRITE_NOTE_WHEN_TO_USE =
    "When to use: Creating a new note. Set overwrite: true only when you intend to replace an existing note's body."
  const WRITE_NOTE_PROPERTIES_LINE =
    "Prefer vault_update_properties for property-only edits (no body round-trip)."
  const WRITE_NOTE_MEMORY_LINE =
    "Prefer vault_update_memory for appending dated entries to About Me/ memory files."

  it.each([
    {
      label: "keeps both routing lines while their tools are served",
      disabledTools: "",
      expectedLines: [WRITE_NOTE_WHEN_TO_USE, WRITE_NOTE_PROPERTIES_LINE, WRITE_NOTE_MEMORY_LINE],
    },
    {
      label: "drops the vault_update_properties line when that tool is disabled",
      disabledTools: "vault_update_properties",
      expectedLines: [WRITE_NOTE_WHEN_TO_USE, WRITE_NOTE_MEMORY_LINE],
    },
    {
      label: "leaves only the when-to-use line when both routing tools are disabled",
      disabledTools: "vault_update_properties,vault_update_memory",
      expectedLines: [WRITE_NOTE_WHEN_TO_USE],
    },
  ])("vault_write_note's when-to-use $label", ({ disabledTools, expectedLines }) => {
    const whenToUse = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_WRITE_NOTE,
      startMarker: "When to use:",
      endMarker: "\n\nErrors:",
    })
    expect(whenToUse).toBe(expectedLines.join("\n"))
  })

  it.each([
    {
      label: "names both edit tools while they are served",
      disabledTools: "",
      expectedSentence:
        " To only change a note's body or properties, use vault_patch_note or vault_update_properties.",
    },
    {
      label: "names only vault_patch_note when vault_update_properties is disabled",
      disabledTools: "vault_update_properties",
      expectedSentence: " To only change a note's body or properties, use vault_patch_note.",
    },
    {
      label: "names only vault_update_properties when vault_patch_note is disabled",
      disabledTools: "vault_patch_note",
      expectedSentence: " To only change a note's body or properties, use vault_update_properties.",
    },
    {
      label: "drops the sentence when both edit tools are disabled",
      disabledTools: "vault_patch_note,vault_update_properties",
      expectedSentence: "",
    },
  ])("vault_move_note's edit routing $label", ({ disabledTools, expectedSentence }) => {
    const editRouting = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_MOVE_NOTE,
      startMarker: "which would orphan every backlink.",
      endMarker: " Protected paths",
    })
    expect(editRouting).toBe(`which would orphan every backlink.${expectedSentence}`)
  })

  const PATCH_NOTE_WHEN_TO_USE =
    "When to use: Modifying part of an existing note without overwriting the entire body."
  const PATCH_NOTE_WRITE_NOTE_SENTENCE =
    "Prefer vault_write_note for creating new notes, or full rewrites (with overwrite: true)."
  const PATCH_NOTE_REPLACE_IN_NOTE_SENTENCE =
    "Prefer vault_replace_in_note for in-place text changes (typos, renaming) that stay in the same location."
  const PATCH_NOTE_INSERT_AT_ANCHOR_SENTENCE =
    "Prefer vault_insert_at_anchor for inserting next to a specific line inside a section."
  const PATCH_NOTE_REPLACE_SPAN_SENTENCE =
    "Prefer vault_replace_span for replacing a run of lines inside a section."
  const PATCH_NOTE_DELETE_SPAN_SENTENCE = "Prefer vault_delete_span for removing lines."
  const PATCH_NOTE_UPDATE_PROPERTIES_SENTENCE =
    "Prefer vault_update_properties for changing frontmatter properties."
  const PATCH_NOTE_CREATE_TASK_SENTENCE = "Prefer vault_create_task for adding a task."
  const PATCH_NOTE_UPDATE_TASK_SENTENCE =
    "Prefer vault_update_task for completing or moving a task in one write."
  const ALL_PATCH_NOTE_ALTERNATIVES = [
    PATCH_NOTE_WRITE_NOTE_SENTENCE,
    PATCH_NOTE_REPLACE_IN_NOTE_SENTENCE,
    PATCH_NOTE_INSERT_AT_ANCHOR_SENTENCE,
    PATCH_NOTE_REPLACE_SPAN_SENTENCE,
    PATCH_NOTE_DELETE_SPAN_SENTENCE,
    PATCH_NOTE_UPDATE_PROPERTIES_SENTENCE,
    PATCH_NOTE_CREATE_TASK_SENTENCE,
    PATCH_NOTE_UPDATE_TASK_SENTENCE,
  ]

  const patchNoteWhenToUseWithout = (droppedSentence: string): string => {
    const servedSentences = ALL_PATCH_NOTE_ALTERNATIVES.filter(
      (sentence) => sentence !== droppedSentence,
    )
    return `${PATCH_NOTE_WHEN_TO_USE}\n${servedSentences.join(" ")}`
  }

  it.each([
    {
      label: "names all eight tools while they are served",
      disabledTools: "",
      expectedSection: `${PATCH_NOTE_WHEN_TO_USE}\n${ALL_PATCH_NOTE_ALTERNATIVES.join(" ")}`,
    },
    {
      label: "drops only the vault_write_note sentence when that tool is disabled",
      disabledTools: "vault_write_note",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_WRITE_NOTE_SENTENCE),
    },
    {
      label: "drops only the vault_replace_in_note sentence when that tool is disabled",
      disabledTools: "vault_replace_in_note",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_REPLACE_IN_NOTE_SENTENCE),
    },
    {
      label: "drops only the vault_insert_at_anchor sentence when that tool is disabled",
      disabledTools: "vault_insert_at_anchor",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_INSERT_AT_ANCHOR_SENTENCE),
    },
    {
      label: "drops only the vault_replace_span sentence when that tool is disabled",
      disabledTools: "vault_replace_span",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_REPLACE_SPAN_SENTENCE),
    },
    {
      label: "drops only the vault_delete_span sentence when that tool is disabled",
      disabledTools: "vault_delete_span",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_DELETE_SPAN_SENTENCE),
    },
    {
      label: "drops only the vault_update_properties sentence when that tool is disabled",
      disabledTools: "vault_update_properties",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_UPDATE_PROPERTIES_SENTENCE),
    },
    {
      label: "drops only the vault_create_task sentence when that tool is disabled",
      disabledTools: "vault_create_task",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_CREATE_TASK_SENTENCE),
    },
    {
      label: "drops only the vault_update_task sentence when that tool is disabled",
      disabledTools: "vault_update_task",
      expectedSection: patchNoteWhenToUseWithout(PATCH_NOTE_UPDATE_TASK_SENTENCE),
    },
    {
      label: "leaves only the when-to-use line when all eight tools are disabled",
      disabledTools:
        "vault_write_note,vault_replace_in_note,vault_insert_at_anchor,vault_replace_span,vault_delete_span,vault_update_properties,vault_create_task,vault_update_task",
      expectedSection: PATCH_NOTE_WHEN_TO_USE,
    },
  ])("vault_patch_note's when-to-use $label", ({ disabledTools, expectedSection }) => {
    const whenToUse = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_PATCH_NOTE,
      startMarker: "When to use:",
      endMarker: "\n\nOperations:",
    })
    expect(whenToUse).toBe(expectedSection)
  })

  it.each([
    {
      label: "names both property editors while they are served",
      disabledTools: "",
      expectedLine:
        "Operates on the body only — properties must be edited via vault_update_properties or vault_write_note's properties parameter.",
    },
    {
      label: "names only vault_write_note when vault_update_properties is disabled",
      disabledTools: "vault_update_properties",
      expectedLine:
        "Operates on the body only — properties must be edited via vault_write_note's properties parameter.",
    },
    {
      label: "names only vault_update_properties when vault_write_note is disabled",
      disabledTools: "vault_write_note",
      expectedLine:
        "Operates on the body only — properties must be edited via vault_update_properties.",
    },
    {
      label: "drops the clause when both property editors are disabled",
      disabledTools: "vault_update_properties,vault_write_note",
      expectedLine: "Operates on the body only.",
    },
  ])("vault_replace_in_note's opening $label", ({ disabledTools, expectedLine }) => {
    const bodyOnlyLine = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
      startMarker: "Operates on the body only",
      endMarker: "\n\nExample:",
    })
    expect(bodyOnlyLine).toBe(expectedLine)
  })

  it.each([
    {
      toolName: TOOL_NAMES.VAULT_PATCH_NOTE,
      expectedEntry: '- "note not found" — path does not exist; check its spelling and letter case',
    },
    {
      toolName: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
      expectedEntry: '- "note not found" — path does not exist; check its spelling and letter case',
    },
    {
      toolName: TOOL_NAMES.VAULT_DELETE_SPAN,
      expectedEntry: '- "note not found" — check the path\'s spelling and letter case',
    },
    {
      toolName: TOOL_NAMES.VAULT_REPLACE_SPAN,
      expectedEntry: '- "note not found" — check the path\'s spelling and letter case',
    },
    {
      toolName: TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
      expectedEntry: '- "note not found" — check the path\'s spelling and letter case',
    },
  ])(
    "$toolName's note-not-found entry keeps a remedy without vault_list_notes",
    ({ toolName, expectedEntry }) => {
      const noteNotFoundEntry = extractDescriptionSection({
        registeredCalls: registerWithConfig({ DISABLED_TOOLS: "vault_list_notes" }),
        toolName,
        startMarker: '- "note not found"',
        endMarker: '\n- "path must end in',
      })
      expect(noteNotFoundEntry).toBe(expectedEntry)
    },
  )

  const PATCH_NOTE_SECTION_BOUNDARIES =
    'Section boundaries: a section spans from its heading to the next heading of the same or higher level (or EOF), so it includes its child headings. Empty headings ("##" with no text) act as boundaries but cannot be targeted'
  const EMPTY_HEADING_EDIT_ADVICE = " — edit their content via vault_replace_in_note instead"
  const LEADING_CALLOUT_EDIT =
    "Editing a leading callout: read it via vault_read_note(outline: true), then vault_replace_in_note the old block for the new one (a no-heading prepend would stack a second callout above it)."

  it.each([
    {
      label: "names both tools while both are served",
      disabledTools: "",
      expectedSection: `${PATCH_NOTE_SECTION_BOUNDARIES}${EMPTY_HEADING_EDIT_ADVICE}.\n\n${LEADING_CALLOUT_EDIT}`,
    },
    {
      label:
        "drops the empty-heading advice and the callout edit when vault_replace_in_note is disabled",
      disabledTools: "vault_replace_in_note",
      expectedSection: `${PATCH_NOTE_SECTION_BOUNDARIES}.`,
    },
    {
      label: "drops only the callout edit when vault_read_note is disabled",
      disabledTools: "vault_read_note",
      expectedSection: `${PATCH_NOTE_SECTION_BOUNDARIES}${EMPTY_HEADING_EDIT_ADVICE}.`,
    },
  ])("vault_patch_note's section-boundary text $label", ({ disabledTools, expectedSection }) => {
    const sectionBoundariesText = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName: TOOL_NAMES.VAULT_PATCH_NOTE,
      startMarker: "Section boundaries:",
      endMarker: "\n\nErrors:",
    })
    expect(sectionBoundariesText).toBe(expectedSection)
  })

  const REPLACE_SPAN_WHEN_TO_USE =
    "When to use: Replacing a block you have already read — a table row, callout, or run of list items — where reproducing it exactly as old_text would be error-prone. Pick a short, unique fragment of the first line for start_anchor and, for a multi-line block, the last line for end_anchor."
  const INSERT_AT_ANCHOR_WHEN_TO_USE =
    "When to use: Adding content at a precise location identified by a nearby line's text, without needing to know the heading structure. Good for inserting rows into tables, adding items into lists at a specific position, or placing content relative to a known landmark line."

  it.each([
    {
      label:
        "vault_replace_span starts its alternatives line at vault_delete_span when vault_replace_in_note is disabled",
      toolName: TOOL_NAMES.VAULT_REPLACE_SPAN,
      disabledTools: "vault_replace_in_note",
      expectedWhenToUse: `${REPLACE_SPAN_WHEN_TO_USE}\nPrefer vault_delete_span when removing without replacement.`,
    },
    {
      label: "vault_replace_span drops its alternatives line when both tools it names are disabled",
      toolName: TOOL_NAMES.VAULT_REPLACE_SPAN,
      disabledTools: "vault_replace_in_note,vault_delete_span",
      expectedWhenToUse: REPLACE_SPAN_WHEN_TO_USE,
    },
    {
      label:
        "vault_insert_at_anchor starts its alternatives line at vault_replace_span when vault_patch_note is disabled",
      toolName: TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
      disabledTools: "vault_patch_note",
      expectedWhenToUse: `${INSERT_AT_ANCHOR_WHEN_TO_USE}\nPrefer vault_replace_span when replacing a block rather than inserting next to it.`,
    },
    {
      label:
        "vault_insert_at_anchor drops its alternatives line when both tools it names are disabled",
      toolName: TOOL_NAMES.VAULT_INSERT_AT_ANCHOR,
      disabledTools: "vault_patch_note,vault_replace_span",
      expectedWhenToUse: INSERT_AT_ANCHOR_WHEN_TO_USE,
    },
    {
      label:
        "vault_replace_in_note drops its alternatives line when all three tools it names are disabled",
      toolName: TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
      disabledTools: "vault_delete_span,vault_replace_span,vault_patch_note",
      expectedWhenToUse:
        'When to use: Targeted text changes within a single location — fixing typos, updating values, renaming terms, or removing a short line (new_text=""). Replaces text in place; does not move content across sections.',
    },
  ])("$label", ({ toolName, disabledTools, expectedWhenToUse }) => {
    const whenToUse = extractDescriptionSection({
      registeredCalls: registerWithConfig({ DISABLED_TOOLS: disabledTools }),
      toolName,
      startMarker: "When to use:",
      endMarker: "\n\nParameters:",
    })
    expect(whenToUse).toBe(expectedWhenToUse)
  })
})

describe("flag-combination matrix", () => {
  const BOOL_VALUES = ["false", "true"] as const
  const flagCombos = BOOL_VALUES.flatMap((readonlyValue) => {
    return BOOL_VALUES.flatMap((memoryValue) => {
      return BOOL_VALUES.flatMap((fileValue) => {
        return BOOL_VALUES.map((embeddingValue) => ({
          READONLY_MODE: readonlyValue,
          MEMORY_ENABLED: memoryValue,
          FILE_TOOLS_ENABLED: fileValue,
          EMBEDDING_ENABLED: embeddingValue,
        }))
      })
    })
  })
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
      const registeredCalls = server.registerTool.mock.calls as RegisterToolCall[]
      const registeredNames = registeredCalls.map(([toolName]) => toolName)
      expect(new Set(registeredNames)).toEqual(computeEnabledToolNames(config))
      expect(registeredNames).toHaveLength(computeEnabledToolNames(config).size)
    },
  )
})

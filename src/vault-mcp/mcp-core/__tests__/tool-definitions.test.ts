import { describe, it, expect, beforeEach, vi } from "vitest"
import { registerTools, TOOL_NAMES } from "../tool-definitions.js"
import { loadConfig } from "../../config.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../../search/search-index.js"
import { logger } from "../../../logger.js"

const ALL_TOOL_NAMES = Object.values(TOOL_NAMES)

const READ_ONLY_TOOLS = [
  TOOL_NAMES.VAULT_READ_NOTE,
  TOOL_NAMES.VAULT_LIST_NOTES,
  TOOL_NAMES.VAULT_SEARCH,
  TOOL_NAMES.VAULT_SEARCH_BY_TAG,
  TOOL_NAMES.VAULT_SEARCH_BY_FOLDER,
  TOOL_NAMES.VAULT_LIST_TAGS,
  TOOL_NAMES.VAULT_RECENT_NOTES,
  TOOL_NAMES.VAULT_GET_MEMORY,
  TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
  TOOL_NAMES.VAULT_GET_DAILY_NOTE,
  TOOL_NAMES.VAULT_LIST_PROPERTY_KEYS,
  TOOL_NAMES.VAULT_LIST_PROPERTY_VALUES,
  TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY,
  TOOL_NAMES.VAULT_GET_BACKLINKS,
  TOOL_NAMES.VAULT_GET_OUTGOING_LINKS,
  TOOL_NAMES.VAULT_FIND_ORPHANS,
] as const

const DESTRUCTIVE_TOOLS = [
  TOOL_NAMES.VAULT_WRITE_NOTE,
  TOOL_NAMES.VAULT_DELETE_NOTE,
  TOOL_NAMES.VAULT_DELETE_SPAN,
  TOOL_NAMES.VAULT_MOVE_NOTE,
  TOOL_NAMES.VAULT_DELETE_MEMORY,
  TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
] as const

// Writers that only add to the vault — never overwrite or delete existing
// content — so destructiveHint must be false even though readOnlyHint is too.
const ADDITIVE_WRITE_TOOLS = [TOOL_NAMES.VAULT_UPDATE_MEMORY] as const

const WRITE_TOOLS = [
  TOOL_NAMES.VAULT_WRITE_NOTE,
  TOOL_NAMES.VAULT_PATCH_NOTE,
  TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
  TOOL_NAMES.VAULT_DELETE_SPAN,
  TOOL_NAMES.VAULT_MOVE_NOTE,
  TOOL_NAMES.VAULT_UPDATE_MEMORY,
  TOOL_NAMES.VAULT_UPDATE_PROPERTIES,
] as const

type RegisterToolCall = [
  name: string,
  config: {
    title?: string
    description?: string
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

describe("registerTools", () => {
  it(`registers exactly ${ALL_TOOL_NAMES.length} tools`, () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(ALL_TOOL_NAMES.length)
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
      const [, config] = findCall(name)!
      expect(config.description).toContain("Obsidian syntax:")
    },
  )

  it("vault_replace_in_note description clarifies in-place scope", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_REPLACE_IN_NOTE)!
    expect(config.description).toContain("in place")
    expect(config.description).toContain("vault_read_note")
  })

  it("vault_patch_note description includes cross-section move guidance", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_PATCH_NOTE)!
    expect(config.description).toContain("Cross-section move")
  })

  it.each([TOOL_NAMES.VAULT_UPDATE_MEMORY, TOOL_NAMES.VAULT_DELETE_MEMORY])(
    "%s description documents the shrink-guard error",
    (name) => {
      const [, config] = findCall(name)!
      expect(config.description).toContain("Errors:")
      expect(config.description).toContain("refusing memory write")
    },
  )

  it("vault_update_properties description documents null-deletes-key contract", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_UPDATE_PROPERTIES)!
    expect(config.description).toContain("null as a value to delete")
  })

  it("vault_write_note description documents null-deletes-key contract", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_WRITE_NOTE)!
    expect(config.description).toContain("keys set to null removed")
  })

  it("vault_recent_notes description documents sorting behavior", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_RECENT_NOTES)!
    expect(config.description).toContain("Sorting behavior:")
    expect(config.description).toContain("sort to the bottom")
  })

  it("vault_read_note description cross-references graph tools", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_READ_NOTE)!
    expect(config.description).toContain("vault_get_backlinks")
    expect(config.description).toContain("vault_get_outgoing_links")
  })

  it("vault_search_by_property parameters cross-reference discovery tools", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_SEARCH_BY_PROPERTY)!
    expect(config.description).toContain("vault_list_property_keys")
    expect(config.description).toContain("vault_list_property_values")
  })

  it("vault_list_notes description cross-references vault_read_note", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_LIST_NOTES)!
    expect(config.description).toContain("vault_read_note")
  })

  it("vault_get_daily_note description cross-references vault_recent_notes", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_GET_DAILY_NOTE)!
    expect(config.description).toContain("vault_recent_notes")
  })

  it("vault_search_by_folder description cross-references graph tools", () => {
    const [, config] = findCall(TOOL_NAMES.VAULT_SEARCH_BY_FOLDER)!
    expect(config.description).toContain("vault_get_backlinks")
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
    const [, config] = findCall(name)!
    expect(config.annotations?.readOnlyHint).toBe(true)
    expect(config.annotations?.destructiveHint).toBe(false)
  })

  it.each(DESTRUCTIVE_TOOLS)("%s has destructiveHint: true", (name) => {
    const [, config] = findCall(name)!
    expect(config.annotations?.destructiveHint).toBe(true)
    expect(config.annotations?.readOnlyHint).toBe(false)
  })

  it.each(ADDITIVE_WRITE_TOOLS)("%s is a non-destructive write", (name) => {
    const [, config] = findCall(name)!
    expect(config.annotations?.readOnlyHint).toBe(false)
    expect(config.annotations?.destructiveHint).toBe(false)
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

  const findCustomCall = (name: string): RegisterToolCall | undefined =>
    customCalls.find(([toolName]) => toolName === name)

  const DEFAULT_MEMORY_REF = "About Me/"

  const memoryDirTools = [
    { name: "vault_get_memory", toolName: TOOL_NAMES.VAULT_GET_MEMORY },
    { name: "vault_update_memory", toolName: TOOL_NAMES.VAULT_UPDATE_MEMORY },
    {
      name: "vault_list_memory_files",
      toolName: TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    },
    { name: "vault_delete_memory", toolName: TOOL_NAMES.VAULT_DELETE_MEMORY },
    { name: "vault_read_note", toolName: TOOL_NAMES.VAULT_READ_NOTE },
  ] as const

  it.each(memoryDirTools)(
    "$name description references the configured memory dir",
    ({ toolName }) => {
      const [, config] = findCustomCall(toolName)!
      expect(config.description).toContain(`${CUSTOM_MEMORY_DIR}/`)
      expect(config.description).not.toContain(DEFAULT_MEMORY_REF)
    },
  )

  it("vault_delete_note description lists configured protected paths", () => {
    const [, config] = findCustomCall(TOOL_NAMES.VAULT_DELETE_NOTE)!
    expect(config.description).toContain("Profile/")
    expect(config.description).not.toContain("About Me/")
  })

  it("vault_find_orphans description references configured exclusion folders", () => {
    const [, config] = findCustomCall(TOOL_NAMES.VAULT_FIND_ORPHANS)!
    expect(config.description).toContain(CUSTOM_MEMORY_DIR)
    expect(config.description).not.toContain("About Me")
  })
})

describe("error handling", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  it("vault_read_note handler returns isError on failure", async () => {
    const [, , handler] = findCall(TOOL_NAMES.VAULT_READ_NOTE)!
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('note not found: "nonexistent.md"')
  })

  it("error text does not contain stack traces", async () => {
    const [, , handler] = findCall(TOOL_NAMES.VAULT_READ_NOTE)!
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0].text).not.toContain("    at ")
    expect(result.content[0].text).not.toContain("node:internal")
  })

  it("vault_get_memory rejects section without file", async () => {
    const [, , handler] = findCall(TOOL_NAMES.VAULT_GET_MEMORY)!
    const result = (await handler(
      { file: undefined, section: "Decision heuristics" },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe("section requires a file")
  })

  it("vault_get_memory handler returns isError on failure", async () => {
    const [, , handler] = findCall(TOOL_NAMES.VAULT_GET_MEMORY)!
    const result = (await handler(
      { file: "Nonexistent", section: undefined },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(
      'memory file not found: "About Me/Nonexistent.md"',
    )
  })

  it("vault_read_note rejects combining outline with heading", async () => {
    const [, , handler] = findCall(TOOL_NAMES.VAULT_READ_NOTE)!
    const result = (await handler(
      { path: "note.md", outline: true, heading: "Active" },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(
      "outline, heading, and properties_only are mutually exclusive — set at most one",
    )
  })

  it("vault_read_note rejects heading_level without a heading", async () => {
    const [, , handler] = findCall(TOOL_NAMES.VAULT_READ_NOTE)!
    const result = (await handler(
      { path: "note.md", heading_level: 2 },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe("heading_level requires a heading")
  })
})

describe("MEMORY_ENABLED=false", () => {
  const MEMORY_TOOLS = [
    TOOL_NAMES.VAULT_GET_MEMORY,
    TOOL_NAMES.VAULT_UPDATE_MEMORY,
    TOOL_NAMES.VAULT_LIST_MEMORY_FILES,
    TOOL_NAMES.VAULT_DELETE_MEMORY,
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

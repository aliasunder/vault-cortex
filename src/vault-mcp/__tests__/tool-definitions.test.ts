import { describe, it, expect, beforeEach, vi } from "vitest"
import { registerTools, TOOL_NAMES } from "../tool-definitions.js"
import { loadConfig } from "../config.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search/search-index.js"
import { logger } from "../../logger.js"

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
  TOOL_NAMES.VAULT_UPDATE_MEMORY,
  TOOL_NAMES.VAULT_DELETE_MEMORY,
] as const

const WRITE_TOOLS = [
  TOOL_NAMES.VAULT_WRITE_NOTE,
  TOOL_NAMES.VAULT_PATCH_NOTE,
  TOOL_NAMES.VAULT_REPLACE_IN_NOTE,
  TOOL_NAMES.VAULT_UPDATE_MEMORY,
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
  calls.find((c) => c[0] === name)

describe("registerTools", () => {
  it(`registers exactly ${ALL_TOOL_NAMES.length} tools`, () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(ALL_TOOL_NAMES.length)
  })

  it.each(ALL_TOOL_NAMES)("registers %s", (name) => {
    expect(findCall(name)).toBeDefined()
  })

  it("every tool has a title", () => {
    for (const call of calls) {
      expect(call[1].title).toBeDefined()
      expect(call[1].title!.length).toBeGreaterThan(0)
    }
  })

  it("every tool has a description", () => {
    for (const call of calls) {
      expect(call[1].description).toBeDefined()
      expect(call[1].description!.length).toBeGreaterThan(0)
    }
  })

  it("every tool description includes an example", () => {
    for (const call of calls) {
      expect(call[1].description).toContain("Example:")
    }
  })

  it("every tool description includes when to use guidance", () => {
    for (const call of calls) {
      expect(call[1].description).toContain("When to use")
    }
  })

  it.each(WRITE_TOOLS)(
    "%s description includes Obsidian syntax guidance",
    (name) => {
      const call = findCall(name)!
      expect(call[1].description).toContain("Obsidian syntax:")
    },
  )

  it("every tool has all 4 annotation hints", () => {
    for (const call of calls) {
      const annotations = call[1].annotations!
      expect(annotations).toHaveProperty("readOnlyHint")
      expect(annotations).toHaveProperty("destructiveHint")
      expect(annotations).toHaveProperty("idempotentHint")
      expect(annotations).toHaveProperty("openWorldHint")
    }
  })
})

describe("annotations", () => {
  it.each(READ_ONLY_TOOLS)("%s has readOnlyHint: true", (name) => {
    const call = findCall(name)!
    expect(call[1].annotations?.readOnlyHint).toBe(true)
    expect(call[1].annotations?.destructiveHint).toBe(false)
  })

  it.each(DESTRUCTIVE_TOOLS)("%s has destructiveHint: true", (name) => {
    const call = findCall(name)!
    expect(call[1].annotations?.destructiveHint).toBe(true)
    expect(call[1].annotations?.readOnlyHint).toBe(false)
  })

  it("all tools have openWorldHint: false", () => {
    for (const call of calls) {
      expect(call[1].annotations?.openWorldHint).toBe(false)
    }
  })
})

describe("config interpolation in descriptions", () => {
  const CUSTOM_MEMORY_DIR = "Profile"
  const customConfig = loadConfig({ MEMORY_DIR: CUSTOM_MEMORY_DIR })
  let customCalls: RegisterToolCall[]

  beforeEach(() => {
    const customServer = { registerTool: vi.fn() }
    registerTools({
      server: customServer as unknown as McpServer,
      vaultPath: "/test-vault",
      search: {} as SearchIndex,
      logger,
      config: customConfig,
    })
    customCalls = customServer.registerTool.mock.calls as RegisterToolCall[]
  })

  const findCustomCall = (name: string): RegisterToolCall | undefined =>
    customCalls.find((c) => c[0] === name)

  it("vault_get_memory description references the configured memory dir", () => {
    const call = findCustomCall(TOOL_NAMES.VAULT_GET_MEMORY)!
    expect(call[1].description).toContain(`${CUSTOM_MEMORY_DIR}/`)
    expect(call[1].description).not.toContain("About Me/")
  })

  it("vault_update_memory description references the configured memory dir", () => {
    const call = findCustomCall(TOOL_NAMES.VAULT_UPDATE_MEMORY)!
    expect(call[1].description).toContain(`${CUSTOM_MEMORY_DIR}/`)
    expect(call[1].description).not.toContain("About Me/")
  })

  it("vault_list_memory_files description references the configured memory dir", () => {
    const call = findCustomCall(TOOL_NAMES.VAULT_LIST_MEMORY_FILES)!
    expect(call[1].description).toContain(`${CUSTOM_MEMORY_DIR}/`)
    expect(call[1].description).not.toContain("About Me/")
  })

  it("vault_delete_memory description references the configured memory dir", () => {
    const call = findCustomCall(TOOL_NAMES.VAULT_DELETE_MEMORY)!
    expect(call[1].description).toContain(`${CUSTOM_MEMORY_DIR}/`)
    expect(call[1].description).not.toContain("About Me/")
  })

  it("vault_delete_note description lists configured protected paths", () => {
    const call = findCustomCall(TOOL_NAMES.VAULT_DELETE_NOTE)!
    expect(call[1].description).toContain("Profile/")
    expect(call[1].description).not.toContain("About Me/")
  })

  it("vault_read_note description references the configured memory dir", () => {
    const call = findCustomCall(TOOL_NAMES.VAULT_READ_NOTE)!
    expect(call[1].description).toContain(`${CUSTOM_MEMORY_DIR}/`)
    expect(call[1].description).not.toContain("About Me/")
  })

  it("vault_find_orphans description references configured exclusion folders", () => {
    const call = findCustomCall(TOOL_NAMES.VAULT_FIND_ORPHANS)!
    expect(call[1].description).toContain(CUSTOM_MEMORY_DIR)
    expect(call[1].description).not.toContain("About Me")
  })
})

describe("error handling", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  it("vault_read_note handler returns isError on failure", async () => {
    const call = findCall(TOOL_NAMES.VAULT_READ_NOTE)!
    const handler = call[2]
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBeTruthy()
  })

  it("error text does not contain stack traces", async () => {
    const call = findCall(TOOL_NAMES.VAULT_READ_NOTE)!
    const handler = call[2]
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0].text).not.toContain("    at ")
    expect(result.content[0].text).not.toContain("node:internal")
  })

  it("vault_get_memory handler returns isError on failure", async () => {
    const call = findCall(TOOL_NAMES.VAULT_GET_MEMORY)!
    const handler = call[2]
    const result = (await handler(
      { file: "Nonexistent", section: undefined },
      mockExtra,
    )) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
  })
})

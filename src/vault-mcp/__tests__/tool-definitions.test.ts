import { describe, it, expect, beforeEach, vi } from "vitest"
import { registerTools } from "../tool-definitions.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SearchIndex } from "../search-index.js"
import { logger } from "../../logger.js"

const TOOL_NAMES = [
  "vault_read_note",
  "vault_write_note",
  "vault_list_notes",
  "vault_delete_note",
  "vault_search",
  "vault_search_by_tag",
  "vault_search_by_folder",
  "vault_list_tags",
  "vault_recent_notes",
  "vault_get_memory",
  "vault_update_memory",
  "vault_list_memory_files",
  "vault_delete_memory",
] as const

const READ_ONLY_TOOLS = [
  "vault_read_note",
  "vault_list_notes",
  "vault_search",
  "vault_search_by_tag",
  "vault_search_by_folder",
  "vault_list_tags",
  "vault_recent_notes",
  "vault_get_memory",
  "vault_list_memory_files",
] as const

const DESTRUCTIVE_TOOLS = [
  "vault_write_note",
  "vault_delete_note",
  "vault_update_memory",
  "vault_delete_memory",
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
  })
  calls = mockServer.registerTool.mock.calls as RegisterToolCall[]
})

const findCall = (name: string): RegisterToolCall | undefined =>
  calls.find((c) => c[0] === name)

describe("registerTools", () => {
  it("registers exactly 13 tools", () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(13)
  })

  it.each(TOOL_NAMES)("registers %s", (name) => {
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

describe("error handling", () => {
  const mockExtra = { requestId: "test-1", sessionId: "session-1" }

  it("vault_read_note handler returns isError on failure", async () => {
    const call = findCall("vault_read_note")!
    const handler = call[2]
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBeTruthy()
  })

  it("error text does not contain stack traces", async () => {
    const call = findCall("vault_read_note")!
    const handler = call[2]
    const result = (await handler({ path: "nonexistent.md" }, mockExtra)) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0].text).not.toContain("    at ")
    expect(result.content[0].text).not.toContain("node:internal")
  })

  it("vault_get_memory handler returns isError on failure", async () => {
    const call = findCall("vault_get_memory")!
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

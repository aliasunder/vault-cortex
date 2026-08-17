/** End-to-end integration tests — every tool and prompt called over real
 *  HTTP transport against a real server with a real vault on disk. */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  startServer,
  startServerExpectingFailure,
  createTestClient,
  toolNames,
  promptNames,
} from "./test-harness.js"

vi.setConfig({ testTimeout: 15_000 })

const BASE_PORT = 19400

type TextBlock = { type: "text"; text: string }
type ToolResult = { isError?: boolean; content: TextBlock[] }

const callTool = async ({
  client,
  name,
  args = {},
}: {
  client: Client
  name: string
  args?: Record<string, unknown>
}): Promise<ToolResult> =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>

const textContent = (result: ToolResult): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")

/** Extract joined text from a prompt result's messages. */
const promptText = (result: Awaited<ReturnType<Client["getPrompt"]>>): string =>
  result.messages
    .map((message) =>
      message.content.type === "text" ? message.content.text : "",
    )
    .join("\n")

// ── Default config (30 tools, 3 prompts) ──────────────────────

describe("default config", () => {
  let client: Client
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const server = await startServer(BASE_PORT)
    client = await createTestClient(server.port)
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    await client.close()
    await cleanup()
  })

  describe("surface", () => {
    it("lists 30 tools", async () => {
      const names = await toolNames(client)
      expect(names).toHaveLength(30)
    })

    it("lists 3 prompts", async () => {
      const names = await promptNames(client)
      expect(names).toHaveLength(3)
      expect(names).toEqual([
        "daily-review",
        "memory-review",
        "vault-orientation",
      ])
    })
  })

  describe("vault-crud read tools", () => {
    it("vault_read_note — full content", async () => {
      const result = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Project Alpha")
    })

    it("vault_read_note — outline mode", async () => {
      const result = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md", outline: true },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Tasks")
    })

    it("vault_read_note — heading mode", async () => {
      const result = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md", heading: "Tasks" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("alpha-task-1")
    })

    it("vault_read_note — properties_only", async () => {
      const result = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md", properties_only: true },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("active")
    })

    it("vault_list_notes", async () => {
      const result = await callTool({ client, name: "vault_list_notes" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Projects/alpha.md")
    })

    it("vault_list_notes — folder filter", async () => {
      const result = await callTool({
        client,
        name: "vault_list_notes",
        args: { folder: "Projects" },
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("Projects/alpha.md")
      expect(text).not.toContain("Orphan Note.md")
    })
  })

  describe("search tools", () => {
    it("vault_search", async () => {
      const result = await callTool({
        client,
        name: "vault_search",
        args: { query: "integration testing" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("alpha")
    })

    it("vault_search_by_tag", async () => {
      const result = await callTool({
        client,
        name: "vault_search_by_tag",
        args: { tag: "project" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("alpha")
    })

    it("vault_list_tags", async () => {
      const result = await callTool({ client, name: "vault_list_tags" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("project")
    })

    it("vault_recent_notes", async () => {
      const result = await callTool({ client, name: "vault_recent_notes" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain(".md")
    })

    it("vault_search_by_folder", async () => {
      const result = await callTool({
        client,
        name: "vault_search_by_folder",
        args: { folder: "Projects" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("alpha")
    })

    it("vault_list_property_keys", async () => {
      const result = await callTool({
        client,
        name: "vault_list_property_keys",
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("status")
    })

    it("vault_list_property_values", async () => {
      const result = await callTool({
        client,
        name: "vault_list_property_values",
        args: { key: "status" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("active")
    })

    it("vault_search_by_property", async () => {
      const result = await callTool({
        client,
        name: "vault_search_by_property",
        args: { key: "status", value: "active" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("alpha")
    })

    it("vault_get_backlinks", async () => {
      const result = await callTool({
        client,
        name: "vault_get_backlinks",
        args: { path: "Projects/beta.md" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("alpha")
    })

    it("vault_get_outgoing_links", async () => {
      const result = await callTool({
        client,
        name: "vault_get_outgoing_links",
        args: { path: "Projects/alpha.md" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("beta")
    })

    it("vault_find_orphans", async () => {
      const result = await callTool({ client, name: "vault_find_orphans" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Orphan Note")
    })
  })

  describe("memory tools", () => {
    it("vault_list_memory_files", async () => {
      const result = await callTool({
        client,
        name: "vault_list_memory_files",
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Preferences")
    })

    it("vault_get_memory — all", async () => {
      const result = await callTool({ client, name: "vault_get_memory" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("dark mode")
    })

    it("vault_get_memory — file + section", async () => {
      const result = await callTool({
        client,
        name: "vault_get_memory",
        args: { file: "Preferences", section: "Editor settings" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Vim keybindings")
    })

    it("vault_memory_recall", async () => {
      const result = await callTool({
        client,
        name: "vault_memory_recall",
        args: { query: "dark mode" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("dark mode")
    })

    it("vault_update_memory + vault_delete_memory cycle", async () => {
      // Use a fixed date so the delete matches regardless of timezone
      // (server defaults to Luxon local time; `new Date().toISOString()` is UTC)
      const testDate = "2026-01-15"
      const updateResult = await callTool({
        client,
        name: "vault_update_memory",
        args: {
          file: "Preferences",
          section: "Editor settings",
          entry: "Integration test entry — SDK Client",
          options: { date: testDate },
        },
      })
      expect(updateResult.isError).not.toBe(true)

      const deleteResult = await callTool({
        client,
        name: "vault_delete_memory",
        args: {
          file: "Preferences",
          section: "Editor settings",
          date: testDate,
          entry: "Integration test entry — SDK Client",
        },
      })
      expect(deleteResult.isError).not.toBe(true)
    })
  })

  describe("task tools", () => {
    it("vault_list_tasks", async () => {
      const result = await callTool({ client, name: "vault_list_tasks" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("alpha-task-1")
    })

    it("vault_update_task", async () => {
      const result = await callTool({
        client,
        name: "vault_update_task",
        args: {
          path: "Projects/alpha.md",
          block_id: "alpha-task-1",
          priority: "high",
        },
      })
      expect(result.isError).not.toBe(true)
    })
  })

  describe("daily note tool", () => {
    it("vault_get_daily_note", async () => {
      const result = await callTool({
        client,
        name: "vault_get_daily_note",
        args: { date: "2026-01-15" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("integration test results")
    })
  })

  describe("write chain", () => {
    it("write → patch → replace → delete_span → update_properties → move → delete", async () => {
      const writeResult = await callTool({
        client,
        name: "vault_write_note",
        args: {
          path: "Scratch/test-write.md",
          body: "# Test Write\n\nCreated by integration test.\n\nRemovable line.",
        },
      })
      expect(writeResult.isError).not.toBe(true)

      const patchResult = await callTool({
        client,
        name: "vault_patch_note",
        args: {
          path: "Scratch/test-write.md",
          operation: "append",
          content: "\nAppended line.",
        },
      })
      expect(patchResult.isError).not.toBe(true)

      const replaceResult = await callTool({
        client,
        name: "vault_replace_in_note",
        args: {
          path: "Scratch/test-write.md",
          old_text: "Appended line.",
          new_text: "Replaced line.",
        },
      })
      expect(replaceResult.isError).not.toBe(true)

      const deleteSpanResult = await callTool({
        client,
        name: "vault_delete_span",
        args: {
          path: "Scratch/test-write.md",
          start_anchor: "Removable line",
        },
      })
      expect(deleteSpanResult.isError).not.toBe(true)

      const propsResult = await callTool({
        client,
        name: "vault_update_properties",
        args: {
          path: "Scratch/test-write.md",
          properties: { tags: ["test"], type: "scratch" },
        },
      })
      expect(propsResult.isError).not.toBe(true)

      const moveResult = await callTool({
        client,
        name: "vault_move_note",
        args: {
          old_path: "Scratch/test-write.md",
          new_path: "Scratch/test-moved.md",
        },
      })
      expect(moveResult.isError).not.toBe(true)

      const deleteResult = await callTool({
        client,
        name: "vault_delete_note",
        args: { path: "Scratch/test-moved.md" },
      })
      expect(deleteResult.isError).not.toBe(true)
    })
  })

  describe("asset tools", () => {
    it("vault_list_files", async () => {
      const result = await callTool({ client, name: "vault_list_files" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("test-data.txt")
    })

    it("vault_read_file — text", async () => {
      const result = await callTool({
        client,
        name: "vault_read_file",
        args: { path: "test-data.txt" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("plain text file")
    })

    it("vault_read_file — canvas", async () => {
      const result = await callTool({
        client,
        name: "vault_read_file",
        args: { path: "Boards/test.canvas" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Node A")
    })
  })

  describe("prompts", () => {
    it("vault-orientation — assembles live vault data", async () => {
      const result = await client.getPrompt({ name: "vault-orientation" })
      expect(promptText(result)).toContain("Projects/alpha.md")
    })

    it("memory-review — includes memory content", async () => {
      const result = await client.getPrompt({
        name: "memory-review",
        arguments: {},
      })
      expect(promptText(result)).toContain("Preferences")
    })

    it("daily-review — includes daily note content", async () => {
      const result = await client.getPrompt({
        name: "daily-review",
        arguments: { date: "2026-01-15" },
      })
      expect(promptText(result)).toContain("integration test results")
    })
  })
})

// ── READONLY_MODE (20 tools, 2 prompts) ───────────────────────

describe("READONLY_MODE=true", () => {
  let client: Client
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const server = await startServer(BASE_PORT + 1, {
      READONLY_MODE: "true",
    })
    client = await createTestClient(server.port)
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    await client.close()
    await cleanup()
  })

  it("lists 20 tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(20)
    expect(names).not.toContain("vault_write_note")
    expect(names).not.toContain("vault_update_memory")
    expect(names).not.toContain("vault_update_task")
    expect(names).not.toContain("vault_delete_note")
  })

  it("lists 2 prompts — no memory-review", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(2)
    expect(names).not.toContain("memory-review")
  })

  it("read tools work", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Projects/alpha.md" },
    })
    expect(result.isError).not.toBe(true)
    expect(textContent(result)).toContain("Project Alpha")
  })

  it("search works", async () => {
    const result = await callTool({
      client,
      name: "vault_search",
      args: { query: "project" },
    })
    expect(result.isError).not.toBe(true)
  })
})

// ── DISABLED_TOOLS (selective, 27 tools) ──────────────────────

describe("DISABLED_TOOLS=vault_delete_note,vault_move_note,vault_delete_memory", () => {
  let client: Client
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const server = await startServer(BASE_PORT + 2, {
      DISABLED_TOOLS: "vault_delete_note,vault_move_note,vault_delete_memory",
    })
    client = await createTestClient(server.port)
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    await client.close()
    await cleanup()
  })

  it("lists 27 tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(27)
    expect(names).not.toContain("vault_delete_note")
    expect(names).not.toContain("vault_move_note")
    expect(names).not.toContain("vault_delete_memory")
  })

  it("all 3 prompts present", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(3)
  })

  it("surviving write tools work", async () => {
    const result = await callTool({
      client,
      name: "vault_write_note",
      args: {
        path: "Scratch/disabled-test.md",
        body: "# Test\n\nWritten during DISABLED_TOOLS test.",
      },
    })
    expect(result.isError).not.toBe(true)
  })
})

// ── DISABLED_TOOLS=vault_update_memory (prompt dependency) ────

describe("DISABLED_TOOLS=vault_update_memory", () => {
  let client: Client
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const server = await startServer(BASE_PORT + 3, {
      DISABLED_TOOLS: "vault_update_memory",
    })
    client = await createTestClient(server.port)
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    await client.close()
    await cleanup()
  })

  it("lists 29 tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(29)
  })

  it("memory-review prompt hidden", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(2)
    expect(names).not.toContain("memory-review")
  })
})

// ── MEMORY_ENABLED=false (25 tools, 2 prompts) ───────────────

describe("MEMORY_ENABLED=false", () => {
  let client: Client
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const server = await startServer(BASE_PORT + 4, {
      MEMORY_ENABLED: "false",
    })
    client = await createTestClient(server.port)
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    await client.close()
    await cleanup()
  })

  it("lists 25 tools — no memory group", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(25)
    expect(names).not.toContain("vault_get_memory")
    expect(names).not.toContain("vault_list_memory_files")
    expect(names).not.toContain("vault_memory_recall")
    expect(names).not.toContain("vault_update_memory")
    expect(names).not.toContain("vault_delete_memory")
  })

  it("memory-review prompt hidden", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(2)
    expect(names).not.toContain("memory-review")
  })
})

// ── FILE_TOOLS_ENABLED=false (28 tools) ──────────────────────

describe("FILE_TOOLS_ENABLED=false", () => {
  let client: Client
  let cleanup: () => Promise<void>

  beforeAll(async () => {
    const server = await startServer(BASE_PORT + 5, {
      FILE_TOOLS_ENABLED: "false",
    })
    client = await createTestClient(server.port)
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    await client.close()
    await cleanup()
  })

  it("lists 28 tools — no asset tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(28)
    expect(names).not.toContain("vault_read_file")
    expect(names).not.toContain("vault_list_files")
  })

  it("all 3 prompts present", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(3)
  })
})

// ── Boot rejection ───────────────────────────────────────────

describe("boot rejection", () => {
  it("unknown DISABLED_TOOLS name exits with error", async () => {
    const { exitCode, stderr } = await startServerExpectingFailure(
      BASE_PORT + 6,
      { DISABLED_TOOLS: "vault_fake_tool" },
    )
    expect(exitCode).toBe(1)
    expect(stderr).toContain("vault_fake_tool")
  }, 15_000)
})

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
  randomPort,
  mcpInitStatus,
} from "./test-harness.js"

vi.setConfig({ testTimeout: 15_000 })

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
  let cleanup: (() => Promise<void>) | undefined
  let port: number

  beforeAll(async () => {
    port = randomPort()
    const server = await startServer(port)
    cleanup = server.cleanup
    client = await createTestClient(server.port)
  }, 30_000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } finally {
      if (cleanup) await cleanup()
    }
  })

  describe("surface", () => {
    it("lists 30 tools", async () => {
      const names = await toolNames(client)
      expect(names).toEqual([
        "vault_delete_memory",
        "vault_delete_note",
        "vault_delete_span",
        "vault_find_orphans",
        "vault_get_backlinks",
        "vault_get_daily_note",
        "vault_get_memory",
        "vault_get_outgoing_links",
        "vault_list_files",
        "vault_list_memory_files",
        "vault_list_notes",
        "vault_list_property_keys",
        "vault_list_property_values",
        "vault_list_tags",
        "vault_list_tasks",
        "vault_memory_recall",
        "vault_move_note",
        "vault_patch_note",
        "vault_read_file",
        "vault_read_note",
        "vault_recent_notes",
        "vault_replace_in_note",
        "vault_search",
        "vault_search_by_folder",
        "vault_search_by_property",
        "vault_search_by_tag",
        "vault_update_memory",
        "vault_update_properties",
        "vault_update_task",
        "vault_write_note",
      ])
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
      const text = textContent(result)
      expect(text).toContain("Tasks")
      expect(text).not.toContain("alpha-task-1")
    })

    it("vault_read_note — heading mode", async () => {
      const result = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md", heading: "Tasks" },
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("alpha-task-1")
      expect(text).not.toContain("Some notes about the project")
    })

    it("vault_read_note — properties_only", async () => {
      const result = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md", properties_only: true },
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("active")
      expect(text).not.toContain("Some notes about the project")
    })

    it("vault_list_notes", async () => {
      const result = await callTool({ client, name: "vault_list_notes" })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("Projects/alpha.md")
      expect(text).toContain("Projects/beta.md")
      expect(text).toContain("Orphan Note.md")
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
      expect(textContent(result)).toContain("Projects/alpha.md")
    })

    it("vault_search_by_tag", async () => {
      const result = await callTool({
        client,
        name: "vault_search_by_tag",
        args: { tag: "project" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Projects/alpha.md")
    })

    it("vault_list_tags", async () => {
      const result = await callTool({ client, name: "vault_list_tags" })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("project")
      expect(text).toContain("active")
      expect(text).toContain("test")
    })

    it("vault_recent_notes", async () => {
      const result = await callTool({ client, name: "vault_recent_notes" })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Projects/alpha.md")
    })

    it("vault_search_by_folder", async () => {
      const result = await callTool({
        client,
        name: "vault_search_by_folder",
        args: { folder: "Projects" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Projects/alpha.md")
    })

    it("vault_list_property_keys", async () => {
      const result = await callTool({
        client,
        name: "vault_list_property_keys",
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("status")
      expect(text).toContain("type")
      expect(text).toContain("tags")
    })

    it("vault_list_property_values", async () => {
      const result = await callTool({
        client,
        name: "vault_list_property_values",
        args: { key: "status" },
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("active")
      expect(text).toContain("planning")
    })

    it("vault_search_by_property", async () => {
      const result = await callTool({
        client,
        name: "vault_search_by_property",
        args: { key: "status", value: "active" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Projects/alpha.md")
    })

    it("vault_get_backlinks", async () => {
      const result = await callTool({
        client,
        name: "vault_get_backlinks",
        args: { path: "Projects/beta.md" },
      })
      expect(result.isError).not.toBe(true)
      expect(textContent(result)).toContain("Projects/alpha.md")
    })

    it("vault_get_outgoing_links", async () => {
      const result = await callTool({
        client,
        name: "vault_get_outgoing_links",
        args: { path: "Projects/alpha.md" },
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("Projects/beta.md")
      expect(text).toContain("About Me/Preferences.md")
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
      const text = textContent(result)
      expect(text).toContain("dark mode")
      expect(text).toContain("Vim keybindings")
      expect(text).toContain("Font size 14px")
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

      // Verify the entry was added
      const verifyResult = await callTool({
        client,
        name: "vault_get_memory",
        args: { file: "Preferences", section: "Editor settings" },
      })
      expect(textContent(verifyResult)).toContain(
        "Integration test entry — SDK Client",
      )

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

      // Verify the entry was removed
      const afterDelete = await callTool({
        client,
        name: "vault_get_memory",
        args: { file: "Preferences", section: "Editor settings" },
      })
      expect(textContent(afterDelete)).not.toContain(
        "Integration test entry — SDK Client",
      )
    })
  })

  describe("task tools", () => {
    it("vault_list_tasks", async () => {
      const result = await callTool({ client, name: "vault_list_tasks" })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("alpha-task-1")
      expect(text).toContain("alpha-task-2")
    })

    it("vault_update_task — verify priority applied", async () => {
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

      // Re-read the task section and verify the priority landed on the right line
      const readback = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md", heading: "Tasks" },
      })
      expect(textContent(readback)).toMatch(/First task for Alpha.*⏫/)
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
      // write
      const writeResult = await callTool({
        client,
        name: "vault_write_note",
        args: {
          path: "Scratch/test-write.md",
          body: "# Test Write\n\nCreated by integration test.\n\nRemovable line.",
        },
      })
      expect(writeResult.isError).not.toBe(true)
      const afterWrite = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md" },
      })
      expect(textContent(afterWrite)).toContain("Created by integration test.")

      // patch
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
      const afterPatch = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md" },
      })
      expect(textContent(afterPatch)).toContain("Appended line.")

      // replace — verify the replacement happened
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
      const afterReplace = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md" },
      })
      expect(textContent(afterReplace)).toContain("Replaced line.")
      expect(textContent(afterReplace)).not.toContain("Appended line.")

      // delete_span — verify the line was removed
      const deleteSpanResult = await callTool({
        client,
        name: "vault_delete_span",
        args: {
          path: "Scratch/test-write.md",
          start_anchor: "Removable line",
        },
      })
      expect(deleteSpanResult.isError).not.toBe(true)
      const afterSpan = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md" },
      })
      expect(textContent(afterSpan)).not.toContain("Removable line")
      expect(textContent(afterSpan)).toContain("Replaced line.")

      // update_properties — verify frontmatter merged
      const propsResult = await callTool({
        client,
        name: "vault_update_properties",
        args: {
          path: "Scratch/test-write.md",
          properties: { tags: ["test"], type: "scratch" },
        },
      })
      expect(propsResult.isError).not.toBe(true)
      const afterProps = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md", properties_only: true },
      })
      expect(textContent(afterProps)).toContain("scratch")

      // move
      const moveResult = await callTool({
        client,
        name: "vault_move_note",
        args: {
          old_path: "Scratch/test-write.md",
          new_path: "Scratch/test-moved.md",
        },
      })
      expect(moveResult.isError).not.toBe(true)
      const afterMoveOld = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md" },
      })
      expect(afterMoveOld.isError).toBe(true)
      const afterMoveNew = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-moved.md" },
      })
      expect(textContent(afterMoveNew)).toContain("Replaced line.")

      // delete — verify the note is gone
      const deleteResult = await callTool({
        client,
        name: "vault_delete_note",
        args: { path: "Scratch/test-moved.md" },
      })
      expect(deleteResult.isError).not.toBe(true)
      const afterDelete = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-moved.md" },
      })
      expect(afterDelete.isError).toBe(true)
    })
  })

  describe("asset tools", () => {
    it("vault_list_files", async () => {
      const result = await callTool({ client, name: "vault_list_files" })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("test-data.txt")
      expect(text).toContain("Boards/test.canvas")
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

    it("vault_read_file — canvas raw mode", async () => {
      const result = await callTool({
        client,
        name: "vault_read_file",
        args: { path: "Boards/test.canvas", raw: true },
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain('"type": "text"')
      expect(text).toContain('"fromNode": "1"')
    })

    it("vault_read_file — text with line paging", async () => {
      const result = await callTool({
        client,
        name: "vault_read_file",
        args: { path: "test-data.txt", start_line: 2, limit: 1 },
      })
      expect(result.isError).not.toBe(true)
      const text = textContent(result)
      expect(text).toContain("Line 2")
      expect(text).not.toContain("plain text file")
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

  describe("auth", () => {
    it("missing Authorization header is rejected", async () => {
      const status = await mcpInitStatus(port)
      expect(status).toBe(401)
    })

    it("invalid token is rejected", async () => {
      const status = await mcpInitStatus(port, "Bearer wrong-token")
      expect(status).toBe(401)
    })
  })
})

// ── READONLY_MODE (20 tools, 2 prompts) ───────────────────────

describe("READONLY_MODE=true", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(randomPort(), {
      READONLY_MODE: "true",
    })
    cleanup = server.cleanup
    client = await createTestClient(server.port)
  }, 30_000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } finally {
      if (cleanup) await cleanup()
    }
  })

  it("lists 20 tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(20)
    expect(names).not.toContain("vault_write_note")
    expect(names).not.toContain("vault_patch_note")
    expect(names).not.toContain("vault_replace_in_note")
    expect(names).not.toContain("vault_delete_span")
    expect(names).not.toContain("vault_delete_note")
    expect(names).not.toContain("vault_move_note")
    expect(names).not.toContain("vault_update_properties")
    expect(names).not.toContain("vault_update_memory")
    expect(names).not.toContain("vault_delete_memory")
    expect(names).not.toContain("vault_update_task")
    expect(names).toContain("vault_search")
  })

  it("lists 2 prompts — no memory-review", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(2)
    expect(names).toEqual(["daily-review", "vault-orientation"])
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
    expect(textContent(result)).toContain("Projects/alpha.md")
  })
})

// ── DISABLED_TOOLS (selective, 27 tools) ──────────────────────

describe("DISABLED_TOOLS=vault_delete_note,vault_move_note,vault_delete_memory", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(randomPort(), {
      DISABLED_TOOLS: "vault_delete_note,vault_move_note,vault_delete_memory",
    })
    cleanup = server.cleanup
    client = await createTestClient(server.port)
  }, 30_000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } finally {
      if (cleanup) await cleanup()
    }
  })

  it("lists 27 tools with expected survivors", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(27)
    expect(names).not.toContain("vault_delete_note")
    expect(names).not.toContain("vault_move_note")
    expect(names).not.toContain("vault_delete_memory")
    expect(names).toContain("vault_write_note")
    expect(names).toContain("vault_read_note")
    expect(names).toContain("vault_update_task")
  })

  it("all 3 prompts present", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(3)
    expect(names).toEqual([
      "daily-review",
      "memory-review",
      "vault-orientation",
    ])
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

    // Verify the write took effect
    const readback = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Scratch/disabled-test.md" },
    })
    expect(textContent(readback)).toContain("DISABLED_TOOLS test")
  })
})

// ── DISABLED_TOOLS=vault_update_memory (prompt dependency) ────

describe("DISABLED_TOOLS=vault_update_memory", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(randomPort(), {
      DISABLED_TOOLS: "vault_update_memory",
    })
    cleanup = server.cleanup
    client = await createTestClient(server.port)
  }, 30_000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } finally {
      if (cleanup) await cleanup()
    }
  })

  it("lists 29 tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(29)
    expect(names).not.toContain("vault_update_memory")
    expect(names).toContain("vault_get_memory")
  })

  it("memory-review prompt hidden", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(2)
    expect(names).toEqual(["daily-review", "vault-orientation"])
  })
})

// ── MEMORY_ENABLED=false (25 tools, 2 prompts) ───────────────

describe("MEMORY_ENABLED=false", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(randomPort(), {
      MEMORY_ENABLED: "false",
    })
    cleanup = server.cleanup
    client = await createTestClient(server.port)
  }, 30_000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } finally {
      if (cleanup) await cleanup()
    }
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
    expect(names).toEqual(["daily-review", "vault-orientation"])
  })
})

// ── FILE_TOOLS_ENABLED=false (28 tools) ──────────────────────

describe("FILE_TOOLS_ENABLED=false", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(randomPort(), {
      FILE_TOOLS_ENABLED: "false",
    })
    cleanup = server.cleanup
    client = await createTestClient(server.port)
  }, 30_000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } finally {
      if (cleanup) await cleanup()
    }
  })

  it("lists 28 tools — no asset tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(28)
    expect(names).not.toContain("vault_read_file")
    expect(names).not.toContain("vault_list_files")
    expect(names).toContain("vault_read_note")
  })

  it("all 3 prompts present", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(3)
    expect(names).toEqual([
      "daily-review",
      "memory-review",
      "vault-orientation",
    ])
  })
})

// ── Boot rejection ───────────────────────────────────────────

describe("boot rejection", () => {
  it("unknown DISABLED_TOOLS name exits with error", async () => {
    const { exitCode, stderr } = await startServerExpectingFailure(
      randomPort(),
      { DISABLED_TOOLS: "vault_fake_tool" },
    )
    expect(exitCode).toBe(1)
    expect(stderr).toContain("vault_fake_tool")
  }, 15_000)
})

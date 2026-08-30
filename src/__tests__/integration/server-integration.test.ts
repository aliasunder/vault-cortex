/** End-to-end integration tests — every tool and prompt called over real
 *  HTTP transport against a real server with a real vault on disk. */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  onTestFinished,
  vi,
} from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { DateTime } from "luxon"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  startServer,
  startServerExpectingFailure,
  createTestClient,
  toolNames,
  promptNames,
  freePort,
  mcpInitStatus,
  callTool,
  textContent,
} from "./test-harness.js"

vi.setConfig({ testTimeout: 15_000 })

/** Extract joined text from a prompt result's messages. */
const promptText = (result: Awaited<ReturnType<Client["getPrompt"]>>): string =>
  result.messages
    .map((message) =>
      message.content.type === "text" ? message.content.text : "",
    )
    .join("\n")

// ── Default config (33 tools, 3 prompts) ──────────────────────

describe("default config", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined
  let port: number

  beforeAll(async () => {
    port = await freePort()
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
    it("lists 33 tools", async () => {
      const names = await toolNames(client)
      expect(names).toEqual([
        "vault_create_task",
        "vault_delete_memory",
        "vault_delete_note",
        "vault_delete_span",
        "vault_find_orphans",
        "vault_get_backlinks",
        "vault_get_daily_note",
        "vault_get_memory",
        "vault_get_outgoing_links",
        "vault_insert_at_anchor",
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
        "vault_replace_span",
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
      // The Multi Column fixture opens with `--- start-multi-column:` —
      // its presence proves the server booted without crashing on a note
      // whose first line gray-matter alone would reject (issue #485)
      expect(text).toContain("Multi Column Template.md")
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

    it("vault_create_task — creates a card and verifies via readback", async () => {
      const createResult = await callTool({
        client,
        name: "vault_create_task",
        args: {
          path: "Projects/alpha.md",
          description: "Integration test task",
          block_id: "integ-test-task",
          heading: "Tasks",
          priority: "medium",
        },
      })
      expect(createResult.isError).not.toBe(true)
      const createJson = JSON.parse(textContent(createResult))
      // Inserted at the top of the Tasks section: line 18 of the fixture
      expect(createJson).toEqual({
        path: "Projects/alpha.md",
        line: 18,
        description: "Integration test task",
        block_id: "integ-test-task",
        heading: "Tasks",
        changes: [
          `created: (none) → ${DateTime.now().toISODate()}`,
          "priority: (none) → medium",
        ],
      })

      // Verify the created task is in the file via vault_read_note
      const readback = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Projects/alpha.md", heading: "Tasks" },
      })
      const readbackText = textContent(readback)
      expect(readbackText).toContain("Integration test task")
      expect(readbackText).toContain("^integ-test-task")
      expect(readbackText).toContain("🔼")
    })

    it("vault_list_tasks — top_level_only excludes sub-tasks", async () => {
      const allResult = await callTool({
        client,
        name: "vault_list_tasks",
        args: {
          path: "Projects/board.md",
          status: "all",
          sort_by: "position",
        },
      })
      const allJson = JSON.parse(textContent(allResult))
      // board.md fixture: 3 cards + 2 checklist items under the in-progress card
      expect(allJson.total).toBe(5)

      const topOnlyResult = await callTool({
        client,
        name: "vault_list_tasks",
        args: {
          path: "Projects/board.md",
          status: "all",
          sort_by: "position",
          top_level_only: true,
        },
      })
      const topOnlyJson = JSON.parse(textContent(topOnlyResult))

      expect(topOnlyJson.total).toBe(3)
      expect(
        topOnlyJson.tasks.map(
          (task: {
            description: string
            depth: number
            is_kanban_task: boolean
          }) => ({
            description: task.description,
            depth: task.depth,
            is_kanban_task: task.is_kanban_task,
          }),
        ),
      ).toEqual([
        { description: "In-progress feature", depth: 0, is_kanban_task: true },
        { description: "Planned work", depth: 0, is_kanban_task: true },
        { description: "Shipped item", depth: 0, is_kanban_task: true },
      ])
    })

    it("vault_update_task — description edit preserves metadata", async () => {
      const result = await callTool({
        client,
        name: "vault_update_task",
        args: {
          path: "Projects/alpha.md",
          block_id: "alpha-task-2",
          description: "Renamed second task",
        },
      })
      expect(result.isError).not.toBe(true)
      const json = JSON.parse(textContent(result))
      // Line 22, not the fixture's 21: the vault_create_task case above
      // inserted a card at the top of the same Tasks section.
      expect(json).toEqual({
        path: "Projects/alpha.md",
        line: 22,
        description: "Renamed second task",
        block_id: "alpha-task-2",
        heading: "Tasks",
        changes: ["description: Second task → Renamed second task"],
      })
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
    it("write → patch → replace → delete_span → replace_span → insert_at_anchor → update_properties → move → delete", async () => {
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

      // replace_span — verify anchor-based replacement
      const replaceSpanResult = await callTool({
        client,
        name: "vault_replace_span",
        args: {
          path: "Scratch/test-write.md",
          start_anchor: "Replaced line",
          content: "Span-replaced line.",
        },
      })
      expect(replaceSpanResult.isError).not.toBe(true)
      const afterReplaceSpan = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md" },
      })
      expect(textContent(afterReplaceSpan)).toContain("Span-replaced line.")
      expect(textContent(afterReplaceSpan)).not.toContain("Replaced line.")

      // insert_at_anchor — verify anchor-based insertion
      const insertResult = await callTool({
        client,
        name: "vault_insert_at_anchor",
        args: {
          path: "Scratch/test-write.md",
          anchor: "Span-replaced line",
          position: "after",
          content: "Inserted line.",
        },
      })
      expect(insertResult.isError).not.toBe(true)
      const afterInsert = await callTool({
        client,
        name: "vault_read_note",
        args: { path: "Scratch/test-write.md" },
      })
      expect(textContent(afterInsert)).toContain("Inserted line.")
      expect(textContent(afterInsert)).toContain("Span-replaced line.")

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
      expect(textContent(afterMoveNew)).toContain("Span-replaced line.")

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

  describe("OAuth rate limiting", () => {
    const register = (forwardedIp: string) =>
      fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          forwarded: `for=${forwardedIp}`,
        },
        body: JSON.stringify({
          client_name: "integration-test",
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })

    // With the Forwarded header untrusted (the default), a distinct spoofed
    // value per request must NOT mint a fresh rate-limit bucket — all six
    // share the socket peer's bucket.
    it("spoofed Forwarded headers do not bypass the /register rate limit", async () => {
      for (let i = 1; i <= 5; i++) {
        const response = await register(`198.51.100.${i}`)
        expect(response.status).toBe(201)
      }
      const sixth = await register("198.51.100.6")
      expect(sixth.status).toBe(429)
    })
  })
})

// ── X-Forwarded-For rate limiting (default proxy trust) ────────

describe("X-Forwarded-For rate limiting (default proxy trust)", () => {
  let cleanup: (() => Promise<void>) | undefined
  let port: number

  beforeAll(async () => {
    port = await freePort()
    // Dedicated default-config server: the limiter's in-memory store is
    // per-process and blocked hits count, so the default-config describe's
    // Forwarded test leaves its shared 5-req bucket exhausted inside the
    // 60s window — running this test there would 429 on the first request.
    const server = await startServer(port)
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    if (cleanup) await cleanup()
  })

  const register = (xffIp: string) =>
    fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": xffIp,
      },
      body: JSON.stringify({
        client_name: "integration-test",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })

  // X-Forwarded-For is the other spoofable channel: with TRUST_PROXY_HOPS=0
  // (the default), a client-supplied X-Forwarded-For must not shift the
  // bucket either — re-raising the hop count would reopen the bypass
  // silently.
  it("spoofed X-Forwarded-For headers do not bypass the /register rate limit", async () => {
    for (let i = 1; i <= 5; i++) {
      const response = await register(`198.51.100.${i}`)
      expect(response.status).toBe(201)
    }
    const sixth = await register("198.51.100.6")
    expect(sixth.status).toBe(429)
  })
})

// ── TRUST_PROXY_HOPS=1 ─────────────────────────────────────────

describe("TRUST_PROXY_HOPS=1", () => {
  let cleanup: (() => Promise<void>) | undefined
  let port: number

  beforeAll(async () => {
    port = await freePort()
    const server = await startServer(port, { TRUST_PROXY_HOPS: "1" })
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    if (cleanup) await cleanup()
  })

  const register = (xffIp: string) =>
    fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": xffIp,
      },
      body: JSON.stringify({
        client_name: "integration-test",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })

  // Positive wiring proof for `app.set("trust proxy", config.trustProxyHops)`:
  // with one trusted hop the XFF-derived IP is the bucket key, so exhausting
  // one client's bucket must leave another client's bucket fresh. If the
  // config value never reached Express, every request would share the socket
  // peer's bucket and the second client's request would 429.
  it("buckets the /register rate limit by the X-Forwarded-For client IP", async () => {
    for (let i = 1; i <= 5; i++) {
      const response = await register("203.0.113.50")
      expect(response.status).toBe(201)
    }
    const sixth = await register("203.0.113.50")
    expect(sixth.status).toBe(429)
    const otherClient = await register("203.0.113.51")
    expect(otherClient.status).toBe(201)
  })
})

// ── TRUST_FORWARDED_HOPS=1 ─────────────────────────────────────

describe("TRUST_FORWARDED_HOPS=1", () => {
  let cleanup: (() => Promise<void>) | undefined
  let port: number

  beforeAll(async () => {
    port = await freePort()
    const server = await startServer(port, { TRUST_FORWARDED_HOPS: "1" })
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    if (cleanup) await cleanup()
  })

  const register = (forwardedIp: string) =>
    fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        forwarded: `for=${forwardedIp}`,
      },
      body: JSON.stringify({
        client_name: "integration-test",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })

  it("buckets the /register rate limit by the Forwarded client IP", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await register("198.51.100.1")
      expect(response.status).toBe(201)
    }
    const sixthSameClient = await register("198.51.100.1")
    expect(sixthSameClient.status).toBe(429)
    const firstOtherClient = await register("198.51.100.2")
    expect(firstOtherClient.status).toBe(201)
  })

  // An edge proxy that appends (as API Gateway does) leaves any
  // client-supplied prefix ahead of its own claim — the bucket key must be
  // the LAST for= element, never the first.
  it("buckets by the last for= element, not a client-supplied prefix", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          forwarded: "for=203.0.113.99, for=198.51.100.4",
        },
        body: JSON.stringify({
          client_name: "integration-test",
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })
      expect(response.status).toBe(201)
    }
    // If the prefix (203.0.113.99) were the key, this plain request would
    // open a fresh bucket instead of joining 198.51.100.4's exhausted one.
    const sixth = await register("198.51.100.4")
    expect(sixth.status).toBe(429)
  })
})

// ── TRUST_FORWARDED_HOPS=2 ─────────────────────────────────────

// A CDN in front of the header-writing proxy makes the last for= the
// CDN's address; the client is the element before it.
describe("TRUST_FORWARDED_HOPS=2", () => {
  let cleanup: (() => Promise<void>) | undefined
  let port: number

  beforeAll(async () => {
    port = await freePort()
    const server = await startServer(port, {
      TRUST_FORWARDED_HOPS: "2",
    })
    cleanup = server.cleanup
  }, 30_000)

  afterAll(async () => {
    if (cleanup) await cleanup()
  })

  const register = (forwarded: string) =>
    fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", forwarded },
      body: JSON.stringify({
        client_name: "integration-test",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })

  it("buckets the /register rate limit by the for= element before the last", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await register("for=198.51.100.1, for=172.69.0.1")
      expect(response.status).toBe(201)
    }
    // Same client behind a different CDN edge — same bucket.
    const sixthSameClient = await register("for=198.51.100.1, for=172.69.0.2")
    expect(sixthSameClient.status).toBe(429)
    // Different client behind the same CDN edge — fresh bucket.
    const firstOtherClient = await register("for=198.51.100.2, for=172.69.0.1")
    expect(firstOtherClient.status).toBe(201)
  })

  it("ignores a client-supplied prefix ahead of the two trusted elements", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await register(
        "for=203.0.113.99, for=198.51.100.4, for=172.69.0.1",
      )
      expect(response.status).toBe(201)
    }
    // The exhausted bucket is keyed on 198.51.100.4 alone: neither the
    // prefix (203.0.113.99) nor the CDN element (172.69.0.1) is part of
    // the key, so a different prefix and a different CDN edge both land
    // in it.
    const sixth = await register("for=198.51.100.4, for=172.69.0.1")
    expect(sixth.status).toBe(429)
    const otherPrefixAndEdge = await register(
      "for=203.0.113.77, for=198.51.100.4, for=172.69.0.2",
    )
    expect(otherPrefixAndEdge.status).toBe(429)
    const prefixAsClient = await register("for=203.0.113.99, for=172.69.0.1")
    expect(prefixAsClient.status).toBe(201)
  })
})

// ── READONLY_MODE (20 tools, 2 prompts) ───────────────────────

describe("READONLY_MODE=true", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(await freePort(), {
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
    expect(names).not.toContain("vault_replace_span")
    expect(names).not.toContain("vault_insert_at_anchor")
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

// ── DISABLED_TOOLS (selective, 30 tools) ──────────────────────

describe("DISABLED_TOOLS=vault_delete_note,vault_move_note,vault_delete_memory", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(await freePort(), {
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

  it("lists 30 tools with expected survivors", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(30)
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
    const server = await startServer(await freePort(), {
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

  it("lists 32 tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(32)
    expect(names).not.toContain("vault_update_memory")
    expect(names).toContain("vault_get_memory")
  })

  it("memory-review prompt hidden", async () => {
    const names = await promptNames(client)
    expect(names).toHaveLength(2)
    expect(names).toEqual(["daily-review", "vault-orientation"])
  })
})

// ── MEMORY_ENABLED=false (28 tools, 2 prompts) ───────────────

describe("MEMORY_ENABLED=false", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(await freePort(), {
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

  it("lists 28 tools — no memory group", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(28)
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

// ── FILE_TOOLS_ENABLED=false (31 tools) ──────────────────────

describe("FILE_TOOLS_ENABLED=false", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const server = await startServer(await freePort(), {
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

  it("lists 31 tools — no asset tools", async () => {
    const names = await toolNames(client)
    expect(names).toHaveLength(31)
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

describe("DAILY_NOTES_FORMAT with unsupported token", () => {
  let client: Client
  let cleanup: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const port = await freePort()
    const server = await startServer(port, {
      DAILY_NOTES_FORMAT: "MMMM Do, YYYY",
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

  it("server starts despite unsupported token in format", async () => {
    const names = await toolNames(client)
    expect(names).toContain("vault_get_daily_note")
  })

  it("vault_get_daily_note returns a tool error for unsupported Do token", async () => {
    const result = await callTool({
      client,
      name: "vault_get_daily_note",
      args: { date: "2026-01-15" },
    })
    expect(result.isError).toBe(true)
    expect(textContent(result)).toContain("unsupported token(s): Do")
  })
})

describe("boot rejection", () => {
  it("unknown DISABLED_TOOLS name exits with error", async () => {
    const { exitCode, stderr } = await startServerExpectingFailure(
      await freePort(),
      { DISABLED_TOOLS: "vault_fake_tool" },
    )
    expect(exitCode).toBe(1)
    expect(stderr).toContain("vault_fake_tool")
  }, 15_000)

  // Express 5 hands bind failures to the listen callback instead of
  // throwing; without the check the second server would log "server
  // started" and idle while the first one keeps answering the port.
  it("exits with error when the port is already in use", async () => {
    const port = await freePort()
    const occupant = await startServer(port)
    onTestFinished(() => occupant.cleanup())

    const { exitCode, stderr } = await startServerExpectingFailure(port, {})
    expect(exitCode).toBe(1)
    expect(stderr).toContain('"message":"server failed to listen"')
    expect(stderr).toContain("EADDRINUSE")
  }, 30_000)
})

// ── Rotating MCP_AUTH_TOKEN ends every OAuth session ───────────

describe("rotating MCP_AUTH_TOKEN", () => {
  const REDIRECT_URI = "http://127.0.0.1/callback"
  const TOKEN_A = "integration-token-before-rotation"
  const TOKEN_B = "integration-token-after-rotation"

  const base64Url = (buffer: Buffer): string =>
    buffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

  type RegisteredClient = { client_id: string; client_secret: string }
  type IssuedTokens = { access_token: string; refresh_token: string }

  const isRegisteredClient = (value: unknown): value is RegisteredClient =>
    typeof value === "object" &&
    value !== null &&
    "client_id" in value &&
    "client_secret" in value

  const isIssuedTokens = (value: unknown): value is IssuedTokens =>
    typeof value === "object" &&
    value !== null &&
    "access_token" in value &&
    "refresh_token" in value

  /** Initialize over /mcp with the transport's required Accept header, so
   *  a valid bearer is distinguishable (200) from a rejected one (401). */
  const mcpStatusWithBearer = async (
    port: number,
    bearer: string,
  ): Promise<number> => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    })
    return response.status
  }

  const registerClient = async (port: number): Promise<RegisteredClient> => {
    const response = await fetch(`http://127.0.0.1:${port}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "integration-test",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    })
    expect(response.status).toBe(201)
    const registered: unknown = await response.json()
    if (!isRegisteredClient(registered)) throw new Error("malformed client")
    return registered
  }

  /** Consent page → approve with the auth token → PKCE code exchange. */
  const authorize = async ({
    port,
    client,
    authToken,
  }: {
    port: number
    client: RegisteredClient
    authToken: string
  }): Promise<IssuedTokens> => {
    const verifier = base64Url(randomBytes(32))
    const challenge = base64Url(createHash("sha256").update(verifier).digest())
    const authorizeUrl = new URL(`http://127.0.0.1:${port}/authorize`)
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "vault",
    }).toString()
    const consentHtml = await (await fetch(authorizeUrl)).text()
    const requestId = /name="request_id"\s+value="([^"]+)"/.exec(
      consentHtml,
    )?.[1]
    if (!requestId) throw new Error("consent page carried no request_id")

    const decision = await fetch(`http://127.0.0.1:${port}/oauth/decide`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request_id: requestId,
        token: authToken,
        action: "approve",
      }),
      redirect: "manual",
    })
    const location = decision.headers.get("location")
    const code = location ? new URL(location).searchParams.get("code") : null
    if (!code) {
      throw new Error(
        `consent did not redirect with a code: ${decision.status}`,
      )
    }

    const tokenResponse = await fetch(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: REDIRECT_URI,
      }),
    })
    expect(tokenResponse.status).toBe(200)
    const issued: unknown = await tokenResponse.json()
    if (!isIssuedTokens(issued)) throw new Error("malformed token response")
    return issued
  }

  const refresh = ({
    port,
    client,
    refreshToken,
  }: {
    port: number
    client: RegisteredClient
    refreshToken: string
  }): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }),
    })

  it("rejects every refresh token issued under the old token and accepts a fresh consent", async () => {
    // The OAuth database lives beside INDEX_DB_PATH, so a test-owned data
    // directory survives the first server's cleanup and the second boot
    // opens the same oauth.db under the new token.
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-rotation-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const indexDbPath = join(dataDir, "search.db")
    const port = await freePort()

    const before = await startServer(port, {
      MCP_AUTH_TOKEN: TOKEN_A,
      INDEX_DB_PATH: indexDbPath,
    })
    const client = await registerClient(port)
    const issued = await authorize({ port, client, authToken: TOKEN_A })
    expect(await mcpStatusWithBearer(port, issued.access_token)).toBe(200)
    const rotated = await refresh({
      port,
      client,
      refreshToken: issued.refresh_token,
    })
    expect(rotated.status).toBe(200)
    const rotatedTokens: unknown = await rotated.json()
    if (!isIssuedTokens(rotatedTokens)) throw new Error("malformed refresh")
    await before.cleanup()

    // A fresh port: the first server's socket can linger after exit, and
    // only the data directory needs to carry over. PUBLIC_URL stays on the
    // first port so the old access token's audience still matches — its
    // 401 below must come from the rotated key, not from a changed URL.
    const rotatedPort = await freePort()
    const after = await startServer(rotatedPort, {
      MCP_AUTH_TOKEN: TOKEN_B,
      INDEX_DB_PATH: indexDbPath,
      PUBLIC_URL: `http://127.0.0.1:${port}`,
    })
    onTestFinished(() => after.cleanup())

    const rejected = await refresh({
      port: rotatedPort,
      client,
      refreshToken: rotatedTokens.refresh_token,
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token expired or invalid",
    })
    expect(
      await mcpStatusWithBearer(rotatedPort, rotatedTokens.access_token),
    ).toBe(401)

    const reissued = await authorize({
      port: rotatedPort,
      client,
      authToken: TOKEN_B,
    })
    expect(await mcpStatusWithBearer(rotatedPort, reissued.access_token)).toBe(
      200,
    )
    const refreshedAgain = await refresh({
      port: rotatedPort,
      client,
      refreshToken: reissued.refresh_token,
    })
    expect(refreshedAgain.status).toBe(200)
  }, 60_000)

  it("sweeps a week-old registration that never consented on the next boot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vc-integ-sweep-"))
    onTestFinished(async () => {
      await rm(dataDir, { recursive: true, force: true })
    })
    const sameDataDir = { INDEX_DB_PATH: join(dataDir, "search.db") }
    const port = await freePort()

    const before = await startServer(port, sameDataDir)
    const stale = await registerClient(port)
    const kept = await registerClient(port)
    await before.cleanup()

    // Backdate both past the sweep's one-week age on disk. Only `stale`
    // is tokenless: `kept` gets a refresh token row seeded under an
    // unrelated key, the state a rotation leaves behind.
    const oauthDb = new Database(join(dataDir, "oauth.db"))
    onTestFinished(() => {
      oauthDb.close()
    })
    const eightDaysAgo = DateTime.now().minus({ days: 8 }).toUnixInteger()
    const backdate = oauthDb.prepare(
      "UPDATE clients SET data = json_set(data, '$.client_id_issued_at', ?) WHERE client_id = ?",
    )
    backdate.run(eightDaysAgo, stale.client_id)
    backdate.run(eightDaysAgo, kept.client_id)
    oauthDb
      .prepare(
        "INSERT INTO refresh_tokens (token, client_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "hmac-sha256:unreachable-after-rotation",
        kept.client_id,
        "vault",
        DateTime.now().plus({ days: 60 }).toUnixInteger(),
      )

    const rebootedPort = await freePort()
    const after = await startServer(rebootedPort, sameDataDir)
    onTestFinished(() => after.cleanup())
    await fetch(`http://127.0.0.1:${rebootedPort}/healthz`)

    const registeredClientIds = oauthDb
      .prepare<[], { client_id: string }>("SELECT client_id FROM clients")
      .all()
      .map((clientRow) => clientRow.client_id)
    expect(registeredClientIds).toEqual([kept.client_id])
  }, 60_000)
})

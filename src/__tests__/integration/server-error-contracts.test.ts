/** Error contract integration tests — every tool's documented error paths
 *  verified over real HTTP transport against a real server. */

import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from "vitest"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  startServer,
  startServerExpectingFailure,
  createTestClient,
  freePort,
  callTool,
  textContent,
} from "./test-harness.js"
import type { ToolResult } from "./test-harness.js"

vi.setConfig({ testTimeout: 15_000 })

const expectToolError = (result: ToolResult, expectedSubstring: string): void => {
  expect(result.isError).toBe(true)
  expect(textContent(result)).toContain(expectedSubstring)
}

// ── Single server boot for all error contract tests ──────────

let client: Client
let cleanup: (() => Promise<void>) | undefined
// The server's on-disk vault root, so a test can address a note by its
// absolute container path — the input form the absolute-path tests pin.
let serverVaultPath: string

beforeAll(async () => {
  const port = await freePort()
  const server = await startServer(port)
  cleanup = server.cleanup
  serverVaultPath = server.vaultPath
  client = await createTestClient(server.port)
}, 30_000)

afterAll(async () => {
  try {
    if (client) await client.close()
  } finally {
    if (cleanup) await cleanup()
  }
})

// ── Protected paths ──────────────────────────────────────────

describe("protected path refusals", () => {
  it("vault_delete_note refuses a note under a protected folder", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_note",
      args: { path: "About Me/Preferences.md" },
    })
    expectToolError(result, 'cannot delete protected path "About Me/Preferences.md"')
  })

  it("vault_move_note refuses a source under a protected folder", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "About Me/Preferences.md", new_path: "Elsewhere.md" },
    })
    expectToolError(result, 'cannot move protected path "About Me/Preferences.md"')
  })
})

// ── Absolute paths ───────────────────────────────────────────

describe("absolute path blocked", () => {
  it("vault_read_note rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: `${serverVaultPath}/Projects/alpha.md` },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_write_note rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: `${serverVaultPath}/injected.md`, body: "content" },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/injected.md" must be vault-relative`,
    )
  })

  it("vault_patch_note rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: {
        path: `${serverVaultPath}/Projects/alpha.md`,
        operation: "append",
        content: "injected",
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_delete_note rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_note",
      args: { path: `${serverVaultPath}/About Me/Preferences.md` },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/About Me/Preferences.md" must be vault-relative`,
    )
  })

  it("vault_replace_in_note rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: {
        path: `${serverVaultPath}/Projects/alpha.md`,
        old_text: "old",
        new_text: "new",
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_delete_span rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: {
        path: `${serverVaultPath}/Projects/alpha.md`,
        start_anchor: "anything",
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_replace_span rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_span",
      args: {
        path: `${serverVaultPath}/Projects/alpha.md`,
        start_anchor: "anything",
        content: "replaced",
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_insert_at_anchor rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_insert_at_anchor",
      args: {
        path: `${serverVaultPath}/Projects/alpha.md`,
        anchor: "anything",
        position: "after",
        content: "inserted",
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_update_properties rejects an absolute container path", async () => {
    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: {
        path: `${serverVaultPath}/Projects/alpha.md`,
        properties: { status: "active" },
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_move_note rejects an absolute container path as old_path", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: {
        old_path: `${serverVaultPath}/Projects/alpha.md`,
        new_path: "safe.md",
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/Projects/alpha.md" must be vault-relative`,
    )
  })

  it("vault_move_note rejects an absolute container path as new_path", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: {
        old_path: "Projects/alpha.md",
        new_path: `${serverVaultPath}/moved.md`,
      },
    })
    expectToolError(
      result,
      `absolute path blocked: "${serverVaultPath}/moved.md" must be vault-relative`,
    )
  })
})

// ── Path traversal ───────────────────────────────────────────

describe("path traversal blocked", () => {
  it("vault_read_note rejects paths escaping the vault root", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "../escape.md" },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_write_note rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: "../../escape.md", body: "malicious" },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_patch_note rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: {
        path: "../outside.md",
        operation: "append",
        content: "injected",
      },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_delete_note rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_note",
      args: { path: "../escape.md" },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_replace_in_note rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: { path: "../outside.md", old_text: "old", new_text: "new" },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_delete_span rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: { path: "../outside.md", start_anchor: "anything" },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_replace_span rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_span",
      args: {
        path: "../outside.md",
        start_anchor: "anything",
        content: "replaced",
      },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_insert_at_anchor rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_insert_at_anchor",
      args: {
        path: "../outside.md",
        anchor: "anything",
        position: "after",
        content: "inserted",
      },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_update_properties rejects path traversal", async () => {
    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "../outside.md", properties: { status: "active" } },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_move_note rejects path traversal on old_path", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "../escape.md", new_path: "safe.md" },
    })
    expectToolError(result, "path traversal blocked")
  })

  it("vault_move_note rejects path traversal on new_path", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "Projects/alpha.md", new_path: "../escape.md" },
    })
    expectToolError(result, "path traversal blocked")
  })
})

// ── Hidden paths ─────────────────────────────────────────────

describe("hidden path blocked", () => {
  it("vault_read_note rejects dot-prefixed paths", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: ".obsidian/plugins.md" },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_write_note rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: ".hidden/secret.md", body: "hidden content" },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_patch_note rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: {
        path: ".hidden/note.md",
        operation: "append",
        content: "injected",
      },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_replace_in_note rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: { path: ".hidden/note.md", old_text: "old", new_text: "new" },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_delete_note rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_note",
      args: { path: ".obsidian/config.md" },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_delete_span rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: { path: ".hidden/note.md", start_anchor: "anything" },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_replace_span rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_span",
      args: {
        path: ".hidden/note.md",
        start_anchor: "anything",
        content: "replaced",
      },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_insert_at_anchor rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_insert_at_anchor",
      args: {
        path: ".hidden/note.md",
        anchor: "anything",
        position: "after",
        content: "inserted",
      },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_update_properties rejects hidden paths", async () => {
    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: ".hidden/note.md", properties: { status: "active" } },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_move_note rejects hidden old_path", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: ".hidden/note.md", new_path: "visible.md" },
    })
    expectToolError(result, "hidden path blocked")
  })

  it("vault_move_note rejects hidden new_path", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "Projects/alpha.md", new_path: ".hidden/moved.md" },
    })
    expectToolError(result, "hidden path blocked")
  })
})

// ── Note not found ───────────────────────────────────────────

describe("note not found", () => {
  it("vault_read_note for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "does-not-exist.md" },
    })
    expectToolError(result, 'note not found: "does-not-exist.md"')
  })

  it("vault_patch_note for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: {
        path: "ghost.md",
        operation: "append",
        content: "appended",
      },
    })
    expectToolError(result, 'note not found: "ghost.md"')
  })

  it("vault_replace_in_note for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: {
        path: "missing.md",
        old_text: "old",
        new_text: "new",
      },
    })
    expectToolError(result, 'note not found: "missing.md"')
  })

  it("vault_delete_note for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_note",
      args: { path: "nonexistent.md" },
    })
    expectToolError(result, 'note not found: "nonexistent.md"')
  })

  it("vault_update_properties for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "nope.md", properties: { status: "active" } },
    })
    expectToolError(result, 'note not found: "nope.md"')
  })

  it("vault_delete_span for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: { path: "gone.md", start_anchor: "anything" },
    })
    expectToolError(result, 'note not found: "gone.md"')
  })

  it("vault_replace_span for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_span",
      args: {
        path: "vanished.md",
        start_anchor: "anything",
        content: "replacement",
      },
    })
    expectToolError(result, 'note not found: "vanished.md"')
  })

  it("vault_insert_at_anchor for a nonexistent path", async () => {
    const result = await callTool({
      client,
      name: "vault_insert_at_anchor",
      args: {
        path: "nowhere.md",
        anchor: "anything",
        position: "after",
        content: "inserted",
      },
    })
    expectToolError(result, 'note not found: "nowhere.md"')
  })
})

// ── Note already exists ──────────────────────────────────────

describe("note already exists", () => {
  it("vault_write_note without overwrite rejects existing path", async () => {
    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: "Projects/alpha.md", body: "overwrite attempt" },
    })
    expectToolError(result, 'note already exists: "Projects/alpha.md"')
  })
})

// ── Heading not found ────────────────────────────────────────

describe("heading not found", () => {
  it("vault_read_note with a nonexistent heading", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Projects/alpha.md", heading: "Nonexistent Section" },
    })
    expectToolError(result, 'heading not found: "Nonexistent Section"')
  })

  it("vault_patch_note replace with a nonexistent heading", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: {
        path: "Projects/alpha.md",
        operation: "replace",
        heading: "No Such Heading",
        content: "replaced content",
      },
    })
    expectToolError(result, 'heading not found: "No Such Heading"')
  })
})

// ── Ambiguous heading ────────────────────────────────────────

describe("ambiguous heading", () => {
  it("vault_read_note with a heading that matches multiple sections", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Ambiguous Headings.md", heading: "Details" },
    })
    expectToolError(result, 'ambiguous heading: "Details"')
  })

  it("vault_patch_note with an ambiguous heading", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: {
        path: "Ambiguous Headings.md",
        operation: "append",
        heading: "Details",
        content: "which one?",
      },
    })
    expectToolError(result, 'ambiguous heading: "Details"')
  })
})

// ── Text not found ───────────────────────────────────────────

describe("text not found", () => {
  it("vault_replace_in_note with text that does not appear in the note", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: {
        path: "Projects/alpha.md",
        old_text: "this text does not exist in the note",
        new_text: "replacement",
      },
    })
    expectToolError(
      result,
      'text not found in "Projects/alpha.md": "this text does not exist in the note"',
    )
  })
})

// ── Anchor not found / ambiguous ─────────────────────────────

describe("anchor errors", () => {
  it("vault_delete_span with a nonexistent anchor", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: {
        path: "Projects/alpha.md",
        start_anchor: "this anchor does not exist anywhere in the file",
      },
    })
    expectToolError(
      result,
      'start anchor not found in "Projects/alpha.md": "this anchor does not exist anywhere in the file"',
    )
  })

  it("vault_replace_span with a nonexistent anchor", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_span",
      args: {
        path: "Projects/alpha.md",
        start_anchor: "this anchor does not exist anywhere in the file",
        content: "replacement content",
      },
    })
    expectToolError(
      result,
      'start anchor not found in "Projects/alpha.md": "this anchor does not exist anywhere in the file"',
    )
  })

  it("vault_insert_at_anchor with a nonexistent anchor", async () => {
    const result = await callTool({
      client,
      name: "vault_insert_at_anchor",
      args: {
        path: "Projects/alpha.md",
        anchor: "this anchor does not exist anywhere in the file",
        position: "after",
        content: "inserted content",
      },
    })
    expectToolError(
      result,
      'anchor not found in "Projects/alpha.md": "this anchor does not exist anywhere in the file"',
    )
  })
})

// ── Memory errors ────────────────────────────────────────────

describe("memory errors", () => {
  it("vault_get_memory with a nonexistent file", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { file: "Nonexistent" },
    })
    expectToolError(result, 'memory file not found: "About Me/Nonexistent.md"')
  })

  it("vault_get_memory with a nonexistent section", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { file: "Preferences", section: "No Such Section" },
    })
    expectToolError(result, 'section not found: "No Such Section" in About Me/Preferences.md')
  })

  it("vault_get_memory on_or_after without file", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { on_or_after: "2026-01-01" },
    })
    expectToolError(result, "on_or_after requires file and section")
  })

  it("vault_get_memory on_or_after with section but no file", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { section: "Editor settings", on_or_after: "2026-01-01" },
    })
    expectToolError(result, "on_or_after requires file and section")
  })

  it("vault_get_memory on_or_after with file but no section", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { file: "Preferences", on_or_after: "2026-01-01" },
    })
    expectToolError(result, "on_or_after requires file and section")
  })

  it("vault_get_memory on_or_after with invalid date", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: {
        file: "Preferences",
        section: "Editor settings",
        on_or_after: "not-a-date",
      },
    })
    expectToolError(result, "date must be a real ISO calendar date")
  })

  it("vault_update_memory rejects multi-line entries", async () => {
    const result = await callTool({
      client,
      name: "vault_update_memory",
      args: {
        file: "Preferences",
        section: "Editor settings",
        entry: "line one\nline two",
      },
    })
    expectToolError(result, "entry must be a single line")
  })

  it("vault_delete_memory with a nonexistent section", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_memory",
      args: {
        file: "Preferences",
        section: "Missing Section",
        date: "2026-01-01",
        entry: "anything",
      },
    })
    expectToolError(result, 'section not found: "Missing Section" in About Me/Preferences.md')
  })
})

// ── Task errors ──────────────────────────────────────────────

describe("task errors", () => {
  it("vault_update_task done on a board with two Complete-marked lanes and no heading", async () => {
    await callTool({
      client,
      name: "vault_write_note",
      args: {
        path: "Projects/two-done-lanes.md",
        properties: { "kanban-plugin": "board" },
        body: "## Active\n\n- [ ] Task A ^two-done-a\n\n## Done\n\n**Complete**\n\n## Archived\n\n**Complete**\n",
      },
    })
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/two-done-lanes.md",
        block_id: "two-done-a",
        status: "done",
      },
    })
    expectToolError(result, "multiple done lanes detected")
  })

  it("vault_update_task done on a board with no Complete marker and no Done heading", async () => {
    await callTool({
      client,
      name: "vault_write_note",
      args: {
        path: "Projects/no-done-lane.md",
        properties: { "kanban-plugin": "board" },
        body: "## Active\n\n- [ ] Task A ^no-done-a\n\n## Backlog\n\n- [ ] Task B\n",
      },
    })
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/no-done-lane.md",
        block_id: "no-done-a",
        status: "done",
      },
    })
    expectToolError(result, "no done lane detected")
  })

  it("vault_update_task with an unrecognized recurrence rule", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/alpha.md",
        block_id: "alpha-task-1",
        recurrence: "whenever I remember",
      },
    })
    expectToolError(
      result,
      'unrecognized recurrence rule "whenever I remember" (use the Tasks plugin\'s natural language, e.g. "every week", "every 2 weeks when done")',
    )
  })

  it("vault_update_task with a nonexistent block_id", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/alpha.md",
        block_id: "nonexistent-block-id",
        status: "done",
      },
    })
    expectToolError(result, 'blockId "nonexistent-block-id" not found')
  })

  it("vault_create_task with duplicate block_id", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/alpha.md",
        description: "Duplicate",
        block_id: "alpha-task-1",
        heading: "Tasks",
      },
    })
    expectToolError(result, 'blockId "alpha-task-1" already exists')
  })

  it("vault_create_task with invalid block_id characters", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/alpha.md",
        description: "Bad id",
        block_id: "bad id!",
      },
    })
    expectToolError(result, "contains invalid characters")
  })

  it("vault_create_task on nonexistent note", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "nonexistent.md",
        description: "Ghost",
        block_id: "ghost",
      },
    })
    expectToolError(result, "note not found")
  })

  it("vault_create_task on Kanban board without heading", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "No heading",
        block_id: "no-heading",
      },
    })
    expectToolError(result, "heading required for Kanban boards")
  })

  it("vault_create_task with an unrecognized recurrence rule", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/alpha.md",
        description: "Bad rule",
        block_id: "bad-rule",
        recurrence: "whenever I remember",
      },
    })
    expectToolError(
      result,
      'unrecognized recurrence rule "whenever I remember" (use the Tasks plugin\'s natural language, e.g. "every week", "every 2 weeks when done")',
    )
  })

  it("vault_create_task with invalid date", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/alpha.md",
        description: "Bad date",
        block_id: "bad-date",
        due: "2026-02-30",
      },
    })
    expectToolError(result, "invalid date")
  })

  it("vault_update_task with invalid date", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/alpha.md",
        block_id: "alpha-task-1",
        due: "not-a-date",
      },
    })
    expectToolError(result, "invalid date")
  })

  it("vault_update_task — cannot move a sub-task to a heading", async () => {
    // First create a sub-task on the board
    await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "Sub for error test",
        block_id: "sub-error-test",
        parent_block_id: "board-active-1",
      },
    })
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/board.md",
        block_id: "sub-error-test",
        heading: "Done",
      },
    })
    expectToolError(result, "cannot move a sub-task to a heading")
  })

  it("vault_update_task — cannot reposition a sub-task", async () => {
    await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "Sub for position test",
        block_id: "sub-pos-test",
        parent_block_id: "board-active-1",
      },
    })
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/board.md",
        block_id: "sub-pos-test",
        position: 1,
      },
    })
    expectToolError(result, "cannot reposition a sub-task")
  })

  it("vault_update_task — cannot reorder above the first heading", async () => {
    const setupResult = await callTool({
      client,
      name: "vault_write_note",
      args: {
        path: "error-test-above-heading.md",
        body: "- [ ] Orphan task ^orphan-above\n\n## Later\n\n- [ ] Under a heading ^under-heading\n",
        properties: { title: "Above heading test" },
      },
    })
    expect(setupResult.isError).not.toBe(true)
    onTestFinished(async () => {
      await callTool({
        client,
        name: "vault_delete_note",
        args: { path: "error-test-above-heading.md" },
      })
    })

    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "error-test-above-heading.md",
        block_id: "orphan-above",
        position: 2,
      },
    })
    expectToolError(result, "cannot reorder a task that sits above the first heading")
  })

  it("vault_update_task — cannot reorder within an ambiguous heading", async () => {
    const setupResult = await callTool({
      client,
      name: "vault_write_note",
      args: {
        path: "error-test-dup-heading.md",
        body: "## Tasks\n\n- [ ] First ^dup-first\n\n## Tasks\n\n- [ ] Second ^dup-second\n",
        properties: { title: "Dup heading test" },
      },
    })
    expect(setupResult.isError).not.toBe(true)
    onTestFinished(async () => {
      await callTool({
        client,
        name: "vault_delete_note",
        args: { path: "error-test-dup-heading.md" },
      })
    })

    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "error-test-dup-heading.md",
        block_id: "dup-first",
        position: 2,
      },
    })
    expectToolError(result, 'cannot reorder within "Tasks"')
  })

  it("vault_create_task — description must be a single line", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "Line one\nLine two",
        block_id: "two-line-card",
        heading: "Active",
      },
    })
    expectToolError(result, "description must be a single line")
  })

  it("vault_update_task — add_subtasks items must be a single line", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/board.md",
        block_id: "board-active-1",
        add_subtasks: ["Design", "Implement\nTest"],
      },
    })
    expectToolError(result, "addSubtasks items must be a single line")
  })

  it("vault_create_task with both parent_block_id and parent_line", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "Two parent locators",
        block_id: "two-parent-locators",
        parent_block_id: "board-active-1",
        parent_line: 11,
      },
    })
    expectToolError(result, "parentBlockId and parentLine are mutually exclusive")
  })

  it("vault_create_task with a parent_line and a heading", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "Conflicting locators",
        block_id: "conflicting-locators",
        parent_line: 11,
        heading: "Up Next",
      },
    })
    expectToolError(result, "parent and heading are mutually exclusive")
  })

  it("vault_update_task with neither block_id nor line", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: { path: "Projects/alpha.md", status: "done" },
    })
    expectToolError(result, "exactly one of blockId or line is required")
  })

  it("vault_update_task with both block_id and line", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/alpha.md",
        block_id: "alpha-task-1",
        line: 19,
        status: "done",
      },
    })
    expectToolError(result, "blockId and line are mutually exclusive")
  })
})

// ── Path extension errors ────────────────────────────────────

describe("path extension errors", () => {
  it("vault_read_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Projects/alpha" },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_write_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: "Projects/plan", body: "content" },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/plan")')
  })

  it("vault_move_note rejects new_path without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "Projects/alpha.md", new_path: "Projects/moved" },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/moved")')
  })

  it("vault_patch_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: { path: "Projects/alpha", operation: "append", content: "text" },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_replace_in_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: { path: "Projects/alpha", old_text: "old", new_text: "new" },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_delete_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_note",
      args: { path: "Projects/alpha" },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_delete_span rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: { path: "Projects/alpha", start_anchor: "anything" },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_replace_span rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_span",
      args: {
        path: "Projects/alpha",
        start_anchor: "anything",
        content: "replaced",
      },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_insert_at_anchor rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_insert_at_anchor",
      args: {
        path: "Projects/alpha",
        anchor: "anything",
        position: "after",
        content: "inserted",
      },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_update_properties rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "Projects/alpha", properties: { status: "active" } },
    })
    expectToolError(result, 'path must end in ".md" (received "Projects/alpha")')
  })

  it("vault_move_note rejects old_path without extension", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "Projects/alpha", new_path: "Projects/moved.md" },
    })
    // old_path is validated by the backlinks lookup that runs before the move,
    // which accepts .md or .canvas — so the error uses the wider extension set
    expectToolError(result, 'path must end in ".md" or ".canvas" (received "Projects/alpha")')
  })

  it("vault_get_backlinks rejects paths without .md or .canvas extension", async () => {
    const result = await callTool({
      client,
      name: "vault_get_backlinks",
      args: { path: "Projects/alpha" },
    })
    expectToolError(result, 'path must end in ".md" or ".canvas" (received "Projects/alpha")')
  })

  it("vault_get_outgoing_links rejects paths without .md or .canvas extension", async () => {
    const result = await callTool({
      client,
      name: "vault_get_outgoing_links",
      args: { path: "Projects/alpha" },
    })
    expectToolError(result, 'path must end in ".md" or ".canvas" (received "Projects/alpha")')
  })

  it("vault_get_backlinks accepts .canvas paths", async () => {
    const result = await callTool({
      client,
      name: "vault_get_backlinks",
      args: { path: "Boards/roadmap.canvas" },
    })
    expect(result.isError).not.toBe(true)
  })

  it("vault_get_outgoing_links accepts .canvas paths", async () => {
    const result = await callTool({
      client,
      name: "vault_get_outgoing_links",
      args: { path: "Boards/roadmap.canvas" },
    })
    expect(result.isError).not.toBe(true)
  })
})

// ── Startup validation ─────────────────────────────────────

describe("startup validation", () => {
  it("rejects a path-prefixed PUBLIC_URL at boot", async () => {
    const port = await freePort()
    const { exitCode, stderr } = await startServerExpectingFailure(port, {
      PUBLIC_URL: `http://127.0.0.1:${port}/vault/`,
    })
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("PUBLIC_URL must be a bare origin — path prefixes are not supported")
  })

  it("rejects a non-http(s) PUBLIC_URL at boot", async () => {
    const port = await freePort()
    const { exitCode, stderr } = await startServerExpectingFailure(port, {
      PUBLIC_URL: `htps://127.0.0.1:${port}`,
    })
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("PUBLIC_URL must be an http:// or https:// URL")
  })

  it("rejects a PUBLIC_URL with a query string at boot", async () => {
    const port = await freePort()
    const { exitCode, stderr } = await startServerExpectingFailure(port, {
      PUBLIC_URL: `http://127.0.0.1:${port}?debug=1`,
    })
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("PUBLIC_URL must be a bare origin — no query string or fragment")
  })
})

/** Error contract integration tests — every tool's documented error paths
 *  verified over real HTTP transport against a real server. */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  startServer,
  createTestClient,
  freePort,
  callTool,
  textContent,
} from "./test-harness.js"
import type { ToolResult } from "./test-harness.js"

vi.setConfig({ testTimeout: 15_000 })

const expectToolError = (
  result: ToolResult,
  expectedSubstring: string,
): void => {
  expect(result.isError).toBe(true)
  expect(textContent(result)).toContain(expectedSubstring)
}

// ── Single server boot for all error contract tests ──────────

let client: Client
let cleanup: (() => Promise<void>) | undefined

beforeAll(async () => {
  const port = await freePort()
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
    expectToolError(
      result,
      'section not found: "No Such Section" in About Me/Preferences.md',
    )
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
    expectToolError(
      result,
      'section not found: "Missing Section" in About Me/Preferences.md',
    )
  })
})

// ── Task errors ──────────────────────────────────────────────

describe("task errors", () => {
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
    expectToolError(result, 'block_id "nonexistent-block-id" not found')
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
    expectToolError(result, 'block_id "alpha-task-1" already exists')
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
        parent_task: "board-active-1",
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

  it("vault_create_task with a line-number parent_task and a heading", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "Conflicting locators",
        block_id: "conflicting-locators",
        parent_task: 11,
        heading: "Up Next",
      },
    })
    expectToolError(result, "parent_task and heading are mutually exclusive")
  })

  it("vault_update_task with neither block_id nor line", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: { path: "Projects/alpha.md", status: "done" },
    })
    expectToolError(result, "exactly one of block_id or line is required")
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
    expectToolError(result, "block_id and line are mutually exclusive")
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
    expectToolError(
      result,
      'path must end in ".md" (received "Projects/alpha")',
    )
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
    expectToolError(
      result,
      'path must end in ".md" (received "Projects/moved")',
    )
  })

  it("vault_patch_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: { path: "Projects/alpha", operation: "append", content: "text" },
    })
    expectToolError(
      result,
      'path must end in ".md" (received "Projects/alpha")',
    )
  })

  it("vault_replace_in_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: { path: "Projects/alpha", old_text: "old", new_text: "new" },
    })
    expectToolError(
      result,
      'path must end in ".md" (received "Projects/alpha")',
    )
  })

  it("vault_delete_note rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_note",
      args: { path: "Projects/alpha" },
    })
    expectToolError(
      result,
      'path must end in ".md" (received "Projects/alpha")',
    )
  })

  it("vault_delete_span rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: { path: "Projects/alpha", start_anchor: "anything" },
    })
    expectToolError(
      result,
      'path must end in ".md" (received "Projects/alpha")',
    )
  })

  it("vault_update_properties rejects paths without .md extension", async () => {
    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "Projects/alpha", properties: { status: "active" } },
    })
    expectToolError(
      result,
      'path must end in ".md" (received "Projects/alpha")',
    )
  })

  it("vault_move_note rejects old_path without extension", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "Projects/alpha", new_path: "Projects/moved.md" },
    })
    // old_path is validated by the backlinks lookup that runs before the move,
    // which accepts .md or .canvas — so the error uses the wider extension set
    expectToolError(
      result,
      'path must end in ".md" or ".canvas" (received "Projects/alpha")',
    )
  })

  it("vault_get_backlinks rejects paths without .md or .canvas extension", async () => {
    const result = await callTool({
      client,
      name: "vault_get_backlinks",
      args: { path: "Projects/alpha" },
    })
    expectToolError(
      result,
      'path must end in ".md" or ".canvas" (received "Projects/alpha")',
    )
  })

  it("vault_get_outgoing_links rejects paths without .md or .canvas extension", async () => {
    const result = await callTool({
      client,
      name: "vault_get_outgoing_links",
      args: { path: "Projects/alpha" },
    })
    expectToolError(
      result,
      'path must end in ".md" or ".canvas" (received "Projects/alpha")',
    )
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

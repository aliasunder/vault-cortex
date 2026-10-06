/** Error contract integration tests — every tool's documented error paths
 *  verified over real HTTP transport against a real server. */

import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from "vitest"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
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

// ── Orphan exclusion query capacity ──────────────────────────

describe("orphan exclusion query capacity", () => {
  it("returns a structured tool error when the exclusion list exceeds query capacity", async () => {
    const result = await callTool({
      client,
      name: "vault_find_orphans",
      args: {
        exclude_folders: Array.from({ length: 1000 }, (_, index) => `Folder${index}`),
      },
    })
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "[Error]: too many excluded folders",
        },
      ],
      isError: true,
    })
  })
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

// ── Path is not a file ───────────────────────────────────────

describe("path is not a file", () => {
  it("vault_write_note refuses a path that a folder occupies", async () => {
    const folderPath = "Folder Named Like A Note.md"
    const folderFullPath = join(serverVaultPath, folderPath)
    await mkdir(folderFullPath)
    onTestFinished(() => rm(folderFullPath, { recursive: true }))

    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: folderPath, body: "refused" },
    })
    expectToolError(result, `cannot write note "${folderPath}": that path is not a file`)
  })
})

// ── Unreadable properties blocks ─────────────────────────────

const UNCLOSED_BLOCK_NOTE = "---\ntitle: [unclosed\n---\nBody line\n"

const UNCLOSED_BLOCK_MESSAGE =
  "properties block is not valid YAML at line 2, column 17: Flow sequence in block collection must be sufficiently indented and end with a ]"

const CARRY_TEXT_REPAIR_STEPS =
  "To repair it: 1. read the note in full with vault_read_note; 2. copy any text between the --- lines that is not a property; 3. call vault_update_properties with replace: true and the complete corrected properties; 4. add the copied text back to the body with vault_patch_note, without the --- lines."

const OPENING_BLOCK_STEP =
  "To write it, give the note at least one property, put a line of text above the --- lines, or remove those lines."

describe("unreadable properties blocks", () => {
  /** Plants a note straight on disk, as a hand edit or a sync would, and
   *  removes it when the test ends. */
  const plantNote = async (notePath: string, content: string): Promise<string> => {
    const fullPath = join(serverVaultPath, notePath)
    await writeFile(fullPath, content)
    onTestFinished(() => rm(fullPath, { force: true }))
    return fullPath
  }

  it("returns the planted text from a full read, so an agent can see the broken block", async () => {
    await plantNote("Broken Properties.md", UNCLOSED_BLOCK_NOTE)

    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Broken Properties.md" },
    })

    expect(result.isError).not.toBe(true)
    expect(textContent(result)).toBe(UNCLOSED_BLOCK_NOTE)
  })

  it("refuses a merge with the server's message and the repair steps", async () => {
    const fullPath = await plantNote("Broken Properties.md", UNCLOSED_BLOCK_NOTE)

    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "Broken Properties.md", properties: { status: "done" } },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(
      `[Error]: ${UNCLOSED_BLOCK_MESSAGE}. ${CARRY_TEXT_REPAIR_STEPS}`,
    )
    expect(await readFile(fullPath, "utf8")).toBe(UNCLOSED_BLOCK_NOTE)
  })

  it("repairs the block with replace: true, after which a merge keeps, overwrites and deletes keys", async () => {
    const fullPath = await plantNote("Broken Properties.md", UNCLOSED_BLOCK_NOTE)

    const replaced = await callTool({
      client,
      name: "vault_update_properties",
      args: {
        path: "Broken Properties.md",
        properties: { title: "Fixed", draft: true, keep: 1 },
        replace: true,
      },
    })

    expect(replaced.isError).not.toBe(true)
    expect(textContent(replaced)).toBe("Replaced properties on Broken Properties.md")
    expect(await readFile(fullPath, "utf8")).toBe(
      "---\ntitle: Fixed\ndraft: true\nkeep: 1\n---\nBody line\n",
    )

    const merged = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "Broken Properties.md", properties: { title: "Final", draft: null } },
    })

    expect(merged.isError).not.toBe(true)
    expect(await readFile(fullPath, "utf8")).toBe("---\ntitle: Final\nkeep: 1\n---\nBody line\n")
  })

  it.each([
    {
      label: "a prose block that fails as invalid YAML",
      content: "---\n[[Some Link]] is related\n---\nBody line\n",
      prose: "[[Some Link]] is related\n",
    },
    {
      label: "a single-value prose block",
      content: "---\nJust a paragraph.\n---\nBody line\n",
      prose: "Just a paragraph.\n",
    },
  ])("repairs $label by replacing it and putting the prose back", async ({ content, prose }) => {
    const fullPath = await plantNote("Prose Block.md", content)

    const replaced = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "Prose Block.md", properties: {}, replace: true },
    })
    const prepended = await callTool({
      client,
      name: "vault_patch_note",
      args: { path: "Prose Block.md", operation: "prepend", content: prose },
    })

    expect(replaced.isError).not.toBe(true)
    expect(prepended.isError).not.toBe(true)
    // A no-heading prepend leaves one blank line before the old body
    expect(await readFile(fullPath, "utf8")).toBe(`${prose}\nBody line\n`)
  })

  it("tells an agent editing a single-value prose block to carry its text over", async () => {
    await plantNote("Prose Block.md", "---\nJust a paragraph.\n---\nBody line\n")

    const result = await callTool({
      client,
      name: "vault_replace_in_note",
      args: { path: "Prose Block.md", old_text: "Body line", new_text: "Edited line" },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(
      `[Error]: properties block holds a single value, not key-value pairs (a --- line at the top and a later --- line make a properties block), so rewriting the note would delete it. ${CARRY_TEXT_REPAIR_STEPS}`,
    )
  })

  it("repairs a list block by replacing it with properties that keep the items", async () => {
    const fullPath = await plantNote("List Block.md", "---\n- alpha\n- beta\n---\nBody line\n")

    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "List Block.md", properties: { items: ["alpha", "beta"] }, replace: true },
    })

    expect(result.isError).not.toBe(true)
    expect(await readFile(fullPath, "utf8")).toBe(
      "---\nitems:\n  - alpha\n  - beta\n---\nBody line\n",
    )
  })

  it("refuses a vault_write_note body that would open the note with a broken block", async () => {
    const fullPath = join(serverVaultPath, "New Broken.md")
    onTestFinished(() => rm(fullPath, { force: true }))

    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: "New Broken.md", body: "---\ntitle: [unclosed\n---\nBody\n" },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(
      `[Error]: the note would open with a properties block the server cannot keep: ${UNCLOSED_BLOCK_MESSAGE}. ${OPENING_BLOCK_STEP}`,
    )
    await expect(readFile(fullPath, "utf8")).rejects.toThrow("ENOENT")
  })

  it("refuses a body edit that would leave a note without properties opening with a broken block", async () => {
    const original = "Intro paragraph\n---\ntitle: [unclosed\n---\nrest\n"
    const fullPath = await plantNote("Rule Then Block.md", original)

    const result = await callTool({
      client,
      name: "vault_delete_span",
      args: { path: "Rule Then Block.md", start_anchor: "Intro paragraph" },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(
      `[Error]: the note would open with a properties block the server cannot keep: ${UNCLOSED_BLOCK_MESSAGE}. ${OPENING_BLOCK_STEP}`,
    )
    expect(await readFile(fullPath, "utf8")).toBe(original)
  })

  it.each([
    { label: "with properties", properties: { title: "Fixed" } },
    { label: "without properties", properties: undefined },
  ])("refuses a vault_write_note overwrite $label on a broken note", async ({ properties }) => {
    const fullPath = await plantNote("Broken Properties.md", UNCLOSED_BLOCK_NOTE)

    const result = await callTool({
      client,
      name: "vault_write_note",
      args: { path: "Broken Properties.md", body: "New body\n", overwrite: true, properties },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(
      `[Error]: ${UNCLOSED_BLOCK_MESSAGE}. ${CARRY_TEXT_REPAIR_STEPS}`,
    )
    expect(await readFile(fullPath, "utf8")).toBe(UNCLOSED_BLOCK_NOTE)
  })

  it("names a broken memory file when listing memory files", async () => {
    await plantNote("About Me/Broken Memory.md", UNCLOSED_BLOCK_NOTE)

    const result = await callTool({ client, name: "vault_list_memory_files", args: {} })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(
      `[Error]: memory file "About Me/Broken Memory.md": ${UNCLOSED_BLOCK_MESSAGE}. ${CARRY_TEXT_REPAIR_STEPS}`,
    )
  })

  /** The refusal of a write that would leave a single-value block at the top of a note. */
  const SINGLE_VALUE_OPENING_BLOCK_ERROR = `[Error]: the note would open with a properties block the server cannot keep: properties block holds a single value, not key-value pairs (a --- line at the top and a later --- line make a properties block), so rewriting the note would delete it. ${OPENING_BLOCK_STEP}`

  it("refuses removing every property with replace: true when the body opens with --- lines", async () => {
    const original = "---\nold: 1\n---\n---\nJust a paragraph.\n---\nBody line\n"
    const fullPath = await plantNote("Stacked Blocks.md", original)

    const result = await callTool({
      client,
      name: "vault_update_properties",
      args: { path: "Stacked Blocks.md", properties: {}, replace: true },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(SINGLE_VALUE_OPENING_BLOCK_ERROR)
    expect(await readFile(fullPath, "utf8")).toBe(original)
  })

  // An empty first block reads as no properties, so these writes would leave
  // the body's own --- lines at the top of the note

  it("refuses a vault_update_memory write that would open the file with --- lines", async () => {
    const original =
      "---\n---\n---\nJust a paragraph.\n---\n# Stacked\n\n## Notes (newest first)\n- **2026-05-05**: kept entry\n"
    const fullPath = await plantNote("About Me/Stacked Memory.md", original)

    const result = await callTool({
      client,
      name: "vault_update_memory",
      args: {
        file: "Stacked Memory",
        section: "Notes (newest first)",
        entry: "new entry",
        options: { date: "2026-05-06" },
      },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(SINGLE_VALUE_OPENING_BLOCK_ERROR)
    expect(await readFile(fullPath, "utf8")).toBe(original)
  })

  it("refuses a vault_create_task write that would open the note with --- lines", async () => {
    const original = "---\n---\n---\nJust a paragraph.\n---\n- [ ] Kept task\n"
    const fullPath = await plantNote("Stacked Tasks.md", original)

    const result = await callTool({
      client,
      name: "vault_create_task",
      args: { path: "Stacked Tasks.md", description: "New task", block_id: "new-task" },
    })

    expect(result.isError).toBe(true)
    expect(textContent(result)).toBe(SINGLE_VALUE_OPENING_BLOCK_ERROR)
    expect(await readFile(fullPath, "utf8")).toBe(original)
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

  it("vault_get_memory with section but no file", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { section: "Editor settings" },
    })
    expectToolError(result, "section requires a file")
  })

  it("vault_get_memory on_or_after without file", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { on_or_after: "2026-01-01" },
    })
    expectToolError(result, "on_or_after requires a file")
  })

  it("vault_get_memory on_or_after with section but no file", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { section: "Editor settings", on_or_after: "2026-01-01" },
    })
    expectToolError(result, "on_or_after requires a file")
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

  it("vault_delete_memory with a nonexistent file", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_memory",
      args: {
        file: "Nonexistent",
        section: "Editor settings",
        date: "2026-01-01",
        entry: "anything",
      },
    })
    expectToolError(result, 'memory file not found: "About Me/Nonexistent.md"')
  })

  it("vault_get_memory with a folder in the file name", async () => {
    const result = await callTool({
      client,
      name: "vault_get_memory",
      args: { file: "Nested/Preferences" },
    })
    expectToolError(
      result,
      'memory file must be a bare name without path separators: "Nested/Preferences"',
    )
  })

  it("vault_update_memory with a folder in the file name", async () => {
    const result = await callTool({
      client,
      name: "vault_update_memory",
      args: { file: "Nested/Preferences", section: "Editor settings", entry: "never written" },
    })
    expectToolError(
      result,
      'memory file must be a bare name without path separators: "Nested/Preferences"',
    )
  })

  it("vault_update_memory with a control character in the entry", async () => {
    const result = await callTool({
      client,
      name: "vault_update_memory",
      args: { file: "Preferences", section: "Editor settings", entry: "bell\u0007inside" },
    })
    expectToolError(result, "entry contains a control character (U+0007 at position 4)")
  })

  it("vault_update_memory with a control character in the section", async () => {
    const result = await callTool({
      client,
      name: "vault_update_memory",
      args: { file: "Preferences", section: "Editor\u0007settings", entry: "never written" },
    })
    expectToolError(result, "section contains a control character (U+0007 at position 6)")
  })

  it("vault_delete_memory with a folder in the file name", async () => {
    const result = await callTool({
      client,
      name: "vault_delete_memory",
      args: {
        file: "Nested/Preferences",
        section: "Editor settings",
        date: "2026-01-01",
        entry: "anything",
      },
    })
    expectToolError(
      result,
      'memory file must be a bare name without path separators: "Nested/Preferences"',
    )
  })
})

// ── Parameter combinations ───────────────────────────────────

describe("parameter combinations", () => {
  it("vault_read_note with heading_level but no heading", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Projects/alpha.md", heading_level: 2 },
    })
    expectToolError(result, "heading_level requires a heading")
  })

  it("vault_read_note with a whitespace-only heading", async () => {
    const result = await callTool({
      client,
      name: "vault_read_note",
      args: { path: "Projects/alpha.md", heading: "   " },
    })
    expectToolError(result, "heading cannot be empty")
  })

  it("vault_patch_note with a whitespace-only heading", async () => {
    const result = await callTool({
      client,
      name: "vault_patch_note",
      args: { path: "Projects/alpha.md", operation: "append", heading: "   ", content: "refused" },
    })
    expectToolError(result, "heading cannot be empty")
  })

  it("vault_move_note onto its own path", async () => {
    const result = await callTool({
      client,
      name: "vault_move_note",
      args: { old_path: "Projects/alpha.md", new_path: "Projects/alpha.md" },
    })
    expectToolError(result, "source and destination are the same path")
  })
})

// ── Task tool path guards ────────────────────────────────────

describe("task tool path guards", () => {
  const blockedPathCases = [
    { label: "an absolute path", path: "/TASKS.md", message: "absolute path blocked" },
    { label: "a path outside the vault", path: "../TASKS.md", message: "path traversal blocked" },
    { label: "a hidden path", path: ".obsidian/TASKS.md", message: "hidden path blocked" },
  ]

  it.each(blockedPathCases)("vault_create_task rejects $label", async ({ path, message }) => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: { path, description: "never written", block_id: "never-written" },
    })
    expectToolError(result, message)
  })

  it.each(blockedPathCases)("vault_update_task rejects $label", async ({ path, message }) => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: { path, block_id: "never-read", status: "done" },
    })
    expectToolError(result, message)
  })
})

// ── Malformed canvas ─────────────────────────────────────────

describe("malformed canvas", () => {
  it("vault_read_file on a .canvas that is not valid JSON", async () => {
    const canvasPath = "Not A Canvas.canvas"
    const canvasFullPath = join(serverVaultPath, canvasPath)
    await writeFile(canvasFullPath, "{ not json", "utf8")
    onTestFinished(() => rm(canvasFullPath))

    const result = await callTool({ client, name: "vault_read_file", args: { path: canvasPath } })
    expectToolError(result, "invalid .canvas JSON")
  })
})

// ── Whitespace-only task text ────────────────────────────────

describe("whitespace-only task text", () => {
  it("vault_create_task with a whitespace-only description", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: { path: "Projects/alpha.md", description: "   ", block_id: "blank-description" },
    })
    expectToolError(result, "description is empty")
  })

  it("vault_create_task with a whitespace-only checklist item", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/alpha.md",
        description: "Card with a blank checklist item",
        block_id: "blank-checklist-item",
        subtasks: ["   "],
      },
    })
    expectToolError(result, "subtasks cannot contain an empty item")
  })

  it("vault_update_task with a whitespace-only description", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: { path: "Projects/alpha.md", block_id: "alpha-task-1", description: "   " },
    })
    expectToolError(result, "description cannot be empty")
  })

  it("vault_update_task with a whitespace-only checklist item", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: { path: "Projects/alpha.md", block_id: "alpha-task-1", add_subtasks: ["   "] },
    })
    expectToolError(result, "addSubtasks cannot contain an empty item")
  })
})

// ── Undecodable image ────────────────────────────────────────

describe("undecodable image", () => {
  it("vault_read_file on a .png that holds no image data", async () => {
    const imagePath = "Not Really An Image.png"
    const imageFullPath = join(serverVaultPath, imagePath)
    await writeFile(imageFullPath, "plain text, not image bytes", "utf8")
    onTestFinished(() => rm(imageFullPath))

    const result = await callTool({ client, name: "vault_read_file", args: { path: imagePath } })
    expectToolError(result, "Input buffer contains unsupported image format")
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
    const createResult = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/board.md",
        description: "Sub for position test",
        block_id: "sub-pos-test",
        parent_block_id: "board-active-1",
      },
    })
    expect(createResult.isError).not.toBe(true)
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
    onTestFinished(async () => {
      await callTool({
        client,
        name: "vault_delete_note",
        args: { path: "error-test-above-heading.md" },
      })
    })
    expect(setupResult.isError).not.toBe(true)

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
    onTestFinished(async () => {
      await callTool({
        client,
        name: "vault_delete_note",
        args: { path: "error-test-dup-heading.md" },
      })
    })
    expect(setupResult.isError).not.toBe(true)

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

  it("vault_update_task rejects a NON_TASK checkbox", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/status-registry.md",
        block_id: "forwarded-ref",
        status: "done",
      },
    })
    expectToolError(result, 'checkbox "[>]" is a NON_TASK status')
  })

  it("vault_update_task rejects a block_id inside a fenced code block", async () => {
    const result = await callTool({
      client,
      name: "vault_update_task",
      args: {
        path: "Projects/status-registry.md",
        block_id: "fenced-example",
        status: "done",
      },
    })
    expectToolError(result, "is inside a fenced code block or comment")
  })

  it("vault_create_task rejects a NON_TASK parent", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/status-registry.md",
        description: "Child",
        block_id: "child-of-nontask",
        parent_block_id: "forwarded-ref",
      },
    })
    expectToolError(result, 'checkbox "[>]" is a NON_TASK status')
  })

  it("vault_create_task rejects a parent inside a fenced code block", async () => {
    const result = await callTool({
      client,
      name: "vault_create_task",
      args: {
        path: "Projects/status-registry.md",
        description: "Child",
        block_id: "child-of-fenced",
        parent_block_id: "fenced-example",
      },
    })
    expectToolError(result, "is inside a fenced code block or comment")
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

// ── Trash config read failure ────────────────────────────────
//
// Boots its own server, because a malformed app.json would change the
// outcome of every delete on the shared one.

/** A server's structured stdout log, one parsed entry per line. */
const parseLogEntries = (stdout: string): Record<string, unknown>[] => {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line): Record<string, unknown> => JSON.parse(line))
}

/** The message JSON.parse throws for `malformedJson`. Its wording varies by
 *  engine version, so the test reads it from the engine. The server runs on
 *  the same Node as the test process, so both get the same wording. */
const jsonParseFailureMessage = (malformedJson: string): string => {
  try {
    JSON.parse(malformedJson)
  } catch (error) {
    if (error instanceof SyntaxError) return error.message
  }
  throw new Error("expected JSON.parse to throw a SyntaxError")
}

describe("cannot read trash config", () => {
  it("a malformed app.json refuses the delete and logs the cause with the request's context", async () => {
    const server = await startServer(await freePort())
    onTestFinished(() => server.cleanup())
    const malformedAppConfig = "not valid json{{{"
    await writeFile(join(server.vaultPath, ".obsidian", "app.json"), malformedAppConfig, "utf8")
    const ownClient = await createTestClient(server.port)
    onTestFinished(() => ownClient.close())

    await callTool({
      client: ownClient,
      name: "vault_write_note",
      args: { path: "Scratch/malformed-config.md", body: "still here" },
    })
    const deleteResult = await callTool({
      client: ownClient,
      name: "vault_delete_note",
      args: { path: "Scratch/malformed-config.md" },
    })

    // Asserting the whole result keeps the cause out of every part of it: the
    // text, any further content block, and any other field.
    expect(deleteResult).toEqual({
      content: [
        { type: "text", text: "[Error]: cannot read trash config from .obsidian/app.json" },
      ],
      isError: true,
    })
    await expect(
      readFile(join(server.vaultPath, "Scratch", "malformed-config.md"), "utf8"),
    ).resolves.toBe("still here\n")

    // The server's stdout arrives through a pipe, so the log line can land
    // after the tool result; a half-received line fails to parse and retries.
    const { deleteCallLog, readFailureLog } = await vi.waitFor(() => {
      const logEntries = parseLogEntries(server.stdout())
      const loggedReadFailure = logEntries.find(
        (logEntry) => logEntry.message === "cannot read trash config",
      )

      if (!loggedReadFailure) {
        throw new Error("the read failure is not logged yet")
      }

      return {
        deleteCallLog: logEntries.find(
          (logEntry) => logEntry.message === "tool_call" && logEntry.tool === "vault_delete_note",
        ),
        readFailureLog: loggedReadFailure,
      }
    })

    // The delete's own tool_call line carries the context the warning must
    // share. The type checks keep that comparison from passing on undefined.
    expect(typeof deleteCallLog?.requestId).toBe("number")
    expect(typeof deleteCallLog?.sessionId).toBe("string")
    expect({
      error: readFailureLog.error,
      tool: readFailureLog.tool,
      requestId: readFailureLog.requestId,
      sessionId: readFailureLog.sessionId,
    }).toEqual({
      error: `[SyntaxError]: ${jsonParseFailureMessage(malformedAppConfig)}`,
      tool: "vault_delete_note",
      requestId: deleteCallLog?.requestId,
      sessionId: deleteCallLog?.sessionId,
    })
  }, 30_000)
})

describe("cannot read daily notes config", () => {
  it("an unreadable daily-notes.json refuses delete and move until it is repaired", async () => {
    const server = await startServer(await freePort())
    onTestFinished(() => server.cleanup())
    const dailyNotesConfigPath = join(server.vaultPath, ".obsidian", "daily-notes.json")
    await writeFile(dailyNotesConfigPath, JSON.stringify({ folder: "Journal" }), "utf8")
    const ownClient = await createTestClient(server.port)
    onTestFinished(() => ownClient.close())
    for (const path of ["Journal/entry.md", "Scratch/keep.md"]) {
      await callTool({ client: ownClient, name: "vault_write_note", args: { path, body: "kept" } })
    }

    // A refused delete while the file is valid: the folder has been read once.
    const refusedWhileValid = await callTool({
      client: ownClient,
      name: "vault_delete_note",
      args: { path: "Journal/entry.md" },
    })
    expect(textContent(refusedWhileValid)).toBe(
      '[Error]: cannot delete protected path "Journal/entry.md"',
    )

    await writeFile(dailyNotesConfigPath, "", "utf8")

    const deleteWhileUnreadable = await callTool({
      client: ownClient,
      name: "vault_delete_note",
      args: { path: "Scratch/keep.md" },
    })
    const moveWhileUnreadable = await callTool({
      client: ownClient,
      name: "vault_move_note",
      args: { old_path: "Scratch/keep.md", new_path: "Scratch/moved.md" },
    })

    // Asserting the whole result keeps the cause out of every part of it.
    expect(deleteWhileUnreadable).toEqual({
      content: [
        {
          type: "text",
          text: "[Error]: cannot read daily notes config from .obsidian/daily-notes.json",
        },
      ],
      isError: true,
    })
    expect(moveWhileUnreadable).toEqual({
      content: [
        {
          type: "text",
          text: "[Error]: cannot read daily notes config from .obsidian/daily-notes.json",
        },
      ],
      isError: true,
    })
    await expect(readFile(join(server.vaultPath, "Scratch", "keep.md"), "utf8")).resolves.toBe(
      "kept\n",
    )
    await expect(readFile(join(server.vaultPath, "Journal", "entry.md"), "utf8")).resolves.toBe(
      "kept\n",
    )
    await expect(readFile(join(server.vaultPath, "Scratch", "moved.md"), "utf8")).rejects.toThrow(
      "ENOENT",
    )

    await writeFile(dailyNotesConfigPath, JSON.stringify({ folder: "Journal" }), "utf8")

    const deleteAfterRepair = await callTool({
      client: ownClient,
      name: "vault_delete_note",
      args: { path: "Scratch/keep.md" },
    })

    expect(deleteAfterRepair.isError).not.toBe(true)
    expect(textContent(deleteAfterRepair)).toBe(
      "Moved Scratch/keep.md to trash (.trash/Scratch/keep.md)",
    )

    // The warning carries the delete's request context, as the trash reader's does.
    const { deleteCallLog, readFailureLog } = await vi.waitFor(() => {
      const logEntries = parseLogEntries(server.stdout())
      const loggedReadFailure = logEntries.find(
        (logEntry) => logEntry.message === "cannot read daily notes config",
      )

      if (!loggedReadFailure) {
        throw new Error("the read failure is not logged yet")
      }

      return {
        deleteCallLog: logEntries.find(
          (logEntry) =>
            logEntry.message === "tool_call" &&
            logEntry.tool === "vault_delete_note" &&
            logEntry.path === "Scratch/keep.md",
        ),
        readFailureLog: loggedReadFailure,
      }
    })

    expect(typeof deleteCallLog?.requestId).toBe("number")
    expect({
      error: readFailureLog.error,
      tool: readFailureLog.tool,
      requestId: readFailureLog.requestId,
    }).toEqual({
      error: `[SyntaxError]: ${jsonParseFailureMessage("")}`,
      tool: "vault_delete_note",
      requestId: deleteCallLog?.requestId,
    })
  }, 30_000)
})

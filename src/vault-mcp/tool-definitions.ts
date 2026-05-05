/**
 * MCP tool definitions.
 *
 * Registers each MCP tool with a Zod input schema and a handler.
 * This file is the contract between MCP clients and vault-cortex —
 * it defines what operations are available and how they're called.
 *
 * Tools are grouped by function:
 *   - Vault CRUD (R2, R3): read, write, list notes
 *   - Search (R4): full-text search, tag search, folder browse
 *   - Memory (R5): read/append to About Me/ semantic memory files
 *
 * Each handler delegates to vault-filesystem.ts, search-index.ts,
 * or memory-store.ts. This file should contain no business logic
 * beyond mapping MCP inputs to the right function call.
 *
 * Each tool stub below carries an Example call → Example response
 * pair so the implementing agent (and a human reviewer) can sanity
 * check the contract end-to-end before code is written.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SearchIndex } from "./search-index.js";

export const registerTools = (
  _server: McpServer,
  _vaultPath: string,
  _search: SearchIndex,
): void => {
  // TODO: implement — register each tool with server.registerTool()
  //
  // Each tool needs:
  //   1. A unique name (e.g. "vault_read_note")
  //   2. A title + description for MCP clients to display
  //   3. An inputSchema using Zod (z.string(), z.number(), etc)
  //   4. An annotations object ({ readOnlyHint: true } or { destructiveHint: true })
  //   5. An async handler that returns { content: [{ type: "text", text: "..." }] }
  //
  // ────────────────────────────────────────────────────────────────
  // ── Vault CRUD (R2, R3) ────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────
  //
  // vault_read_note(path)            → vault-filesystem.readNote()
  //   readOnlyHint: true
  //   Example call:
  //     { path: "About Me/Principles.md" }
  //   Example response:
  //     { content: [{ type: "text", text:
  //       "---\ntitle: Principles\ntype: about-me\n...\n---\n# Principles\n..." }] }
  //
  // vault_write_note(path, body, frontmatter?)
  //                                  → vault-filesystem.writeNote()
  //   destructiveHint: true
  //   `body` is markdown body only — never raw markdown including
  //   frontmatter (writeNote enforces lossless frontmatter round-trip).
  //   Example call:
  //     { path: "Projects/vault-cortex/notes.md",
  //       body: "# vault-cortex notes\n\n## Today\n- shipped scaffold\n",
  //       frontmatter: { status: "active" } }
  //   Example response:
  //     { content: [{ type: "text", text: "Wrote Projects/vault-cortex/notes.md (412 bytes)" }] }
  //
  // vault_list_notes(folder?, glob?) → vault-filesystem.listNotes()
  //   readOnlyHint: true
  //   Example call:
  //     { folder: "About Me" }
  //   Example response:
  //     { content: [{ type: "text", text: JSON.stringify(
  //       ["About Me/Principles.md","About Me/Career.md",
  //        "About Me/Routines.md","About Me/Preferences.md"]) }] }
  //
  // vault_delete_note(path)          → vault-filesystem.deleteNote()
  //   destructiveHint: true
  //   Refuses paths under "About Me/" or "Daily Notes/" — for memory
  //   entries, use vault_delete_memory.
  //   Example call:
  //     { path: "Projects/scratch/typo.md" }
  //   Example response:
  //     { content: [{ type: "text", text:
  //       "Deleted Projects/scratch/typo.md" }] }
  //   Example error:
  //     { path: "About Me/Principles.md" }
  //     → "Error: cannot delete protected path \"About Me/Principles.md\"
  //        (use vault_delete_memory for individual entries)"
  //
  // ────────────────────────────────────────────────────────────────
  // ── Search (R4) ────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────
  //
  // vault_search(query, filters?)    → search-index.fullTextSearch()
  //   filters: { folder?, tags?, related?, type?, properties?, limit? }
  //   readOnlyHint: true
  //   Example call:
  //     { query: "burnout",
  //       filters: { tags: ["principles"], limit: 5 } }
  //   Example response:
  //     { content: [{ type: "text", text: JSON.stringify({
  //       results: [{
  //         path: "About Me/Principles.md",
  //         title: "Principles",
  //         snippet: "...avoid <mark>burnout</mark> by...",
  //         score: 0.87,
  //         tags: ["principles","self"],
  //         folder: "About Me",
  //         created: "2025-08-12T09:00:00-07:00",
  //         mtime: 1746300000000
  //       }],
  //       total: 1
  //     }) }] }
  //
  //   Example call (property filter — frontmatter-aware):
  //     { query: "Q3 plan",
  //       filters: { properties: { status: "open", area: "work" } } }
  //
  // vault_search_by_tag(tag, exact?) → search-index.searchByTag()
  //   readOnlyHint: true
  //   Example call:
  //     { tag: "project/vault-mcp" }
  //   Example response:
  //     { content: [{ type: "text", text: JSON.stringify([{
  //       path: "Projects/vault-cortex/notes.md",
  //       title: "vault-cortex notes",
  //       tags: ["project/vault-mcp"],
  //       related: ["Principles"],
  //       folder: "Projects",
  //       type: "project-note",
  //       created: "2025-12-01T10:00:00-08:00",
  //       mtime: 1746290000000,
  //       properties: { status: "active", priority: "high" }
  //     }]) }] }
  //
  // vault_list_tags()                → search-index.listAllTags()
  //   readOnlyHint: true
  //   Example call: {}
  //   Example response:
  //     { content: [{ type: "text", text: JSON.stringify([
  //       { tag: "principles", count: 12 },
  //       { tag: "project/vault-mcp", count: 8 },
  //       { tag: "self", count: 5 }
  //     ]) }] }
  //
  // vault_recent_notes(sort_by?, limit?)
  //                                  → search-index.recentNotes()
  //   sort_by: "created" | "mtime" (default "mtime")
  //   readOnlyHint: true
  //   Example call:
  //     { sort_by: "created", limit: 3 }
  //   Example response: { content: [{ type: "text", text: JSON.stringify(
  //     [<NoteMetadata>, <NoteMetadata>, <NoteMetadata>]) }] }
  //
  // ────────────────────────────────────────────────────────────────
  // ── Memory (R5) ────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────
  //
  // vault_get_memory(file?, section?) → memory-store.getMemory()
  //   readOnlyHint: true
  //   Example call:
  //     { file: "Principles", section: "Decision heuristics" }
  //   Example response:
  //     { content: [{ type: "text", text:
  //       "- **2026-05-03**: prefer reversible decisions when context is thin\n" +
  //       "- **2026-04-21**: ship the smallest thing that proves the idea" }] }
  //
  //   Example call (no args — concat all):
  //     {}
  //   Example response: every About Me/*.md concatenated, frontmatter
  //   stripped, separated by `\n\n---\n\n`.
  //
  // vault_update_memory(file, section, entry, options?)
  //                                  → memory-store.updateMemory()
  //   options: { date?: "YYYY-MM-DD", position?: "top" | "bottom" }
  //   destructiveHint: true (mutates a vault file)
  //   Server prefixes the date — agent passes raw entry text only.
  //   Example call:
  //     { file: "Principles",
  //       section: "Decision heuristics",
  //       entry: "prefer reversible decisions when context is thin" }
  //   Example response:
  //     { content: [{ type: "text", text:
  //       "Added entry to About Me/Principles.md → ## Decision heuristics" }] }
  //
  // vault_list_memory_files()        → memory-store.listMemoryFiles()
  //   readOnlyHint: true
  //   Discovery / outline tool — does NOT return memory entries.
  //   Returns files + their H1/H2 headings with per-section entry
  //   counts. Call before vault_update_memory, vault_get_memory, or
  //   vault_delete_memory to find valid section names.
  //   Example call: {}
  //   Example response:
  //     { content: [{ type: "text", text: JSON.stringify([
  //       { file: "Principles", title: "Principles", headings: [
  //         { level: 1, text: "Principles" },
  //         { level: 2, text: "Decision heuristics", entryCount: 12 },
  //         { level: 2, text: "Working style",       entryCount: 7  }
  //       ]},
  //       { file: "Career", title: "Career", headings: [...] }
  //     ]) }] }
  //
  // vault_delete_memory(file, section, date, entry)
  //                                  → memory-store.deleteMemory()
  //   destructiveHint: true
  //   Both date and entry required to disambiguate. Call
  //   vault_get_memory(file, section) first to see the exact entry
  //   text. Errors on no match or ambiguous match.
  //   Example call:
  //     { file: "Principles",
  //       section: "Decision heuristics",
  //       date: "2026-04-21",
  //       entry: "ship the smallest thing that proves the idea" }
  //   Example response:
  //     { content: [{ type: "text", text:
  //       "Deleted entry from About Me/Principles.md → ## Decision heuristics" }] }
};

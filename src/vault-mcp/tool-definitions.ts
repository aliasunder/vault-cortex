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
  // Tools to register:
  //
  // ── Vault CRUD (R2, R3) ───────────────────────────────
  //   vault_read_note(path)          → vault-filesystem.readNote()
  //   vault_write_note(path, content)→ vault-filesystem.writeNote()
  //   vault_list_notes(folder?, glob?)→ vault-filesystem.listNotes()
  //
  // ── Search (R4) ───────────────────────────────────────
  //   vault_search(query, folder?, tags?, type?, limit?)
  //                                  → search-index.fullTextSearch()
  //   vault_search_by_tag(tag, exact?)→ search-index.searchByTag()
  //   vault_list_tags()              → search-index.listAllTags()
  //   vault_recent_notes(limit?)     → search-index.recentNotes()
  //
  // ── Memory (R5) ───────────────────────────────────────
  //   vault_get_memory(file?)        → memory-store.getMemory()
  //   vault_update_memory(file, entry)→ memory-store.updateMemory()
  //   vault_list_memories()          → memory-store.listMemories()
};

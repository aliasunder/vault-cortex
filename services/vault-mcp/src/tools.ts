/**
 * MCP tool registrations.
 *
 * Each tool is registered with a Zod input schema and a handler.
 * Tools are grouped by function: vault CRUD, search, memory.
 *
 * All tools operate on the vault filesystem and/or the SQLite FTS5 index.
 * The vault is the source of truth — the index is derived.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readNote, writeNote, listNotes } from "./vault.js";
import { getMemory, updateMemory, listMemories } from "./memory.js";
import type { VaultSearch } from "./search.js";

export function registerTools(
  server: McpServer,
  vaultPath: string,
  search: VaultSearch,
): void {
  // -- Vault Read/Write (R2, R3) ----------------------------------------

  server.registerTool(
    "vault_read_note",
    {
      title: "Read Note",
      description: "Read a markdown file from the vault by path",
      inputSchema: { path: z.string().describe("Relative path from vault root, e.g. 'Journal/2026-05-01.md'") },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const content = await readNote(vaultPath, path);
      return { content: [{ type: "text" as const, text: content }] };
    },
  );

  server.registerTool(
    "vault_write_note",
    {
      title: "Write Note",
      description: "Create or update a markdown file. Syncs to all devices via Obsidian Sync.",
      inputSchema: {
        path: z.string().describe("Relative path from vault root"),
        content: z.string().describe("Full markdown content to write"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path, content }) => {
      await writeNote(vaultPath, path, content);
      return { content: [{ type: "text" as const, text: `Written: ${path}` }] };
    },
  );

  server.registerTool(
    "vault_list_notes",
    {
      title: "List Notes",
      description: "List markdown files in a folder",
      inputSchema: {
        folder: z.string().optional().describe("Folder to list, defaults to vault root"),
        glob: z.string().optional().describe("Glob pattern filter, e.g. '*.md'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, glob }) => {
      const files = await listNotes(vaultPath, folder, glob);
      return { content: [{ type: "text" as const, text: JSON.stringify(files, null, 2) }] };
    },
  );

  // -- Search (R4) ------------------------------------------------------

  server.registerTool(
    "vault_search_notes",
    {
      title: "Search Notes",
      description: "Full-text search across vault notes via SQLite FTS5. Supports tag and folder filters.",
      inputSchema: {
        query: z.string().describe("Search query"),
        folder: z.string().optional().describe("Restrict to folder"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        type: z.string().optional().describe("Filter by frontmatter type"),
        limit: z.number().optional().default(20).describe("Max results"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, folder, tags, type, limit }) => {
      // TODO: Wire folder/tags/type filters into search.search()
      const results = search.search(query, limit);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  // -- Memory (R5) ------------------------------------------------------

  server.registerTool(
    "vault_get_memory",
    {
      title: "Get Memory",
      description: "Read from About Me/ semantic memory files",
      inputSchema: {
        file: z.string().optional().describe("Specific file, e.g. 'career' or 'principles'. Omit for all."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      const content = await getMemory(vaultPath, file);
      return { content: [{ type: "text" as const, text: content }] };
    },
  );

  server.registerTool(
    "vault_update_memory",
    {
      title: "Update Memory",
      description: "Append a dated entry to an About Me/ memory file",
      inputSchema: {
        file: z.string().describe("Memory file name, e.g. 'career' or 'opinions'"),
        entry: z.string().describe("Text to append (will be prefixed with date)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ file, entry }) => {
      await updateMemory(vaultPath, file, entry);
      return { content: [{ type: "text" as const, text: `Appended to About Me/${file}.md` }] };
    },
  );

  server.registerTool(
    "vault_list_memories",
    {
      title: "List Memories",
      description: "List all About Me/ memory files with section headings",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const memories = await listMemories(vaultPath);
      return { content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }] };
    },
  );
}

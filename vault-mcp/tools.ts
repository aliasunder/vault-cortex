/**
 * MCP tool registrations.
 *
 * Each tool gets a Zod input schema and an async handler.
 * Grouped by function: vault CRUD, search, memory.
 *
 * All tools operate on the vault filesystem and/or SQLite FTS5 index.
 * The vault is the source of truth — the index is derived.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readNote, writeNote, listNotes } from "./vault.js";
import { getMemory, updateMemory, listMemories } from "./memory.js";
import type { SearchIndex } from "./search.js";

export const registerTools = (
  server: McpServer,
  vaultPath: string,
  search: SearchIndex,
): void => {
  // ── Vault Read/Write (R2, R3) ──────────────────────────────────

  server.registerTool(
    "vault_read_note",
    {
      title: "Read Note",
      description: "Read a markdown file from the vault by path",
      inputSchema: {
        path: z.string().describe("Relative path, e.g. 'Journal/2026-05-01.md'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => ({
      content: [{ type: "text" as const, text: await readNote(vaultPath, path) }],
    }),
  );

  server.registerTool(
    "vault_write_note",
    {
      title: "Write Note",
      description:
        "Create or update a markdown file. Syncs to all devices via Obsidian Sync.",
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
        folder: z.string().optional().describe("Folder path, defaults to vault root"),
        glob: z.string().optional().describe("Glob filter, e.g. '*.md'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, glob }) => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await listNotes(vaultPath, folder, glob), null, 2) },
      ],
    }),
  );

  // ── Search (R4) ────────────────────────────────────────────────

  server.registerTool(
    "vault_search_notes",
    {
      title: "Search Notes",
      description:
        "Full-text search via SQLite FTS5. Supports tag and folder filters.",
      inputSchema: {
        query: z.string().describe("Search query"),
        folder: z.string().optional().describe("Restrict to folder"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        type: z.string().optional().describe("Filter by frontmatter type"),
        limit: z.number().optional().default(20).describe("Max results"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      // TODO: Wire folder/tags/type filters into search
      const results = search.search(query, limit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ── Memory (R5) ────────────────────────────────────────────────

  server.registerTool(
    "vault_get_memory",
    {
      title: "Get Memory",
      description: "Read from About Me/ semantic memory files",
      inputSchema: {
        file: z.string().optional().describe("Specific file, e.g. 'career'. Omit for all."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => ({
      content: [{ type: "text" as const, text: await getMemory(vaultPath, file) }],
    }),
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
      return {
        content: [{ type: "text" as const, text: `Appended to About Me/${file}.md` }],
      };
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
    async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await listMemories(vaultPath), null, 2) },
      ],
    }),
  );
};

<!-- AUTO-GENERATED from README.md — do not edit manually. Run: npm run generate:dockerhub-readme -->

<p align="center">
  <img src="https://raw.githubusercontent.com/aliasunder/vault-cortex/main/assets/banner.svg" width="720" alt="Vault Cortex">
</p>

<div align="center">

[![CI](https://img.shields.io/github/actions/workflow/status/aliasunder/vault-cortex/ci.yml?branch=main&logo=github&label=CI&cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/actions/workflows/ci.yml)
[![Gitleaks](https://img.shields.io/github/actions/workflow/status/aliasunder/vault-cortex/gitleaks.yml?branch=main&logo=github&label=Gitleaks&cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/actions/workflows/gitleaks.yml)
[![Trivy](https://img.shields.io/github/actions/workflow/status/aliasunder/vault-cortex/trivy.yml?branch=main&logo=github&label=Trivy&cacheSeconds=43200&v=1)](https://github.com/aliasunder/vault-cortex/actions/workflows/trivy.yml)
[![GitHub Release](https://img.shields.io/github/v/release/aliasunder/vault-cortex?cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/releases)
[![npm](https://img.shields.io/npm/v/vault-cortex?logo=npm&label=npm&cacheSeconds=43200)](https://www.npmjs.com/package/vault-cortex)
[![License: MIT](https://img.shields.io/github/license/aliasunder/vault-cortex?v=1&cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/aliasunder/vault-cortex)
[![vault-cortex MCP server](https://glama.ai/mcp/servers/aliasunder/vault-cortex/badges/score.svg)](https://glama.ai/mcp/servers/aliasunder/vault-cortex)

</div>

> **Full documentation:** [github.com/aliasunder/vault-cortex](https://github.com/aliasunder/vault-cortex)
>
> This is an abbreviated version for Docker Hub. See the full README for quick-start guides, authentication details, and development instructions.


**Vault Cortex** is a standalone MCP server that gives any AI agent **hybrid search, task management, structured memory, and read/write access** to your [Obsidian](https://obsidian.md) vault. No plugins, no running Obsidian, no separate bridge. One Docker container, your vault folder, a full tool suite + guided prompts. Deploy on a VPS with Obsidian Sync and the same vault is accessible from your phone, claude.ai, or any remote MCP client, secured with OAuth 2.1.


## What you get

<table align="center">
  <tr>
    <td align="center"><strong>Search the vault</strong></td>
    <td align="center"><strong>Reason over notes</strong></td>
    <td align="center"><strong>Write back to Obsidian</strong></td>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/aliasunder/vault-cortex/main/assets/demo-remember.gif" width="240" alt="Ask Claude about a past trip — it searches the vault and recalls the route, cities, and highlights"></td>
    <td><img src="https://raw.githubusercontent.com/aliasunder/vault-cortex/main/assets/demo-reason.gif" width="240" alt="Ask what went wrong — Claude synthesizes lessons from session logs and itinerary notes"></td>
    <td><img src="https://raw.githubusercontent.com/aliasunder/vault-cortex/main/assets/demo-writeback.gif" width="240" alt="Save lessons learned to the vault, update travel preferences, then see both in Obsidian"></td>
  </tr>
</table>

<p align="center"><em>All three demos run on Claude mobile. The vault is on a remote server, not the phone.</em></p>

- **[Remote access](https://github.com/aliasunder/vault-cortex#deployment-options)** — works from your phone, a remote server, or any MCP client via OAuth 2.1. Deploy on a VPS with Obsidian Sync for access from anywhere.
- **[Plugin-free](https://github.com/aliasunder/vault-cortex#how-it-works)** — Obsidian doesn't need to be running. The server works directly with `.md` files on disk. Headless sync keeps the vault current.
- **[Hybrid search](https://github.com/aliasunder/vault-cortex#hybrid-search)** — FTS5 keyword matching + vector semantic similarity via RRF fusion, refined by cross-encoder reranking for intent-heavy queries. Keywords stay precise on exact terms and jargon; vectors find notes even when your words differ from the vault's.
- **[Structured memory](https://github.com/aliasunder/vault-cortex#memory)** — dated, append-only entries accumulate into a personal knowledge layer, auto-initialized for AI personalization. Topic recall answers "what do I think about X?" with the current take and the dated history behind it — evolution included.
- **[Tasks](https://github.com/aliasunder/vault-cortex#tasks)** — Kanban-aware task queries and updates: triage by status, dates, or priority, then complete, reprioritize, or move tasks between lanes in one call. Parses both [Tasks plugin](https://publish.obsidian.md/tasks/) emoji and [Dataview](https://blacksmithgu.github.io/obsidian-dataview/) inline-field formats.
- **[Link graph](https://github.com/aliasunder/vault-cortex#tools)** — backlinks, outgoing links, and orphan detection across the vault
- **[Assets](https://github.com/aliasunder/vault-cortex#assets)** — read the vault's non-markdown files too: images arrive as actual images (downscaled to fit), canvases as readable outlines, data files as text
- **[Obsidian-native](https://github.com/aliasunder/vault-cortex#properties)** — understands frontmatter, wikilinks, tags, headings, and daily notes
- **[Guided workflows](https://github.com/aliasunder/vault-cortex#prompts)** — built-in prompts for vault health, memory review, and daily reconciliation — assembled from live vault data each time

**Tested across a 15-day trip through Europe.** 30+ sessions from a phone, 216 tool calls, zero laptop access needed. Writes in one session were immediately available in the next, across cities and days.


## Quick Start

See the [full Quick Start guide](https://github.com/aliasunder/vault-cortex#quick-start) for local setup (2 minutes with Docker), remote deployment with Obsidian Sync, and MCP client configuration.

## Assets

Your notes embed screenshots, reference architecture diagrams, and link out to canvases and data files — but to an agent reading markdown, `![[diagram.png]]` is just text. vault-cortex treats assets as part of the vault rather than clutter around it: the link graph resolves every asset a note references — with its size — and the asset layer makes them readable, each in the form an agent can actually use:

- **Images** — the image itself, not the filename. Screenshots and diagrams are downscaled and recompressed server-side to fit what MCP clients accept, so even a phone session can look at a 5MB architecture diagram
- **Canvases** — a `.canvas` board arrives as a readable outline: its groups, each card's content in reading order, and the connections between them
- **Text and data files** — SVG, JSON, CSV, logs, and [Bases](https://help.obsidian.md/bases) files return exactly as written
- **Browse** — list any folder's assets with per-extension counts and file sizes

See [ARCHITECTURE.md → Assets](https://github.com/aliasunder/vault-cortex/blob/main/ARCHITECTURE.md#assets) for the image pipeline and dispatch model.

## Tools

| Category        | Tool                         | Description                                                                            |
| --------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| **Vault CRUD**  | `vault_read_note`            | Read a note — full body, properties, outline, or a section                             |
|                 | `vault_write_note`           | Create a note (fails if it already exists; set `overwrite` to replace)                 |
|                 | `vault_patch_note`           | Heading-targeted edit (append, prepend, replace, insert)                               |
|                 | `vault_replace_in_note`      | Find-and-replace text in a note                                                        |
|                 | `vault_delete_span`          | Delete a block of lines by short anchors, no full re-quote                             |
|                 | `vault_list_notes`           | List notes with optional glob/folder filter                                            |
|                 | `vault_delete_note`          | Delete a note (protected paths enforced)                                               |
|                 | `vault_move_note`            | Move or rename a note, rewriting links across the vault                                |
| **Search**      | `vault_search`               | Hybrid search with tag/folder/property/date filters                                    |
|                 | `vault_search_by_tag`        | Find notes by tag (exact or prefix match)                                              |
|                 | `vault_search_by_folder`     | Browse notes in a folder with metadata                                                 |
|                 | `vault_recent_notes`         | Recently modified or created notes                                                     |
|                 | `vault_list_tags`            | All tags with usage counts                                                             |
| **Tasks**       | `vault_list_tasks`           | Vault-wide task index — Kanban-aware, 6 date fields, priority, folder/heading scope    |
|                 | `vault_update_task`          | One-call status, priority, and lane changes — auto-detects done lanes on Kanban boards |
| **Memory**      | `vault_get_memory`           | Read structured memory (file, section, or all)                                         |
|                 | `vault_update_memory`        | Append a dated entry to a memory section                                               |
|                 | `vault_delete_memory`        | Remove a specific memory entry by date                                                 |
|                 | `vault_list_memory_files`    | Discover memory files, their sections, and each file's entry policy                    |
|                 | `vault_memory_recall`        | Entry-granular hybrid recall of a topic across memory files, oldest-first              |
| **Properties**  | `vault_list_property_keys`   | All property keys with sample values                                                   |
|                 | `vault_list_property_values` | Distinct values for a property key                                                     |
|                 | `vault_search_by_property`   | Find notes by property key-value                                                       |
|                 | `vault_update_properties`    | Add or update properties without touching the body                                     |
| **Links**       | `vault_get_backlinks`        | Notes linking to a given path                                                          |
|                 | `vault_get_outgoing_links`   | Links from a given note                                                                |
|                 | `vault_find_orphans`         | Notes with no incoming links                                                           |
| **Assets**      | `vault_read_asset`           | Read a non-markdown file — images delivered as images, canvases as readable outlines   |
|                 | `vault_list_assets`          | Browse the vault's non-markdown files with sizes and per-extension counts              |
| **Daily Notes** | `vault_get_daily_note`       | Today's (or any date's) daily note                                                     |

## Prompts

Tools are model-driven — the assistant calls them. **Prompts** are workflows _you_ trigger. Each one queries the search index, link graph, and memory layer at invocation time, then assembles the results with guided instructions — so the session starts grounded in your vault's actual state, not assumptions.

| Prompt              | Arguments             | What it does                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault-orientation` | —                     | Surveys vault stats, folder distribution, property adoption rates (flags low adoption), orphans, broken link count, tags, recent notes, and the memory layer — with contextual tool suggestions                                                                                                         |
| `memory-review`     | `file?`, `max_chars?` | Structural overview (scope callouts, section entry counts) + dated content as a timeline. Guided reflection: evolution narrative, scope-fit, backfill gaps, and coverage analysis — append-only by default, pruning proposed only for `entry-policy: living` files. Hidden when `MEMORY_ENABLED=false`. |
| `daily-review`      | `date?`, `max_chars?` | Reconciles a day — daily note, vault-wide task status (due/overdue, scheduled), modified notes, outgoing links (broken-link detection), and backlinks — surfaces what happened, what's open, and what needs follow-up                                                                                   |

Prompts adapt to your configuration (`MEMORY_DIR`, daily-notes settings) and work for any vault out of the box. Pass `max_chars` to cap embedded content if your client has payload limits.

> **Client support:** Prompts work in Claude Desktop (Chat and Cowork — via the **+** menu under your connector), Claude Code (slash commands), and OpenCode. Support in other clients (Cursor, Windsurf) varies — see the [MCP clients matrix](https://modelcontextprotocol.io/clients) for the latest.

## Properties

Vault Cortex indexes every [property](https://help.obsidian.md/Editing+and+formatting/Properties) in your notes, but five get **promoted** treatment — dedicated columns for fast filtering, and top-level fields in every search and discovery result:

| Property  | What you can do                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `title`   | Display name in search results; falls back to the filename when missing                                      |
| `tags`    | Search and filter by tag, including parent-child hierarchies (`project` matches `project/vault-cortex`)      |
| `type`    | Filter by note type — `meeting`, `person`, `session-log`, or any value your vault uses                       |
| `created` | Sort by creation date and see when each note was created alongside every search result                       |
| `related` | Filter for notes that cross-reference a specific link — surfaces connections invisible without a graph query |

## Configuration

All settings are environment variables with sensible defaults.

| Variable                    | Required?   | Default                              | Description                                                                                                                                                                                                                       |
| --------------------------- | ----------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`            | Yes         | —                                    | Bearer token for authentication (also the JWT signing key)                                                                                                                                                                        |
| `VAULT_PATH`                | Local only  | —                                    | Host path to your vault (bind mount source; remote uses a named volume)                                                                                                                                                           |
| `PUBLIC_URL`                | Remote only | —                                    | Public URL for OAuth discovery metadata                                                                                                                                                                                           |
| `EMBEDDING_ENABLED`         | —           | `true`                               | Set `false` to disable the embedding pipeline — skips model download, vector tables, embedding passes, and hybrid search. Search falls back to FTS5 keyword matching.                                                             |
| `RERANK_MODE`               | —           | `blended`                            | Cross-encoder reranking mode: `blended` applies position-aware score blending after RRF fusion (~200ms added latency), `none` skips reranking. Only takes effect when `EMBEDDING_ENABLED` is true.                                |
| `MEMORY_ENABLED`            | —           | `true`                               | Set `false` to fully disable the memory layer — hides memory tools, skips bootstrap, omits memory from server metadata. `MEMORY_DIR` is ignored when `false`.                                                                     |
| `MEMORY_DIR`                | —           | `About Me`                           | Vault folder for structured memory files                                                                                                                                                                                          |
| `PROTECTED_PATHS`           | —           | `MEMORY_DIR, Daily Notes`            | Folders that `vault_delete_note` refuses to touch                                                                                                                                                                                 |
| `ORPHAN_EXCLUDE_FOLDERS`    | —           | `Daily Notes, Templates, MEMORY_DIR` | Folders excluded from orphan detection                                                                                                                                                                                            |
| `TZ`                        | —           | `UTC`                                | IANA timezone for timestamps and daily note resolution                                                                                                                                                                            |
| `SERVICE_DOCUMENTATION_URL` | —           | GitHub repo URL                      | URL returned in OAuth discovery metadata                                                                                                                                                                                          |
| `LOG_LEVEL`                 | —           | `info`                               | Logging verbosity: `debug`, `info`, `warn`, `error`                                                                                                                                                                               |
| `LOG_DIR`                   | —           | `/data/logs` (remote), unset (local) | Directory for persistent log files. When set, logs are written to date-stamped files there alongside stdout. Unset means stdout only.                                                                                             |
| `LOG_RETENTION_DAYS`        | —           | `30`                                 | Days to keep log files before automatic cleanup on startup                                                                                                                                                                        |
| `WINDOWS_MODE`              | —           | `false`                              | On Windows? Set `true`. Switches the file watcher to polling and note moves to rename-based writes so a vault on a `C:` drive works through Docker Desktop. Safe to leave on for any Windows setup; unneeded on macOS/Linux/WSL2. |

## Deployment Options

Local runs on your machine. Remote deployments run on a VPS — your vault is accessible even when your laptop is closed.

| Path          | What                                                              | Guide                                |
| ------------- | ----------------------------------------------------------------- | ------------------------------------ |
| **Local**     | Your vault on your machine — free, no cloud                       | [`deploy/local/`](https://github.com/aliasunder/vault-cortex/tree/main/deploy/local/)   |
| **Remote**    | VPS + Obsidian Sync — access from any device                      | [`deploy/remote/`](https://github.com/aliasunder/vault-cortex/tree/main/deploy/remote/) |
| **AWS (SST)** | IaC reference deployment — automated infra, defense-in-depth auth | [`DEPLOY.md`](https://github.com/aliasunder/vault-cortex/blob/main/DEPLOY.md)           |


## License

[MIT](https://github.com/aliasunder/vault-cortex/blob/main/LICENSE) — see the full [License section](https://github.com/aliasunder/vault-cortex#license) for details on bundled components.

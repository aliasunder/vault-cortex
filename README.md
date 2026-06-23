<p align="center">
  <img src="./assets/banner.svg" width="720" alt="Vault Cortex">
</p>

<div align="center">

[![CI](https://img.shields.io/github/actions/workflow/status/aliasunder/vault-cortex/ci.yml?branch=main&logo=github&label=CI&cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/actions/workflows/ci.yml)
[![Gitleaks](https://img.shields.io/github/actions/workflow/status/aliasunder/vault-cortex/gitleaks.yml?branch=main&logo=github&label=Gitleaks&cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/actions/workflows/gitleaks.yml)
[![Trivy](https://img.shields.io/github/actions/workflow/status/aliasunder/vault-cortex/trivy.yml?branch=main&logo=github&label=Trivy&cacheSeconds=43200&v=1)](https://github.com/aliasunder/vault-cortex/actions/workflows/trivy.yml)
[![GitHub Release](https://img.shields.io/github/v/release/aliasunder/vault-cortex?cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/releases)
[![License: MIT](https://img.shields.io/github/license/aliasunder/vault-cortex?v=1&cacheSeconds=43200)](https://github.com/aliasunder/vault-cortex/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/aliasunder/vault-cortex)
[![vault-cortex MCP server](https://glama.ai/mcp/servers/aliasunder/vault-cortex/badges/score.svg)](https://glama.ai/mcp/servers/aliasunder/vault-cortex)

</div>

**Vault Cortex** is a standalone MCP server for [Obsidian](https://obsidian.md) vaults. It reads `.md` files directly. No Obsidian plugins, no running Obsidian, no separate bridge. One Docker container gives any MCP client 25 tools and 3 guided prompts for search, memory, link graph, properties, and daily notes.

The typical Obsidian MCP setup requires three moving parts: Obsidian open, a REST API plugin installed, and a separate MCP server wrapping the plugin. Vault Cortex replaces all of that with one Docker container and your vault folder. Deploy on a VPS with Obsidian Sync and the same vault is accessible from your phone, claude.ai, CI, or any remote MCP client.

<table align="center">
  <tr>
    <td align="center"><strong>Search the vault</strong></td>
    <td align="center"><strong>Reason over notes</strong></td>
    <td align="center"><strong>Write back to Obsidian</strong></td>
  </tr>
  <tr>
    <td><img src="./assets/demo-remember.gif" width="240" alt="Ask Claude about a past trip — it searches the vault and recalls the route, cities, and highlights"></td>
    <td><img src="./assets/demo-reason.gif" width="240" alt="Ask what went wrong — Claude synthesizes lessons from session logs and itinerary notes"></td>
    <td><img src="./assets/demo-writeback.gif" width="240" alt="Save lessons learned to the vault, update travel preferences, then see both in Obsidian"></td>
  </tr>
</table>

<p align="center"><em>All three demos run on Claude mobile. The vault is on a remote server, not the phone.</em></p>

- **[Remote access](#authentication)** — works from your phone, a remote server, or any MCP client via OAuth 2.1. Deploy on a VPS with Obsidian Sync for access from anywhere.
- **Plugin-free** — Obsidian doesn't need to be running. The server works directly with `.md` files on disk. Headless sync keeps the vault current.
- **[Ranked search](#tools-25)** — SQLite FTS5 with BM25 scoring, stemming, phrase matching, and tag/property/folder filtering
- **[Structured memory](#tools-25)** — dated entries, section targeting, auto-initialization for AI personalization
- **[Link graph](#tools-25)** — backlinks, outgoing links, and orphan detection across the vault
- **[Obsidian-native](#properties)** — understands frontmatter, wikilinks, tags, headings, and daily notes
- **[Guided workflows](#prompts-3)** — three built-in prompts that surface vault health (orphans, broken links, property adoption), review your memory layer's structure and coverage, or reconcile a day's work with outgoing links, backlinks, and date-specific activity. Assembled from live vault data each time you run them.

### Roadmap

| Phase | What                                                         | Status   |
| ----- | ------------------------------------------------------------ | -------- |
| **1** | Vault CRUD, full-text search (FTS5), memory layer, OAuth 2.1 | Complete |
| **2** | Semantic search + knowledge graph                            | Planned  |

**Contents** — [Why Vault Cortex?](#why-vault-cortex) · [Quick Start](#quick-start) · [Tools](#tools-25) · [Prompts](#prompts-3) · [Properties](#properties) · [Configuration](#configuration) · [Authentication](#authentication) · [How It Works](#how-it-works) · [Deployment](#deployment-options)

## Why Vault Cortex?

Vault Cortex is a standalone knowledge layer for your vault, not an HTTP proxy to a running Obsidian instance. Servers built on Obsidian's REST API route every read, write, and search through a running Obsidian; Vault Cortex reads `.md` files directly and owns its own search index, so it runs fully headless — and adds a structured memory layer plus prompts that fuse search, links, and memory in one pass.

Built and tested across a 15-day trip through Europe. 30 sessions from a phone, 70+ tool calls, zero laptop access needed. Writes in one session were immediately available in the next, across cities and days.

## Quick Start

### Local (2 minutes — Docker + your vault folder)

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/), Node.js >= 20.12 (only for the CLI — the server itself runs in Docker), and an Obsidian vault (or any folder of `.md` files).

```bash
npx vault-cortex@latest init
```

That's it — the CLI asks for your vault path, generates the auth token and config files, starts the server, and prints the connection details for your MCP client.

<details>
<summary><strong>Manual setup</strong> (no Node.js needed)</summary>

```bash
# 1. Get the quickstart files
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/local/docker-compose.yml
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/local/.env.example

# 2. Configure
cp .env.example .env
# Edit .env — set MCP_AUTH_TOKEN (openssl rand -hex 32) and VAULT_PATH

# 3. Start
docker compose up
```

</details>

**[Full local guide →](./deploy/local/)** — on Windows, [set `WINDOWS_MODE=true`](./deploy/local/#windows-docker-desktop) to run against a `C:` drive.

### Remote (access from anywhere — Docker + Obsidian Sync)

**Prerequisites:** a VPS with [Docker](https://docs.docker.com/engine/install/), an [Obsidian Sync](https://obsidian.md/sync) subscription, and Node.js >= 20.12 (only for the CLI — the server itself runs in Docker).

```bash
# On your VPS:
npx vault-cortex@latest init --mode remote
```

That's it — the CLI walks through the public URL, Obsidian Sync token (it can run the token generator for you), and auth config, then starts the server.

<details>
<summary><strong>Manual setup</strong> (no Node.js needed)</summary>

```bash
# On your VPS:
mkdir -p /opt/vault-cortex && cd /opt/vault-cortex
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/remote/docker-compose.yml
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/remote/.env.example
cp .env.example .env
# Edit .env — set MCP_AUTH_TOKEN, PUBLIC_URL, OBSIDIAN_AUTH_TOKEN, VAULT_NAME
docker compose up -d
```

</details>

**[Full remote guide →](./deploy/remote/)**

### Connect your MCP client

| Setup      | Server URL                  |
| ---------- | --------------------------- |
| **Local**  | `http://localhost:8000/mcp` |
| **Remote** | `<PUBLIC_URL>/mcp`          |

Add the server URL in any MCP client — Claude Code, Claude Desktop, Cursor, OpenCode, or any other. OAuth clients open a consent page in your browser — approve with your token, and the client handles token renewal from then on. Clients without OAuth (MCP Inspector, scripts) send the token directly as an `Authorization: Bearer` header.

**Claude Code:**

```bash
claude mcp add --scope user --transport http vault-cortex http://localhost:8000/mcp   # local (or <PUBLIC_URL>/mcp)
```

`--scope user` registers the server for every project; omit it to scope it to the current directory only.

**Claude Desktop:** the "Add custom connector" dialog only accepts `https` URLs. With an `https` PUBLIC_URL, add it directly in the connector dialog; for a localhost server, register it in `claude_desktop_config.json` through the [mcp-remote](https://github.com/geelen/mcp-remote) stdio bridge instead:

```json
{
  "mcpServers": {
    "vault-cortex": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:8000/mcp",
        "--header",
        "Authorization: Bearer <your MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

**claude.ai (web and mobile)** connects to the remote setup only — its connectors are fetched server-side and can never reach localhost.

> "Remote MCP server" refers to the connection type (HTTP) — in the local setup the server still runs entirely on your machine.

See [Authentication](#authentication) for both methods and token lifetimes.

## Tools (25)

| Category        | Tool                         | Description                                                |
| --------------- | ---------------------------- | ---------------------------------------------------------- |
| **Vault CRUD**  | `vault_read_note`            | Read a note — full body, properties, outline, or a section |
|                 | `vault_write_note`           | Create or overwrite a note with properties                 |
|                 | `vault_patch_note`           | Heading-targeted edit (append, prepend, replace, insert)   |
|                 | `vault_replace_in_note`      | Find-and-replace text in a note                            |
|                 | `vault_delete_span`          | Delete a block of lines by short anchors, no full re-quote |
|                 | `vault_list_notes`           | List notes with optional glob/folder filter                |
|                 | `vault_delete_note`          | Delete a note (protected paths enforced)                   |
|                 | `vault_move_note`            | Move or rename a note, rewriting links across the vault    |
| **Search**      | `vault_search`               | Full-text search with tag/folder/property filters          |
|                 | `vault_search_by_tag`        | Find notes by tag (exact or prefix match)                  |
|                 | `vault_search_by_folder`     | Browse notes in a folder with metadata                     |
|                 | `vault_recent_notes`         | Recently modified or created notes                         |
|                 | `vault_list_tags`            | All tags with usage counts                                 |
| **Memory**      | `vault_get_memory`           | Read structured memory (file, section, or all)             |
|                 | `vault_update_memory`        | Append a dated entry to a memory section                   |
|                 | `vault_delete_memory`        | Remove a specific memory entry by date                     |
|                 | `vault_list_memory_files`    | Discover memory files and their sections                   |
| **Properties**  | `vault_list_property_keys`   | All property keys with sample values                       |
|                 | `vault_list_property_values` | Distinct values for a property key                         |
|                 | `vault_search_by_property`   | Find notes by property key-value                           |
|                 | `vault_update_properties`    | Add or update properties without touching the body         |
| **Links**       | `vault_get_backlinks`        | Notes linking to a given path                              |
|                 | `vault_get_outgoing_links`   | Links from a given note                                    |
|                 | `vault_find_orphans`         | Notes with no incoming links                               |
| **Daily Notes** | `vault_get_daily_note`       | Today's (or any date's) daily note                         |

## Prompts (3)

Tools are model-driven — the assistant calls them. **Prompts** are workflows _you_ trigger. Each one queries the search index, link graph, and memory layer at invocation time, then assembles the results with guided instructions — so the session starts grounded in your vault's actual state, not assumptions.

| Prompt              | Arguments             | What it does                                                                                                                                                                                                           |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault-orientation` | —                     | Surveys vault stats, folder distribution, property adoption rates (flags low adoption), orphans, broken link count, tags, recent notes, and the memory layer — with contextual tool suggestions                        |
| `memory-review`     | `file?`, `max_chars?` | Structural overview (scope callouts, section entry counts) + dated content as a timeline. Guided reflection: evolution narrative, scope-fit, backfill gaps, and coverage analysis. Hidden when `MEMORY_ENABLED=false`. |
| `daily-review`      | `date?`, `max_chars?` | Reviews a day's daily note with outgoing links (broken-link detection), backlinks, and date-specific activity — guides reconciliation, link following, and pattern recognition                                         |

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

**All other properties** are still fully queryable — use `vault_search` with `filters.properties` for combined text + metadata queries, or `vault_search_by_property` for metadata-only lookups. `vault_list_property_keys` and `vault_list_property_values` discover what properties exist across your vault.

These are conventions, not requirements — Vault Cortex works with any property schema. Promoted properties just give you richer filtering and cleaner results out of the box.

**Leading callouts** get the same treatment. When a note's first body content is an Obsidian [callout](https://help.obsidian.md/Editing+and+formatting/Callouts) (`> [!type]`) — either right after frontmatter or right after the title heading — it's indexed and surfaced alongside every search and discovery result. This makes notes self-describing: an agent scanning results can see what each note is _for_ before deciding which to read. The memory templates use `> [!info] Scope of this file` callouts for this, and any note in your vault can use the same pattern.

## Configuration

All settings are environment variables with sensible defaults.

| Variable                    | Required?   | Default                              | Description                                                                                                                                                                                                                       |
| --------------------------- | ----------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`            | Yes         | —                                    | Bearer token for authentication (also the JWT signing key)                                                                                                                                                                        |
| `VAULT_PATH`                | Local only  | —                                    | Host path to your vault (bind mount source; remote uses a named volume)                                                                                                                                                           |
| `PUBLIC_URL`                | Remote only | —                                    | Public URL for OAuth discovery metadata                                                                                                                                                                                           |
| `MEMORY_ENABLED`            | —           | `true`                               | Set `false` to fully disable the memory layer — hides memory tools, skips bootstrap, omits memory from server metadata. `MEMORY_DIR` is ignored when `false`.                                                                     |
| `MEMORY_DIR`                | —           | `About Me`                           | Vault folder for structured memory files                                                                                                                                                                                          |
| `PROTECTED_PATHS`           | —           | `MEMORY_DIR, Daily Notes`            | Folders that `vault_delete_note` refuses to touch                                                                                                                                                                                 |
| `ORPHAN_EXCLUDE_FOLDERS`    | —           | `Daily Notes, Templates, MEMORY_DIR` | Folders excluded from orphan detection                                                                                                                                                                                            |
| `TZ`                        | —           | `UTC`                                | IANA timezone for timestamps and daily note resolution                                                                                                                                                                            |
| `SERVICE_DOCUMENTATION_URL` | —           | GitHub repo URL                      | URL returned in OAuth discovery metadata                                                                                                                                                                                          |
| `LOG_LEVEL`                 | —           | `info`                               | Logging verbosity: `debug`, `info`, `warn`, `error`                                                                                                                                                                               |
| `LOG_DIR`                   | —           | `/data/logs` (Docker)                | Directory for persistent log files. Logs survive container restarts.                                                                                                                                                              |
| `LOG_RETENTION_DAYS`        | —           | `30`                                 | Days to keep log files before automatic cleanup on startup                                                                                                                                                                        |
| `WINDOWS_MODE`              | —           | `false`                              | On Windows? Set `true`. Switches the file watcher to polling and note moves to rename-based writes so a vault on a `C:` drive works through Docker Desktop. Safe to leave on for any Windows setup; unneeded on macOS/Linux/WSL2. |

**Smart defaults:** Setting `MEMORY_DIR` automatically updates the defaults for `PROTECTED_PATHS` and `ORPHAN_EXCLUDE_FOLDERS`. You only set those explicitly for a fully custom list. When `MEMORY_ENABLED` is `false`, the memory layer is fully disabled — memory tools are hidden and the memory folder is not auto-created.

See [`templates/memory/`](./templates/memory/) for memory file examples and the dated-entry design philosophy.

## Authentication

For a server with read/write access to personal notes, authentication is not optional. Vault Cortex implements the full OAuth 2.1 specification, including PKCE and refresh-token rotation. The [AWS (SST) deployment](#deployment-options) adds defense-in-depth: requests are validated at two independent layers (API Gateway Lambda authorizer + Express middleware). Per [BlueRock's 2026 MCP security analysis](https://www.bluerock.io/use-cases/safely-adopt-mcp), only 8.5% of MCP servers implement OAuth; 41% have no authentication at all.

Two methods:

| Method            | Used by                                                  | Token format         |
| ----------------- | -------------------------------------------------------- | -------------------- |
| **OAuth 2.1**     | Claude Desktop, Claude Code, claude.ai, any OAuth client | JWT (HS256, 24h)     |
| **Static bearer** | Claude Code, MCP Inspector, curl                         | Raw `MCP_AUTH_TOKEN` |

OAuth uses dynamic client registration — no Client ID/Secret needed. A consent page opens in your browser; enter your `MCP_AUTH_TOKEN` to approve. Refresh tokens have a 60-day sliding expiry (daily users never re-authenticate).

See [ARCHITECTURE.md → Auth](./ARCHITECTURE.md#auth-oauth-21--defense-in-depth) for the full flow diagram.

## How It Works

```mermaid
graph LR
    Client["MCP Client"] -->|OAuth 2.1 / Bearer| Server["vault-mcp"]
    Server -->|read/write| Vault[("/vault<br/>.md files")]
    Server -->|query| SQLite[("SQLite FTS5")]
    Sync["obsidian-sync"] <-->|Obsidian Sync| Vault
```

The vault `.md` files are the source of truth. SQLite FTS5 is rebuildable derived state — the index is built on startup and kept current by a file watcher. `obsidian-sync` keeps the vault in sync with your Obsidian apps (remote deployments only).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design, auth flow diagrams, and Phase 1/2 boundaries.

## Deployment Options

| Path          | What                                               | Guide                                |
| ------------- | -------------------------------------------------- | ------------------------------------ |
| **Local**     | Docker on your machine, vault bind-mounted         | [`deploy/local/`](./deploy/local/)   |
| **Remote**    | VPS + Obsidian Sync, access from anywhere          | [`deploy/remote/`](./deploy/remote/) |
| **AWS (SST)** | Full IaC: Lightsail + API Gateway + Lambda + CI/CD | [`DEPLOY.md`](./DEPLOY.md)           |

## Development

```bash
# Run locally with hot reload
PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/Vault npm run dev:mcp

# Tests
npm test

# Full check suite
npm run prettier:check && npm run lint && npm test && npm run build
```

**MCP Inspector** — interactive browser UI for testing tools:

```bash
# Start server (terminal 1), then:
npx @modelcontextprotocol/inspector
# Enter http://localhost:8000/mcp as URL, local-dev-token as Bearer token
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development setup.

## Companion: obsidian-vault skill

The MCP server works on its own with any client. For agents that support [skills](https://github.com/vercel-labs/skills) (Claude Code, Cursor, Windsurf, Cline, and [70+ others](https://github.com/vercel-labs/skills#supported-agents)), the **obsidian-vault** skill adds deeper knowledge of Obsidian-flavored markdown — frontmatter conventions, callout syntax, and plugin-specific formats like Dataview, Tasks, and Kanban.

```bash
npx skills add aliasunder/agent-skills --skill obsidian-vault
```

[Skill source →](https://github.com/aliasunder/agent-skills/tree/main/skills/obsidian-vault)

## Acknowledgments

Vault Cortex's remote capability exists because of [@Belphemur](https://github.com/Belphemur)'s [obsidian-headless-sync-docker](https://github.com/Belphemur/obsidian-headless-sync-docker) — a [headless Obsidian Sync](https://obsidian.md/help/sync/headless) client that runs in Docker without a display server. It's the piece that makes "access your vault from anywhere" possible. The remote stack runs a small [fork](https://github.com/aliasunder/obsidian-headless-sync-docker) that adds a build-time config `chown` and `--device-name` on the initial Sync registration ([upstream PR #8](https://github.com/Belphemur/obsidian-headless-sync-docker/pull/8) remains open).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, code conventions, and PR guidelines.

## License

[MIT](./LICENSE)

## Security

Report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).

# vault-cortex (CLI)

Set up a [Vault Cortex](https://github.com/aliasunder/vault-cortex) MCP server
for your Obsidian vault in one command:

```bash
npx vault-cortex@latest init
```

Vault Cortex is a plugin-free, remote-capable MCP server for Obsidian vaults —
23 tools for search (SQLite FTS5), notes, frontmatter, links, daily notes, and
a persistent memory layer. It runs as a Docker container; this CLI scaffolds
the config so you don't have to.

## What `init` does

1. Asks how you want to run it:
   - **Local** — Docker on this machine, your vault folder bind-mounted
   - **Remote** — a VPS with [Obsidian Sync](https://obsidian.md/sync), reachable from any device
2. Generates a `docker-compose.yml` and `.env` (with a fresh `MCP_AUTH_TOKEN` —
   no `openssl` incantations needed)
3. Optionally runs `docker compose up -d` and waits for the health check
4. Prints the MCP URL + token to plug into Claude Desktop, Claude Code, or any
   MCP client

Existing files are never overwritten without asking.

## Non-interactive

```bash
npx vault-cortex@latest init --yes --vault-path /path/to/YourVault
```

Flags: `--mode local|remote`, `--vault-path <path>`, `--dir <path>` (default
`./vault-cortex`), `--yes`.

## Requirements

- Node.js >= 20.12 (only for this CLI — the server itself runs in Docker)
- [Docker](https://docs.docker.com/get-docker/) to run the server

## Docs

- [Local quickstart](https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/README.md)
- [Remote quickstart (VPS + Obsidian Sync)](https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md)
- [Full project README](https://github.com/aliasunder/vault-cortex)

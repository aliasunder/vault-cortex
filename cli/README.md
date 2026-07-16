# vault-cortex (CLI)

Set up a [Vault Cortex](https://github.com/aliasunder/vault-cortex) MCP server
for your Obsidian vault in one command:

```bash
npx vault-cortex@latest init
```

Vault Cortex is a standalone, remote-capable MCP server for Obsidian vaults —
Tools for hybrid search (FTS5 + vector + cross-encoder reranking, with
tag/folder/property/date filters), notes, frontmatter, links, daily notes,
Kanban-aware task management (query + complete/move/reprioritize, parsing Tasks-plugin emoji + Dataview inline-field formats), and
a structured memory layer with topic recall (the current take plus the
dated history behind it), plus guided prompts (orientation, memory
review, daily review). It runs as a Docker
container; this CLI scaffolds the config so you don't have to.

## What `init` does

1. Asks how you want to run it:
   - **Local** — Docker on this machine, your vault folder bind-mounted
   - **Remote** — a VPS with [Obsidian Sync](https://obsidian.md/sync), reachable from any device
2. Generates a `.env` file with a securely generated `MCP_AUTH_TOKEN`
3. Optionally starts the container and waits for the health check
4. Prints your connection details — the MCP URL, your auth token, and how to
   connect your client

Existing files are never overwritten without asking.

## Get Sync Token

Generate an Obsidian Sync auth token without leaving the CLI:

```bash
npx vault-cortex get-sync-token
```

The command opens the Obsidian login inside Docker. Once you've signed
in, it picks up your token and prints it — nothing to dig out of the
login output. Use `--dir` to write the token straight into an existing
`.env` instead:

```bash
npx vault-cortex get-sync-token --dir ./vault-cortex
```

During `init --mode remote`, this flow is offered automatically when Docker
is available.

## Upgrade

Pull the latest image, re-create the container, and verify health:

```bash
npx vault-cortex upgrade
```

Run it from the same directory where you ran `init` — it looks for your
config in `./vault-cortex/.env` (pass `--dir <path>` if you scaffolded
somewhere else).

Your vault data, search index, and `.env` settings are preserved across
upgrades — only the server image is replaced. Also applies `.env` changes
(`docker restart` does not re-read env files).

Prefer Docker Compose? The CLI uses `docker run` for simplicity, but the
[deploy guides](https://github.com/aliasunder/vault-cortex/blob/main/deploy/)
include Compose files you can use directly.

## Non-interactive

```bash
npx vault-cortex@latest init --yes --vault-path /path/to/YourVault
```

Flags: `--mode local|remote`, `--vault-path <path>`, `--dir <path>` (default
`./vault-cortex`), `--yes`.

## Requirements

- Node.js >= 20.12 (only for this CLI — the server itself runs in Docker)
- [Docker](https://docs.docker.com/get-docker/) (or any OCI-compatible runtime) to run the server

## Docs

- [Local quickstart](https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/README.md)
- [Remote quickstart (VPS + Obsidian Sync)](https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md)
- [Full project README](https://github.com/aliasunder/vault-cortex)

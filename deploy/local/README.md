# Local Quickstart

Run Vault Cortex on your machine against a local Obsidian vault. No cloud, no
Obsidian Sync — just Docker and a folder of `.md` files.

> **Fastest path:** `npx vault-cortex@latest init` does all of the below
> interactively — generates the token and config files, starts the server, and
> prints the connection details. The steps below are the manual equivalent.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20.10+)
- An Obsidian vault (or any folder of Markdown files)

## Setup

**1. Get the files.** Download this directory, or clone the repo and `cd deploy/local`.

**2. Create your `.env` file:**

```bash
cp .env.example .env
```

**3. Fill in the two required values:**

| Variable         | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| `MCP_AUTH_TOKEN` | Generate with `openssl rand -hex 32`                              |
| `VAULT_PATH`     | Absolute path to your vault (e.g. `/Users/you/Documents/MyVault`) |

**4. Start the server:**

```bash
docker compose up
```

Add `-d` to run in the background. First start pulls the image (~150MB) and
builds the search index — this takes a few seconds depending on vault size.

## Connect your MCP client

The server listens at `http://localhost:8000/mcp`.

**OAuth clients (Claude Desktop, Claude Code, and most MCP clients):**

1. Add `http://localhost:8000/mcp` as a remote MCP server, leaving OAuth
   Client ID and Secret empty.
2. A consent page opens in your browser — approve with your `MCP_AUTH_TOKEN`.
3. Done. The client receives auto-refreshing access tokens, so the token
   itself never sits in client config.

- "Remote" refers to the connection type (HTTP, as opposed to a stdio process
  the client launches itself) — this server still runs entirely on your
  machine.
- Claude Mobile and claude.ai web can't reach localhost — use the
  [remote quickstart](../remote/) for access from other devices.

**Bearer token (MCP Inspector, scripts, clients without OAuth):** Enter
`http://localhost:8000/mcp` as the server URL and your token as the Bearer
token.

**curl:**

```bash
curl -H "Authorization: Bearer <your-token>" http://localhost:8000/mcp
```

## Verify

```bash
# Health check (no auth required):
curl http://localhost:8000/healthz
# → {"ok":true}

# OAuth discovery (no auth required):
curl http://localhost:8000/.well-known/oauth-protected-resource
```

## Stop

```bash
# Stop the server (search index is preserved in a Docker volume):
docker compose down

# Stop and delete all data (index rebuilds on next start):
docker compose down -v
```

## Memory

On first startup, if your vault doesn't already have a memory folder (default:
`About Me/`), the server creates one with template files (Principles.md,
Opinions.md). Agents can also create new memory files and sections on the fly
via `vault_update_memory` — no manual setup needed.

## Configuration

Only `MCP_AUTH_TOKEN` and `VAULT_PATH` are required. For optional settings
(memory folder, protected paths, orphan exclusions, timezone), see the
[Configuration](../../README.md#configuration) section in the main README.

## Building from source

If you want to modify vault-cortex and build from source, clone the repo and
use `docker-compose.local.yml` in the repo root instead. See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the full development setup.

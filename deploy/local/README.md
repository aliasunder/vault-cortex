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

> **On Windows?** Set `WINDOWS_MODE=true` in your `.env` — then `VAULT_PATH` can point
> at a normal Windows path like `C:\Users\you\MyVault`. See
> [Windows (Docker Desktop)](#windows-docker-desktop) below.

**4. Start the server:**

```bash
docker compose up
```

Add `-d` to run in the background. First start pulls the image (~150MB) and
builds the keyword index in seconds; the semantic (embedding) index builds in
the background — expect a few minutes on a large vault, with search served
keyword-only until it finishes.

## Connect your MCP client

The server listens at `http://localhost:8000/mcp`.

**Claude Code:**

1. Run `claude mcp add --scope user --transport http vault-cortex http://localhost:8000/mcp`
   (`--scope user` registers it for every project; drop it to scope the server
   to the current directory only)
2. Approve the consent page in your browser with your `MCP_AUTH_TOKEN`.
3. Done. The client receives auto-refreshing access tokens, so the token
   itself never sits in client config.

**Claude Desktop:** the "Add custom connector" dialog only accepts `https`
URLs, so a localhost server can't be added there. Register it in
`claude_desktop_config.json` (Settings → Developer → Edit Config) through the
[mcp-remote](https://github.com/geelen/mcp-remote) stdio bridge instead:

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

On Windows, spaces inside `args` can be mangled — move the header value into
an env var instead: `"--header", "Authorization:${AUTH_HEADER}"` with
`"env": { "AUTH_HEADER": "Bearer <your MCP_AUTH_TOKEN>" }`.

**Other OAuth clients (Cursor and most MCP clients):**

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

## Updating

Compose does **not** pull new images on `up` — once `:latest` is on your
machine, you stay on that exact image until you pull explicitly:

```bash
# Pull the latest image and recreate the container:
docker compose pull && docker compose up -d
```

Your search index persists in its Docker volume across updates; unchanged
notes are not re-embedded (content-hash cache), so restarts after an update
are fast.

## Stop

```bash
# Stop the server (search index is preserved in a Docker volume):
docker compose down

# Stop and delete all data (index rebuilds on next start):
docker compose down -v
```

## Troubleshooting

**`invalid_client` / "Invalid client_id" when connecting.** Your MCP client
cached an OAuth registration from a previous server at this address. Recreating
the server (`docker compose down -v`, or scaffolding a fresh instance) resets
`oauth.db`, so the cached `client_id` no longer exists and `/authorize` rejects
it. Clear the client's stored authorization for this server and reconnect so it
registers fresh:

- **Claude Code:** `claude mcp remove <name>`, then
  `claude mcp add --scope user --transport http <name> http://localhost:8000/mcp`.
- **Claude Desktop / mcp-remote:** delete `~/.mcp-auth` and restart the client.
- **Other clients:** remove and re-add the server.

**"Invalid token" on the consent page even with the correct token.** The
consent form trims surrounding whitespace and line breaks from the token before
checking it, so a value copied out of a terminal (where a long token can wrap
across lines) still works. If you still see this error, double-check you copied
the full `MCP_AUTH_TOKEN` from your `.env` — a missing or extra character is the
usual cause.

## Windows (Docker Desktop)

vault-cortex runs in a Linux container, so on Windows it reaches your vault through
Docker Desktop's WSL2 bridge. Two things need a non-default code path across that
bridge: live re-indexing (the file watcher's native filesystem events don't cross it)
and `vault_move_note` (its atomic hard-link write isn't supported there). **Setting
`WINDOWS_MODE=true` handles both** — the watcher switches to polling and moves use a
rename-based write — so a vault on a `C:\` drive works out of the box:

```bash
# in .env
VAULT_PATH=C:\Users\you\MyVault
WINDOWS_MODE=true
```

`WINDOWS_MODE` is safe to leave on for any Windows setup; reading, writing, and search
work with or without it — it only changes how re-indexing and moves are done.

**For best performance**, keep the vault inside the WSL2 filesystem (ext4) instead —
native filesystem events are lighter than polling, and you can leave `WINDOWS_MODE`
off:

```bash
# inside WSL (e.g. Ubuntu) — vault lives on ext4
mkdir -p ~/vaults/MyVault
# then in .env:  VAULT_PATH=/home/you/vaults/MyVault
```

You can still open and edit a WSL-hosted vault in Obsidian on Windows — it shows up in
File Explorer at `\\wsl$\Ubuntu\home\you\vaults\MyVault`.

## Memory

On first startup, if your vault doesn't already have a memory folder (default:
`About Me/`), the server creates one with template files (Me.md, Opinions.md,
Principles.md, Routines.md, Agents.md). Agents can also create new memory files
and sections on the fly via `vault_update_memory` — no manual setup needed.
Once entries accumulate, `vault_memory_recall` answers topic questions across
the layer's full dated history. Memory files are append-only by default; a file can declare
`entry-policy: living` in frontmatter for current-state content whose expired
entries get pruned (the Routines template ships this way) — see
[templates/memory](../../templates/memory/README.md) for the full convention.

## Configuration

Only `MCP_AUTH_TOKEN` and `VAULT_PATH` are required. For optional settings
(memory folder, protected paths, orphan exclusions, timezone), see the
[Configuration](../../README.md#configuration) section in the main README.

## Building from source

If you want to modify vault-cortex and build from source, clone the repo and
use `docker-compose.local.yml` in the repo root instead. See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the full development setup.

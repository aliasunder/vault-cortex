# Installing vault-cortex (for AI assistants)

These are step-by-step instructions for an AI assistant (e.g. Cline) to install
and configure **vault-cortex** for the user. vault-cortex is a remote MCP server
that runs in **Docker** and is reached over **HTTP** — it is not an `npx`/`uvx`
stdio command server, so "installing" it means starting the container and
registering its URL (plus a bearer token) with the MCP client.

This file covers the **local** setup (one Docker container, your vault folder
bind-mounted). For remote/VPS access with Obsidian Sync and OAuth, point the
user at [`deploy/remote/`](./deploy/remote/) instead.

## Prerequisites

- **Docker** with Compose v2 (`docker compose`, v20.10+). If `docker` is not
  installed, stop and ask the user to install Docker Desktop / Docker Engine.
- An **Obsidian vault** — any folder of `.md` files works. You need its
  **absolute path** on this machine.

## Step 1 — Collect the two required values

Ask the user for, or determine:

1. **`VAULT_PATH`** — the absolute path to their Obsidian vault folder
   (e.g. `/Users/alex/Documents/MyVault`). Do not guess; confirm it exists.
2. **`MCP_AUTH_TOKEN`** — a bearer token. Generate one:

   ```bash
   openssl rand -hex 32
   ```

   Save the output — the user needs it again in Step 4. Treat it as a secret;
   do not echo it into shared logs.

## Step 2 — Fetch the quickstart files and start the container

Run these in an empty working directory the user is comfortable with:

```bash
# 1. Get the local quickstart compose file + env template
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/local/docker-compose.yml
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/local/.env.example

# 2. Create the .env file
cp .env.example .env
```

Now edit `.env` and set the two required values from Step 1:

```dotenv
MCP_AUTH_TOKEN=<the token you generated>
VAULT_PATH=<absolute path to the user's vault>
```

Then start the server:

```bash
# -d runs it in the background; first start pulls the image (~150MB)
# and builds the search index (a few seconds, depending on vault size)
docker compose up -d
```

The image is `ghcr.io/aliasunder/vault-mcp:latest` and is public — no registry
login is needed.

## Step 3 — Verify it's running

```bash
# Health check (no auth required) — expect {"ok":true}
curl http://localhost:8000/healthz
```

If this does not return `{"ok":true}`, check `docker compose logs vault-mcp`.
Common causes: `VAULT_PATH` doesn't exist or isn't absolute; `MCP_AUTH_TOKEN`
is empty in `.env`; port `8000` is already in use (set `PORT` in `.env` to
change the host port).

## Step 4 — Register the server with the MCP client

The server listens at `http://localhost:8000/mcp` and authenticates with the
`MCP_AUTH_TOKEN` as a bearer token.

**For Cline** — add this to the `mcpServers` object in
`cline_mcp_settings.json` (replace `<the token>` with the value from Step 1):

```json
{
  "mcpServers": {
    "vault-cortex": {
      "type": "streamableHttp",
      "url": "http://localhost:8000/mcp",
      "headers": {
        "Authorization": "Bearer <the token>"
      },
      "disabled": false
    }
  }
}
```

After saving, Cline should connect and discover **23 tools** (vault read/write,
search, memory, link graph, daily notes). If the client only supports stdio MCP
servers, bridge with `mcp-remote`:

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
        "Authorization: Bearer <the token>"
      ]
    }
  }
}
```

## What you get

23 tools across vault CRUD, full-text search (SQLite FTS5), structured memory
(`About Me/` files), link graph (backlinks / outgoing links / orphans), and
daily-note resolution. On first start, if the vault has no memory folder, the
server seeds one (`About Me/`) with template files.

## Managing the server

```bash
docker compose down      # stop (search index preserved in a Docker volume)
docker compose down -v   # stop and delete the index (rebuilds on next start)
docker compose pull && docker compose up -d   # update to the latest image
```

## More

- Full configuration (memory folder, protected paths, timezone, logging):
  [README → Configuration](./README.md#configuration)
- Remote / multi-device setup (Obsidian Sync + OAuth 2.1):
  [`deploy/remote/`](./deploy/remote/)
- Architecture and auth flow: [ARCHITECTURE.md](./ARCHITECTURE.md)

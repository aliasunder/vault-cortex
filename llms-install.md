# Installing Vault Cortex (for AI assistants)

Step-by-step instructions for an AI assistant (e.g. Cline) to install and
configure **Vault Cortex**. It is a **Docker** container reached over **HTTP** —
_not_ an `npx`/`uvx` stdio server — so "installing" means: start the container,
then register its URL + a bearer token with the MCP client.

This covers the **local** setup (one container, your vault bind-mounted). For
remote/VPS access (Obsidian Sync + OAuth 2.1), see [`deploy/remote/`](./deploy/remote/).

> [!IMPORTANT]
> **Read this before you debug authentication.** The token is a **raw secret
> string, not a JWT.** Authenticate by sending `Authorization: Bearer <MCP_AUTH_TOKEN>`
> using the exact value from `.env`. A `401` does **not** mean you need to build a
> JWT or start an OAuth flow — it means the token you sent doesn't match the
> container's `MCP_AUTH_TOKEN`, or the running image is stale. The server also
> exposes OAuth discovery endpoints; **ignore them for this local setup** and use
> the static bearer header. See [Troubleshooting](#troubleshooting).

## Prerequisites

- **Docker** with Compose v2 (`docker compose`, v20.10+). If `docker` isn't installed, stop and ask the user to install Docker Desktop / Docker Engine.
- An **Obsidian vault** — any folder of `.md` files. You need its **absolute path** on this machine.

## Step 1 — Collect the two required values

1. **`VAULT_PATH`** — the absolute path to the vault (e.g. `/Users/alex/Documents/MyVault`). Confirm it exists; don't guess.
2. **`MCP_AUTH_TOKEN`** — generate **one** token and reuse it everywhere:

   ```bash
   openssl rand -hex 32
   ```

   Keep this exact string — the **same** value goes in `.env` (Step 2) _and_ in the client config (Step 4). It's a secret; don't echo it into shared logs.

## Step 2 — Start the container

Work in a dedicated directory so the stack is easy to find and manage later (all the commands below must run from the same directory):

```bash
mkdir -p vault-cortex-mcp && cd vault-cortex-mcp

# Quickstart compose file + env template
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/local/docker-compose.yml
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/local/.env.example
cp .env.example .env
```

Edit `.env` and set both required values **before** starting — the container reads `.env` only at boot:

```dotenv
MCP_AUTH_TOKEN=<paste the exact token from Step 1 — no quotes, no surrounding spaces>
VAULT_PATH=<absolute path to the vault>
```

Pull the current image, then start:

```bash
docker compose pull        # always pull — a stale cached :latest silently runs old code
docker compose up -d
```

The image `ghcr.io/aliasunder/vault-cortex:latest` is public (no login needed) and multi-arch (amd64 + arm64), so it runs natively on Apple Silicon.

> [!NOTE]
> If you change `MCP_AUTH_TOKEN` (or any `.env` value) **after** the container is
> already running, a plain restart keeps the old value — you must recreate it:
>
> ```bash
> docker compose up -d --force-recreate
> ```

## Step 3 — Verify it's running

```bash
curl http://localhost:8000/healthz                                     # expect {"ok":true}
docker exec vault-cortex node -p "require('/app/package.json').version"   # note the running version
```

If healthz doesn't return `{"ok":true}`, run `docker compose logs vault-cortex`. Common causes: `VAULT_PATH` missing or not absolute; `MCP_AUTH_TOKEN` empty in `.env`; port `8000` already in use (set `PORT` in `.env`).

## Step 4 — Register the server with the client

The server is at `http://localhost:8000/mcp`, authenticated by the **raw** `MCP_AUTH_TOKEN` as a bearer token.

**For Cline** — add this to the `mcpServers` object in `cline_mcp_settings.json`. Use the **exact same token string that's in your `.env`** (the value generated in Step 1 — not a placeholder, not a freshly generated one):

```json
{
  "mcpServers": {
    "vault-cortex": {
      "type": "streamableHttp",
      "url": "http://localhost:8000/mcp",
      "headers": {
        "Authorization": "Bearer PASTE_THE_SAME_TOKEN_THAT_IS_IN_ENV"
      },
      "disabled": false
    }
  }
}
```

Save, then confirm the connection by calling a read-only tool such as `vault_list_memory_files`. A healthy install discovers tools across five categories (vault CRUD, search, tasks, memory, and daily notes) and guided prompts (`vault-orientation`, `memory-review`, `daily-review`).

If the client only speaks stdio, bridge with `mcp-remote` (same token):

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
        "Authorization: Bearer PASTE_THE_SAME_TOKEN_THAT_IS_IN_ENV"
      ]
    }
  }
}
```

This same `mcp-remote` config is also the way to register a localhost server
with **Claude Desktop** (`claude_desktop_config.json`) — its "Add custom
connector" dialog only accepts `https` URLs, so the stdio bridge is required
for localhost.

## Troubleshooting

- **`401`, or the client reports the token "has no expiration time" / "needs a JWT."**
  Do **not** build a JWT or switch to OAuth — the raw token is the correct format. The cause is one of:
  1. **Token mismatch** — the token in the client config isn't byte-for-byte equal to the one the container booted with. Compare them literally (watch for quotes/trailing whitespace in `.env`). Check what the container actually has:
     ```bash
     docker exec vault-cortex printenv MCP_AUTH_TOKEN
     ```
     If it differs from `.env`, you edited `.env` after starting — recreate: `docker compose up -d --force-recreate`.
  2. **Stale image** — you're running a build from before the static-token fix (v0.15.5). Refresh and recreate, then confirm the version:
     ```bash
     docker compose pull && docker compose up -d --force-recreate
     docker exec vault-cortex node -p "require('/app/package.json').version"   # must be >= 0.15.5
     ```
- **`no matching manifest for linux/arm64/v8` (Apple Silicon).** You have an old single-arch image cached locally. Pull the current multi-arch `:latest`:
  ```bash
  docker compose pull && docker compose up -d --force-recreate
  ```
  If it persists, remove the stale image first: `docker rmi ghcr.io/aliasunder/vault-cortex:latest`, then pull again.
- **healthz fails.** See the causes listed in Step 3.

## Managing the server

```bash
docker compose down            # stop (search index preserved in a Docker volume)
docker compose down -v         # stop and delete the index (rebuilds on next start)
docker compose pull && docker compose up -d --force-recreate   # update to the latest image
```

## More

- Full configuration (memory folder, protected paths, timezone, logging): [README → Configuration](./README.md#configuration)
- Remote / multi-device setup (Obsidian Sync + OAuth 2.1): [`deploy/remote/`](./deploy/remote/)
- Architecture and auth flow: [ARCHITECTURE.md](./ARCHITECTURE.md)

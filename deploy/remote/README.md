# Remote Quickstart (Obsidian Sync)

Run vault-cortex on a VPS with Obsidian Sync for remote access from any device.
Your vault stays in sync; MCP tools work from Claude Desktop, Claude Code,
claude.ai, or any MCP client — anywhere.

## Prerequisites

- A VPS or cloud server with [Docker](https://docs.docker.com/engine/install/)
  installed (Ubuntu/Debian: `curl -fsSL https://get.docker.com | sh`)
- An [Obsidian Sync](https://obsidian.md/sync) subscription
- A domain name or public IP address for your server

## Setup

**1. SSH into your server** and create a working directory:

```bash
mkdir -p /opt/vault-cortex && cd /opt/vault-cortex
```

**2. Download the quickstart files:**

```bash
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/remote/docker-compose.yml
curl -O https://raw.githubusercontent.com/aliasunder/vault-cortex/main/deploy/remote/.env.example
```

Or clone the repo and `cd deploy/remote`.

**3. Generate your Obsidian Sync auth token** (one-time):

```bash
docker run --rm -it --entrypoint get-token \
  ghcr.io/belphemur/obsidian-headless-sync-docker:latest
```

**4. Create your `.env` file:**

```bash
cp .env.example .env
```

**5. Fill in the required values:**

| Variable              | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| `MCP_AUTH_TOKEN`      | Generate with `openssl rand -hex 32`                               |
| `PUBLIC_URL`          | Your server's public URL (see [HTTPS access](#https-access) below) |
| `OBSIDIAN_AUTH_TOKEN` | Output from step 3                                                 |
| `VAULT_NAME`          | Your exact Obsidian vault name (case-sensitive)                    |

**6. Start the server:**

```bash
docker compose up -d
```

First start pulls images and syncs your vault from Obsidian's servers. The
initial sync takes 30–120 seconds depending on vault size. vault-mcp builds its
search index as files arrive.

## HTTPS access

MCP clients need to reach your server over the network. Three options:

### Reverse proxy (recommended)

Use [Caddy](https://caddyserver.com/) or nginx with a domain and TLS
certificate. Set `PUBLIC_URL` to `https://vault.yourdomain.com`. Caddy handles
TLS automatically:

```
vault.yourdomain.com {
    reverse_proxy localhost:8000
}
```

### Cloudflare Tunnel

Zero-config HTTPS with no open ports. Install
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)
and create a tunnel pointing to `http://localhost:8000`. Set `PUBLIC_URL` to the
tunnel URL.

### Direct access (testing only)

Access the server directly at `http://<your-ip>:8000`. No TLS — suitable for
testing on a private network, not for production. Set `PUBLIC_URL` to
`http://<your-ip>:8000`.

> **Note:** `PUBLIC_URL` must match exactly how MCP clients reach the server.
> OAuth discovery metadata uses this URL, so a mismatch causes authentication
> failures.

## Connect your MCP client

### OAuth (Claude Desktop, Claude Code, Claude Mobile, claude.ai)

Add a remote MCP server with URL `<PUBLIC_URL>/mcp`. Leave OAuth Client ID and
Secret empty — dynamic registration handles it. A consent page opens in your
browser; enter your `MCP_AUTH_TOKEN` to approve. The client receives a JWT
access token (24h) with automatic refresh (60-day sliding window).

### Static bearer token (CLI tools, curl)

```bash
curl -H "Authorization: Bearer <your-MCP_AUTH_TOKEN>" <PUBLIC_URL>/mcp
```

## Verify

```bash
# Health check (no auth):
curl http://localhost:8000/healthz
# → {"ok":true}

# Check obsidian-sync is downloading your vault:
docker logs obsidian-sync

# Check vault-mcp indexed your notes:
docker logs vault-mcp
```

## Monitoring

```bash
# Follow vault-mcp logs:
docker logs -f vault-mcp

# Follow obsidian-sync logs:
docker logs -f obsidian-sync

# Check container status:
docker compose ps
```

## Stop

```bash
# Stop containers — named volumes persist your vault data and search index:
docker compose down

# Stop and delete all volumes (vault re-syncs on next start; index rebuilds):
docker compose down -v
```

## Configuration

Only `MCP_AUTH_TOKEN`, `PUBLIC_URL`, `OBSIDIAN_AUTH_TOKEN`, and `VAULT_NAME` are
required. For optional settings (memory folder, protected paths, timezone), see
the [Configuration](../../README.md#configuration) section in the main README.

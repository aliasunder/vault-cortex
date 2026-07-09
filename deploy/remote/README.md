# Remote Quickstart (Obsidian Sync)

Run Vault Cortex on a VPS with Obsidian Sync for remote access from any device.
Your vault stays in sync; MCP tools work from Claude Desktop, Claude Code,
claude.ai, or any MCP client — anywhere.

Everything runs in **one container**: the `vault-cortex:remote` image bundles
the Obsidian Sync process and the MCP server under
[s6-overlay](https://github.com/just-containers/s6-overlay) supervision. Docker
Compose is used below for its restart policy and log rotation, but it's
optional — the same container runs with [plain `docker run`](#docker-run-no-compose),
Podman, or any OCI runtime.

> **Tip:** if your server has Node.js >= 20.12 installed,
> `npx vault-cortex@latest init --mode remote` walks through steps 2–6
> interactively. The manual steps below work on any box with Docker.

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
  ghcr.io/aliasunder/vault-cortex:remote
```

**4. Create your `.env` file:**

```bash
cp .env.example .env
```

**5. Fill in the required values:**

| Variable              | Value                                                                               |
| --------------------- | ----------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`      | Generate with `openssl rand -hex 32`                                                |
| `PUBLIC_URL`          | Your server's public base URL — no `/mcp` (see [HTTPS access](#https-access) below) |
| `OBSIDIAN_AUTH_TOKEN` | Output from step 3                                                                  |
| `VAULT_NAME`          | Your exact Obsidian vault name (case-sensitive)                                     |

**6. Start the server:**

```bash
docker compose up -d
```

First start pulls the image, logs in to Obsidian Sync, and syncs your vault
from Obsidian's servers. The initial sync takes 30–120 seconds depending on
vault size. The MCP server starts once sync is running and builds its search
index as files arrive.

### docker run (no Compose)

The same `.env` file works with any OCI runtime — swap `docker` for `podman`
or `nerdctl` as needed. One caveat: plain `docker run` doesn't apply the
compose file's fallback defaults, so first set two extra values in `.env`
(both are commented in `.env.example`): `DEVICE_NAME=vault-cortex` —
otherwise the initial Obsidian Sync device registers under a random
container-ID hostname — and `CONFLICT_STRATEGY=merge`, whose compose
default differs from the CLI's built-in default (`conflict`).

```bash
docker run -d --name vault-cortex \
  --env-file .env \
  -v vault_data:/vault \
  -v mcp_data:/data \
  -v obsidian_config:/home/obsidian/.config \
  -p 8000:8000 \
  --restart unless-stopped \
  ghcr.io/aliasunder/vault-cortex:remote
```

## HTTPS access

MCP clients need to reach your server over the network. Four options:

### API Gateway (AWS — no domain needed)

This is the approach Vault Cortex's own production deployment uses. AWS API
Gateway acts as a TLS-terminating reverse proxy in front of your server — no
domain, no certificate management. You get an HTTPS URL immediately:

```
https://<id>.execute-api.<region>.amazonaws.com
```

HTTP API pricing is $1.00 per million requests with a free tier of 1M
requests/month for 12 months — effectively free for personal use.

Create an HTTP API in API Gateway with a route that proxies to
`http://<your-server-ip>:8000/{proxy+}`. Set `PUBLIC_URL` to the API Gateway
URL. See the project's [full cloud deployment](../../DEPLOY.md) for the SST IaC
approach, which adds a Lambda authorizer for an extra auth layer.

> **Need a VPS?** Any provider works — [AWS Lightsail](https://aws.amazon.com/lightsail/),
> DigitalOcean, Hetzner, etc. A 2 GiB instance handles semantic search fine for
> a typical vault; 4 GiB adds headroom for concurrent search and larger vaults.
> Add $5/mo for [Obsidian Sync](https://obsidian.md/sync). For a fully automated
> AWS setup, Vault Cortex also includes an [SST IaC deployment](../../DEPLOY.md)
> that provisions Lightsail, API Gateway, and a Lambda authorizer in one command.

### Reverse proxy (requires a domain)

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

Claude's "Add custom connector" dialog (claude.ai and Claude Desktop) only
accepts `https` URLs, so with an `http` PUBLIC_URL connect via Claude Code
(`claude mcp add --transport http` — see below) or the
[mcp-remote](https://github.com/geelen/mcp-remote) stdio bridge with its
`--allow-http` flag.

> **Note:** `PUBLIC_URL` must match exactly how MCP clients reach the server.
> OAuth discovery metadata uses this URL, so a mismatch causes authentication
> failures.
>
> Use the **base origin only**, without `/mcp` — the server serves the endpoint
> at `/mcp` and the URLs below append it, so a `PUBLIC_URL` ending in `/mcp`
> becomes `…/mcp/mcp` and won't connect.

## Connect your MCP client

### OAuth (Claude Desktop, Claude Code, Claude Mobile, claude.ai)

Add a remote MCP server with URL `<PUBLIC_URL>/mcp`. Leave OAuth Client ID and
Secret empty — dynamic registration handles it. A consent page opens in your
browser; enter your `MCP_AUTH_TOKEN` to approve. The client receives a JWT
access token (24h) with automatic refresh (60-day sliding window).

Claude Code also accepts `http` URLs directly:

```bash
claude mcp add --scope user --transport http vault-cortex <PUBLIC_URL>/mcp
```

`--scope user` registers the server for every project; omit it to scope it to the current directory only.

### Static bearer token (CLI tools, curl)

```bash
curl -H "Authorization: Bearer <your-MCP_AUTH_TOKEN>" <PUBLIC_URL>/mcp
```

## Verify

```bash
# Health check (no auth):
curl http://localhost:8000/healthz
# → {"ok":true}

# One log stream for both processes — MCP server lines are structured
# JSON; init-chain lines carry an [obsidian-sync] prefix and the ongoing
# sync output is plain text (filter with: docker logs vault-cortex 2>&1 | grep -v '^{'):
docker logs vault-cortex
```

## Monitoring

```bash
# Follow the container logs (sync + MCP server):
docker logs -f vault-cortex

# Container status — "healthy" tracks the MCP server's /healthz:
docker compose ps
```

## Restart

The server runs startup tasks on every boot: rebuilds the search index, creates
memory template files if the memory folder doesn't exist, and starts the file
watcher. To re-run the startup flow (e.g., to test bootstrap behavior):

```bash
# Restart the container (sync and the MCP server both restart —
# s6 replays the init chain, which is idempotent):
docker compose restart
```

> **Changed `.env`?** Use `docker compose up -d` instead — `restart` reuses
> the existing container config and does **not** re-read `.env`; `up -d`
> recreates the services whose configuration changed.

The container also restarts automatically on crash (`restart: unless-stopped`
policy), Docker daemon restart, or system reboot.

## Stop

```bash
# Stop containers — named volumes persist your vault data and search index:
docker compose down

# Stop and delete all volumes (vault re-syncs on next start; index rebuilds):
docker compose down -v
```

## Memory

On first startup, if your vault doesn't already have a memory folder (default:
`About Me/`), the server creates one with template files (Me.md, Opinions.md,
Principles.md). Agents can also create new memory files and sections on the fly
via `vault_update_memory` — no manual setup needed.

## Configuration

Only `MCP_AUTH_TOKEN`, `PUBLIC_URL`, `OBSIDIAN_AUTH_TOKEN`, and `VAULT_NAME` are
required. For optional settings (memory folder, protected paths, timezone), see
the [Configuration](../../README.md#configuration) section in the main README.

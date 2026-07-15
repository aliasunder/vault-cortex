# Remote Quickstart (Obsidian Sync)

Run Vault Cortex on a VPS with Obsidian Sync for remote access from any device.
Your vault stays in sync; MCP tools work from Claude Desktop, Claude Code,
claude.ai, or any MCP client — anywhere.

Everything runs in **one container**: the `vault-cortex:remote` image bundles
the Obsidian Sync process and the MCP server under
[s6-overlay](https://github.com/just-containers/s6-overlay) supervision. Docker
Compose is used below for its restart policy and log rotation, but it's
optional — the same container runs with
[plain docker run](#docker-run-no-compose), Podman, or any OCI runtime.

## Prerequisites

- A VPS or cloud server with [Docker](https://docs.docker.com/engine/install/)
  installed (Ubuntu/Debian: `curl -fsSL https://get.docker.com | sh`)
- An [Obsidian Sync](https://obsidian.md/sync) subscription
- A domain name or public IP address for your server

## Setup

```bash
npx vault-cortex@latest init --mode remote
```

The CLI walks through your public URL, Obsidian Sync token (it can run the
token generator for you), and auth config, then starts the server and prints
the connection details for your MCP client.

<details>
<summary><strong>Don't have Node.js installed?</strong></summary>

The CLI needs Node.js >= 20.12 (the server itself runs in Docker). On Ubuntu/Debian:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

</details>

<details>
<summary><strong>Manual setup</strong> (no Node.js needed)</summary>

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

**docker run (no Compose):** The `docker run` command below passes your `.env`
via `--env-file`. Swap `docker` for `podman` or `nerdctl` as needed. First
uncomment two values in `.env` (both are already in `.env.example`):
`DEVICE_NAME=vault-cortex` and `CONFLICT_STRATEGY=merge` — the compose file
supplies these as defaults, but `docker run` only sees what's in `.env`.

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

</details>

## HTTPS access

MCP clients need to reach your server over HTTPS. Here's how to set it up — these options can be combined (e.g. API Gateway for TLS + a Cloudflare Tunnel behind it to close all ports):

### Cloudflare Tunnel (no open ports — free)

An encrypted outbound connection from your server to Cloudflare's edge. No
inbound ports need to be open on your server's firewall — traffic flows
through the tunnel instead of arriving directly. Requires a
[Cloudflare account](https://dash.cloudflare.com/sign-up) (free) with a
domain using Cloudflare's nameservers.

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)
on your server, create a tunnel in the Cloudflare dashboard
([Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels), and
point it at `http://localhost:8000`. Set `PUBLIC_URL` to the tunnel URL
(e.g. `https://vault.yourdomain.com`).

Once the tunnel is working, close port 8000 on your server's firewall — all
traffic flows through the tunnel, so the direct port is no longer needed.
See [Hardening](#hardening-recommended) below.

### API Gateway (AWS — no domain needed)

AWS API Gateway acts as a TLS-terminating reverse proxy — no domain, no
certificate management. You get an HTTPS URL immediately:

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
certificate. Caddy handles TLS automatically. Port 443 stays open on your
server's firewall (unlike a tunnel, your server is still directly reachable):

```
vault.yourdomain.com {
    reverse_proxy localhost:8000
}
```

Set `PUBLIC_URL` to `https://vault.yourdomain.com`.

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

## Updating

**Set up with the CLI?** `npx vault-cortex upgrade` pulls the latest image,
re-creates the container, and verifies health. Your vault data, search index,
and `.env` settings all persist — nothing is deleted.

**Set up with Docker Compose?** Stick with Compose for updates — the CLI and
Compose manage the container independently. Compose does **not** pull new
images on `up`, so pull explicitly:

```bash
docker compose pull && docker compose up -d
```

Named volumes persist across updates — no re-sync, no device re-registration,
and unchanged notes are not re-embedded.

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

**CLI or `docker run`:** `docker stop vault-cortex` — data persists in Docker volumes.

**Docker Compose:**

```bash
# Stop (data persists in Docker volumes):
docker compose down

# Stop and delete all volumes (vault re-syncs on next start; index rebuilds):
docker compose down -v
```

## Memory

The memory layer is enabled by default. Set `MEMORY_ENABLED=false` in your
`.env` to disable it — memory tools are hidden, no files are created, and the
server runs without it.

When enabled, the server creates a memory folder (default: `About Me/`) on
first startup with template files (Me.md, Opinions.md, Principles.md,
Routines.md, Agents.md). Agents can also create new memory files and sections
on the fly via `vault_update_memory` — no manual setup needed. Once entries
accumulate, `vault_memory_recall` answers topic questions across the layer's
full dated history. Memory files are append-only by default; a file can declare
`entry-policy: living` in frontmatter for current-state content whose expired
entries get pruned (the Routines template ships this way) — see
[templates/memory](../../templates/memory/README.md) for the full convention.

## Configuration

Only `MCP_AUTH_TOKEN`, `PUBLIC_URL`, `OBSIDIAN_AUTH_TOKEN`, and `VAULT_NAME` are
required. These optional settings are worth knowing about:

| Setting             | Default   | What it does                                                                                          |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `TZ`                | `UTC`     | Your IANA timezone (e.g. `America/New_York`) — affects daily note dates and timestamps                |
| `VAULT_PASSWORD`    | —         | Set this if your vault has end-to-end encryption enabled                                              |
| `EMBEDDING_ENABLED` | `true`    | Set `false` to skip AI models (~45MB) and use keyword search only — saves memory on smaller instances |
| `RERANK_MODE`       | `blended` | Set `none` to skip reranking for lower latency                                                        |
| `MEMORY_ENABLED`    | `true`    | Set `false` to disable the structured memory layer                                                    |

All settings are documented in `.env.example` and in the
[Configuration](../../README.md#configuration) section of the main README.

## Hardening (recommended)

The setup above is authenticated — every request requires your token or an
OAuth session. These optional measures add defense-in-depth:

- **Close port 8000** — once a tunnel or reverse proxy handles HTTPS, close
  direct access to port 8000. How depends on your setup — your VPS
  provider's firewall panel, security groups if you're on AWS,
  infrastructure-as-code, or whatever fits your setup. All traffic
  then flows through the encrypted path; the raw HTTP port disappears
  from the network.

- **Restrict SSH access** — limit SSH to a VPN or trusted IPs instead of the
  open internet. [Tailscale](https://tailscale.com/) (free for personal use)
  creates a private WireGuard mesh between your devices. Install it on your
  VPS and your laptop, verify you can SSH through the Tailscale hostname,
  then close port 22 in your firewall — SSH through Tailscale continues to
  work because it bypasses the public firewall.

- **Add a second auth layer** — the reference
  [AWS deployment](../../DEPLOY.md) validates tokens twice: once at the
  network edge (API Gateway + Lambda authorizer) and once at the server
  (Express middleware). This is an AWS-specific setup, but the principle
  applies anywhere — an auth-aware reverse proxy in front of the server
  means a misconfigured server alone can't expose your vault.

These measures stack. Start with whichever is easiest for your setup — even
one makes a meaningful difference.

## Troubleshooting

**"container name vault-cortex already in use" on start or upgrade.** A
container from a different management method is still running. The CLI
(`npx vault-cortex upgrade`) and Docker Compose (`docker compose up -d`)
manage the container independently — stop the existing one first with
`docker rm -f vault-cortex`, then retry with your preferred method.

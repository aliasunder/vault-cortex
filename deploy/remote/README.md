# Remote Quickstart (Obsidian Sync)

Run Vault Cortex on a VPS with Obsidian Sync for remote access from any device.
Your vault stays in sync; MCP tools work from Claude Desktop, Claude Code,
claude.ai, or any MCP client — anywhere. (Vault on this machine and no
Obsidian Sync? Use the [local quickstart](../local/) instead.)

Everything runs in **one container**: the `vault-cortex:remote` image bundles
the Obsidian Sync process and the MCP server, supervised together so both
restart automatically
([how the container is put together →](../../ARCHITECTURE.md#container-startup)).
The CLI setup below manages that container with plain `docker run`; the
manual setup offers a Docker Compose file that declares the same
configuration. Both produce an identical container — restart policy, log
rotation, and health check included — and Podman or any OCI-compatible
container runtime works in place of Docker.

**Contents** — [Prerequisites](#prerequisites) · [Setup](#setup) · [HTTPS access](#https-access) · [Connect](#connect-your-mcp-client) · [Verify](#verify) · [Monitoring](#monitoring) · [Updating](#updating) · [Restart](#restart) · [Stop](#stop) · [Memory](#memory) · [Config](#configuration) · [Hardening](#hardening-recommended) · [Troubleshooting](#troubleshooting)

## Prerequisites

- A VPS or cloud server with [Docker](https://docs.docker.com/engine/install/)
  installed (Ubuntu/Debian: `curl -fsSL https://get.docker.com | sh`)
- An [Obsidian Sync](https://obsidian.md/sync) subscription
- A domain name or public IP address for your server

## Setup

```bash
npx vault-cortex@latest init --mode remote
```

The CLI walks through your public URL, Obsidian Sync token (it can run
[`get-sync-token`](../../cli/#get-sync-token) for you), and auth config, then
starts the server and prints the connection details for your MCP client
([CLI reference →](../../cli/)).

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

If you have Node.js >= 20.12 on this machine, the CLI runs the login and
captures the token for you:

```bash
npx vault-cortex@latest get-sync-token
```

Otherwise, run the Docker image directly:

```bash
docker run --rm -it --entrypoint get-sync-token \
  ghcr.io/aliasunder/vault-cortex:remote
```

**4. Create your `.env` file:**

```bash
cp .env.example .env
```

**5. Fill in the required values:**

| Variable              | Value                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`      | Generate with `openssl rand -hex 32`                                                                                                                                                                     |
| `PUBLIC_URL`          | Your server's public base URL, e.g. `https://vault.example.com` — no `/mcp` at the end; it's appended automatically, and clients connect at `<PUBLIC_URL>/mcp` (see [HTTPS access](#https-access) below) |
| `OBSIDIAN_AUTH_TOKEN` | Output from step 3                                                                                                                                                                                       |
| `VAULT_NAME`          | Your exact Obsidian vault name (case-sensitive)                                                                                                                                                          |

**6. Start the server:**

```bash
docker compose up -d
```

First start pulls the image, logs in to Obsidian Sync, and syncs your vault
from Obsidian's servers. The initial sync takes 30–120 seconds depending on
vault size. The MCP server starts once sync is running and builds its search
index as files arrive.

**docker run (no Compose):** The command the CLI runs for you, spelled out —
for when you have neither Node.js nor Compose, invoke a different runtime
directly (swap `docker` for `podman` or `nerdctl`), or want the raw
invocation for your own automation. The same `.env` file works, and the
flags mirror the Compose file, volume names included, so your data carries
over if you ever switch between methods:

```bash
docker run -d --name vault-cortex \
  --hostname vault-cortex \
  --env-file .env \
  -v vault-cortex_vault_data:/vault \
  -v vault-cortex_mcp_data:/data \
  -v vault-cortex_obsidian_config:/home/obsidian/.config \
  -p 8000:8000 \
  --restart unless-stopped \
  --health-cmd "node -e \"fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
  --health-interval 15s --health-timeout 5s --health-retries 5 \
  --health-start-period 60s \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  ghcr.io/aliasunder/vault-cortex:remote
```

</details>

## HTTPS access

MCP clients need to reach your server over HTTPS. Pick one option — they can
also be combined (e.g. API Gateway adding an independent auth check in front
of a Cloudflare Tunnel that keeps every port closed):

| Option                                                      | Cost                          | Domain needed       | Ports open on your server |
| ----------------------------------------------------------- | ----------------------------- | ------------------- | ------------------------- |
| [Cloudflare Tunnel](#cloudflare-tunnel-no-open-ports--free) | Free                          | Yes (on Cloudflare) | None                      |
| [API Gateway](#api-gateway-aws--no-domain-needed)           | Free tier covers personal use | No                  | 8000                      |
| [Reverse proxy](#reverse-proxy-requires-a-domain)           | Free (Caddy/nginx)            | Yes                 | 443                       |
| [Direct access](#direct-access-testing-only)                | Free                          | No                  | 8000 (testing only)       |

> **Just trying it out?** Start with [direct access](#direct-access-testing-only)
> to confirm everything works, then come back and set up HTTPS.

### Cloudflare Tunnel (no open ports — free)

Lets clients reach your server without opening any ports — the tunnel is an
encrypted connection your server makes outward to Cloudflare, and traffic
flows back through it instead of arriving directly. Requires a
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

AWS API Gateway gives you an HTTPS address immediately — no domain, no
certificate to manage (it handles TLS in front of your server). You get an
HTTPS URL like:

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
server's firewall — the proxy receives traffic directly, so your server
stays reachable from the internet, whereas a tunnel needs no inbound ports
at all once port 8000 is closed:

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

> **Note:** Clients connect at `<PUBLIC_URL>/mcp`, but `PUBLIC_URL` itself is
> the **base URL only** — the server serves the endpoint at `/mcp` and appends
> it for you, so a `PUBLIC_URL` ending in `/mcp` becomes `…/mcp/mcp` and won't
> connect.
>
> The base must be exactly the one clients reach the server through (scheme,
> host, and any path prefix) — OAuth discovery metadata uses this URL, so a
> mismatch causes authentication failures.

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

Run these on your server:

```bash
# Health check (no auth):
curl http://localhost:8000/healthz
# → {"ok":true}

# One log stream for both processes — MCP server lines are structured
# JSON; init-chain lines carry an [obsidian-sync] prefix and the ongoing
# sync output is plain text (filter with: docker logs vault-cortex 2>&1 | grep -v '^{'):
docker logs vault-cortex
```

Once [HTTPS access](#https-access) is set up, the same health check works
from any device: `curl <PUBLIC_URL>/healthz`.

## Monitoring

```bash
# Follow the container logs (sync + MCP server):
docker logs -f vault-cortex

# Container status — "healthy" tracks the MCP server's /healthz:
docker ps
```

## Updating

Update with the same method you set up with — each one manages the container
independently.

**Set up with the CLI?**

```bash
npx vault-cortex@latest upgrade
```

Run it from the same directory where you ran `init` — it pulls the new image
and re-creates the container for you. Nothing is deleted — see
[`upgrade`](../../cli/#upgrade) in the CLI reference for what's preserved
and the `--dir` flag.

**Set up with Docker Compose?** Compose does **not** pull new images on
`up`, so pull explicitly:

```bash
docker compose pull && docker compose up -d
```

**Set up with `docker run` (no Compose)?** Do manually what `upgrade` does —
pull the new image, remove the container, then re-run the `docker run`
command from [Setup](#setup):

```bash
docker pull ghcr.io/aliasunder/vault-cortex:remote
docker rm -f vault-cortex
```

Named volumes persist across updates — no re-sync, no device re-registration,
and unchanged notes are not re-embedded.

## Restart

The server runs startup tasks on every boot: it rebuilds the search index,
creates memory template files if the memory folder doesn't exist, and starts
the file watcher. Restarting the container re-runs this flow (useful when
testing bootstrap behavior). The command is the same for every setup method,
since all three name the container `vault-cortex`:

```bash
# Sync and the MCP server both restart; the startup steps re-run cleanly:
docker restart vault-cortex
```

> **Changed `.env`?** A restart does **not** re-read `.env` — the container
> has to be re-created. Set up with the CLI? Run `npx vault-cortex@latest upgrade`
> (re-creates the container and also pulls the latest image). Using Compose?
> Run `docker compose up -d` — it re-creates services whose configuration
> changed.

The container also restarts automatically on crash (`restart: unless-stopped`
policy), Docker daemon restart, or system reboot.

## Stop

**Set up with the CLI (or `docker run`)?**

```bash
# Stop (data persists in Docker volumes):
docker stop vault-cortex
```

**Set up with Docker Compose?**

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

When enabled, the server creates a memory folder (default: `About Me/`) with
starter template files on first startup, and agents grow it from there. See
[Memory](../../README.md#memory) in the main README for how the layer works,
and [templates/memory](../../templates/memory/README.md) for the file format.

## File Tools

File tools (`vault_read_file`, `vault_list_files`) are enabled by default. Set
`FILE_TOOLS_ENABLED=false` in your `.env` to hide them — useful when Obsidian
Sync has asset syncing disabled and no files exist on disk.

## Configuration

Only `MCP_AUTH_TOKEN`, `PUBLIC_URL`, `OBSIDIAN_AUTH_TOKEN`, and `VAULT_NAME` are
required. These optional settings are worth knowing about:

| Setting              | Default   | What it does                                                                                          |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `TZ`                 | `UTC`     | Your IANA timezone (e.g. `America/New_York`) — affects daily note dates and timestamps                |
| `VAULT_PASSWORD`     | —         | Set this if your vault has end-to-end encryption enabled                                              |
| `EMBEDDING_ENABLED`  | `true`    | Set `false` to skip AI models (~45MB) and use keyword search only — saves memory on smaller instances |
| `RERANK_MODE`        | `blended` | Set `none` to skip reranking for lower latency                                                        |
| `MEMORY_ENABLED`     | `true`    | Set `false` to disable the structured memory layer                                                    |
| `FILE_TOOLS_ENABLED` | `true`    | Set `false` to hide file tools when Obsidian Sync has asset syncing disabled                          |

All settings are documented in `.env.example` and in the
[Configuration](../../README.md#configuration) section of the main README.

## Hardening (recommended)

The setup above is authenticated — every request requires your token or an
OAuth session. These optional measures add defense-in-depth:

- **Close port 8000** — once a tunnel or reverse proxy handles HTTPS, close
  direct access to port 8000 wherever you manage your server's firewall
  (provider panel, AWS security groups, infrastructure-as-code). All traffic
  then flows through the encrypted path.

- **Restrict SSH access** — limit SSH to a VPN or trusted IPs instead of the
  open internet. [Tailscale](https://tailscale.com/) (free for personal use)
  creates a private network between your devices: install it on the VPS and
  your laptop, verify SSH works through the Tailscale hostname, then close
  port 22 in your firewall.

- **Add a second auth layer** — the reference [AWS deployment](../../DEPLOY.md)
  validates tokens once at the network edge (API Gateway + Lambda authorizer)
  and again at the server. The principle applies anywhere: an auth-aware
  proxy in front means a misconfigured server alone can't expose your vault.

These measures stack. Start with whichever is easiest for your setup — even
one makes a meaningful difference.

## Troubleshooting

**"container name vault-cortex already in use" on start or upgrade.** A
container from a different management method is still running. The CLI
(`npx vault-cortex@latest upgrade`) and Docker Compose (`docker compose up -d`)
manage the container independently — stop the existing one first with
`docker rm -f vault-cortex`, then retry with your preferred method.

**Vault re-syncs from scratch (or the search index is empty) after switching
between the CLI, Compose, and `docker run`.** All three methods use the same
named volumes, so data normally carries over — but only when the names match
exactly, and a mismatch produces **no error**. Docker silently creates
fresh, empty volumes and the container starts with a clean slate: Obsidian
Sync registers a new device and re-syncs the vault, and the search index
rebuilds.

Nothing is lost — your data is still in the old volumes. Confirm with
`docker volume ls`: unprefixed names (`vault_data`) alongside prefixed ones
(`vault-cortex_vault_data`) mean an earlier setup used different volumes.
Two ways to recover:

- **Let the re-sync finish (simplest).** Your vault's source of truth is
  Obsidian Sync, so the fresh volumes repopulate on their own — wait for the
  sync and index rebuild to complete, then delete the old volumes
  (`docker volume rm vault_data mcp_data obsidian_config`).

- **Carry your existing data over** — keeps the built search index (no
  re-embedding) and the already-registered Sync device. Remove the container
  and the freshly created volumes, copy each old volume into its prefixed
  counterpart, then start the server again with your preferred method:

  ```bash
  docker rm -f vault-cortex
  docker volume rm vault-cortex_vault_data vault-cortex_mcp_data vault-cortex_obsidian_config

  docker run --rm -v vault_data:/from -v vault-cortex_vault_data:/to \
    --entrypoint sh ghcr.io/aliasunder/vault-cortex:remote -c "cp -a /from/. /to/"
  docker run --rm -v mcp_data:/from -v vault-cortex_mcp_data:/to \
    --entrypoint sh ghcr.io/aliasunder/vault-cortex:remote -c "cp -a /from/. /to/"
  docker run --rm -v obsidian_config:/from -v vault-cortex_obsidian_config:/to \
    --entrypoint sh ghcr.io/aliasunder/vault-cortex:remote -c "cp -a /from/. /to/"
  ```

# vault-cortex

Remote MCP server that exposes an Obsidian vault over HTTPS via the Model Context Protocol.

> **Status:** Phase 1 complete — all 12 MCP tools implemented and tested (151 tests). Infrastructure deployed. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Contents

- [Architecture](#architecture)
- [Authentication](#authentication)
- [Deployment](#deployment)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)
- [Monitoring](#monitoring)
- [Further reading](#further-reading)

## Architecture

> Full design, diagrams, and decisions: [ARCHITECTURE.md](./ARCHITECTURE.md)

- **Edge:** API Gateway HTTP API + Lambda bearer-token authorizer
- **Backend:** Lightsail (~$12/mo) running Docker Compose with two services:
  - `obsidian-sync` — bidirectional Obsidian Sync
  - `vault-mcp` — Express MCP server with SQLite FTS5 search
- **IaC:** SST v4
- **Auth:** OAuth 2.0 (Authorization Code + PKCE) for all clients, static bearer token as CLI alternative. Dual-layer validation: Lambda authorizer + Express middleware. JWT access tokens signed with HMAC-SHA256.
- **Source of truth:** the vault `.md` files. SQLite (and Phase 2 LightRAG) is rebuildable derived state.

## Authentication

Two auth methods — both validated at two layers (defense in depth). See [ARCHITECTURE.md § Auth](./ARCHITECTURE.md#auth-oauth-20--defense-in-depth) for the full flow diagram.

| Method                  | Used by                                                      | Token format                |
| ----------------------- | ------------------------------------------------------------ | --------------------------- |
| **OAuth 2.0**           | Claude Desktop, Claude Code, Claude Mobile, any OAuth client | JWT access token (HS256)    |
| **Static bearer token** | Claude Code, MCP Inspector, curl                             | Raw `MCP_AUTH_TOKEN` string |

**How it works:** The Lambda authorizer (edge) is path-aware. OAuth discovery endpoints (`/.well-known/*`, `/authorize`, `/token`, `/register`) pass through unauthenticated. `/mcp` requires a valid bearer token — either the static `MCP_AUTH_TOKEN` or a JWT signed with it. Express validates again in-process (second layer).

### Connecting via OAuth (all clients)

OAuth is the primary auth method. All MCP clients that support OAuth 2.0 — Claude Desktop, Claude Code, Claude Mobile, claude.ai, Perplexity — can connect this way. Remote connectors configured at [claude.ai/customize/connectors](https://claude.ai/customize/connectors) sync automatically across Claude Desktop, Claude Code, and Claude Mobile.

1. Add a custom connector / MCP server with the API Gateway URL + `/mcp` (e.g. `https://<id>.execute-api.us-east-1.amazonaws.com/mcp`)
2. Leave OAuth Client ID and Secret empty (dynamic registration handles it)
3. The client auto-discovers endpoints via `/.well-known/oauth-protected-resource`
4. A consent page opens in your browser — enter your `MCP_AUTH_TOKEN` to approve
5. The client receives a JWT access token (24h) + refresh token (no expiry, persisted in SQLite)
6. Token refresh is automatic — no re-authentication unless the server's data volume is wiped

### Connecting with a static bearer token

An alternative for CLI tools (Claude Code, MCP Inspector, curl) that don't need the OAuth flow. Claude Code can also connect via OAuth above.

```bash
curl -H "Authorization: Bearer <MCP_AUTH_TOKEN>" <apiUrl>/mcp
```

### Secrets: two channels, one token

`MCP_AUTH_TOKEN` is shared between two systems:

| Channel         | Feeds                                        | Where                                       |
| --------------- | -------------------------------------------- | ------------------------------------------- |
| **SST secret**  | Lambda authorizer + JWT verification         | `npx sst secret set McpAuthToken "<value>"` |
| **`.env` file** | Docker containers (Express + OAuth provider) | `~/.config/vault-cortex/.env`               |

Both **must match**. The token is also the HMAC key for JWT signing/verification and the password for the OAuth consent page.

**Rotation:**

```bash
NEW_TOKEN=$(openssl rand -hex 32)
npx sst secret set McpAuthToken "$NEW_TOKEN"
npm run deploy
sed -i '' "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$NEW_TOKEN/" ~/.config/vault-cortex/.env
npm run lightsail:up
```

Existing JWTs signed with the old key become invalid immediately. OAuth clients will silently re-authenticate on their next token refresh.

## Deployment

SST uses a stage name based on your OS username (run `npx sst secret list` once and SST writes `.sst/stage`). Commands below omit `--stage` to use the default.

### Prerequisites

- AWS credentials configured (`aws configure` or `AWS_PROFILE`)
- Docker installed locally
- A GitHub PAT with `read:packages` + `write:packages` scopes
- An SSH keypair at `~/.ssh/id_ed25519.pub` (or `~/.ssh/id_rsa.pub`). If you don't have one: `ssh-keygen -t ed25519`. SST uploads the public key to Lightsail so SCP/SSH work with your default identity.

### One-time setup

**1. Install deps:**

```bash
npm install
```

**2. Generate MCP auth token and set SST secrets** (placeholders are fine for smoke-testing infra):

```bash
MCP_AUTH_TOKEN=$(openssl rand -hex 32)
npx sst secret set McpAuthToken      "$MCP_AUTH_TOKEN"
npx sst secret set ObsidianAuthToken "dev-placeholder"
npx sst secret set ObsidianVaultName "dev-placeholder"
```

**3. Create the deploy `.env` file** (secrets live outside the repo at `~/.config/vault-cortex/.env`):

```bash
mkdir -p ~/.config/vault-cortex
cp .env.example ~/.config/vault-cortex/.env
chmod 600 ~/.config/vault-cortex/.env
```

Write the MCP token into `.env` (must match the SST secret from step 2):

```bash
sed -i '' "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$MCP_AUTH_TOKEN/" ~/.config/vault-cortex/.env
```

Then open `~/.config/vault-cortex/.env` and fill in the remaining values:

| Variable              | Value                                                                    |
| --------------------- | ------------------------------------------------------------------------ |
| `PUBLIC_URL`          | API Gateway URL (from `sst deploy` output, available after first deploy) |
| `GHCR_USER`           | Your GitHub username                                                     |
| `GHCR_TOKEN`          | The GitHub PAT from prerequisites                                        |
| `VAULT_NAME`          | Your Obsidian vault name (exact, case-sensitive)                         |
| `VAULT_PASSWORD`      | Only if vault has E2E encryption                                         |
| `OBSIDIAN_AUTH_TOKEN` | Generate with the command below                                          |

```bash
docker run --rm -it --entrypoint get-token ghcr.io/belphemur/obsidian-headless-sync-docker:latest
```

**4. Authenticate to GHCR** (once per machine):

```bash
echo "<your-GHCR_TOKEN>" | docker login ghcr.io -u <your-github-username> --password-stdin
```

### Deploy

```bash
npm run deploy:dev
```

That runs, in order:

1. `npx sst deploy` — provisions Lightsail VM, API Gateway, smart Lambda authorizer
2. `npm run docker:publish` — builds (targeting linux/amd64) + pushes to GHCR
3. `npm run lightsail:up` — ensures `/opt/vault-cortex` exists, waits for Docker (cloud-init), logs into GHCR on the instance, SCPs `docker-compose.yml` + `.env`, then `docker compose pull && up -d`

On startup, docker-compose runs three services in order: `init-config-perms` (chowns the obsidian config volume — workaround for an upstream bug) → `obsidian-sync` (syncs your vault) → `vault-mcp` (MCP server). Both `obsidian-sync` and `vault-mcp` run as UID 1000 to share the `/vault` volume. See [ARCHITECTURE.md § Docker Compose Startup](./ARCHITECTURE.md#docker-compose-startup) for the full diagram.

### Verify

```bash
# Direct hit on the Lightsail VM (skips API Gateway):
curl http://<lightsailIp>:8000/healthz

# Full chain via API Gateway (validates the bearer token):
curl -H "Authorization: Bearer <McpAuthToken>" <apiUrl>/healthz
```

`<lightsailIp>` and `<apiUrl>` come from the `sst deploy` output (also in `.sst/outputs.json`).

### Command reference

| Command                  | What it does                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `npm run deploy`         | `npx sst deploy` — creates/updates AWS infra. First run provisions everything; subsequent runs are incremental. |
| `npm run docker:publish` | Builds the vault-mcp image (linux/amd64) and pushes to GHCR.                                                    |
| `npm run lightsail:up`   | Bootstraps the VM (mkdir, Docker wait, GHCR login), SCPs config, pulls + restarts containers. Volumes persist.  |
| `npm run deploy:dev`     | Full chain: `deploy` → `docker:publish` → `lightsail:up`.                                                       |
| `npm run dev:mcp`        | Runs the MCP server locally with `tsx watch` (hot reload). Requires `MCP_AUTH_TOKEN` in env.                    |
| `npx sst remove`         | **Destructive** — deletes Lightsail VM, API Gateway, Lambda. Frees the ~$12/mo.                                 |

`deploy`, `docker:publish`, `lightsail:up`, `deploy:dev` are all idempotent and safe to run repeatedly.

### Updating the deployed app

App-only update (no infra changes):

```bash
npm run docker:publish && npm run lightsail:up
```

Infra changes (anything in `sst.config.ts`): use `npm run deploy:dev` (full chain) or `npx sst deploy` (infra only).

### Tearing down

```bash
npx sst remove   # removes Lightsail, API Gateway, Lambda
```

## Local development

### Tests

```bash
npm test            # vitest one-shot
npm run test:watch  # vitest in watch mode
```

### MCP server (no Docker)

Run the MCP server against your local vault (no Docker, no Lightsail):

```bash
PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/Vault npm run dev:mcp
```

This starts `tsx watch` with hot reload on port 8000. Test with:

```bash
# Health check (no auth):
curl http://localhost:8000/healthz

# OAuth discovery (no auth):
curl http://localhost:8000/.well-known/oauth-protected-resource

# Authenticated MCP call:
curl -H "Authorization: Bearer local-dev-token" http://localhost:8000/mcp
```

The token is only validated locally — it doesn't need to match the SST secret.

### Docker (local)

`docker-compose.local.yml` runs vault-mcp against your local vault without Lightsail or `obsidian-sync` (not needed — `~/Vault` is bind-mounted directly). It builds from source instead of pulling from GHCR.

```bash
npm run dev:docker
# or: docker compose -f docker-compose.local.yml up --build
```

Test with the same curl commands above. The hardcoded token is `local-dev-token`.

### MCP Inspector

Test all 12 tools interactively in a browser UI. The server must be running first:

```bash
# Terminal 1 — start the server
PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/Vault npm run dev:mcp

# Terminal 2 — launch the inspector
npx @modelcontextprotocol/inspector
```

In the inspector UI, enter `http://localhost:8000/mcp` as the server URL and `local-dev-token` as the Bearer token. It discovers all tools with their schemas, lets you call any tool with custom inputs, and shows the response.

To test against the deployed Lightsail instance instead, point the inspector at the API Gateway URL with the real token (no local server needed).

### Type checking and linting

```bash
npm run build           # tsc — type check
npm run lint            # eslint
npm run prettier:check  # formatting
```

## Troubleshooting

- **`npm run build` fails with `Property 'McpAuthToken' does not exist`** — `sst-env.d.ts` hasn't been generated. Run `npx sst deploy` (or `sst dev`) once for your stage.
- **`sst dev` errors with `SecretMissingError`** — set the three secrets first (one-time setup step 2).
- **`curl <lightsailIp>` hangs** — use `:8000`. The security group only allows ports 22 and 8000.
- **`scp` / `ssh` fails with `Permission denied (publickey)`** — your local SSH key doesn't match what SST deployed to the Lightsail KeyPair. Verify `~/.ssh/id_ed25519.pub` exists and redeploy, or set `SSH_PUBKEY_PATH` to the correct `.pub` file.
- **`docker: command not found` on `lightsail:up`** — cloud-init hasn't finished installing Docker. The script waits up to 120s automatically; if it still times out, SSH in and check `tail /var/log/cloud-init-output.log`.
- **Host key changed warning** — the Lightsail instance was replaced (e.g. `userData` or `keyPairName` changed in `sst.config.ts`). Run `ssh-keygen -R <lightsailIp>` and retry.

## Monitoring

### SSH into the server

```bash
ssh ubuntu@<lightsailIp>
```

`<lightsailIp>` comes from `sst deploy` output (also in `.sst/outputs.json`). Uses the SSH key that SST uploaded to Lightsail during provisioning (`~/.ssh/id_ed25519` by default).

### Tailing logs

Both containers write structured JSON to stdout/stderr, captured by Docker's `json-file` log driver (10MB per file, 3 rotated files — ~30MB retained per container).

```bash
# Follow vault-mcp logs in real time
docker logs -f vault-mcp

# With timestamps
docker logs -f --timestamps vault-mcp

# Last 50 lines + follow
docker logs -f --tail 50 vault-mcp

# obsidian-sync logs (for cross-referencing file sync activity)
docker logs -f obsidian-sync
```

### Filtering with jq

vault-mcp logs are structured JSON with `timestamp`, `level`, `message`, `source` (file:line), plus contextual properties like `requestId`, `sessionId`, `tool`, `clientIp`.

```bash
# Errors only (token mismatch, watcher failures — things that need fixing)
docker logs vault-mcp 2>&1 | jq 'select(.level == "error")'

# Trace a single request across all layers
docker logs vault-mcp 2>&1 | jq 'select(.requestId == "1")'

# All activity from a specific client IP
docker logs vault-mcp 2>&1 | jq 'select(.clientIp == "73.48.22.1")'

# All tool calls
docker logs vault-mcp 2>&1 | jq 'select(.message == "tool_call")'

# Auth failures
docker logs vault-mcp 2>&1 | jq 'select(.message | startswith("auth_failed"))'
```

Note: `2>&1` is needed because error-level logs go to stderr — piping to jq requires combining both streams.

### Log levels

| Level   | Meaning                           | Examples                                                  |
| ------- | --------------------------------- | --------------------------------------------------------- |
| `error` | Something is broken — investigate | Token mismatch, file watcher failure, unhandled exception |
| `warn`  | Unexpected but not broken         | Malformed auth header, stale session ID, tool input error |
| `info`  | Normal operations                 | Tool calls, reads, writes, searches, session lifecycle    |
| `debug` | Verbose tracing (dev only)        | File watcher indexing individual files                    |

Set `LOG_LEVEL` in `.env` to control the threshold (default: `info`).

## Further reading

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full design, MCP tool surface, Phase 1/2 boundaries
- [`AGENTS.md`](./AGENTS.md) — code conventions for AI-assisted development

# vault-cortex

Remote MCP server that exposes an Obsidian vault over HTTPS via the Model Context Protocol.

> **Status:** Phase 1 scaffolding — infrastructure and authorizer are deployed; MCP tool surface is contract-only (stubs with Zod schemas and example call/response blocks). See `ARCHITECTURE.md` for the full design.

## Architecture

- **Edge:** API Gateway HTTP API + Lambda bearer-token authorizer
- **Backend:** Lightsail (~$12/mo) running Docker Compose with two services:
  - `obsidian-sync` — bidirectional Obsidian Sync
  - `vault-mcp` — Express MCP server with SQLite FTS5 search
- **IaC:** SST v4
- **Auth:** the bearer token is validated at TWO layers (Lambda authorizer + in-process Express middleware) — defense in depth
- **Source of truth:** the vault `.md` files. SQLite (and Phase 2 LightRAG) is rebuildable derived state.

## Secrets: two channels, one token

The `MCP_AUTH_TOKEN` is validated at two layers (defense in depth), each fed by a different channel:

| Channel         | What it feeds                                             | Where it's stored                                                         | How to set                                  |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| **SST secrets** | Lambda authorizer (API Gateway layer)                     | AWS SSM Parameter Store (encrypted)                                       | `npx sst secret set McpAuthToken "<value>"` |
| **`.env` file** | Docker containers on Lightsail (Express middleware layer) | `~/.config/vault-cortex/.env` locally; `/opt/vault-cortex/.env` on the VM | Edit the file directly                      |

Both values **must match** — they're the same token stored in two places because SST (serverless) and Docker Compose (VM) have no shared secrets mechanism.

**Rotation procedure:**

```bash
# 1. Generate a new token
NEW_TOKEN=$(openssl rand -hex 32)

# 2. Update SST (Lambda side)
npx sst secret set McpAuthToken "$NEW_TOKEN"
npm run deploy  # redeploys Lambda with new value

# 3. Update .env (Docker side)
# Edit ~/.config/vault-cortex/.env → set MCP_AUTH_TOKEN=$NEW_TOKEN
npm run lightsail:up  # pushes new .env + restarts containers
```

## Deployment

SST uses a stage name based on your OS username (run `npx sst secret list` once and SST writes `.sst/stage`). Commands below omit `--stage` to use the default.

### Prerequisites

- AWS credentials configured (`aws configure` or `AWS_PROFILE`)
- Docker installed locally
- A GitHub PAT with `read:packages` + `write:packages` scopes
- An SSH keypair at `~/.ssh/id_ed25519.pub` (or `~/.ssh/id_rsa.pub`). If you don't have one: `ssh-keygen -t ed25519`. SST uploads the public key to Lightsail so SCP/SSH work with your default identity.

### One-time setup

```bash
# 1. Install deps
npm install

# 2. Set SST secrets (placeholders are fine for smoke-testing infra):
npx sst secret set McpAuthToken      "$(openssl rand -hex 32)"
npx sst secret set ObsidianAuthToken "dev-placeholder"
npx sst secret set ObsidianVaultName "dev-placeholder"

# 3. Configure the deploy environment for Docker + Lightsail.
#    Secrets live OUTSIDE the repo at ~/.config/vault-cortex/.env
mkdir -p ~/.config/vault-cortex
cp .env.example ~/.config/vault-cortex/.env
chmod 600 ~/.config/vault-cortex/.env
# Fill in at minimum:
#   MCP_AUTH_TOKEN      — must match the SST McpAuthToken from step 2
#   GHCR_USER           — your GitHub username
#   GHCR_TOKEN          — the GitHub PAT from prerequisites
#   OBSIDIAN_AUTH_TOKEN, VAULT_NAME — placeholders OK if just smoke-testing

# 4. Authenticate to GHCR locally (once per machine):
docker login ghcr.io -u <your-github-username> --password-stdin
# paste your PAT and press Enter
```

### Deploy

```bash
npm run deploy:dev
```

That runs, in order:

1. `npx sst deploy` — provisions Lightsail VM, API Gateway, Lambda authorizer
2. `npm run docker:publish` — builds (targeting linux/amd64) + pushes to GHCR
3. `npm run lightsail:up` — ensures `/opt/vault-cortex` exists, waits for Docker (cloud-init), logs into GHCR on the instance, SCPs `docker-compose.yml` + `.env`, then `docker compose pull && up -d`

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
MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/Vault npm run dev:mcp
```

This starts `tsx watch` with hot reload on port 8000. Test with:

```bash
# Health check (no auth):
curl http://localhost:8000/healthz

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

## Further reading

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full design, MCP tool surface, Phase 1/2 boundaries
- [`AGENTS.md`](./AGENTS.md) — code conventions for AI-assisted development

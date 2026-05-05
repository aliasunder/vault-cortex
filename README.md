# vault-cortex

Remote MCP server that exposes an Obsidian vault over HTTPS via the Model Context Protocol.

> **Status:** Phase 1 scaffolding — infrastructure and authorizer are production-ready; the MCP tool surface is contract-only (stubs with detailed signatures and Example call/response blocks). See `ARCHITECTURE.md` for the full design and `CLAUDE.md` for code conventions.

## Architecture (one-pager)

- **Edge:** API Gateway HTTP API + Lambda bearer-token authorizer
- **Backend:** Lightsail (~$12/mo) running Docker Compose with two services:
  - `obsidian-sync` — bidirectional Obsidian Sync
  - `vault-mcp` — Express MCP server with SQLite FTS5 search
- **IaC:** SST v4
- **Auth:** the bearer token is validated at TWO layers (Lambda authorizer + in-process Express middleware) — defense in depth
- **Source of truth:** the vault `.md` files. SQLite (and Phase 2 LightRAG) is rebuildable derived state.

## Personal stage deployment

SST defaults to a personal stage based on your username (run `npx sst secret list` once and SST writes `.sst/stage`). Commands below omit `--stage` to use it. Substitute `--stage production` for the real deployment.

### Prerequisites

- AWS credentials configured (`aws configure` or `AWS_PROFILE`)
- Docker installed locally
- A GitHub PAT with `write:packages` scope, exported as `$GHCR_TOKEN`, for pushing the vault-mcp image to GHCR

### One-time setup

```bash
# 1. Install deps
npm install

# 2. Set secrets (placeholders are fine for a personal stage):
npx sst secret set McpAuthToken      "$(openssl rand -hex 32)"
npx sst secret set ObsidianAuthToken "dev-placeholder"
npx sst secret set ObsidianVaultName "dev-placeholder"

# 3. Configure the deploy environment for Docker + Lightsail
cp .env.example .env
# Fill in at minimum:
#   MCP_AUTH_TOKEN  — must match the SST McpAuthToken you set in step 2
#   GHCR_USER       — your GitHub username
#   VAULT_MCP_TAG   — "dev" is fine
#   OBSIDIAN_AUTH_TOKEN, VAULT_NAME — placeholders OK if just smoke-testing infra

# 4. Authenticate to GHCR (once per machine):
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

### Deploy

```bash
npm run deploy:dev
```

That runs, in order:

1. `npx sst deploy` — provision Lightsail VM, API Gateway, Lambda authorizer; emit `sst-env.d.ts` so `tsc` works
2. `npm run docker:publish` — build + push `ghcr.io/$GHCR_USER/vault-mcp:$VAULT_MCP_TAG`
3. `npm run lightsail:up` — SCP `docker-compose.yml` + `.env` to the VM (IP read from `.sst/outputs.json`), then `docker compose pull && up -d` over SSH

You can also run any step individually — see `scripts/dev.mts` for the helper, and `npm run` to see all script names.

### Verify

```bash
# Direct hit on the Lightsail VM (skips API Gateway):
curl http://<lightsailIp>:8000/healthz

# Full chain via API Gateway (validates the bearer token):
curl -H "Authorization: Bearer <McpAuthToken>" <apiUrl>/healthz
```

`<lightsailIp>` and `<apiUrl>` come from the `npx sst deploy` output (also in `.sst/outputs.json`).

### What works today vs aspirational

| Step | Status |
|------|--------|
| 1–4 (deps, secrets, SST deploy, `npm run build`) | ✅ Works today |
| 5 (Docker build/push) | ✅ Image builds; runtime is a stub (no app to serve) |
| 6–7 (SCP + `docker compose up`) | ⚠️ Container starts but exits — `server.ts` is `export {}` |
| 8 (curl `/healthz`) | ❌ Endpoint doesn't exist until Phase 1 lands |

To smoke-test the deployment plumbing without waiting on Phase 1, swap the `vault-mcp` service in `docker-compose.yml` for a quick `nginx:alpine` listening on `:8000` to verify TCP reach + API Gateway proxying end-to-end.

### Updating the deployed app

Once you have changes you want to ship to your personal stage:

App-only update (no infra changes):

```bash
npm run docker:publish && npm run lightsail:up
```

Infra changes (anything in `sst.config.ts`): `npm run deploy:dev` (full chain) or `npx sst deploy` (infra only).

### Tearing down

```bash
npx sst remove   # removes Lightsail, API Gateway, Lambda — frees the ~$12/mo
```

## Production deployment

Same as personal, with `--stage production` and real secrets:

```bash
npx sst secret set McpAuthToken      "$(openssl rand -hex 32)" --stage production
npx sst secret set ObsidianAuthToken "<real Obsidian token>"   --stage production
npx sst secret set ObsidianVaultName "My Vault"                --stage production
# Then a stage-aware deploy. The npm scripts above all default to your
# personal stage; for production, run the steps explicitly with `--stage`:
npx sst deploy --stage production
GHCR_USER=<you> VAULT_MCP_TAG=prod npm run docker:publish
GHCR_USER=<you> VAULT_MCP_TAG=prod npm run lightsail:up
```

Before making this repo public, work through the pre-public hardening checklist (SSH `0.0.0.0/0` → admin IP, API Gateway throttling, full git-history secret scan). See `ARCHITECTURE.md` once that section is written.

## Troubleshooting

- **`npm run build` fails with `Property 'McpAuthToken' does not exist on type 'Resource'`** — you haven't generated `sst-env.d.ts` yet. Run `npx sst dev` (or `sst deploy`) once for your stage; SST writes the file at the project root and `tsconfig.json` picks it up.
- **`sst dev` errors with `SecretMissingError`** — set the three secrets first (step 2 above).
- **`curl <lightsailIp>` hangs** — port 80 isn't open. Use `:8000`. The security group only allows 22 (SSH) and 8000 (vault-mcp).
- **`Could not resolve host`** — your machine's network/VPN. Lightsail issue this is not.

## Project structure

```
sst.config.ts              # SST v4 IaC (fully implemented)
package.json               # single package, all deps
tsconfig.json              # single config
Dockerfile                 # vault-mcp Docker image
docker-compose.yml         # Lightsail: obsidian-sync + vault-mcp
.env.example               # template for Lightsail .env
src/
  functions/
    authorizer.ts          # Lambda: bearer-token auth (implemented)
  vault-mcp/
    server.ts              # Express + MCP transport entry (stub)
    tool-definitions.ts    # MCP tool registrations + Zod schemas (stub)
    vault-filesystem.ts    # Read/write/list/delete .md files (stub)
    memory-store.ts        # About Me/ get/update/delete/list (stub)
    search-index.ts        # SQLite FTS5 factory (stub)
    file-watcher.ts        # chokidar → keeps index current (stub)
                           # Phase 2: gains LightRAG ingestion hook
```

## Further reading

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full design, MCP tool surface, Phase 1/2 boundaries
- [`CLAUDE.md`](./CLAUDE.md) — code conventions for AI-assisted development

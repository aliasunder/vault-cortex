# CLAUDE.md

Project conventions for AI-assisted development on vault-cortex.

## What this project is

Remote MCP server exposing an Obsidian vault over HTTPS. Two containers on
Lightsail (obsidian-headless for sync, vault-mcp for MCP tools), fronted by
API Gateway with a Lambda bearer-token authorizer. IaC via SST v4.

See `ARCHITECTURE.md` for the full design.

## Structure

```
sst.config.ts              # SST v4 IaC — Lightsail + API Gateway + secrets
package.json               # Single package — all deps here
tsconfig.json              # Single config — tsc for Docker, esbuild for Lambda
Dockerfile                 # vault-mcp Docker image
docker-compose.yml         # Runs on Lightsail (obsidian-sync + vault-mcp)
.env.example               # Template for Lightsail .env file
functions/
  authorizer.ts            # Lambda: bearer-token validation for API Gateway
vault-mcp/
  server.ts                # Express + MCP StreamableHTTPServerTransport
  tools.ts                 # MCP tool registrations (Zod schemas)
  vault.ts                 # Filesystem ops (read, write, list)
  memory.ts                # About Me/ memory layer
  search.ts                # SQLite FTS5 (factory pattern, not class)
  watcher.ts               # chokidar -> keeps SQLite index current
```

## Code style

- Functional over OOP. Arrow functions over `function` declarations.
- Factory/closure pattern for stateful modules (see `search.ts`).
- TypeScript strict mode. `node:` prefix for built-ins.
- Explicit return types on exports. Zod for MCP tool schemas.
- No `any`. Prefer `async/await`.

## SST conventions

- Secrets via `sst.Secret`, PascalCase names. Never hardcode.
- `$interpolate` for `Output<string>` composition.
- Raw Pulumi `aws.*` for Lightsail (no SST component exists).
- `sst.aws.ApiGatewayV2` for API Gateway — `routeUrl()` for HTTP proxy.
- SST bundles Lambda handlers with esbuild — tree-shakes from entry file.

## Deployment

```bash
sst secret set McpAuthToken "$(openssl rand -hex 32)" --stage production
sst secret set ObsidianAuthToken "<token>" --stage production
sst secret set ObsidianVaultName "My Vault" --stage production
sst deploy --stage production
```

## Docker (on Lightsail)

```bash
cd /opt/vault-cortex
cp .env.example .env  # fill in real values
docker compose up -d
```

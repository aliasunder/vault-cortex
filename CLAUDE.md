# CLAUDE.md

Project conventions for AI-assisted development on vault-cortex.

## What this project is

Remote MCP server exposing an Obsidian vault over HTTPS. Two containers on
Lightsail (obsidian-headless for sync, vault-mcp for MCP tools), fronted by
API Gateway with a Lambda bearer-token authorizer. IaC via SST v4.

See `ARCHITECTURE.md` for the full design.

## Structure

```
sst.config.ts                      # SST v4 IaC
packages/functions/src/            # Lambda functions (authorizer)
services/vault-mcp/src/            # MCP server (Express + MCP SDK + SQLite FTS5)
docker/                            # docker-compose.yml for Lightsail
```

## Code conventions

- TypeScript strict mode. `node:` prefix for built-ins.
- Explicit return types on exports. Zod for MCP tool schemas.
- No `any`. Prefer `async/await`.

## SST conventions

- Secrets via `sst.Secret`, PascalCase names. Never hardcode.
- `$interpolate` for `Output<string>` composition.
- Raw Pulumi `aws.*` for Lightsail. `sst.aws.ApiGatewayV2` for API Gateway.

## Deployment

```bash
sst secret set McpAuthToken "$(openssl rand -hex 32)" --stage production
sst secret set ObsidianAuthToken "<token>" --stage production
sst secret set ObsidianVaultName "My Vault" --stage production
sst deploy --stage production
```

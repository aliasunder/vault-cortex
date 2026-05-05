# CLAUDE.md

Project conventions for AI-assisted development on vault-cortex.

## What this project is

Remote MCP server exposing an Obsidian vault over HTTPS. Two containers on
Lightsail (obsidian-headless for sync, vault-mcp for MCP tools), fronted by
API Gateway with a Lambda bearer-token authorizer. IaC via SST v4.

**Phase 1** delivers vault CRUD, full-text search (SQLite FTS5), and the
About Me/ memory layer — enough to make any MCP client personalized.

**Phase 2** adds LightRAG for semantic/knowledge-graph queries over the
vault. The file watcher gains a second hook for LightRAG ingestion,
and a new `vault_query_kb` tool is added. Additive — not a rewrite.

See `ARCHITECTURE.md` for the full design.

## Structure

```
sst.config.ts                          # SST v4 IaC (fully implemented)
package.json                           # single package, all deps
tsconfig.json                          # single config
Dockerfile                             # vault-mcp Docker image
docker-compose.yml                     # Lightsail: obsidian-sync + vault-mcp
.env.example                           # template for Lightsail .env
src/
  functions/
    authorizer.ts                      # Lambda: bearer-token auth (implemented)
  vault-mcp/
    server.ts                          # Express + MCP transport entry
    tool-definitions.ts                # MCP tool registrations + Zod schemas
    vault-filesystem.ts                # Read/write/list .md files
    memory-store.ts                    # About Me/ read/append/list
    search-index.ts                    # SQLite FTS5 factory (tags, folders, etc)
    file-watcher.ts                    # chokidar -> keeps index current
                                       # Phase 2: gains LightRAG ingestion hook
```

## Code style

- Functional over OOP. Arrow functions over `function` declarations.
- Factory/closure pattern for stateful modules (see search-index.ts).
- `type` over `interface` unless `interface` is specifically required.
- TypeScript strict mode. `node:` prefix for built-ins.
- Explicit return types on exports. Zod for MCP tool schemas.
- No `any`. Prefer `async/await`.

## SST conventions

- Secrets via `sst.Secret`, PascalCase names. Never hardcode.
- `$interpolate` for `Output<string>` composition.
- Raw Pulumi `aws.*` for Lightsail (no SST component exists).
- `sst.aws.ApiGatewayV2` + `routeUrl()` for HTTP proxy.
- SST bundles Lambda handlers with esbuild from entry file.

## Local development

`Resource.McpAuthToken` (used by `src/functions/authorizer.ts`) is
typed via `.sst/types.generated.ts`, which SST emits only when it
runs the resource graph. On a fresh clone, `npm run build` fails
with `Property 'McpAuthToken' does not exist on type 'Resource'`
until you bootstrap SST once.

```bash
npm install
sst dev --stage <yourname>      # generates .sst/ types; leave running
# in another shell:
npm run build                   # tsc now sees Resource.McpAuthToken
```

`sst dev` keeps types fresh as you edit `sst.config.ts`. For a CI /
non-dev build, `sst deploy --stage <ci>` also generates the types as
a side effect.

## Deployment

```bash
sst secret set McpAuthToken "$(openssl rand -hex 32)" --stage production
sst secret set ObsidianAuthToken "<token>" --stage production
sst secret set ObsidianVaultName "My Vault" --stage production
sst deploy --stage production
```

## Before going public

Before this repo is made public, work through the pre-public hardening
checklist (SSH `0.0.0.0/0` → admin IP, API Gateway throttling, full
git-history secret scan, etc). See `ARCHITECTURE.md` for the full list
once it's written.

# AGENTS.md

Project conventions for AI-assisted development on vault-cortex — for Claude Code and other AI agents.

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
  logger.ts                            # Root logger (child pattern + extensions)
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

## Logging

Single root logger at `src/logger.ts`, extended via `.child()` per module.

```typescript
// src/logger.ts exports the root instance
export const logger = createLogger("vault-cortex")

// each module creates a child with carried properties
import { logger as rootLogger } from "../logger.js"
const logger = rootLogger.child({ module: "search-index" })
```

**Key concepts:**

- **Child loggers are immutable** — `.child({ key: value })` returns a new
  logger that carries those properties in every log call. The parent is
  never mutated. No need to "unset" properties.
- **Extensions** — pure functions `(entry: LogEntry) => void` attached at
  the root. They receive every log entry and can forward it (Sentry,
  external log drain, etc). Extensions propagate to all children.
- **Module-level loggers** are for startup and background work
  (`rebuildFromVault`, file-watcher events).
- **Per-request loggers** — when `server.ts` handles an MCP request,
  create a child with `{ requestId }` and pass it to data-layer functions
  as a parameter. This keeps request tracing explicit without
  AsyncLocalStorage indirection.

```typescript
// in a tool handler (Session 2)
const reqLogger = logger.child({ requestId: crypto.randomUUID() })
reqLogger.info("vault_read_note", { path: notePath })
const content = await readNote(vaultPath, notePath, reqLogger)
```

Data-layer functions that need per-request tracing accept an optional
`logger` parameter, falling back to the module-level logger for calls
outside a request context (startup, file-watcher).

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

## Build pipeline gotcha

`Resource.McpAuthToken` (used by `src/functions/authorizer.ts`) is
typed via `sst-env.d.ts` at the project root, which SST writes when
it runs the resource graph. The file is gitignored (auto-generated)
so on a fresh clone, `npm run build` fails with
`Property 'McpAuthToken' does not exist on type 'Resource'` until
you've run `npx sst deploy` (or `sst dev`) once for your stage.

If you add or rename a secret in `sst.config.ts`, re-run `sst deploy`
(or `sst dev`) to regenerate `sst-env.d.ts`.

## Operational docs

Personal-stage and production deployment walkthroughs live in
`README.md` (it's the front door — humans land there first). Keep
this file focused on conventions; don't duplicate procedure here.

## Before going public

Before this repo is made public, work through the pre-public hardening
checklist (SSH `0.0.0.0/0` → admin IP, API Gateway throttling, full
git-history secret scan, etc). See `ARCHITECTURE.md` for the full list
once it's written.

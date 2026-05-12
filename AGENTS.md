# AGENTS.md

Project conventions for AI-assisted development on vault-cortex — for Claude Code and other AI agents.

## What this project is

Remote MCP server exposing an Obsidian vault over HTTPS. Three services on
Lightsail via Docker Compose: init-config-perms (one-shot volume fix),
obsidian-sync (bidirectional Obsidian Sync), vault-mcp (MCP server, UID 1000).
Fronted by API Gateway with a smart Lambda authorizer (path-aware: OAuth
endpoints pass through, /mcp validates static token or JWT). IaC via SST v4.

**Phase 1** delivers vault CRUD, full-text search (SQLite FTS5), and the
About Me/ memory layer — enough to make any MCP client personalized.

**Phase 2** adds LightRAG for semantic/knowledge-graph queries over the
vault. The file watcher gains a second hook for LightRAG ingestion,
and a new `vault_query_kb` tool is added. Additive — not a rewrite.

This repo will be made **public**. All solutions must be portable — they
can't rely on one-off manual fixes, hardcoded paths, or user-specific
configuration. If it works only on the author's machine, it's not done.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Structure

```
sst.config.ts                          # SST v4 IaC (fully implemented)
package.json                           # single package, all deps
tsconfig.json                          # single config
Dockerfile                             # vault-mcp Docker image
docker-compose.yml                     # Lightsail: obsidian-sync + vault-mcp
.env.example                           # template for Lightsail .env
src/
  logger.ts                            # Root logger (structured JSON, source location)
  auth.ts                              # Shared auth utilities (safeEqual, parseBearer)
  jwt.ts                               # Minimal JWT sign/verify (HS256, used by Lambda + Express)
  functions/
    authorizer.ts                      # Lambda: path-aware auth (OAuth pass-through, JWT + static)
  vault-mcp/
    server.ts                          # Entry point — config, mount routes, listen
    mcp-router.ts                      # /mcp session routes + transport lifecycle
    oauth-routes.ts                    # SDK auth router + consent form handler
    oauth-provider.ts                  # OAuthServerProvider — JWT tokens, SQLite persistence
    consent-page.ts                    # HTML consent page for OAuth authorization
    tool-definitions.ts                # MCP tool registrations + Zod schemas
    vault-filesystem.ts                # Read/write/list/delete .md files
    vault-patcher.ts                   # Surgical edits: heading-targeted patch + find-and-replace
    memory-store.ts                    # About Me/ heading-aware read/append/delete
    search-index.ts                    # SQLite FTS5 factory (tags, folders, etc)
    file-watcher.ts                    # chokidar -> keeps index current
                                       # Phase 2: gains LightRAG ingestion hook
```

## Tooling

When working on this repo in Claude Code, the deployed `vault-cortex` MCP
connector is typically loaded as deferred tools (names like
`mcp__*__vault_*`). Before claiming inability to read or write the vault,
check the deferred-tools list and load schemas via `ToolSearch`. The
connector exposes `vault_read_note`, `vault_search`, `vault_get_memory`,
`vault_write_note`, and the rest of the API in
`src/vault-mcp/tool-definitions.ts`.

## Logging

Root logger at `src/logger.ts`. Structured JSON to stdout/stderr.

**Log format:**

```json
{
  "timestamp": "...",
  "level": "info",
  "name": "vault-cortex",
  "message": "read note",
  "source": "vault-filesystem.ts:67",
  "requestId": "1",
  "sessionId": "abc",
  "tool": "vault_read_note",
  "clientIp": "73.48.22.1",
  "path": "About Me/Principles.md"
}
```

- `timestamp` — ISO 8601
- `source` — `filename.ts:line` (auto-captured via V8 `prepareStackTrace`
  on info/warn/error; skipped at debug level for performance)
- Contextual properties (`requestId`, `sessionId`, `tool`, `clientIp`)
  are carried by child loggers, not passed per call

**Logger chain — context flows via `.child()`:**

```
root logger (src/logger.ts)
  → session logger: logger.child({ sessionId, clientIp })
    → request logger: sessionLogger.child({ requestId, tool })
      → passed to data-layer functions as required `logger` param
```

- `server.ts` creates a **session logger** when a new MCP session
  initializes, adding `sessionId` + `clientIp`
- `tool-definitions.ts` creates a **request logger** per tool call,
  adding `requestId` + `tool` name from the MCP SDK's
  `RequestHandlerExtra`
- Data-layer functions (`vault-filesystem`, `memory-store`,
  `search-index`) take the logger as a **required** second argument
  (two-arg pattern: `(params, logger)`)
- Background callers (file-watcher, startup) use the root logger
  directly — no request context available

**Two-arg `(params, logger)` pattern:**

All data-layer functions use named params + required logger:

```typescript
vaultFs.readNote({ vaultPath, path }, reqLogger)
memoryStore.getMemory({ vaultPath, file, section }, reqLogger)
search.fullTextSearch({ query, filters }, reqLogger)
```

**Log levels:**

| Level   | Meaning                                       | Alert-worthy? |
| ------- | --------------------------------------------- | ------------- |
| `error` | Something is broken — needs investigation     | Yes           |
| `warn`  | Unexpected but not broken (bad client input)  | No            |
| `info`  | Normal operations (tool calls, reads, writes) | No            |
| `debug` | Verbose tracing (file watcher, dev only)      | No            |

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

Deployment walkthrough lives in `README.md` (it's the front door —
humans land there first). Keep
this file focused on conventions; don't duplicate procedure here.

## Before going public

Before this repo is made public, work through the pre-public hardening
checklist (SSH `0.0.0.0/0` → admin IP, API Gateway throttling, full
git-history secret scan, etc). See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full list
once it's written.

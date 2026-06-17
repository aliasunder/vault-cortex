# AGENTS.md

Project conventions for AI-assisted development on vault-cortex — for Claude Code and other AI agents.

## What this project is

Remote MCP server exposing an Obsidian vault over HTTPS. Two services on
Lightsail via Docker Compose: obsidian-sync (bidirectional Obsidian Sync),
vault-mcp (MCP server, UID 1000). The obsidian-sync image is a fork of
Belphemur/obsidian-headless-sync-docker that chowns its config dir at build
time (so no init container is needed) and registers the initial Sync device
under DEVICE_NAME.
Fronted by API Gateway with a smart Lambda authorizer (path-aware: OAuth
endpoints pass through, /mcp validates static token or JWT). IaC via SST v4.

**Phase 1** delivers vault CRUD, full-text search (SQLite FTS5), and the
About Me/ memory layer — enough to make any MCP client personalized.

**Phase 2** adds semantic / knowledge-graph queries over the vault. The
file watcher gains a second hook for semantic ingestion, and a new
`vault_query_kb` tool is added. Additive — not a rewrite.

All solutions must be portable — they can't rely on one-off manual fixes,
hardcoded paths, or user-specific configuration. If it works only on
the author's machine, it's not done.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Structure

```text
sst.config.ts                          # SST v4 IaC (fully implemented)
package.json                           # single package, all deps
tsconfig.json                          # single config
server.json                            # MCP server registry manifest
Dockerfile                             # vault-mcp Docker image
docker-compose.yml                     # Lightsail: obsidian-sync + vault-mcp
docker-compose.local.yml               # Contributor dev: builds from source
.env.example                           # template for Lightsail .env
templates/                             # Bootstrap templates for new vaults
  memory/                              #   About Me/ memory file templates
deploy/                                # End-user quickstart (no clone needed)
  local/                               #   vault-mcp + bind-mounted vault
    README.md                          #     quickstart walkthrough
    docker-compose.yml                 #     just: docker compose up
    .env.example                       #     MCP_AUTH_TOKEN + VAULT_PATH
  remote/                              #   vault-mcp + Obsidian Sync + named volumes
    README.md                          #     quickstart walkthrough (VPS, HTTPS, etc.)
    docker-compose.yml                 #     just: docker compose up
    .env.example                       #     + OBSIDIAN_AUTH_TOKEN, VAULT_NAME, PUBLIC_URL
src/
  logger.ts                            # Root logger (structured JSON, source location)
  auth.ts                              # Shared auth utilities (safeEqual, parseBearer)
  jwt.ts                               # Minimal JWT sign/verify (HS256, used by Lambda + Express)
  functions/
    authorizer.ts                      # Lambda: path-aware auth (OAuth pass-through, JWT + static)
  vault-mcp/
    server.ts                          # Entry point — config, mount routes, listen
    config.ts                          # Env-var loader + ServerConfig type (loadConfig)
    mcp-router.ts                      # /mcp session routes + transport lifecycle
    tool-definitions.ts                # MCP tool registrations + Zod schemas
    vault-operations/                  # Vault content read/write/patch
      vault-filesystem.ts              # Read/write/list/delete .md files; outline + section reads
      vault-patcher.ts                 # Surgical edits: heading-targeted patch + find-and-replace
      heading-parser.ts                # Shared H1–H6 section-span parser (read + patch)
      memory-store.ts                  # About Me/ heading-aware read/append/delete
      daily-notes.ts                   # Daily note config reader + path resolver
    search/                            # SQLite FTS5 indexing + file watching
      search-index.ts                  # SQLite FTS5 factory (tags, folders, etc)
      file-watcher.ts                  # chokidar -> keeps index current
                                       # Phase 2: gains a semantic-ingestion hook
    auth/                              # OAuth 2.1
      oauth-provider.ts                # OAuthServerProvider — JWT tokens, SQLite persistence
      oauth-routes.ts                  # SDK auth router + consent form handler
      consent-page.ts                  # HTML consent page for OAuth authorization
```

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
  "clientIp": "203.0.113.42",
  "path": "About Me/Principles.md"
}
```

- `timestamp` — ISO 8601
- `source` — `filename.ts:line` (auto-captured via V8 `prepareStackTrace`
  on info/warn/error; skipped at debug level for performance)
- Contextual properties (`requestId`, `sessionId`, `tool`, `clientIp`)
  are carried by child loggers, not passed per call

**Logger chain — context flows via `.child()`:**

```text
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
- Data-layer functions (`vault-filesystem`, `vault-patcher`,
  `memory-store`, `search-index`) take the logger as a **required**
  second argument (two-arg pattern: `(params, logger)`)
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
- No `any`. Prefer `async/await` over `.then()`/`.catch()`.
- Luxon `DateTime` over the native `Date` API. Luxon is declarative
  (`DateTime.now().minus({ days: 7 }).toISODate()`), immutable, and
  avoids manual arithmetic (`Date.now() - 7 * 86_400_000`) and
  mutation (`date.setDate()`). Use `DateTime.now()` for current time,
  `.toISO()` for timestamps, `.toISODate()` for date-only strings,
  `.toUnixInteger()` for epoch seconds.
- Immutable by default. Avoid `let` — carry state in reduce
  accumulators, use early returns, or destructure conditional results.
  A bit of duplication is acceptable to keep code immutable and clear.
  When `let` is necessary (caching, parser state), add a comment
  justifying why mutation is needed here.
- Explicit names over abbreviations. Variable names should describe
  what the value _is_, not use shorthand (`availableHeadings` not
  `available`, `searchText` not `needle`, `fileContent` not `raw`).
  This applies everywhere: function params, callback params (`row`
  not `r`, `entry` not `e`, `orphan` not `o`), SQL aliases
  (`element` not `je`), destructured bindings, and loop variables.
- Regex constants get doc comments explaining what they match.
  Inline regexes used more than once should be extracted to a named
  `const` with a doc comment.
- Comments above any logic that is complex or multi-step. A reader
  should not need to pause to understand what the code does. SQL
  with branching logic (CASE, EXISTS subqueries) needs a comment
  explaining the overall strategy before the query.
- Early returns over nested `if/else` — reduces indentation depth
  and cognitive load. Prefer `if (done) return` over wrapping 15
  lines in `if (!done) { ... }`.
- Simple code over clever code when the same outcome is achievable.
  A person should be able to read and follow the code without
  unnecessary cognitive overload.
- MCP tool descriptions include `Example:`, `When to use:`, and
  `Returns:` sections. Include `Errors:` whenever the tool has
  failure modes (with remediation guidance) or a no-match /
  empty-result contract worth clarifying (e.g. "returns an empty
  array, not an error"); omit it only for tools that cannot
  meaningfully fail. Include `Obsidian syntax:` on write tools.

### MCP naming conventions

Two naming layers — MCP (JSON wire format) and TypeScript (internal):

- **MCP inputs and outputs** use `snake_case` — this is the JSON
  shape clients see. Examples: `old_text`, `heading_level`,
  `snippet_tokens`, `additional_properties`, `sample_values`,
  `outgoing_links`, `exclude_folders`, `sort_by`.
- **Internal TypeScript** uses `camelCase` — function params,
  local variables, internal types that never reach the wire.
  Examples: `oldText`, `headingLevel`, `snippetTokens`.
- The mapping happens in `tool-definitions.ts` handlers:
  `replaceAllOccurrences: replace_all_occurrences`.
- Types that ARE the JSON response shape (`PropertyKeyInfo`,
  `SearchResult`, `NoteMetadata`) use `snake_case` for any
  multi-word fields to match the wire format. Single-word fields
  (`path`, `title`, `count`) are the same in both conventions.

### Test conventions

- Tests read as a behavioral spec. One focused `it()` per
  behavior — a failing test name should identify which behavior
  regressed without reading the body.
- `const` per test over `let` in `beforeEach` when possible.
  `beforeEach` is justified for shared setup that all tests in a
  `describe` need (e.g. indexing fixture notes, creating temp dirs).
- Every test must actually verify the behavior it claims to test.
  A folder-filter test must include data both inside and outside the
  folder to confirm exclusion works — not just data inside.
- Tests must fail when the verified behavior breaks. If a test
  claims "body is unchanged", it must assert the full body — not
  a substring that would still match if the body were modified.
- Exact assertions (`toHaveLength(2)`, `toBe("value")`) over
  loose matchers (`toBeGreaterThanOrEqual(1)`, `toBeDefined()`)
  when the expected value is known.
- Explicit callback parameter names — `orphan` not `o`, `entry`
  not `e`, `link` not `l`. Same naming rules as production code.
- Test names match what they assert. If the test asserts 1 result,
  don't name it "returns multiple results."
- Use vitest helpers (`onTestFinished`, `vi.mocked`, `vi.each`)
  before hand-rolling test plumbing.

## SST conventions

- Secrets via `sst.Secret`, PascalCase names. Never hardcode.
- `$interpolate` for `Output<string>` composition.
- Raw Pulumi `aws.*` for Lightsail (no SST component exists).
- `sst.aws.ApiGatewayV2` + `routeUrl()` for HTTP proxy.
- SST bundles Lambda handlers with esbuild from entry file.

## Build pipeline gotcha

`Resource.McpAuthToken` (used by `src/functions/authorizer.ts`) is
typed via `sst-env.d.ts` at the project root, which SST writes when
it runs the resource graph. The file is committed but auto-generated
— on a fresh clone it may be stale, and `npm run build` can fail with
`Property 'McpAuthToken' does not exist on type 'Resource'` until
you've run `npx sst deploy` (or `sst dev`) once for your stage.

If you add or rename a secret in `sst.config.ts`, re-run `sst deploy`
(or `sst dev`) to regenerate `sst-env.d.ts`.

## Operational docs

The README is the front door — humans land there first. The full AWS/SST
deployment walkthrough lives in [`DEPLOY.md`](./DEPLOY.md); the local and
Obsidian-Sync quickstarts live under [`deploy/`](./deploy/). Keep this
file focused on conventions; don't duplicate procedure here.

Contributor and release conventions live in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) — notably, flag a **breaking change**
for the generated release notes with the `breaking-change` PR label (primary)
plus a `BREAKING CHANGE:` footer in the PR description for the descriptive
line; a `!` type marker (`feat(scope)!:`) also works.

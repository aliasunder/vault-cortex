# AGENTS.md

Project conventions for AI-assisted development on vault-cortex — for Claude Code and other AI agents.

## What this project is

Remote MCP server exposing an Obsidian vault over HTTPS. One two-target
Dockerfile builds the `ghcr.io/aliasunder/vault-cortex` image: the `local`
target (`:latest`, the default stage) is tini + the MCP server alone; the
`remote` target (`:remote`) adds s6-overlay supervising both obsidian-sync
(bidirectional Obsidian Sync via the `obsidian-headless` npm CLI) and the MCP
server in a single container — s6 service definitions live in `rootfs/`, and
the init chain registers the initial Sync device under the `DEVICE_NAME` env
var, or the container hostname when unset. Both
processes run as UID 1000 (PUID/PGID-adjustable). Production runs the
`:remote` image on Lightsail as a single Compose service, fronted by API
Gateway: OAuth endpoints and `/healthz` pass straight through, and every
other route goes through a Lambda authorizer that validates the static
token or JWT.
IaC via SST v4.

The server provides vault CRUD, hybrid search (FTS5 keyword and sqlite-vec
vector results fused by Reciprocal Rank Fusion, then reranked by a
cross-encoder; the vector and rerank stages are optional via
`EMBEDDING_ENABLED` and `RERANK_MODE`; see ARCHITECTURE.md → Hybrid Search),
and an optional memory layer (dated-entry notes in the vault's `About Me/`
folder by default, set by `MEMORY_DIR`). The Docker image uses Debian
slim (`node:24-trixie-slim`) because `onnxruntime-node` requires glibc,
and specifically trixie because better-sqlite3 v13's bundled linux-arm64
prebuild needs glibc >= 2.38 (bookworm's 2.36 crash-loops arm64 images).

All solutions must be portable — they can't rely on one-off manual fixes,
hardcoded paths, or user-specific configuration. If it works only on
the author's machine, it's not done.

Design for the Obsidian user. The end user is always an Obsidian user, so
anything that mirrors an Obsidian concept — backlinks, outgoing links, orphans,
the graph, tags, properties, daily notes — must match what Obsidian itself does.
At minimum, recognize every form Obsidian recognizes; behavior that is a strict
subset of Obsidian's is a bug, not a limitation. For link resolution
specifically, that means all of Obsidian's link styles (`[[wikilink]]`,
`[[wikilink|alias]]`, `[[wikilink#heading]]`, `![[embed]]`, `[md](path.md)`,
`![alt](image.png)`),
links in frontmatter properties (e.g. `related:`), and all three "New link
format" modes — shortest path, path from vault folder, and path from current
file (including relative `../` paths).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Structure

The tree lists the main folders, a few root files, the loose files in `src/`
and `src/vault-mcp/`, and single-file folders. Where the names help, a
folder's comment names its main modules, without the `.ts` extension. Inside
a folder, a file gets its own line only when its comment states a constraint
the name does not show. Test folders appear only when their harness needs
explaining. Routine files (READMEs and other top-level docs, compose files,
tool configs such as `package.json`, `tsconfig.json`, and `eslint.config.ts`,
and the `.github/`, `.devin/`, and `.husky/` folders) are left out; run `ls`
on a folder for the full list.

```text
server.json # MCP server registry manifest
render.yaml # Render Blueprint; stays at the repo root, the only place Render reads it
Dockerfile # Two-target build: local (default) + remote
.claude/ # Committed dependency hooks (the rest is gitignored); settings.json registers Claude Code setup
  hooks/install-deps.sh # Claude session/worktree setup; loads the checkout's Node and installs dependencies/SST types when needed
  hooks/prepare-command.sh # Optional command interface: environment selects Node; prepare also runs dependency setup
obsidian-headless/ # Lockfile-pinned obsidian-headless Sync CLI for the :remote image
rootfs/ # Container filesystem overlay for the :remote image: s6 init chain and services in etc/s6-overlay/, and usr/local/bin/get-sync-token, an in-container terminal sign-in to Obsidian that prints the Sync token for .env
templates/memory/ # About Me/ memory file templates for new vaults
deploy/ # End-user quickstarts (no clone needed): local/ and remote/ (guide, compose file, .env.example), render/ and railway/ (one-click guides; the Railway template definition lives in CONTRIBUTING.md)
assets/ # Static assets (not shipped in Docker)
scripts/ # Dev and ops helpers in TypeScript (not shipped in Docker); most open with a header comment saying what they do
  deployment-env.ts # Loads ~/.config/vault-cortex/.env; shell variables override its values
  instance-env.ts # Derives PUBLIC_URL for manual deploys (npm run lightsail:up) the same way sst.config.ts and deploy.yml do, or the Lambda authorizer rejects tokens
  tool-surface-capture.ts # Boots one server per settings combination for the tool-surface snapshot test, size report, and LobeHub manifest; an on/off setting that gates tools goes in its SURFACE_AXES
  obsidian-tag-oracle.ts, generate-body-tag-vectors.ts, compare-body-tags-random.ts # Check body tags against Obsidian's own parser (see "Upgrading remark-parse")
cli/src/ # npx vault-cortex CLI, run on the host: bin (entry) → main (wiring) → program (Commander), the only loose files; layers under "CLI layering"
  adapters/ # The outside world: docker, prompts, env-file (.env read and write), vault, token
  rules/ # Decisions and text, with no file, Docker or prompt I/O: env-values (.env parse and typed getters), ports, messages, env-templates, node-version
  steps/ # Shared workflow pieces: deployment, container-start, port-prompt, instance-identity, optional-settings, obsidian-sign-in
  commands/ # One module per command: init, configure, upgrade, get-sync-token; lifecycle holds start, restart, logs, and down
  __tests__/integration/ # Interactive flows through node-pty in a real PTY: pty-harness, the cli-pty tests, and a fake docker binary in fixtures/
src/
  logger.ts # Root logger (structured JSON, source location)
  auth.ts # Auth helpers shared by the Lambda authorizer and vault-mcp/
  jwt.ts # Minimal HS256 JWT sign and verify for the Lambda authorizer and the OAuth server
  http-error-middleware.ts # Express error handler shared by the full server and setup mode: short 4xx for bad request bodies, 500 with a stack otherwise
  utils/ # Generic helpers with no domain logic (admission rules under Module layering)
  functions/authorizer.ts # Lambda: validates the static token or a JWT on every protected route
  __tests__/integration/ # Server tests over real HTTP through the SDK Client; files listed under "Integration tests — when to add"
  __tests__/docker/ # :remote image boot tests (npm run test:remote-boot): docker-harness, and fixtures/ob, a stub of the obsidian-headless CLI
  vault-mcp/
    server.ts, config.ts # Entry point and env-var loader, the only loose files here
    obsidian-markdown/ # Pure parsers and transforms with no I/O (pdf-engine excepted): lines, frontmatter, callouts, headings, links, tags, body-tags + obsidian-remark-parser + remark-ports/, tasks, recurrence, memory-entries, canvas, file-kinds, html, plaintext, pdf + pdf-engine, moment-format
    vault-operations/ # Vault read, write, and patch: vault-filesystem (base I/O), vault-patcher, note-mover, memory-store, daily-notes, vault-folder-config, task-mutations, task-format-config, trash-config, trash-sweeper, asset-operations
    mcp-core/ # MCP protocol surface: mcp-router, tool-registry, tool-availability, tool-definitions, prompt-definitions, coded-error-remedy
      tools/ # One <domain>-tools module per data-layer domain (vault-crud, search, task, memory, daily-note, asset), plus tool-helpers
      prompts/ # One <name>-prompt module per prompt (vault-orientation, memory-review, daily-review), plus prompt-helpers
    search/ # SQLite FTS5, hybrid search, file watching, embedding: search-index, search-queries, fts-query, hybrid-search, search-helpers, rrf, embedder, reranker, search-models, chunker, file-watcher, body-tag-parser + body-tag-worker (body tags parsed in a worker thread)
    oauth/ # OAuth 2.1: oauth-provider, oauth-routes, consent-page
    setup/ # Setup mode (browser sign-in to Obsidian Sync while the :remote image has no working token): setup-server (entry), setup-routes, setup-page, obsidian-api, vault-key, sync-token-store
```

### Module layering

The `vault-mcp/` tree is organized in dependency layers — leaf layers
(`obsidian-markdown/` parsers, plus `src/utils/`) → I/O and use-cases
(`vault-operations/`, `search/`) → protocol (`mcp-core/`, `oauth/`, `setup/`)
→ wiring (`server.ts`).
A module's folder is decided by **what it depends on**, not just its topic:

- **`obsidian-markdown/`** — pure parsers/transforms over Obsidian's file
  formats (frontmatter, lines, headings, callouts, links). **No fs, no SQLite,
  no MCP**; they take strings/lines and return data or transformed strings, so
  they're trivially unit-testable. The folder's contract is the dependency
  profile, not the syntax family: `canvas.ts` parses JSON
  ([JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/)),
  but its text nodes and its linearized output are markdown, and it's the same
  pure leaf layer — Obsidian format parsers belong here regardless of whether
  the format is markdown, JSON, or YAML. `lines.ts` is the single home of the
  [CommonMark §4.5](https://spec.commonmark.org/0.31.2/#fenced-code-blocks)
  fence state machine (`advanceFence`) — every function that walks lines
  and tracks code fences calls it, so they can't disagree about where a
  fence opens.
  - **PDF engine exception:** `pdf-engine.ts` is the one module in this folder
    that performs side effects — it resolves `pdfjs-dist` package paths from
    disk via `createRequire` and sets the pdfjs build unpdf uses for the whole
    process (`definePDFJSModule`). It lives here because it is PDF domain
    logic: the bootstrap that configures pdfjs so `pdf.ts`'s extraction
    pipeline works. The two PDF
    modules are a unit and belong together in the parser layer.
    `pdf.ts` imports it as a sibling for the `extractPdfText` pipeline.
  - **Dual-format task mutations:** `tasks.ts` reads **and writes** both emoji
    signifiers (`✅`, `📅`, `⏫`) and Dataview inline fields
    (`[completion:: date]`, `[priority:: high]`). Mutation functions must strip
    both formats when removing a field (a Dataview-formatted task must not get
    fields orphaned). `tasks.ts` takes the format as a parameter;
    `vault-operations/task-format-config.ts` decides it from the user's Tasks
    plugin settings (`taskFormat` in
    `.obsidian/plugins/obsidian-tasks-plugin/data.json`, emoji by default), and
    its `setDoneDate`/`setCancelledDate` switches control whether completion
    dates are stamped at all. When `.obsidian/` is not synced to the server,
    `task-format-config.ts` falls back to emoji.
- **`vault-operations/`** — everything that reads/writes the vault.
  `vault-filesystem.ts` is the base I/O primitive (atomic writes, path-safety,
  read/list/delete); `vault-patcher`, `note-mover`, `memory-store`, and
  `daily-notes` are use-cases composing it with the parsers. The line between
  `vault-filesystem.ts` and `utils/fs.ts` is **policy vs. adapter**: `utils/fs.ts`
  holds only policy-free `node:fs` wrappers (`readFileOrNull`, `readdirOrNull`,
  `fileExists`), while anything that encodes _how the vault is written or guarded_
  — the atomic-write strategy, vault-root path-safety, the `vaultFs` data API —
  stays in `vault-filesystem.ts`. "Mechanically generic" (an atomic write works on
  any file) isn't enough to demote something to `utils/` if it's load-bearing
  vault-I/O policy.
- **`mcp-core/`** — the MCP protocol surface. `tool-registry.ts` is the
  declarative registry: every tool's wire name, feature group, and MCP
  annotations in one leaf module with zero imports (config validation and
  tests consume it without loading the tool layer). `tool-definitions.ts` is
  the orchestrator: it computes the enabled tool set by filtering the
  registry through one AND-chain of predicates — group flags
  (`MEMORY_ENABLED`, `FILE_TOOLS_ENABLED`), read-only mode via each tool's
  own `readOnlyHint` annotation, and the subtractive `DISABLED_TOOLS` list —
  then invokes each group's register function with a gated `registerTool`
  wrapper that skips disabled names and injects the registry's annotations
  (the wrapper's config type has no `annotations` key, so restating them
  inline is a compile error). A new gating axis is one new predicate, never
  new branching in group modules. `tool-availability.ts` is where "given the
  enabled set, how do you talk about tools" lives — `isToolEnabled`,
  `whenToolEnabledText`, and `formatEnabledToolList` (which narrows a list of tool
  names to the served ones and renders it as prose, empty when none survives).
  All three text surfaces — tool descriptions, prompt steps, and the router's
  server metadata — build on that one view, so a cross-reference disappears
  whenever its target does. It sits at `mcp-core/` root precisely because
  `tools/` and `prompts/` both need it and cannot import each other. Each group
  module is self-contained: one register function and its data-layer imports,
  with tool names imported from the registry. Shared helpers
  (`createSafeHandlers`, `formatNoteMetadata`, `ToolRegistrationContext`
  type) live in `tool-helpers.ts`. Group modules take `safeHandler` and
  `safeHandlerContent` from the registration context; `createSafeHandlers`
  builds them per server from the enabled tools and the vault path.
  **Tool handlers stay thin**: schema, wire mapping (snake_case ↔ camelCase),
  one data-layer call, and content-block/JSON formatting. Multi-step
  composition — filtering, counting, pagination, dispatching across parsers
  and I/O — is a _use-case_ and belongs in `vault-operations/`
  (`asset-operations.ts` is the worked example). The
  smell: a handler importing a parser to orchestrate between two data-layer
  calls; the fix is a use-case module, not a bigger handler.
  `prompt-definitions.ts` is the orchestrator that composes `PROMPT_NAMES` from
  three group modules under `mcp-core/prompts/` (vault-orientation, memory-review,
  daily-review) — mirroring the `tools/` pattern. Shared helpers
  (`PromptRegistrationContext` type, `textResult`, and `wrapWithDataMarkers`,
  which wraps vault content in `<vault-content>` tags so the model treats it as
  data) live in `prompt-helpers.ts`.
- **`search/`** — SQLite FTS5 + sqlite-vec index, embedding pipeline, file watcher.
- **`oauth/`** — the OAuth 2.1 server (distinct from the shared `src/auth.ts`
  token utilities).
- **`setup/`** — the `:remote` image's setup mode. Contains the sign-in
  page served while the container has no working Obsidian Sync token, the
  Obsidian account API client, and the token store. A sibling surface to
  `oauth/`, not a layer below it: builds on `config.ts`, `src/auth.ts`,
  and `utils/`; nothing lower imports it (lint-enforced: each lower layer's
  `no-restricted-imports` bans `setup/` and `oauth/`).
  `rootfs/etc/s6-overlay/s6-rc.d/svc-vault-mcp/run` starts `setup-server.ts`
  instead of `server.ts` when the init chain sets `SETUP_MODE`:
  `init-check-auth` when no token exists, `init-obsidian-login` when the
  saved token's login is rejected.
- **`utils/`** (at `src/`) — generic cross-cutting helpers.

Three rules keep this honest:

- **Dependency direction.** `obsidian-markdown/` and `utils/` depend on nothing
  internal (leaf layers); `vault-operations/` and `search/` depend on those;
  `mcp-core/` and the top-level wiring depend on everything. A _search_ module
  importing a _parser_ should read as "uses the shared parser," never as reaching
  sideways into `vault-operations/`.
- **Group operations by shared dependency layer, not by topic.** A domain's
  operations live together only when they share a layer: asset read + browse
  are both filesystem work, so `asset-operations.ts` holds both. Task list
  (a SQL query — lives with the queries in `search/`) and task update (a file
  mutation — `task-mutations.ts`) stay apart, and so do note search and note
  mutations. A topic-symmetric "one module per domain" grouping that crosses
  layers is the smell, not the goal — each file answers for one layer's view
  of its domain.
- **Top level is wiring only.** Folders are domains; the only loose files at
  `vault-mcp/` are the entry point (`server.ts`) and its `config.ts` — the
  setup-mode entry point stays inside `setup/`.

The dependency-direction rule is lint-enforced: `eslint.config.ts` bans runtime
cross-layer imports per folder via `@typescript-eslint/no-restricted-imports`
(type-only imports allowed — erased at compile time; tests exempt).

**Tool-surface rules are lint-enforced too** — the registry owns tool identity,
and gating is derived once rather than re-decided per call site:

- **`config.readOnlyMode` is banned throughout `mcp-core/`** except
  `tool-definitions.ts`, which is where the predicate lives. Everything
  downstream — descriptions, prompt steps, router metadata — keys on the enabled
  set through `isToolEnabled` / `whenToolEnabledText`. The flag knows nothing about
  `DISABLED_TOOLS` or any axis added later, so branching on it is how a prompt
  ends up naming a tool the server never registered. Banned as a member access
  and as a destructured binding.
- **A local `TOOL_NAMES` in `mcp-core/tools/` or `mcp-core/prompts/` is an
  error** — import it from `tool-registry.ts`. A local copy compiles and passes
  tests while drifting.
- **`prompts/` and `tools/` cannot import each other at runtime.** They are
  sibling surfaces, not a layer stack; a helper both need is either generic
  enough for `utils/` or belongs in that group's own helpers module.

Before editing these lint rules, read the comments in `eslint.config.ts`:
a narrower config block's rule options replace the wider block's instead of
merging, and import patterns match the specifier as written. Confirm any new
rule fires on a deliberately added violation.

**`utils/` admission:** a helper belongs here only if it is **generic with zero
domain knowledge** (no vault, Markdown, or MCP concepts) **and** clears one of two
bars:

- **(1) It removes real duplication** — already called from more than one place
  (`describeError`, `readFileOrNull`).
- **(2) It's a complete, standalone primitive** — you could name, describe, and
  test it without mentioning any caller or the vault, and it would look at home in
  a standard library (`mapWithConcurrency` — a bounded-concurrency async map). This
  bar admits a single-caller helper; bar (1) does not.

Premature-abstraction guard: if the only way to explain the helper is "the part of
`someFunction` that does X," it fails bar (2) — it's a _fragment_, not a primitive,
so keep it private until a second caller appears. Markdown logic is domain — it
goes in `obsidian-markdown/`, never `utils/`.

`import type` from infrastructure modules (`Logger`, config types) is fine in
`utils/` — type-only imports are erased at compile time and don't create runtime
coupling. Don't reinvent a type with a structural stand-in when the real type
exists.

**Export style** depends on what kind of module it is:

- **Operation / data-layer modules** — anything that performs vault or index
  operations — export a **single namespace object** so call sites self-document
  which module an operation belongs to: `vaultFs.readNote(…)`,
  `vaultPatcher.patchNote(…)`, `noteMover.moveNote(…)`,
  `assetOperations.readAssetContent(…)`.
  **Function count is irrelevant** — `noteMover` is essentially a
  single-operation module and still exports a namespace; "it only has one
  function" is not the named-export test. Stateful ones use a
  **factory-closure** returning that object (`createSearchIndex`,
  `createMemoryStore`), so prepared statements / caches live in the closure.
- **Parser, small-helper, and config-reader modules** — the
  `obsidian-markdown/` parsers (`frontmatter`, `headings`, `callouts`,
  `lines`), `utils/`, and the config readers (`daily-notes`,
  `task-format-config`, `trash-config`) — export **named functions**. The shape tracks whether
  a module _performs operations_ (→ namespace) or _parses/reads
  configuration_ (→ named), **not** whether it does I/O: the parsers are pure,
  while the config readers do light I/O, yet both use named exports because
  neither is an operation surface.
- **`links.ts` is the deliberate edge case** — a pure parser that nonetheless
  exports a single `links` namespace to keep link recognition private behind
  position-safe methods. Its scanners own their cursors per call; the remaining
  `/g` inline-code regex is used through `matchAll` and `replace`.

`vault-filesystem.ts` illustrates the nuance within one module: its high-level
data API is grouped under `vaultFs`, but its low-level shared primitives
(`resolveSafePath`, `atomicWriteFile`, `pruneEmptyParents`, …) are **named
exports** — infrastructure consumed à la carte by other modules, not part of the
vault data API.

### CLI layering

`cli/src/` follows the same rule as the server: a module's folder is decided by
what it depends on. `bin.ts`, `main.ts` and `program.ts` are the wiring and the
only loose files.

| Layer       | Holds                                                                                                                                             | May import at runtime        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `adapters/` | The outside world: Docker, the terminal prompts, `.env` file I/O, vault path, token                                                               | nothing internal             |
| `rules/`    | Decisions and text, with no file, Docker or prompt I/O: `.env` parsing and typed getters, ports, messages, templates                              | other rules                  |
| `steps/`    | Shared workflow pieces: deployment checks, the container start, the free-port question, instance identity, the settings chooser, Obsidian sign-in | rules, adapters, other steps |
| `commands/` | One module per command (`lifecycle` holds start, restart, logs and down)                                                                          | steps, rules, adapters       |

- **Shared logic moves down.** When two commands need the same step, it goes
  in `steps/`, never in one command for the other to import. A message or
  command line two modules print goes in `rules/messages.ts`
  (`vaultCortexCommand` builds every `npx vault-cortex@latest …` line).
- **Pure decisions stay out of prompts.** A rule returns its decision as data
  (`decidePort`), and a step acts on it, so `--yes` and the interactive flow
  share one decision.
- **Type-only imports cross any layer,** as in the server: `rules/` takes the
  `Mode`, `DaemonStatus` and `PublishedPort` types from `adapters/docker.ts`.
- **Export style** follows the server's: the `.env` file adapter and the
  container start step export one namespace object (`envFile`,
  `containerStart`), the Docker and prompt adapters export a factory that
  returns one (`createDockerRunner`, `createPrompts`), and every other module,
  rules included, exports named functions.

Lint enforces the direction: `eslint.config.ts` has one
`no-restricted-imports` block per CLI folder, and `rules/` also bans `node:fs`,
`node:child_process` and `@clack/prompts`. Tests are exempt.

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

- `mcp-core/mcp-router.ts` creates a **session logger** when a new MCP
  session initializes, adding `sessionId` + `clientIp`
- Child props may be **function-valued** — resolved fresh on every emit.
  Use `() => value` for context that doesn't exist at child-creation
  time (the session logger's `sessionId` is generated by the SDK
  transport only while it handles the initialize request)
- Each tool group module (`mcp-core/tools/*.ts`) creates a **request
  logger** per tool call, adding `requestId` (from the MCP SDK's
  `RequestHandlerExtra`) + `tool` name (from the shared `TOOL_NAMES`
  constant in `tool-registry.ts`)
- Data-layer functions (`vault-filesystem`, `vault-patcher`,
  `note-mover`, `memory-store`, `search-index`) take the logger as a
  **required** second argument (two-arg pattern: `(params, logger)`)
- Background modules (`file-watcher`) take the logger the same way,
  through their entry point. Startup wiring in `server.ts` has no
  request context, so it passes the root logger

**Two-arg `(params, logger)` pattern:**

All data-layer functions use named params + required logger:

```typescript
vaultFs.readNote({ vaultPath, path }, reqLogger)
memoryStore.getMemory({ vaultPath, file, section }, reqLogger)
search.fullTextSearch({ query, filters }, reqLogger) // search: the SearchIndex on ToolRegistrationContext
```

**Log levels:**

| Level   | Meaning                                       | Alert-worthy? |
| ------- | --------------------------------------------- | ------------- |
| `error` | Something is broken — needs investigation     | Yes           |
| `warn`  | Unexpected but not broken (bad client input)  | No            |
| `info`  | Normal operations (tool calls, reads, writes) | No            |
| `debug` | Verbose tracing (file watcher, dev only)      | No            |

**info vs debug boundary:** `info` is for **per-request summaries** —
one log per tool call or lifecycle event (startup, shutdown, rebuild).
`debug` is for **per-file background events** — fired by the file
watcher or during bulk indexing, with no user-initiated action. If the
log would produce N lines during a vault rebuild (one per note), it's
`debug`; if it produces one summary line, it's `info`.

**Log content and security:**

- Never log PII, credentials, tokens, or secrets — not in messages,
  not in structured fields, not in tests (fake fixtures only). Log
  identifiers (`sessionId`), never identity payloads such as an account
  email or name.
- Pass field values as they are: the logger caps every string it logs.
- Redact by destructuring the sensitive keys out:
  `const { password, token, ...safe } = payload`. Keep the payload typed
  (no `any`), and never `delete` keys from a copy.
- If a child-process command contains sensitive values, catch a failure
  at the call site and log a sanitized description. A rethrow must be a
  new error without `{ cause }`: the original message, and any cause chain
  carrying it, expose the full command.
- Layer-appropriate messages: internal/data-layer functions describe
  what went wrong in their own domain and never name API surfaces
  (tool names, routes) or prescribe caller-level remediation.
- Log full detail internally, return generic messages externally —
  error responses to clients never include the server's own paths,
  stack traces, or implementation state. A Node error's paths reach the
  client vault-relative, because the tool and prompt boundaries rewrite
  them (`describeErrorRelativeTo`), so a wrapper passes the Node error as
  `cause` and never copies its message into its own. Errors the server
  throws itself keep their text, since they can quote the caller's input
  (a refused absolute path comes back as sent).
- `/healthz` needs no sign-in, so never add deployment settings or host
  details to its response. The full server returns `{ ok: true }`, and
  setup mode adds `mode: "setup"` so the setup page can tell when the full
  server is back.

## Platform

The server runs in Linux Docker — even on Windows and macOS, Docker
Desktop runs a Linux VM internally. Path operations (`relative`,
`join`, `basename`) produce POSIX separators (`/`) in all deployment
paths; `WINDOWS_MODE=true` handles Docker Desktop's WSL2 bind mount
limitations (no hard links, polling for file watching) but does not
change path separator behavior. Native Windows execution (without
Docker) is not a supported deployment and would break path handling
throughout the codebase.

## Dependency setup for agent commands

Before integrating agent command setup, read [Agent command setup](./CONTRIBUTING.md#agent-command-setup).

## Code style

<!-- distilled from vault Reference/code-standards-* on 2026-11-03; refresh (merges, keeps hand edits): run the sync-code-standards skill -->

These rules are authoring guidance, not a review checklist. Apply them
while writing, not after. `eslint.config.ts` enforces this subset:

- No `function` declarations, and `type` over `interface`.
- No `any`, `as` casts other than `as const`, or `!` non-null assertions
  (warnings only in tests).
- No nested ternaries, and no `else` after `return`.
- No single-character identifiers (lint allows `i`, `a`/`b`, `k`, `_`).
- No empty `catch {}` blocks (lint does not flag `.catch(() => {})`).
- A blank line between a declaration and the guard that consumes it.
- In `src/` only: no `console`; Luxon over `Date` and no `process.env`
  member access outside `config.ts` (tests exempt). The rule misses a
  destructured `import { env } from "node:process"`, which `logger.ts` uses.
- The Module layering bans (layer imports, `config.readOnlyMode`, a local
  `TOOL_NAMES`).

The rest are the author's responsibility at write time.

### Tooling and project defaults

- TypeScript strict mode. `node:` prefix for built-ins. Explicit return
  types on exports. Zod for MCP tool schemas.
- Factory/closure pattern for stateful modules (see `search-index.ts`);
  export style is under "Module layering" above.
- Luxon `DateTime` over the native `Date` API (`DateTime.now()`,
  `.toISO()`, `.toISODate()`, `.toUnixInteger()`); no manual millisecond
  arithmetic or `setDate()` mutation.
- Standalone scripts are TypeScript (`.ts`, tsx-compatible), never
  `.mjs`/`.js`; `scripts/` meets the same bar as `src/`.
- Default-on features get an explicit sentinel off switch
  (`SYNC_CONFIGS=none`), never empty/unset semantics: the sentinel is
  greppable and keeps `${VAR:-default}` compose interpolation working.
- Public config switches are named for the user's mental model
  (`READONLY_MODE`, the term users search for), not internal symmetry
  (`WRITE_TOOLS_ENABLED`).
- Pin what must match across machines: overrides to exact versions; a dev
  tool used locally and in CI to one version plus each platform's archive
  SHA-256, verified on first download, never a package manager's current
  version or an npm wrapper fetching an unverified binary.
- Vet a new dependency (maintainers, releases, downloads) before adopting
  it; at negligible adoption with a small core, write it locally.
  Established high-adoption libraries are exempt.

### Naming

- Values are named for what they are: `availableHeadings` not
  `available`, `searchText` not `needle`, `filesIndexed` not `count`.
  This holds everywhere, including callback params (`entry` not `e`),
  SQL aliases (`element` not `je`) and loop variables. A placeholder
  (`row`, `item`) fails whenever a domain noun exists.
- Category constants name the domain contrast they represent
  (`CONCRETE_STATUSES`, not `ALL_REAL_STATUSES`), and pipeline
  intermediates keep the domain noun on every step (`statusInput` →
  `statusValues` → `expandedStatusValues`).
- Alias generic destructured keys with their source when the use sites
  do not show the destructure (`{ on: modifiedOn }` from
  `filters.modified`). Bare keys are fine when self-describing or when
  every use stays nearby.
- Functions are named for their point. Side-effect functions say what
  they do (`collectWikilinksFrom` not `collect`); value-returning
  functions name the return (`getPdfEngine`, not `ensurePdfEngine`);
  converters go input noun → output noun. No trailing `Of`
  (`laneRecordOf` → `findLaneRecord`); rename an existing one only when a
  change already touches it. A docstring never excuses a vague name.
- Booleans are named for the affirmative state: `hardLinksSupported: false`,
  never `hardLinksUnsupported: true`. Guard booleans name the action they
  control (`needsStatusFilter`). A double negative is a smell.
- No planning-session coinages in identifiers; sweep new identifiers
  before landing.
- Wire names (`snake_case`) and internal names (`camelCase`) are two
  layers mapped at the handler boundary; see "MCP naming conventions".

### Structure and control flow

- Early return from the simpler branch so the main path flows linearly;
  in loops, `if (cond) { …; continue }` over `if/else if` chains.
- `while (condition)` over `for (;;)` + `break` when the exit condition
  fits the loop head.
- Never a chained ternary or a `let` assigned through if/else branches:
  one `if … return` per branch in a small helper, or one named const per
  step.
- Extract a multi-clause condition into a named boolean:
  `if (hasDeletedNotes)` over
  `if (deletedPaths.length > 0 && deleteVectorsForNoteStmt && …)`.
- Blank lines separate logical sections inside a function; a comment
  never glues onto the previous statement.
- Block bodies `{}` for any multiline function response; expression
  bodies only for trivial one-liners.
- Break nested composition into named steps at about two nesting levels
  (`[...new Set(items.flatMap(transform))]` becomes two named consts); a
  single `items.map(f)` stays inline.
- Extract multi-step `.map()`/`.reduce()` callbacks into named functions
  when they build intermediates or nest chains; name non-trivial
  `.filter()` predicates. Conditional spreads and `.filter(Boolean)`
  assembly are both fine; don't convert one to the other.
- Named params when a positional value hides its role at the call site,
  even for one literal; always above two args or for adjacent same-typed
  args. Keep a clear one- or two-arg call positional.
- A boolean mode param means the function does two things: split it;
  the caller owns the gating.
- Decomposition must earn its seams; DRY targets shared decisions, not
  repeated text. A one-expression SDK or Zod wrapper stays inline; a
  parameter a function only forwards is a wrong seam (compile config into
  a closure); files that only import each other need an independent
  consumer.
- Plain values over thunks: when every caller passes
  `() => alreadyComputed`, accept the value.
- Named records over positional tuples (`{ start, end }` over
  `[start, end] as const`) and named locals over cryptic sub-expressions,
  where it helps a line read on its own; this is judgment, not mechanical
  extraction.
- Named constants over bare mode, permission and other magic literals,
  with the one-line why at the definition; scope constants to where they
  are used.
- Platform built-ins over hand-rolled parsing: check Node 24's stdlib
  (static `URL.parse`) before `split`/slice/regex over URLs, paths,
  headers or dates. With no built-in parser, compare exact values; use a
  doc-commented regex with named groups only when values genuinely vary.
- Cut user-visible text on whole graphemes: apply a code-point limit,
  then back up to the start of any grapheme the cut splits
  (`Intl.Segmenter`); never slice UTF-16 units. Internal byte caps only
  need whole code points.
- Cross-process locks use a kernel-released primitive (`flock`), never a
  lock file with a takeover; in-process concurrency uses the language's
  own primitives.
- Prefer simple over clever; working is the floor, not the bar. Before
  settling, ask whether fewer moving parts and fewer lines do the job.
  Each line says what it does on its own.

### Immutability and data flow

- `const` by default; no unjustified `let`. Prefer the immutable methods
  (`toSorted`, `with`, `at(-1)`) and stage multi-step work as named consts
  or pure helpers. A `let` that is necessary (caching, parser state) gets
  a comment saying why. Readability gates any refactor toward a more
  functional shape.
- Never disguise mutation as a fold: a `reduce` that mutates its
  accumulator (`acc.push(…)`, then `return acc`) is banned. A genuine
  immutable fold returns a new value each step; a plain commented
  `for…of` loop carries inherently sequential state (a parser threading
  line-by-line state). A map plus a named sum is not a reduce.
- A helper never mutates its inputs, and its signature says so: type
  collection params as `ReadonlyArray`, `ReadonlySet` or `Readonly<T>` and
  return new values. A `const` local collection may be mutated in a plain
  `for…of` loop.
- LLM-facing wire contracts omit an optional field whose absence is
  unambiguous; no always-present zero placeholders. Keep a field when
  `0`/`[]` is a legitimate value or it is structural attribution.
- One meaning per result field. Data from another source gets its own
  field (`body_tags` beside `tags`) so a caller can tell what it may
  edit, and each field's description names the tool that edits it.
- Data-layer functions do not truncate output or return observability
  data: presentation limits belong to the consumer, and the function has
  the logger, so it logs at the site.

### Types

- No `as` or `!` (`as const` exempt); runtime guards or type-guard
  functions instead. When a library returns `T | null` and the null case
  is unreachable (`DateTime.now().toISO()`), throw on null, never
  `?? ""` or another sentinel.
- Truthy/falsy checks over explicit comparisons (`if (!taskLine)`),
  unless `0`, `""` or `false` are legitimate values. Optional chaining
  and nullish coalescing flatten guards (`heading?.text ?? "(none)"`).
  `Boolean(x)` over `!!x`. TS ≥5.5 infers `.filter()` predicates from
  bare null/undefined comparisons; `filter(Boolean)` does not narrow.
- A param consumed only for truthiness is a boolean: type it `boolean`,
  name it for the action it controls, and drop the dead value-or-`""`
  sentinel.
- `type` over `interface` unless declaration merging or `implements` is
  genuinely needed. Type-only imports over structural duplication.
- Model states in the type system. A field doc-commented "present only
  in mode X" becomes a discriminated union; a callback param with a
  closed set of instantiations becomes a discriminated field naming the
  domain choice (`format: "date" | "datetime"`). Branch on a union of
  outcomes with an exhaustive `switch` naming every member, never an `if`
  plus a ternary whose fallback catches the rest unnamed. Reuse
  [type predicates](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates)
  in filters over union members; keep `x is T` bodies to a short `&&`
  chain, and turn a negated `in` or `||` into early returns.
- One discriminant per fact. Two result shapes for the same outcome plus
  a converter between them is a smell: merge into one
  status-discriminated union, and add new cases as members, never a
  second vocabulary.

### Errors

- Per-operation try/catch: each catch encloses one operation with one
  failure meaning. Broad catch-alls are banned; bare `try/finally` for
  resource scoping is fine. `async/await` over `.then()`/`.catch()`
  chains; where `.then()` or `.finally()` is the natural idiom
  (promise-chain serialization queues), use it with a comment.
- Every catch logs or re-throws: `.catch(() => {})` and empty catch
  blocks are banned. Content rules are in "Logging" above.
- Three tiers at input boundaries: invalid → reject; valid with a
  surprising structural consequence → non-blocking advisory;
  machine-derived values (the stored value byte-exactly matches the
  tool's own earlier output) → auto-correct and report. User-authored
  values are never auto-corrected.
- Required inputs are enforced at every entry point: fail fast at
  boot/load, not only the friendliest launcher. Making an
  already-expected value mandatory is a bug fix, not a breaking change.
  Breaking means a documented, supported call or read stops working;
  accidental behaviour and undocumented wire fields can change.
- A declared schema and the runtime say the same thing: never advertise
  a rejection the runtime doesn't perform. A stricter contract is a
  runtime change first, then the schema.
- A guard that cannot engage fails closed (lock not taken, settings file
  present but unparseable): refuse and log why; never run unguarded. A
  missing settings file takes the defaults; readers affecting only reads
  or formatting fall back with a `warn`.
- Error messages use the layer's own names (`includeChildren`, not
  `include_children`); a remedy that names an API param belongs in the
  tool layer. The API-surface rule is under "Logging" above.
- A misleading error that invites destructive recovery is a bug: detect
  the real condition; refuse honestly at minimum, and implement the real
  behaviour when it traces small.
- Prevent a failure rather than document its remedy: make the input
  impossible to get wrong, or accept it, so no `Errors:` entry is needed.
  Code whose only effect is a clearer message for a rare, non-default
  misconfiguration earns no place when it prevents no failure and removes
  no documented error text.

### Modules, SQL and lint

- Layering, dependency direction and `utils/` admission are under
  "Module layering" above; genericize to decouple
  (`assertPathHasExtension(path, ".md")`) rather than moving domain
  policy into `utils/`.
- Prepared statements at factory scope, compiled once; filter inside the
  query before any `LIMIT`/`k` window.
- SQL with branching logic (CASE, EXISTS subqueries) gets a comment
  explaining the overall strategy before the query.
- Multiplying config axes get a declarative registry plus an AND-composed
  predicate chain, never per-flag branching: a new axis is one predicate,
  generated cross-references key on the enabled set, and no alias layer
  survives to dodge migration churn.
- A dead-code-path claim is proven by enumerating every trigger, not by
  log silence; if the path runs, remove it or switch off its trigger.
- Lint-enforce the mechanically checkable conventions: layering via
  per-layer `no-restricted-imports` (`allowTypeImports: true`; tests
  exempt), style via core/typescript-eslint rules. Trial candidates
  against the codebase first; curated exceptions over blanket bans; never
  adopt a rule that fights an established idiom; a justified
  `eslint-disable` with a why-comment beats weakening the rule.
- **knip** (`knip.json`, pre-commit + CI) flags unused exports, types,
  dependencies and files. Remove a flagged `export` rather than adding an
  ignore comment.
- **markdownlint** (`.markdownlint-cli2.jsonc`, lint-staged with `--fix`,
  and CI) enforces blank lines around fences, a language on every fenced
  block and no bare URLs. Ignores are documented in the config.
- **ShellCheck** (`npm run lint:shell`, lint-staged + CI) checks only the
  scripts `SHELL_SCRIPT_GLOBS` in `scripts/lint-shell.ts` lists, so add a
  new shell script's path there. ShellCheck cannot read
  `#!/command/with-contenv sh`, so s6 scripts that start with it carry
  `# shellcheck shell=sh`. A disable directive gets a comment saying why.

### Comments

- Comment decision at write time (`/** */`, only when earned): the
  signature says it → no comment, which is most functions; something
  non-obvious → one-line JSDoc of the constraint the signature can't
  convey; restates the name (`/** Gets the PDF engine. */` on
  `getPdfEngine`) → delete it; explains what instead of why → rewrite as
  the constraint; over two lines → bullets or numbered steps, never
  prose that breaks the blob into smaller blobs.
- Inline comments at the relevant line, not everything in the docstring.
  The docstring states the outward contract; a guard or branch comment
  states the scenario, the mechanism and what breaks without it. When
  code moves into a helper, inline why-comments stay beside the call.
- Chosen numbers in declarative config (caps, timeouts, cadences,
  retention) get a comment directly above stating the why; fixed facts
  need none. Regex constants get a doc comment explaining what they
  match. Borrowed standard terms get a one-line gloss and a link.
- Comment prose uses short complete sentences, with no colon-hinged
  labels and no verbless fragments.
- Durable rationale only, never transition history, decision narrative or
  the maintainer's own infrastructure details. A genuine risk of
  retracing an abandoned error is rationale, not history. OSS boundary:
  issue/PR numbers, incident dates, deployment names, task-board IDs,
  remediation narration and investigation chronology never enter any
  public artifact (committed files, PR descriptions or comments).

### MCP tool definitions

These rules cover the two parts of a tool's definition that carry prose:
the description and each parameter's Zod `.describe()` text.

- **MCP tool descriptions include `Example:`, `When to use:`, and
  `Returns:` sections.** Include `Errors:` whenever the tool has
  failure modes; omit it only for tools that cannot meaningfully fail.
  An empty-result contract ("returns an empty array, not an error")
  goes under `Behavior:`, not `Errors:`. Include `Obsidian syntax:` on
  write tools.
- **`Errors:` lists only failures a client can receive, each proven end
  to end.** A message appears only when a schema-valid call over the
  real transport returns it and a test in
  `server-error-contracts.test.ts` makes that call; a message the input
  schema rejects first is not listed, and a quoted message is the exact
  text the server sends.
- **Errors sharing a remedy share one bullet.** The message carries the
  remedy, so the bullet names which reading needs which fix and lists
  only the messages that tool can raise (`"absolute path blocked"`,
  `"path traversal blocked"`, `"hidden path blocked"`). Every bullet
  still keeps a remedy.
- **Split parameter facts between `.describe()` and the tool
  description.** The calling model receives `.describe()` inside the
  input schema, so the description earns its space (and its grader
  score, such as Glama's TDQS) only with what that text doesn't say.
  `.describe()` gives the parameter's plain meaning, format and default;
  the description gives interactions between parameters, consequences
  and non-obvious semantics. A semantic fact in both stays in the
  description. Never drop a fact only `.describe()` carries.
- **Every sentence changes what a calling agent does.** A sentence earns
  its place when it changes which tool or values the agent sends, what it
  does with the result or an error, whether it picks the tool at all (a
  purpose or sibling-contrast sentence stays), or when it corrects a
  wrong assumption the rest of the definition leaves open. Judge each
  claim on its own. How the server carries out the call (which
  `.obsidian` file holds a setting, how a save stages its write) goes in
  ARCHITECTURE.md, however accurate; the outcome the caller sees stays.
- **State a fact, never its absence, its implication or its mechanism.**
  The reader is an agent picking tools from text it pays for by the
  token. A definition never says that a limit, cap or restriction does
  not exist ("no upper cap"): a limit is named only where one applies,
  and an unnamed one is not assumed. It never spells out what a stated
  fact already implies ("in the server's timezone" already says the day
  may not be the caller's), and never explains a mechanism the agent
  cannot change ("until the index catches up"). The test for any clause:
  delete it, and if the agent would send the same call and read the
  result the same way, it stays deleted.
- **Tool input schemas stay at `.min(1)` — no `.refine`.** Rich
  validation (format, date validity, mutual exclusivity) lives in the
  data layer or handler, where failures flow through `safeHandler` as
  structured tool errors with remediation text and are logged as
  `tool_error`. A Zod failure surfaces as a protocol-level invalid-params
  error that bypasses both, and `.refine` does not serialize into the
  JSON schema clients see; `.min(1)` does (`minLength`).
- **Edit only the tools a change is meant for.** A grader re-scores
  every definition whose text changes, so apply a shared wording change
  tool by tool and leave every other tool's text as it is.
- **`tool-surface-snapshot.test.ts` caps the tool list's size**, because
  clients such as claude.ai load every definition into each
  conversation. Each checked combo's total must stay within
  `CHARS_PER_TOOL_ALLOWANCE` times its tool count.
  `npm run report:tool-surface-size` prints per-tool sizes; run it
  before and after editing a description.

### Adding a new tool

1. **Registry entry** — add the name to `TOOL_NAMES`, then an entry to
   `TOOL_REGISTRY` in `tool-registry.ts`: name, group, and annotations. The
   registry is a leaf module with zero imports.
2. **Handler** — add the tool in the appropriate `tools/*.ts` group
   module. The `registerTool` wrapper auto-injects annotations from
   the registry and enforces the enabled-tool gate. Write the
   description and input schema to the rules in "MCP tool definitions"
   above.
3. **Tests** — unit tests in `tools/__tests__/`, plus a happy-path case in
   `server-integration.test.ts` (see "Integration tests — when to add").
   Cover the handler's behavior, not just the schema.
4. **Availability keying** — if the tool's description names other
   tools, use `whenToolEnabledText` so references disappear when their
   target is disabled.
5. **Snapshot baseline** — run `npm run snapshot:update` and commit the
   regenerated `__snapshots__/tool-surface/` files; any change to the
   tool surface fails the drift test until the baseline matches. The
   size cap in `tool-surface-snapshot.test.ts` fails if the new tool is
   much larger than the per-tool average; trim the text, or raise
   `CHARS_PER_TOOL_ALLOWANCE` and give the reason in the PR.
6. **Feature-surface docs** — see the "Files that track feature
   surface" list below for which files to update (README tools table,
   ARCHITECTURE.md, DOCKERHUB regen, etc.).

### Adding a new prompt

1. **Group module** — create or extend a module in `prompts/`. Export
   `PROMPT_NAMES` and a `register*Prompt` function taking
   `PromptRegistrationContext`.
2. **Registration** — add the register call in
   `prompt-definitions.ts`. If the prompt depends on a specific tool,
   gate it on `context.isToolEnabled(TOOL_NAMES.*)`.
3. **Tests** — co-located at `prompts/__tests__/`. Use the shared
   `prompt-test-harness.ts` in that folder for registration capture.
4. **Availability keying** — use `whenToolEnabledText`,
   `isToolEnabled`, and `formatEnabledToolList` from the context for
   any tool references in the prompt text or fallback paths.
5. **Snapshot baseline** — run `npm run snapshot:update` and commit the
   regenerated `__snapshots__/tool-surface/` files (prompts are part of
   the captured surface).
6. **Feature-surface docs** — update the README prompts table and
   regenerate DOCKERHUB.md.

### MCP prompt conventions

Prompts (`mcp-core/prompts/`) are user-initiated workflows, distinct
from tools:

- **Kebab-case names** (`vault-orientation`, `memory-review`), exported
  via `PROMPT_NAMES` — mirroring `TOOL_NAMES`.
- **Short, picker-facing `title`/`description`** — they render in slash
  command / **+**-menu pickers, so no `Example:`/`Returns:` scaffolding;
  one or two sentences.
- **A prompt earns its place only through live content** — assembled at
  invocation time from the data layer — plus thin, durable instruction.
  Never re-encode a procedure that can drift. Zero-arg prompts **omit**
  `argsSchema` so the SDK calls back as `(extra) =>`.
- **Handlers degrade, never throw** — wrap data gathering so a failure
  returns a valid fallback message; a prompt must not hard-fail the client.
- **`memory-review` is append-only by design** — it reads the memory layer
  as a dated **evolution** (never "newest supersedes older"), proposes only
  append updates, and never prunes "stale" entries. The one exception is a
  memory file whose frontmatter declares `entry-policy: living` (surfaced
  by `vault_list_memory_files`; absent means append-only): a current-state
  snapshot whose expired entries the review may propose pruning.

### MCP naming conventions

Two naming layers — MCP (JSON wire format) and TypeScript (internal):

- **MCP inputs and outputs** use `snake_case` — this is the JSON
  shape clients see. Examples: `old_text`, `heading_level`,
  `snippet_tokens`, `additional_properties`, `sample_values`,
  `outgoing_links`, `exclude_folders`, `sort_by`.
- **Internal TypeScript** uses `camelCase` — function params,
  local variables, internal types that never reach the wire.
  Examples: `oldText`, `headingLevel`, `snippetTokens`.
- The mapping happens in each tool group module's handlers
  (`mcp-core/tools/*.ts`): `replaceAllOccurrences: replace_all_occurrences`.
- Types that ARE the JSON response shape (`PropertyKeyInfo`,
  `SearchResult`, `NoteMetadata`) use `snake_case` for any
  multi-word fields to match the wire format. Single-word fields
  (`path`, `title`, `count`) are the same in both conventions.

### MCP path conventions

- **Note-path tool inputs must end in `.md`.** Every input naming a single
  markdown note (`path` on read/write/patch/replace/delete/update_properties,
  the anchor tools and the task tools; `new_path` on move) requires the
  full filename; a bare `Projects/Plan` is rejected. The generic
  `assertPathHasExtension(path, ".md")` util
  (`src/utils/assert-path-has-extension.ts`) enforces it in the data-layer
  function each tool routes through. Folder, glob and memory-file (`file`)
  inputs are exempt. **Backlinks/outgoing_links accept `.md` or `.canvas`**
  (`assertPathHasExtension(path, [".md", ".canvas"])`), and so does
  **`vault_move_note`'s `old_path`** at the handler boundary, because the
  handler runs a backlinks lookup before the data-layer `.md`-only check.
- **`vault_read_file` is the deliberate inverse.** Its `path` names any
  non-markdown file and **must not** end in `.md`; `vaultFs.readAsset`
  rejects notes so the `.md` boundary stays one rule with two sides
  (notes → `vault_read_note`, everything else → `vault_read_file`). Error
  messages never name tools; routing guidance lives in each tool's
  description.

### Test conventions

- A test that denies file access with `chmod` and expects the access to
  fail can't pass as root, because root ignores file permissions. Mark it
  `it.skipIf(runsAsRoot)`, importing `runsAsRoot` from
  `src/__tests__/runs-as-root.ts`. CI runs it as a normal user. To run
  these tests from a root shell, such as a cloud session, use
  `npm run test:as-nobody`; it takes the same arguments as `vitest run`.
- Tests read as a behavioral spec: one focused `it()` per behavior, named
  so a failure identifies the regressed behavior without reading the
  body, and matching what is asserted. For every guard or invariant,
  write the test that catches the unrelated change that would silently
  undo it.
- The two-bar rule: a test (1) fails when the behavior breaks and
  (2) passes only because the intended behavior occurred. Five traps
  against bar 2:
  - **Silent no-op.** "State X is retained" passes even if the operation
    never ran; also assert the trigger happened (the note was actually
    deleted or moved).
  - **Wrong-error pass.** `rejects.toThrow()` with no argument matches
    any error; assert the specific message and build the fixture so the
    intended rejection is the only one possible.
  - **Early-return pass.** A returned `0`/empty/`false` can come from the
    guard under test or from bailing before it; assert a side effect
    only the intended path produces (the expected `warn`).
  - **Wrong-item pass.** Seeding several items and asserting only
    "something came back"; assert the specific item (path/id/content).
  - **Coincidental-equality hazard.** When production and test read the
    same source (`err.stack`), both being `undefined` passes trivially;
    set a predictable value and assert it exactly. `expect.any(String)`
    still matches `""`.

  When in doubt, mutate the code and confirm the test fails for that
  reason, not a compile error or an unrelated assertion.

- Assert the full result (`toEqual` on the whole object, `toBe` on
  complete content) when output is deterministic and inputs are
  controlled; `toContain`/`toMatch`/`arrayContaining`/`toHaveLength` on
  deterministic output tolerate drift, so reserve them for a genuine
  fragment-only check. A looser neighboring test is never the standard:
  fix loose siblings in a file the PR already edits as a separate
  test-only commit; in a file the PR does not touch, card them.
- Never decompose: `toHaveLength(1)` plus index checks is weaker than
  `expect(results.map(result => result.path)).toEqual(["foo"])`.
  Ordered collections get positional assertions; deterministic error
  messages get exact assertions (pass `new Error(message)` to `toThrow`,
  which Vitest compares whole); objects are matched whole, not with
  `objectContaining`.
- Test-owned expected values for drift-catching tests: define the
  expected prompt text, config default or rendered output in the test
  file; importing the production constant makes both sides drift
  together.
- Assert mock interactions through the matcher API
  (`toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(exactArgs)`), never
  positional call-log readback. Derive an expected value test-side with
  the mechanism production uses; production is never its own oracle.
- `const` per test via factory helpers (`const index = createTestIndex()`)
  is the strong default; `beforeEach` plus shared `let` only when
  per-test creation is genuinely impractical.
- Every test file maps to a real source module and lives in the
  `__tests__/` folder next to the module it tests, not in a centralized
  test directory higher up the tree. Don't spawn a standalone test file
  just to mock differently; use `vi.mock(path, { spy: true })` to keep
  the real implementation.

  **Exception — shell scripts outside vitest's include paths.** These
  scripts are not TypeScript modules, and vitest's include paths (`src/`,
  `cli/src/`, `scripts/`) reach none of their folders, so their tests
  live in folders vitest reaches:
  - the remote image's s6 init scripts in
    `rootfs/etc/s6-overlay/scripts/` (the `vault-mcp` server's boot chain
    for the `:remote` target) → `src/vault-mcp/__tests__/`:
    `init-check-auth.test.ts`, `init-obsidian-login.test.ts`,
    `init-first-sync.test.ts`, `init-setup-user.test.ts`,
    `init-setup-vault.test.ts`, `check-sync-vault.test.ts` (the vault
    check `init-setup-vault` runs), and `print-derived-env.test.ts` (the
    derivation that `init-derive-env` publishes)
  - the dependency hooks in `.claude/hooks/` →
    `src/__tests__/install-deps.test.ts`
  - the release scripts in `.github/scripts/` → `src/__tests__/`:
    `generate-notes.test.ts`, `generate-cli-notes.test.ts`,
    `update-changelog.test.ts`

  These script tests run the real script under its own shell (`sh` for
  the init scripts, `bash` for the others) with stub binaries on `PATH`
  or, for `generate-notes.sh` and `generate-cli-notes.sh`, a temporary
  git repository, and name the script they cover — don't move them next
  to the scripts or widen vitest's include for them.

  Whole-image behaviour (the init chain's ordering, the
  `container_environment` files the chain publishes, the volume layout,
  and the checks that stop the container) belongs in the remote-boot test
  suite (`src/__tests__/docker/`, see "Remote image boot tests — when to
  add"); the branches inside one script stay in that script's test file.

- New test support files go in subfolders of their `__tests__/` folder:
  a module that a test imports or runs (a harness, an input generator,
  an oracle, a script the test spawns) in `helpers/`, and data that the
  code under test reads (a sample vault, JSON vectors, a stub binary) in
  `fixtures/`.
- Separate `it()` blocks over callback-pattern `it.each` when assertions
  are structurally different. `it.each` is for identical assertion
  shapes, with labeled case objects and `$label` in the title, never
  printf `%s` over positional arrays.
- Vitest helpers (`onTestFinished`, `vi.mocked`, `vi.restoreAllMocks`)
  before hand-rolled plumbing. No cleanup after assertions: register it
  in `afterEach`/`onTestFinished` at creation time, because trailing
  `rm`/`close()` is skipped when an assertion throws.
- Every test abstraction justifies its existence by removing real
  duplication. A mock must not create a condition production cannot
  produce, and it preserves the dimension under test (order, timing,
  ranking, size) with deliberate variation and decoys; when it cannot,
  test against the real component.
- Error paths and boundaries are covered, not just the happy path:
  zero/one/empty inputs expose the special-case bugs, and filter tests
  seed data both inside and outside the filter.
- Prefer a controllable seam over fake timers for retry/polling logic
  (an injected deadline, or a named wrapper mocked with controlled
  outcomes). Fake timers are legitimate when timing is the contract
  (debounce, TTL, deadline expiry) or a wrapper seam would exist only for
  tests; assert outcomes after advancing the clock, never the
  tick-by-tick schedule.
- Production type rules apply in tests: no `!`, but `?.` and
  `?? fallback` are legitimate narrowing, and callback params are spelled
  out (`entry` not `e`).
- Production code never carries test-serving structure (cache keying,
  extra branches, widened semantics whose only job is isolating tests);
  tests own their isolation (`vi.resetModules`, factory-created
  instances), and review findings proposing production changes for
  test-only scenarios get declined. One setting read in `config.ts` through
  `env-var` with a default, whose only job is to unlock an otherwise
  impossible test tier, is acceptable; anything more is not, and a raw
  `process.env` read anywhere in `src/` stays banned.
- Real integration with blast-radius controls beats a structural check
  when the risky path touches an external system: run the real thing
  with the write path disabled (pull-only mode, throwaway identifiers).
- Mirroring a vendor's undocumented behaviour: the vendor's own code is
  the oracle, when the repo may read it. For the pinned `obsidian-headless`
  CLI, extract the functions verbatim from its bundle, pin their outputs
  for fixed inputs as test-owned vectors (each commented with its source),
  and keep the live end-to-end run as the final oracle. Obsidian's app
  code is never read; "Upgrading remark-parse" runs it as a black box.
- CI shell snippets are tested under `bash -e` before committing: Actions
  runs `run:` steps with errexit, so use `if/then/fi` over
  `[ test ] && cmd`.

### Integration tests — when to add

Integration tests (`src/__tests__/integration/`) boot a real server
and call tools over real HTTP via the MCP SDK Client, catching handler
miscalls, config-gated surface mismatches and transport-layer bugs. The
deciding question: **would this bug survive unit tests but break in
production?** If the unit test already uses real I/O (temp dirs, real
SQLite), skip the integration test.

**Always add:**

- New tool → happy-path test in `server-integration.test.ts` + fixture
  data if needed.
- New error path in a tool's `Errors:` section → test in
  `server-error-contracts.test.ts` asserting the distinctive message
  prefix (include test-controlled variable parts like paths and
  section names).
- New config gating axis → config matrix test in
  `server-integration.test.ts` (tool count + key behavior), and add the
  axis to `SURFACE_AXES` in `scripts/tool-surface-capture.ts` so the
  snapshot combos cover it. For a setting that changes only one tool's
  text, add a single combo to `SURFACE_COMBOS` instead.
- New prompt → assembly test verifying live vault data, not just the
  instruction wrapper.

**Never add:**

- Parser changes (pure, no I/O).
- Search query changes (`search-index.test.ts` uses a real SQLite DB).
- Config validation (`config.test.ts` tests `loadConfig` directly).
- Tool registration/annotation (`tool-definitions.test.ts` covers
  the registration layer via a mock server).

**File structure:**

- `server-integration.test.ts` — happy paths + config gating (one
  server per config combo).
- `server-error-contracts.test.ts` — error paths, default config only
  (errors are config-independent).
- `server-oauth-integration.test.ts` — OAuth flows: token rotation,
  client sweep, reuse detection, scope widening.
- `test-harness.ts` — shared server lifecycle + client factory.
- `fixtures/vault/` — committed fixture vault; a PR that adds a tool
  also adds fixture data and a test case.

**When to split a test file:** when navigating the file requires
scrolling past unrelated test groups to find what you need — the
file has multiple distinct concerns that don't share setup or
context. Split along concern boundaries (happy path vs error
contracts, by tool group, by config combo), not arbitrary size.

### CLI PTY tests — when to add

CLI PTY tests (`cli/src/__tests__/integration/`) drive the real CLI
binary in a pseudo-terminal via node-pty. They catch what unit tests
(which use `createScriptedPrompts` DI) structurally can't — real
keystroke processing, terminal rendering, and entry-point wiring.
Run via `npm run test:cli-pty` (separate vitest config, excluded
from `npm test`).

**Always add:**

- New interactive command → happy-path test driving the full prompt
  sequence.
- New prompt in an existing command → extend or add a scenario.
- Docker start/health-check changes → test with the fake `docker`
  binary's `/healthz` server.

**Never add:**

- Output/message changes — unit tests pin via `createScriptedPrompts`.
- Flag parsing — `program.test.ts` covers Commander.
- Prompt branching logic — unit tests cover via scripted answers.
- Docker interaction — unit tests inject `DockerRunner` stubs.

### Remote image boot tests — when to add

Remote image boot tests (`src/__tests__/docker/`) boot the built
`:remote` image with the Sync CLI replaced by the `fixtures/ob` stub.
They catch what a single script's test file cannot: the ordering of
init scripts, the `container_environment` files the init chain
writes, the volume layout, and the guards that stop the container on bad
state (such as the deletion-storm guard). Run via `npm run test:remote-boot`
(builds the image, then runs a separate vitest config excluded from
`npm test`).

Tests in a `describe` block share one booted container. Two places boot
more often, because each scenario sets a different environment or
expects a different exit outcome: every guard scenario boots inside its
own `it()`, and the failing-sync block boots once per sub-`describe`
(memory on, memory off).

**Always add:**

- New init script or ordering change → extend the expected `ob` call
  sequence.
- New variable that `init-derive-env` writes → assert its
  `container_environment` file.
- New safety check that stops the container → a guard-scenario test
  asserting the ERROR line.
- New Sync failure mode → a new stub switch (like
  `OB_STUB_SYNC_FAIL=1`).

**Never add:**

- Branch logic inside one script — that script's test file covers it.
- Server tool behaviour — the integration test suite covers it.
- Anything needing real Obsidian Sync — that stays a manual test
  deploy.

## SST conventions

- Secrets via `sst.Secret`, PascalCase names. Never hardcode.
- Check the [SST v4 docs](https://sst.dev/docs/) before writing config you
  haven't used in this repo (linking, secrets, outputs) — don't infer from
  other IaC tools or older SST versions.
- Plain configuration a Lambda needs (`PUBLIC_URL`) goes in the function's
  `environment:`, read with `env-var`; `link:` is for SST resources a
  handler reads through `Resource.*` (the `McpAuthToken` secret).
  Type-generation timing is in "Build pipeline gotcha" below.
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
you've run `npm run deploy` once for your stage.
`npm run deploy` requires `~/.config/vault-cortex/.env`; create it from
`.env.example` as shown in `DEPLOY.md` one-time setup step 2.

If you add or rename a secret in `sst.config.ts`, re-run `npm run deploy`
to regenerate `sst-env.d.ts`.

`sst.config.ts` is typechecked by `npm run build:sst` (part of
`npm run build`) through its own `tsconfig.sst.json`. It cannot share
`tsconfig.json`: its globals come from `.sst/platform/config.d.ts`, which
pulls SST's platform source into the program, and that source does not
compile under the repo's stricter checks. `.sst/platform` exists only after
`npx sst install` — CI runs it before the build; run it once locally on a
fresh clone.

## Upgrading rrule (recurrence parity)

`recurrence.ts` transliterates the Tasks plugin's recurrence logic
(`Recurrence.ts` + `Occurrence.ts`) and pins `rrule` to the exact version
the plugin declares, so rule parsing and next-hit computation match the
plugin by construction. The pin is deliberately excluded from Dependabot.
On any rrule bump — or when re-verifying against a newer Tasks plugin
release — re-check each of these against the plugin source before merging:

- The rule grammar split (`/^([a-zA-Z0-9, !]+?)( when done)?$/i`) and the
  `parseText` try/null handling.
- Reference-date priority (due → scheduled → start; flipped to due →
  start → scheduled under `removeScheduledDateOnRecurrence`).
- The month/year overflow walk-back: the rule's start date (rrule's
  `dtstart`) moves with each step, and a rule whose text contains `" on "`
  (an explicit day, "every month on the 31st") skips the walk-back — month
  rules only.
- The fields `createNextOccurrence` sets on the next occurrence: block
  link, 🆔, and ⛔ cleared; created date replaced per `setCreatedDate`,
  never carried forward.
- The `recurrence.test.ts` vectors lifted from the plugin's own
  `Recurrence.test.ts` — refresh them from the new release's tests.

Two deliberate divergences are pinned by tests, each contracted where it
lives: exhausted finite rules complete without spawning (`recurrence.ts`'s
docstring), and calendar-invalid dates are nulled at parse time
(`calendarValidOrNull` in `tasks.ts`). A behavior change in either is a
decision, not a drift fix.

## Upgrading remark-parse (body-tag parity)

`obsidian-markdown/body-tags.ts` finds a note's `#tags` with
`remark-parse@8.0.3`, the version Obsidian's metadata cache forked, plus
Obsidian's syntax as tokenizers in `obsidian-remark-parser.ts`. The pin is
excluded from Dependabot, and 8.0.3 is the last 8.x release, so an advisory
anywhere in its dependency tree is answered with an `overrides` entry, as
`trim` is. `knip.json` lists remark-parse under `ignoreDependencies`, because
the parser loads it through `createRequire`, which knip does not trace.

NEVER open, read or copy Obsidian's app code (`worker.js`, `app.js`) when
editing `obsidian-remark-parser.ts`, `body-tags.ts` or `remark-ports/`.
Obsidian is proprietary and this repo is MIT, so those files are written
from Obsidian's observed behaviour only: the scripts below run `worker.js`
as a black box and print its answers, and nothing else may read it.

Re-check the parser against Obsidian when remark-parse changes and when
Obsidian ships a new release:

1. Extract `worker.js` from the installed app:
   `npx -y @electron/asar extract "<app-dir>/obsidian-<version>.asar" <dir>`
   (on macOS, `<app-dir>` is `~/Library/Application Support/obsidian`).
2. Regenerate the vectors:
   `npm run vectors:body-tags -- <dir>/worker.js <version>`. It asks that
   worker for every input in
   `src/vault-mcp/obsidian-markdown/__tests__/fixtures/obsidian-body-tag-vectors.json`
   and rewrites each expected answer.
3. Run `npx vitest run src/vault-mcp/obsidian-markdown/__tests__/body-tags.test.ts`
   and `npm run compare:body-tags -- <dir>/worker.js --documents 300000 --out disagreements.json`.
4. When the comparison finds disagreements, `disagreements.json` holds each
   shrunk input as a `{ label, input }` record. Pass that file as the third
   argument to step 2's command, then fix the parser until every row passes.

For a one-off question, `npm run oracle:body-tags -- <dir>/worker.js <inputs.json>`
prints Obsidian's raw tags and listed names for each input.

## Upgrading obsidian-headless

The Sync CLI's [documentation](https://obsidian.md/help/sync/headless)
covers usage, not internals, so the `:remote` init chain depends on
behaviour observed in the pinned `cli.js`. Treat every bump
of `obsidian-headless/package.json` as a potential regression and
re-verify each contract against the new source before merging:

- Verbs and flags the scripts call: `login`, `sync-config` (including
  `--mode` and `--json`), `sync`, `sync --continuous`,
  `sync-setup --vault --device-name`, `sync-list-remote --json` and
  `sync-list-local --json`. `sync-config --json` prints `vaultId`
  and `syncMode` (`bidirectional` when unset), and an unknown `--mode`
  value exits non-zero, which `init-setup-vault` treats as fatal.
- Each vault's setup is `obsidian-headless/sync/<vaultId>/config.json`, and
  every command uses the first setup, in folder-name order, whose
  `path.resolve(vaultPath)` is the working folder. `check-sync-vault` relies
  on these outputs, captured as vectors in its test file:
  - `sync-config --json` exits 3 when no setup matches the folder and 1 when
    a setup without `vaultPath` sorts first, and it skips a setup file it
    can't read or parse;
  - `sync-list-local --json` lists `{ id, path, host }` per setup;
  - `sync-list-remote --json` lists owned and shared vaults with `id` and
    `name`, and needs the token;
  - `sync-setup` resolves `--vault` by ID first, then by a unique name.
- `sync-setup` rewrites the whole config on every boot without the filter
  fields or `syncMode`. `sync-config --file-types` / `--excluded-folders` /
  `--configs` then queue only the recorded server files that the new value
  allows and the reset defaults block, so some changes queue nothing.
- `ob sync` creates `<vault>/.obsidian/` and a `.obsidian/.sync.lock`
  directory before transferring anything. `vault_has_content` in
  `init-first-sync` therefore treats an `.obsidian/` folder that holds
  nothing but `.sync.lock` as an empty vault.
- The device's file record is
  `obsidian-headless/sync/<vaultId>/state.db` under `$XDG_CONFIG_HOME`,
  table `local_files`. The engine loads this record at startup and compares
  it against the files on disk. The deletion-storm guard in `init-first-sync`
  reads the same table: it stops the container when the record lists files
  but the vault is empty, because the engine would push each missing file as
  a deletion.
- Files delivered by `sync --continuous` are recorded in that same
  table as they arrive, and a file deleted locally has its row removed at
  once. The stub's `sync-record` and `sync-forget` verbs mirror the two.
- `init-first-sync` queues every file the engine knows about but this
  device has no local record of (its header explains why). That step
  relies on five engine behaviours. The remote-boot oracle
  (`fixtures/sync-engine-oracle.ts`) runs the image's own engine on the
  first; re-check the other four by hand in the new `cli.js`:
  1. The deletion scan pushes a deletion for a `server_files` row with no
     `local_files` row, and only two-way sync runs it: `pull-only` and
     `mirror-remote` return first. The pending loop runs before the scan,
     and a one-shot `sync` stops at the first failed download, before it.
  2. `server_files` and `pending_files` rows share one record shape
     (`addPendingFile` writes `uid, path, data`), and the three tables keep
     the columns the script's schema check lists.
  3. `sync --continuous` backs off a failed download and still runs the scan.
  4. Skipping a superseded queued entry deletes every queued row for that
     path (`DELETE FROM pending_files WHERE path = ?`).
  5. The oracle's minified names are unchanged: the closing `x.parse();`
     call, and `is` as the engine class's name.

- The setup page's pre-flight (`src/vault-mcp/setup/`) mirrors two calls
  `ob sync-setup` makes on the next boot: `/vault/list` (an
  end-to-end encrypted vault comes back with `password: ""`) and
  `/vault/access` with the key hash — scrypt over the NFKC-normalized
  password and salt (N 32768, r 8, p 1, 32 bytes), then HKDF-SHA256 with
  info `ObsidianKeyHash` for `encryption_version` 2 and 3, SHA-256 for 0. The
  vectors in `vault-key.test.ts` were produced by the pinned CLI's own
  functions; recompute them on a bump.

The remote-boot scenarios never run the real CLI — they run the stub
(`src/__tests__/docker/fixtures/ob`), which imitates the behaviour listed
above. So if a new CLI version behaves differently, those tests still pass,
because the stub still behaves the old way. Only the sync-engine oracle runs
the image's real engine. After updating the pinned version:

1. Update the stub to match the new behaviour, and the oracle's minified
   names if they changed.
2. Run the remote-boot tests (the oracle among them) and the init-script
   tests.
3. Boot the new image once against real Obsidian Sync and confirm the
   first sync, the guard's file count, and continuous sync in the logs.

## Operational docs

The README is the front door — humans land there first. The full AWS/SST
deployment walkthrough lives in [`DEPLOY.md`](./DEPLOY.md); the local and
Obsidian-Sync quickstarts live under [`deploy/`](./deploy/). Keep this
file focused on conventions; don't duplicate procedure here.

**Write for the Obsidian user, not the developer.** User-facing docs
(README, deploy guides, cli/README) describe what a feature does in
terms the end user thinks in — "complete a task," "move between lanes,"
"filter by due date" — not implementation vocabulary ("mutate,"
"atomic write cycle," "composable mutations"). Internal docs (AGENTS.md,
ARCHITECTURE.md, code comments) use precise engineering language. The
test: would an Obsidian user with no programming background understand
the sentence? If not, rewrite it.

**Write-time format decision** — before committing any prose (code
comments, JSDoc, README sections, PR descriptions, env-file comments):
information gets structured format (table for lookups, bullets for
parallel items, numbered list for steps, one sentence for a single
constraint); narrative goes in the PR description, not committed files.
More than 3 sentences of prose → probably the wrong format. Sections
match their siblings' length and shape.

**Doc quality rules:**

- Before calling a doc done, pick each reader the doc serves (the
  Obsidian user, a self-hoster deploying it, a contributor) and walk the
  entire document start to finish — line-level fact-checking
  cannot validate a doc; each sentence can be true while the doc
  as a whole misleads.
- When a doc offers multiple paths (install methods, tools, runtimes),
  every operational section (update, restart, verify, troubleshoot)
  serves every offered path — or explicitly scopes itself.
- Structural self-references ("shown below", "the section above") are
  claims about the document — they must resolve against the current
  document after any restructuring.
- Sibling docs (local/remote guides, per-OS variants) are authored as
  a set — same lead method and section skeleton, diverging only where
  the variant genuinely differs.
- Factual claims match the implementation — capability lists and
  data-flow descriptions are verified against the code; conditional
  capabilities are stated conditionally.
- Add an authoritative specification link when it helps a reader verify
  a specific requirement or implement a behavior. Do not require a link
  for every first mention, a bare protocol name, or a broad capability
  summary. Use a Markdown link in docs and a raw URL in explanatory code
  or env-file comments. Keep citation URLs out of MCP tool descriptions
  and test names (`it`/`describe` titles).
- Pair a destructive-outcome claim with its actual recovery path at
  the same point in the doc.
- Mechanism language is earned — "caches", "batches", "switches
  automatically" only when the code implements that mechanism.
- Corrections leave no residue — fixing an over-claim states the
  current design directly, never a walk-back parenthetical explaining
  what "actually" handles it; in inventory-style sections, one
  mechanism per bullet.
- Before cutting copy that survived earlier reviews as redundant,
  check why it exists. Preserve a useful explanation or replace it
  with a plainer one that carries the same information.
- Concrete referents at the point of use — when a specific name exists
  (a UI toggle, a filename, a section title), state it where the reader
  is; a "see below" names its target. Vague referents force backwards
  sentences — lead with the reader's action as the conditional's
  subject (cause → effect).
- Opt-outs surface at the point of decision — a section describing
  opinionated behavior (auto-created files, background writes) states
  its disable switch inline in that section, not only in the config
  reference.

Contributor and release conventions live in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Flag a **breaking change** with a
`BREAKING CHANGE:` footer in the PR description, so the generated release
notes list it (other accepted flags are in `CONTRIBUTING.md`).

Pick a commit's conventional-commit type by what it changes in what this
repo ships: the server's Docker images and the `vault-cortex` npm CLI.
Claude Code hooks, dev scripts and other local tooling
are never `feat` or `fix`: use `chore`, or `ci` or `build` where they fit,
so they stay out of the changelog's Features and Bug Fixes. A squash merge
lands the PR title, so the title takes the type of the PR's main purpose.

### Files that track feature surface

**No hardcoded tool or prompt counts in user-facing surfaces.** Never
write a specific number of tools or prompts in README, server.json,
the social preview, `.devin/wiki.json`, the image descriptions (in the
`Dockerfile`, `deploy.yml`, and `dockerhub-description.yml`), or any other
surface an end user or registry sees. Use category names or capability
descriptions instead. Counts go stale on every tool addition and the drift compounds
across surfaces. The README's Tools and Prompts tables are the source of
truth; a reader counts from those. Internal docs (AGENTS.md, code
comments) may include counts where they help agents gauge
module size — these are agent-facing and not propagated externally.

Several files outside `src/` reflect the project's feature surface and
need updating alongside code changes. What to check depends on what
changed:

- `README.md`: New deployment mode, new feature worth mentioning in the value prop
- `ARCHITECTURE.md`: New component, requirement, or design decision; component diagram changes. Write for scannability: bullet lists and numbered pipelines over dense prose — a reader landing on this page should grasp the flow at a glance, not parse nested parentheticals.
- `ROADMAP.md`: Direction genuinely changes — a priority shifts between Planned and Exploring, or a non-goal is decided. Refreshed in periodic passes (roughly once or twice a year) that remove completed Planned entries; not updated per feature PR, and shipped items are never promoted into Delivered — that section is a static foundations sketch, not a changelog
- `server.json`: Description changes. `description` has a 100-character limit per the MCP registry schema — counted in code points, not bytes, so em dashes are safe here (CI guards it).
- `Dockerfile`: OCI `image.description` label — keep in sync with `server.json` and `deploy.yml` descriptions
- `assets/social-preview.svg` + `.png`: Feature category changes (rendered in the image); regenerate PNG after SVG edits (run `npm run render:social-preview`)
- `.devin/wiki.json`: New architectural area (new page), module renamed/moved (update `repo_notes` or `purpose` references). Purposes stay structural — what the page covers and which modules — never capability narratives, counts, or tuning values; those live in README/ARCHITECTURE and DeepWiki derives them at index time.
- `src/vault-mcp/mcp-core/__tests__/__snapshots__/tool-surface/`: Any change to tool schemas, descriptions, annotations, prompts, or server instructions — run `npm run snapshot:update` and commit the regenerated baseline in the same PR (the drift test fails until it matches). A dependency bump that changes the MCP SDK's schema serialization needs the same regen commit: that CI failure is the gate working, not flake.
- `deploy/local/` + `deploy/remote/`: New env var, changed default, new deployment step, or Docker Compose service change — update `.env.example` and `README.md` in the affected directory
- `render.yaml` + `deploy/render/` + `deploy/railway/`: A variable the image needs at boot is added or renamed, a shipped default changes (plan, disk size, hop count, health path, port), or the image tag changes. `templates.test.ts` pins `render.yaml`; the Railway template is re-published by hand from the definition table in `CONTRIBUTING.md` — existing deployments keep their settings until their owners redeploy
- `.env.example` (root): New env var or changed default for the Lightsail reference deployment
- `cli/README.md`: Feature description or search capability changes — this is the npmjs.com landing page
- `cli/src/rules/env-templates.ts`: Auto-synced optional blocks from `deploy/*/.env.example` via `npm run sync:cli-env-blocks` — run the script after editing deploy/ env files
- `CONTRIBUTING.md`: CI pipeline, repo settings, or release conventions change
- `DEPLOY.md`: Infrastructure, env vars, or deployment procedure changes
- `GOVERNANCE.md`: Access to a sensitive resource changes — a registry, bot, or workflow credential is added or dropped, or a collaborator gains rights. The Access list and Continuity paragraph name concrete credentials, so they must track the workflows' secrets
- `SECURITY.md`: The attack surface or its protections change — a new endpoint, auth layer, guard, scanner, or credential kind. The scope, hardening, setup-mode, and Secrets Management sections state what the code and CI actually do, and a stale claim here misleads vulnerability reporters
- `DOCKERHUB.md`: Auto-generated — regenerate via `npm run generate:dockerhub-readme` when README.md changes tool/prompt tables, feature descriptions, env var table, or deployment options. Do not edit manually.
- `.github/workflows/dockerhub-description.yml`: Description changes. Reads from `DOCKERHUB.md`. Docker Hub limits short descriptions to 100 UTF-8 **bytes**, not characters — an em dash costs 3 (CI guards the byte length).
- `lhm.plugin.json`: Generated and gitignored — never edit or commit it. `npm run publish:lobehub` regenerates it from the live tool/prompt registry and publishes the LobeHub listing; that command is the only thing that needs running when tools, prompts, the `server.json` description, or the `package.json` keywords change (keywords become the listing's tags).

**Env var update checklist** — when adding, removing, or changing an
env var that the server reads (defined in `config.ts`, `server.ts`,
`setup/setup-server.ts`, or `logger.ts`), update every downstream surface.
Not every var goes in every file — container-internal vars (HOST, INDEX_DB_PATH) are hardcoded
in compose and skip .env.example; remote-only vars (OBSIDIAN_AUTH_TOKEN,
PUID, etc.) only go in the remote surfaces. Use existing entries as a
pattern:

1. **Server source** (`config.ts`, `server.ts`, `setup/setup-server.ts`, or
   `logger.ts`) — authoritative definition via the `env-var` package
   (`logger.ts` reads `LOG_*` from `node:process` `env` directly)
2. **Deploy compose** (`deploy/local/docker-compose.yml` and/or
   `deploy/remote/docker-compose.yml`) — add `${VAR:-default}` passthrough
   in `environment:`
3. **Deploy .env.example** (`deploy/local/.env.example` and/or
   `deploy/remote/.env.example`) — document for users with comment + default.
   These are the source of truth for optional var documentation.
4. **Run `npm run sync:cli-env-blocks`** — syncs the optional sections from
   step 3 into `cli/src/rules/env-templates.ts` (`LOCAL_OPTIONAL_BLOCK` /
   `REMOTE_OPTIONAL_BLOCK`). Always run after editing deploy/ env files.
5. **Root .env.example** — Lightsail reference deployment (if applicable)
6. **Root compose files** (`docker-compose.yml`, `docker-compose.local.yml`)
   — maintainer/contributor surfaces (if applicable)
7. **Deploy workflows** (`.github/workflows/deploy.yml`,
   `.github/workflows/test_deploy.yml`) — write the Lightsail `.env` from
   repo Variables. A var the workflows never write can never reach the
   instance. Required vars go in the always-written block; optional vars
   go in the conditional block (unset Variable = no line written).
8. **Hosted templates** (`render.yaml` and the Railway definition table in
   `CONTRIBUTING.md`) — only for a var the
   image needs at boot or that has no derivation; optional vars are
   documented in both guides' Configuration sections by reference to
   the remote guide's table. Re-publish the Railway template after editing
   its definition.

CI drift tests in `cli/src/rules/__tests__/templates.test.ts` catch omissions across
steps 2–4 after the fact and pin the committed hosted templates (step 8);
following the checklist avoids the omissions in the first place.

Not every PR touches these. A new tool in an existing category updates
the README tools table, `DOCKERHUB.md` (regenerated), and the tool-surface
snapshot. Update the
`server.json` description only when the category description changes. A
module rename updates `.devin/wiki.json` and `ARCHITECTURE.md`. Use the
list as a checklist, not a mandate to touch every file.

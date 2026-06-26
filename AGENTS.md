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

**Phase 2** (in discovery) adds hybrid search — FTS5 + sqlite-vec vector
search with RRF fusion — to the existing `vault_search` tool. The file
watcher gains a second hook for embedding ingestion. Additive — not a
rewrite.

All solutions must be portable — they can't rely on one-off manual fixes,
hardcoded paths, or user-specific configuration. If it works only on
the author's machine, it's not done.

Design for the Obsidian user. The end user is always an Obsidian user, so
anything that mirrors an Obsidian concept — backlinks, outgoing links, orphans,
the graph, tags, properties, daily notes — must match what Obsidian itself does.
At minimum, recognize every form Obsidian recognizes; behavior that is a strict
subset of Obsidian's is a bug, not a limitation. For link resolution
specifically, that means all of Obsidian's link styles (`[[wikilink]]`,
`[[wikilink|alias]]`, `[[wikilink#heading]]`, `![[embed]]`, `[md](path.md)`),
links in frontmatter properties (e.g. `related:`), and all three "New link
format" modes — shortest path, path from vault folder, and path from current
file (including relative `../` paths).

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
  utils/                               # Cross-cutting helpers (no domain logic)
    map-with-concurrency.ts            # Bounded-concurrency async map (batch-based)
    describe-error.ts                  # describeError — message from an unknown throw
    fs.ts                              # readFileOrNull / readdirOrNull / fileExists (ENOENT-safe)
  functions/
    authorizer.ts                      # Lambda: path-aware auth (OAuth pass-through, JWT + static)
  vault-mcp/
    server.ts                          # Entry point — config, mount routes, listen
    config.ts                          # Env-var loader + ServerConfig type (loadConfig)
    obsidian-markdown/                 # Pure Obsidian/Markdown parsers + transforms (no I/O)
      lines.ts                         # splitIntoLines (CRLF) + fence state machine + classifyLines
      frontmatter.ts                   # gray-matter parse/stringify + frontmatter merge
      callouts.ts                      # Leading-callout parser (> [!type] blocks)
      headings.ts                      # Shared H1–H6 section-span parser (read + patch)
      links.ts                         # Link grammar: parse, extract, resolve (wikilinks + md)
    vault-operations/                  # Vault content read/write/patch (filesystem I/O)
      vault-filesystem.ts              # Read/write/list/delete .md files; outline + section reads
      vault-patcher.ts                 # Surgical edits: heading-targeted patch + find-and-replace
      note-mover.ts                    # Move/rename a note + rewrite every vault-wide link to it
      memory-store.ts                  # About Me/ heading-aware read/append/delete
      daily-notes.ts                   # Daily note config reader + path resolver
    mcp-core/                          # MCP protocol surface
      mcp-router.ts                    # /mcp session routes + transport lifecycle
      tool-definitions.ts              # Tool orchestrator — TOOL_NAMES + conditional group registration
      prompt-definitions.ts            # MCP prompt registrations + Zod arg schemas
      tools/                           # Tool group modules (one per data-layer domain)
        tool-helpers.ts                # Shared ToolRegistrationContext type + safeHandler
        vault-crud-tools.ts            # 9 tools: read, write, patch, replace, delete, move
        search-tools.ts                # 11 tools: search, tags, properties, graph queries
        memory-tools.ts                # 4 tools: get/update/list/delete memory
        daily-note-tools.ts            # 1 tool: get daily note
    search/                            # SQLite FTS5 indexing + file watching
      search-index.ts                  # SQLite FTS5 factory (tags, folders, etc)
      file-watcher.ts                  # chokidar -> keeps index current
                                       # Phase 2: gains a semantic-ingestion hook
    oauth/                             # OAuth 2.1 (provider, routes, consent)
      oauth-provider.ts                # OAuthServerProvider — JWT tokens, SQLite persistence
      oauth-routes.ts                  # SDK auth router + consent form handler
      consent-page.ts                  # HTML consent page for OAuth authorization
```

### Module layering

The `vault-mcp/` tree is organized in dependency layers — parsers → I/O →
use-cases → protocol → wiring. A module's folder is decided by **what it depends
on**, not just its topic:

- **`obsidian-markdown/`** — pure parsers/transforms over Obsidian-flavored
  Markdown (frontmatter, lines, headings, callouts, links). **No fs, no SQLite,
  no MCP**; they take strings/lines and return data or transformed strings, so
  they're trivially unit-testable. `lines.ts` is the single home of the
  CommonMark §4.5 fence state machine (`advanceFence`) — every fence-aware walk
  threads it, so they can't disagree about where a fence opens.
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
- **`mcp-core/`** — the MCP protocol surface. `tool-definitions.ts` is the
  orchestrator that composes `TOOL_NAMES` from four domain group modules under
  `mcp-core/tools/` (vault-crud, search, memory, daily-note) and calls each
  register function — conditionally skipping memory tools when `MEMORY_ENABLED`
  is `false`. Each group module is self-contained: its own tool name constants,
  register function, and data-layer imports. Shared helpers (`safeHandler`,
  `formatNoteMetadata`, `ToolRegistrationContext` type) live in `tool-helpers.ts`.
  `prompt-definitions.ts` registers the MCP prompts (not yet split into groups).
- **`search/`** — SQLite FTS5 index + file watcher. **`oauth/`** — the OAuth 2.1
  server (distinct from the shared `src/auth.ts` token utilities).
- **`utils/`** (at `src/`) — generic cross-cutting helpers.

Two rules keep this honest:

- **Dependency direction.** `obsidian-markdown/` and `utils/` depend on nothing
  internal (leaf layers); `vault-operations/` and `search/` depend on those;
  `mcp-core/` and the top-level wiring depend on everything. A _search_ module
  importing a _parser_ should read as "uses the shared parser," never as reaching
  sideways into `vault-operations/`.
- **Top level is wiring only.** Folders are domains; the only loose files at
  `vault-mcp/` are the entry point (`server.ts`) and its `config.ts`.

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

**Export style** depends on what kind of module it is:

- **Service / data-layer modules** — those that wrap a cohesive set of operations
  over a resource (the vault, the index) — export a **single namespace object**
  so call sites self-document which module an operation belongs to:
  `vaultFs.readNote(…)`, `vaultPatcher.patchNote(…)`, `noteMover.moveNote(…)`.
  Stateful ones use a **factory-closure** returning that object
  (`createSearchIndex`, `createMemoryStore`), so prepared statements / caches
  live in the closure.
- **Parser and small-helper modules** — the `obsidian-markdown/` parsers
  (`frontmatter`, `headings`, `callouts`, `lines`), `utils/`, and `daily-notes` —
  export **named functions**. The shape tracks whether a module is a _cohesive
  service surface_ (→ namespace) or just a loose set of functions (→ named),
  **not** whether it does I/O: the parsers are pure, while `daily-notes` does
  light I/O (reads and caches daily-note config), yet both use named exports
  because neither is a grouped service API.
- **`links.ts` is the deliberate edge case** — a pure parser that nonetheless
  exports a single `links` namespace, _not_ for the service-grouping reason above
  but to wall off its `/g` grammar regexes (shared `lastIndex` footgun) behind
  position-safe methods.

`vault-filesystem.ts` illustrates the nuance within one module: its high-level
data API is grouped under `vaultFs`, but its low-level shared primitives
(`resolveSafePath`, `atomicWriteFile`, `pruneEmptyParents`, …) are **named
exports** — infrastructure consumed à la carte by other modules, not part of the
vault data API.

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
- Each tool group module (`mcp-core/tools/*.ts`) creates a **request
  logger** per tool call, adding `requestId` (from the MCP SDK's
  `RequestHandlerExtra`) + `tool` name (from the module's own
  `TOOL_NAMES` constant)
- Data-layer functions (`vault-filesystem`, `vault-patcher`,
  `note-mover`, `memory-store`, `search-index`) take the logger as a
  **required** second argument (two-arg pattern: `(params, logger)`)
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

**info vs debug boundary:** `info` is for **per-request summaries** —
one log per tool call or lifecycle event (startup, shutdown, rebuild).
`debug` is for **per-file background events** — fired by the file
watcher or during bulk indexing, with no user-initiated action. If the
log would produce N lines during a vault rebuild (one per note), it's
`debug`; if it produces one summary line, it's `info`.

## Platform

The server runs in Linux Docker — even on Windows and macOS, Docker
Desktop runs a Linux VM internally. Path operations (`relative`,
`join`, `basename`) produce POSIX separators (`/`) in all deployment
paths; `WINDOWS_MODE=true` handles Docker Desktop's WSL2 bind mount
limitations (no hard links, polling for file watching) but does not
change path separator behavior. Native Windows execution (without
Docker) is not a supported deployment and would break path handling
throughout the codebase.

## Code style

- Functional over OOP. Arrow functions over `function` declarations.
- Factory/closure pattern for stateful modules (see search-index.ts).
- `type` over `interface` unless `interface` is specifically required.
- TypeScript strict mode. `node:` prefix for built-ins.
- Explicit return types on exports. Zod for MCP tool schemas.
- No `any`. No `as` or `!` (non-null assertion) — both are type
  assertions that bypass the compiler. Use runtime guards (`if (x ===
undefined) return`) or schema validation to narrow types instead.
  Prefer `async/await` over `.then()`/`.catch()`.
- Luxon `DateTime` over the native `Date` API. Luxon is declarative
  (`DateTime.now().minus({ days: 7 }).toISODate()`), immutable, and
  avoids manual arithmetic (`Date.now() - 7 * 86_400_000`) and
  mutation (`date.setDate()`). Use `DateTime.now()` for current time,
  `.toISO()` for timestamps, `.toISODate()` for date-only strings,
  `.toUnixInteger()` for epoch seconds.
- Immutable by default. Avoid `let` — carry state in a reduce that
  returns a _new_ accumulator each step, use early returns, or
  destructure conditional results. A bit of duplication is acceptable to
  keep code immutable and clear. When `let` is necessary (caching, parser
  state), add a comment justifying why mutation is needed here.
- Don't disguise mutation as a fold. A `reduce` that mutates its
  accumulator (`acc.push(...)`, `acc.count += …`, then `return acc`) is
  the worst of both worlds — it reads as declarative but isn't, so a
  reader has to mentally run it to see what it builds. Pick one and be
  honest: a genuine immutable fold (return a new value each step) for a
  real reduction to a single value, or a plain `for…of` loop with a
  justifying comment when the state is inherently sequential (a parser
  threading line-by-line state). A map-plus-sum is not a reduce —
  `items.map(rewrite)` then a separate, named count sum reads on its own.
- Explicit names over abbreviations. Variable names should describe
  what the value _is_, not use shorthand (`availableHeadings` not
  `available`, `searchText` not `needle`, `fileContent` not `raw`,
  `filesIndexed` not `count`).
  This applies everywhere: function params, callback params (`row`
  not `r`, `entry` not `e`, `orphan` not `o`), SQL aliases
  (`element` not `je`), destructured bindings, and loop variables.
- Lean toward named records over positional tuples, and named locals over
  inline expressions, where it helps a line read on its own — `{ start, end }`
  over `[start, end] as const` destructured as `[spanStart, spanEnd]`;
  `const linkText = match[0]` over an inline `match[0].length`. Judgment,
  not a hard rule: an inline expression that's obvious in its context is
  fine. Optimize for readability in context, not mechanical extraction.
- Function and helper names state what they _do_, specifically — a reader
  should know what a function does without reading its body
  (`collectWikilinksFrom` not `collect`,
  `convertFrontmatterDatesToIsoStrings` not `normalizeDates`). A docstring
  complements a self-documenting name; it never excuses a vague one.
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
- Name booleans (params, flags, locals) for the affirmative state, and
  let the value carry the negation: `hardLinksSupported: false` reads
  clearer than `hardLinksUnsupported: true`, and a double negative like
  `if (!notReady)` is a smell. A positively-named flag also keeps the
  guard's condition positive (`if (hardLinksSupported) { … return }`),
  so it pairs naturally with the early-return rule above — the common
  path returns, the fallback flows beneath it, no `else`.
- Simple code over clever code when the same outcome is achievable.
  A person should be able to read and follow the code without
  unnecessary cognitive overload. Working is the floor, not the bar — if
  "it passes" were enough, code review wouldn't matter. The first
  structure that compiles is rarely the simplest: before settling, ask
  whether it can be done with fewer moving parts and in fewer lines, and
  whether this is the shape that makes the most sense or just the first
  that came to mind. Each line should say what it does on its own — a
  reader shouldn't have to simulate the code to follow it.
- MCP tool descriptions include `Example:`, `When to use:`, and
  `Returns:` sections. Include `Errors:` whenever the tool has
  failure modes (with remediation guidance) or a no-match /
  empty-result contract worth clarifying (e.g. "returns an empty
  array, not an error"); omit it only for tools that cannot
  meaningfully fail. Include `Obsidian syntax:` on write tools.

### MCP prompt conventions

Prompts (`prompt-definitions.ts`) are user-initiated workflows, distinct
from tools:

- **Kebab-case names** (`vault-orientation`, `memory-review`), exported
  via `PROMPT_NAMES` — mirroring `TOOL_NAMES`.
- **Short, picker-facing `title`/`description`** — they render in slash
  command / **+**-menu pickers, so no `Example:`/`Returns:` scaffolding;
  one or two sentences.
- **A prompt earns its place only through live content** — assembled at
  invocation time from the data layer — plus thin, durable instruction.
  Never re-encode a procedure that can drift (a prior `memory-checkpoint`
  slash command was removed for exactly this). Zero-arg prompts **omit**
  `argsSchema` so the SDK calls back as `(extra) =>`.
- **Handlers degrade, never throw** — wrap data gathering so a failure
  returns a valid fallback message; a prompt must not hard-fail the client.
- **`memory-review` is append-only by design** — it reads the memory layer
  as a dated **evolution** (never "newest supersedes older"), proposes only
  append updates, and never prunes "stale" entries.

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

- **Note-path tool inputs must end in `.md`.** Inputs naming a single markdown
  note — `path` on read/write/patch/replace/delete/delete_span/update_properties,
  `old_path`/`new_path` on move, `path` on backlinks/outgoing_links — require the
  full filename with extension; a bare `Projects/Plan` is rejected. Enforced by
  the generic `assertPathHasExtension(path, ".md")` util
  (`src/utils/assert-path-has-extension.ts`), called in the data-layer function
  each tool routes through (one rule, every layer). Folder, glob, and
  memory-file (`file`) inputs are exempt.

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
- A test must pass **only** for the intended reason — not for an
  unintended or coincidental one. These are two separate bars, and
  both must hold: (1) the test fails when the behavior is wrong
  (above), and (2) it passes _because the intended behavior
  occurred_, not because of a no-op or a different code path that
  happens to leave the asserted state. Guard against the second:
  - **Silent no-op.** A test asserting "the folder is retained /
    state X is preserved" passes even if the triggering operation
    never ran. Also assert the trigger happened — that the note was
    actually deleted / actually moved — so retention can't be
    satisfied by doing nothing.
  - **Wrong-error pass.** `rejects.toThrow()` with no argument
    matches _any_ error, so a test meant to verify "rejected for
    reason A" can pass on an unrelated failure (e.g. a missing
    fixture throwing ENOENT). Assert the specific message, and set
    up the fixture so the intended rejection is the only one
    possible.
  - **Early-return pass.** A returned `0`/empty/`false` can come
    from the guard you're testing _or_ from the function bailing out
    before reaching it. Assert a side effect that only the intended
    path produces (e.g. the expected `warn` was logged) so the
    happy-accident return can't pass.
    When in doubt, mutate the code (break the specific behavior) and
    confirm the test fails for _that_ reason — not a compile error or
    an unrelated assertion.
- Exact assertions (`toHaveLength(2)`, `toBe("value")`) over
  loose matchers (`toBeGreaterThanOrEqual(1)`, `toBeDefined()`)
  when the expected value is known.
- Prefer an exact assertion on the **whole** value (`toBe` on the
  full output/object) over `contains`/substring checks when the
  output is deterministic and you control the inputs — `contains`
  silently tolerates ordering changes, formatting drift, and
  accidental duplication. Reserve `contains` for when only a
  fragment is genuinely under test (one branch among many, or an
  excerpt of large output).
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
for the generated release notes with a `BREAKING CHANGE:` footer in the PR
description (primary: it carries the descriptive line and is read from the
merged PR via the API, so it survives even when the squash body is dropped).
A `breaking-change` PR label or a `!` type marker (`feat(scope)!:`) also work
as flags.

### Files that track feature surface

Several files outside `src/` reflect the project's feature surface and
need updating alongside code changes. What to check depends on what
changed:

| File                                 | Update when…                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                          | Tool/prompt count changes, new deployment mode, new feature worth mentioning in the value prop                                                           |
| `ARCHITECTURE.md`                    | New component, requirement, or design decision; component diagram changes                                                                                |
| `server.json`                        | Tool/prompt count changes (the `tools` and `prompts` fields)                                                                                             |
| `assets/social-preview.svg` + `.png` | Tool count changes (rendered in the image); regenerate PNG after SVG edits                                                                               |
| `.devin/wiki.json`                   | New architectural area (new page), module renamed/moved (update `repo_notes` or `purpose` references), significant tool count jump (update `repo_notes`) |
| `deploy/local/` + `deploy/remote/`   | New env var, changed default, new deployment step, or Docker Compose service change — update `.env.example` and `README.md` in the affected directory    |
| `.env.example` (root)                | New env var or changed default for the Lightsail reference deployment                                                                                    |
| `CONTRIBUTING.md`                    | CI pipeline, repo settings, or release conventions change                                                                                                |
| `DEPLOY.md`                          | Infrastructure, env vars, or deployment procedure changes                                                                                                |

Not every PR touches these — a new tool in an existing category needs
a `server.json` + `README.md` count bump but nothing else. A module
rename needs `.devin/wiki.json` + `ARCHITECTURE.md`. Use the table as
a checklist, not a mandate to touch every file.

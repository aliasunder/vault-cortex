# Changelog


## [0.11.2] — 2026-05-16

### Documentation

- OAuth 2.0 → OAuth 2.1 (#36)
- Update CHANGELOG.md for v0.11.1

### Maintenance

- Align Node references on Node 24 and fix doc inaccuracies (#37)

All notable changes to this project will be documented in this file.


## [0.11.1] — 2026-05-16

### Bug Fixes

- Env-var import — default import, not namespace (#35)


## [0.11.0] — 2026-05-16

### Bug Fixes

- Collapse blank lines when vault_replace_in_note deletes text (#34)

### Documentation

- README rewrite and deployment docs for open-source (#33)
- Update CHANGELOG.md for v0.10.0


## [0.10.0] — 2026-05-16

### Features

- Auto-create memory files on first write (#32)
- Add local and remote Docker quickstart deploys (#31)

### Documentation

- Update CHANGELOG.md for v0.9.0


## [0.9.0] — 2026-05-16

### Bug Fixes

- **deps:** Resolve dependabot security alerts (#30)

### Documentation

- Add community files for open-source release (#24)
- Update CHANGELOG.md for v0.8.1

### Maintenance

- **deps:** Update all dependencies, Node 24, TypeScript 6 (#27)


## [0.8.1] — 2026-05-15

### Documentation

- Improve tool descriptions for structural edit safety (#23)
- Update CHANGELOG.md for v0.8.0


## [0.8.0] — 2026-05-15

### Features

- Externalize configuration for open-source adoption (#22)

### Documentation

- Document sort order in search-by-tag/folder/property tool descriptions
- Update CHANGELOG.md for v0.7.0


## [0.7.0] — 2026-05-14

No notable changes.


## [0.6.4] — 2026-05-14

### Features

- Add Obsidian syntax guidance to write tool descriptions (#21)

### Documentation

- Update CHANGELOG.md for v0.6.3


## [0.6.3] — 2026-05-14

### Refactoring

- Organize vault-mcp into domain subdirectories (#20) (#20)
- Replace magic string tool names with TOOL_NAMES const object map (#19)

### Documentation

- Update CHANGELOG.md for v0.6.2


## [0.6.2] — 2026-05-14

### Bug Fixes

- FTS5 hyphen-as-negation in vault_search (#18)

### Documentation

- Update CHANGELOG.md for v0.6.1


## [0.6.1] — 2026-05-14

### Bug Fixes

- Preserve trailing %% comment blocks in vault_patch_note (#17)

### Documentation

- Update CHANGELOG.md for v0.6.0

### Maintenance

- Update .gitignore


## [0.6.0] — 2026-05-13

### Features

- **vault-mcp:** Backlinks, outgoing links, and orphan detection (19 → 22) (#16)

### Documentation

- Update CHANGELOG.md for v0.5.0


## [0.5.0] — 2026-05-13

### Features

- **vault-mcp:** Daily note + property discovery tools (15 → 19) (#15)

### Bug Fixes

- **deploy:** Wait for container health before curl /healthz (#11)

### Refactoring

- **tool-definitions:** Rewrite safeHandler with try/catch (#13)

### Documentation

- Update CHANGELOG.md for v0.4.0

### Other Changes

- **vault-mcp:** Cover server.ts helpers and mcp-router.ts (#14)


## [0.4.0] — 2026-05-13

### Features

- **mcp:** Add vault_patch_note and vault_replace_in_note tools (#12)

### Refactoring

- Rename mtime → modified, convert to ISO 8601

### Documentation

- Update CHANGELOG.md for v0.3.0


## [0.3.0] — 2026-05-12

### Features

- **mcp:** FTS5 fix, search response shape, tool descriptions, new tools (#9)

### Documentation

- Update CHANGELOG.md for v0.2.0

All notable changes to this project will be documented in this file.

## [0.2.0] — 2026-05-11

### Features

- **oauth:** 60-day sliding refresh + Luxon, JWT tests, doc sweep (#8)
- **sst:** Add Lightsail durability — auto-snapshot + Pulumi protect (#7)

### Documentation

- Update CHANGELOG.md for v0.1.2

## [0.1.2] — 2026-05-11

### Bug Fixes

- **ci:** Inline deploy + release in manual_release so the chain fires (#6)


## [0.1.1] — 2026-05-11

Initial tagged release — Phase 1 scaffold and core implementation.

### Features

- Phase 1 scaffold (vault-cortex remote MCP server) (#1)
- Implement vault-filesystem and search-index (Phase 1 Session 1)
- Implement Phase 1 Session 2 — memory-store, file-watcher, tool-definitions, server
- Add OAuth 2.0 with JWT tokens and defense-in-depth auth
- Add server description and instructions for Claude Desktop connector UI

### Bug Fixes

- Use dedicated deploy key to prevent instance replacement
- Run vault-mcp as UID 1000 (node user) to match vault volume
- Add init container to fix obsidian config volume permissions
- Mount obsidian config volume at correct path
- Store session in Map after handleRequest sets the session ID
- Serve MCP at /mcp endpoint (Claude Desktop compatibility iteration)
- Proper rate limiting with Forwarded header key generator, trust proxy = 1
- Disable rate limiting on OAuth endpoints
- Remove authorizer identity source so OAuth paths aren't auto-rejected
- Rebuild better-sqlite3 native addon after --ignore-scripts
- Docker build fails on husky not found and missing sst-env.d.ts
- **ci:** Add default bump value so mobile UI can dispatch manual_release (#4)

### Refactoring

- Extract MCP and OAuth routes from server.ts

### CI / Infrastructure

- Add GitHub Actions for build, deploy, and release (#3)

### Maintenance

- Collapse Dockerfile to single stage, add local dev workflow
- Add Prettier, ESLint, Husky, lint-staged and fix Node types
- Split CLAUDE.md into AGENTS.md for multi-agent support
- Pin Node 22 with strict engines, harden mermaid subgraph IDs (#2)
- Add version 0.1.0 to package.json (#5)

### Documentation

- Comprehensive README, AGENTS, ARCHITECTURE for OAuth, init container, UID, volumes
- Split one-time setup into copy-pasteable blocks
- Fix GHCR login to pipe token from .env
- Fix token setup and rotation instructions in README
- Fix refresh token lifetime in ARCHITECTURE.md (no expiry, not 7d)
- Add public repo portability constraint to AGENTS.md
- Clarify MCP Inspector requires running server, add two-terminal flow

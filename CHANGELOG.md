# Changelog

















## [0.15.13] — 2026-06-08

### Bug Fixes

- Publish multi-arch (amd64 + arm64) Docker image (#76)

### Documentation

- Harden llms-install.md against real Cline setup failures (#77)
- Add llms-install.md for Cline Marketplace setup (#75)
- Update CHANGELOG.md for v0.15.12

## [0.15.12] — 2026-06-07

### Documentation

- Lead README with banner, center badges; add banner border (#74)
- Update CHANGELOG.md for v0.15.11

### Other Changes

- Bump wordmark to SemiBold (600) on banner + social card (#73)
- Brand icon + social preview card + consistent dark-mode banner (#72)

## [0.15.11] — 2026-06-07

### Documentation

- Update CHANGELOG.md for v0.15.10

### CI / Infrastructure

- Bump mcp-publisher to v1.7.9 to fix OIDC audience 401 (#71)

## [0.15.10] — 2026-06-07

### Documentation

- Update CHANGELOG.md for v0.15.9

### CI / Infrastructure

- Auto-publish to MCP Registry on release via GitHub OIDC (#70)

## [0.15.9] — 2026-06-06

### Documentation

- Update CHANGELOG.md for v0.15.8

### Maintenance

- **deps-dev:** Bump the development group with 5 updates (#69)
- **deps-dev:** Bump typescript-eslint in the development group (#68)
- **deps:** Bump sst from 4.14.3 to 4.15.2 in the production group (#67)

## [0.15.8] — 2026-05-27

### Bug Fixes

- Sort vault_search_by_folder results by most recently modified

### Documentation

- Scope delete_note recoverability claim and add Errors sections
- Enrich low-scoring tool descriptions for Glama TDQS
- Cache-bust Glama score badge and simplify alt text (#65)
- Update CHANGELOG.md for v0.15.7

### Other Changes

- Assert every tool description includes a Returns section

## [0.15.7] — 2026-05-26

### Documentation

- Update CHANGELOG.md for v0.15.6

### Maintenance

- **deps:** Bump qs from 6.15.1 to 6.15.2 (#64)
- **deps:** Bump sst from 4.14.1 to 4.14.3 in the production group (#62)
- **deps-dev:** Bump the development group with 5 updates (#63)

## [0.15.6] — 2026-05-20

### Bug Fixes

- Grant auto_release.yml the permissions deploy.yml requires (#61)

### Documentation

- Update CHANGELOG.md for v0.15.5

## [0.15.5] — 2026-05-20

### Bug Fixes

- Static token rejected by requireBearerAuth (missing expiresAt) (#60)
- OCI package version belongs in identifier tag, not version field (#59)
- Hardcode transport.url port for MCP Registry validation (#58)

### Documentation

- Add Glama listing badge to README (#57)
- Update CHANGELOG.md for v0.15.4

## [0.15.4] — 2026-05-20

### Bug Fixes

- Server.json audit corrections + OCI ownership label (#56)

### Documentation

- Update CHANGELOG.md for v0.15.3

## [0.15.3] — 2026-05-19

### Documentation

- Link Obsidian, Obsidian Sync, and headless docs on first mention (#54)
- Update CHANGELOG.md for v0.15.2

### CI / Infrastructure

- Skip Auto Release when triggered by release App push (#53)

### Maintenance

- Registry-listing prep — server.json, glama.json, README count, release automation (#55)

## [0.15.2] — 2026-05-19

### Documentation

- Update CHANGELOG.md for v0.15.1

### CI / Infrastructure

- Authenticate release pushes via GitHub App token (#52)

## [0.15.1] — 2026-05-19

### Features

- Persist logs across deploys, prune dangling images (#50)

### Bug Fixes

- Only toggle %% comment state at line boundaries (#51)
- Bust camo proxy cache for license badge
- Format server.json + run prettier after jq in release workflow

### Documentation

- Add Gitleaks workflow status badge
- Update CHANGELOG.md for v0.15.0

### CI / Infrastructure

- Use secrets for sensitive deploy config, mask IP in logs

### Maintenance

- **deps-dev:** Bump brace-expansion from 5.0.5 to 5.0.6 (#49)

## [0.15.0] — 2026-05-19

### Features

- Add vault_update_properties + properties_only on read (#48)

### Documentation

- Update CHANGELOG.md for v0.14.0

## [0.14.0] — 2026-05-19

### Refactoring

- Readability pass — naming, comments, simplicity (#45)

### Documentation

- Fix stale references, release automation, and pre-public language (#47)
- Add ORIGIN_URL healthcheck to verify section
- Reorder verify steps, note port 8000 may be closed
- Add Auth Keys (Write) scope to Tailscale OAuth instructions
- Update CHANGELOG.md for v0.13.0

### Maintenance

- Remove dead code, unused exports, etc (#44)

### Other Changes

- Add verifyAccessToken coverage for three-tier auth (#46)

## [0.13.0] — 2026-05-18

### Features

- Close port 8000 with configurable origin routing (#43)

### Documentation

- Update CHANGELOG.md for v0.12.1


## [0.12.1] — 2026-05-18

### Bug Fixes

- Prevent port 8000 wipe by avoiding ForceNew on InstancePublicPorts (#42)


## [0.12.0] — 2026-05-18

### Features

- Restrict SSH to Tailscale with configurable firewall CIDRs (#40)

### Maintenance

- Remove unneeded type


## [0.11.3] — 2026-05-17

### Features

- Throttle API Gateway stage to 20 RPS / 40 burst (#39)

### Documentation

- Update CHANGELOG.md for v0.11.2

### CI / Infrastructure

- Add gitleaks secret scanning (#38)


## [0.11.2] — 2026-05-16

### Documentation

- OAuth 2.0 → OAuth 2.1 (#36)
- Update CHANGELOG.md for v0.11.1

### Maintenance

- Align Node references on Node 24 and fix doc inaccuracies (#37)


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

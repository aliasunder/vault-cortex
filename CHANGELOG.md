# Changelog


## [0.11.1] — 2026-05-16

### Bug Fixes

- Env-var import — default import, not namespace (#35)


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

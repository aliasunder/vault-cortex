# Changelog





















## [0.25.3] — 2026-07-02

### Bug Fixes

- **memory:** Make vault_update_memory idempotent on exact duplicate entries (#245)
- **mcp:** Return 405 for GET /mcp instead of holding a standalone SSE stream (#246)

### Documentation

- **readme:** Update trip dogfooding stat to audited tool-call count (#244)
- Add force_deploy and ghcr-cleanup to DEPLOY.md workflow table (#243)
- Add missing files to AGENTS.md structure tree (#242)
- Update CHANGELOG.md for v0.25.2

## [0.25.2] — 2026-07-01

### Documentation

- Complete the hybrid search narrative (#241)
- Update DeepWiki annotations for Phase 2 (#240)
- Update CHANGELOG.md for v0.25.1

## [0.25.1] — 2026-07-01

### Documentation

- Polish README and ARCHITECTURE for readability (#239)
- Update CHANGELOG.md for v0.25.0

### Maintenance

- **cli:** Add cross-encoder and reranking npm keywords (#238)

## [0.25.0] — 2026-07-01

### Features

- **search:** Add cross-encoder reranker with position-aware score blending (#235)

### Refactoring

- **prompts:** Decompose prompt-definitions into prompts/ directory (#236)

### Documentation

- Update CHANGELOG.md for v0.24.0

### Maintenance

- **cli:** Update npm keywords for Phase 2 search (#237)
- Remove dead Phase 2 workflow + unused type exports (#234)

## [0.24.0] — 2026-06-30

### ⚠ BREAKING CHANGES

- Search index factory `createSearchIndex` gains an optional second parameter (`embedder`). Existing callers are unaffected.
- Docker base image changed from Alpine to Debian slim. Users with Alpine-specific customizations (apk packages, musl-linked binaries) need to update to Debian equivalents.

### Features

- **search:** Add hybrid search with RRF fusion (#224)
- **search:** Add embedding pipeline for vector search indexing (#217)

### Bug Fixes

- Normalize trailing slashes in folder filter inputs (#233)
- **search:** Run embedding pass in background so server starts immediately (#218)

### Refactoring

- **search:** Decompose search-index.ts into focused modules (#226)

### Documentation

- Update README and ARCHITECTURE for Phase 2a completion (#227)
- Update feature surface docs for hybrid search (#225)
- Update CHANGELOG.md for v0.23.12

### Maintenance

- **deps-dev:** Bump the development group across 1 directory with 3 updates (#232)
- **deps:** Bump aws-actions/configure-aws-credentials from 6.2.0 to 6.2.1 (#230)
- **deps:** Bump tailscale/github-action from 4.1.2 to 4.1.3 (#231)

### Other Changes

- Migrate Docker base image from Alpine to Debian slim (#215)

## [0.23.12] — 2026-06-29

### Features

- Add fail-fast exclusive file lock for vault write operations (#223)

### Bug Fixes

- Serialize concurrent writes to prevent TOCTOU lost updates (#220)
- Pass MEMORY_ENABLED through docker-compose to container (#219)

### Documentation

- Update CHANGELOG.md for v0.23.12
- Update CHANGELOG.md for v0.23.11

### CI / Infrastructure

- Fix skip_deploy to build image but skip instance deploy (#222)
- Add skip_deploy escape hatch to manual release workflow (#221)

## [0.23.11] — 2026-06-27

### Bug Fixes

- **search:** Include symlinked files in vault indexing and listing (#213)

### Documentation

- Update CHANGELOG.md for v0.23.10

## [0.23.10] — 2026-06-26

### Features

- **tools:** Require the ".md" extension on note-path tool inputs (#209)

### Documentation

- Fix Remote access bullet anchor to point at Deployment Options (#212)
- Update CHANGELOG.md for v0.23.9

### Maintenance

- **deps:** Bump node from `156b55f` to `a0b9bf0` (#210)
- **deps-dev:** Bump the development group with 6 updates (#211)

## [0.23.9] — 2026-06-25

### Documentation

- **tools:** Revert vault_delete_note to 4.9-era TDQS structure (#208)
- Update CHANGELOG.md for v0.23.8

### Other Changes

- Lightsail 4GB upgrade + Phase 2 deploy workflow (#207)

## [0.23.8] — 2026-06-25

### Documentation

- **tools:** Fix TDQS regressions in vault_list_property_values, vault_search_by_property, vault_delete_note (#205)
- Update CHANGELOG.md for v0.23.7

## [0.23.7] — 2026-06-25

### Documentation

- **tools:** Improve TDQS scores for 10 sub-5.0 tools (#204)
- Update CHANGELOG.md for v0.23.6

## [0.23.6] — 2026-06-25

### Documentation

- **arch:** Add SSH hardening cross-reference to Infrastructure section (#203)
- **tools:** Fix vault_get_backlinks TDQS regression, improve 4 sub-5.0 tools (#202)
- Update CHANGELOG.md for v0.23.5

## [0.23.5] — 2026-06-25

### Features

- **security:** OAuth audit logging + prompt content data markers (#198)

### Bug Fixes

- **search:** Exclude Templater syntax and daily note forward-refs from broken link detection (#200)
- **security:** Escape closing vault-content tags in prompt data markers (#201)

### Documentation

- **tools:** TDQS improvement pass across all 25 tool descriptions (#199)
- Update CHANGELOG.md for v0.23.4

## [0.23.4] — 2026-06-24

### Bug Fixes

- **move:** Handle escaped pipe wikilinks in table cells (#196)

### Documentation

- **arch:** Fix tool table accuracy and enrich Key Decisions (#197)
- **tools:** Improve TDQS scores and cross-tool discoverability (#195)
- Update CHANGELOG.md for v0.23.3

## [0.23.3] — 2026-06-24

### Features

- **search:** Non-markdown file awareness for broken link detection (#194)

### Documentation

- Update CHANGELOG.md for v0.23.2

## [0.23.2] — 2026-06-23

### Bug Fixes

- **links:** Stop counting escaped-pipe wikilinks and non-markdown assets as broken (#193)

### Documentation

- Update CHANGELOG.md for v0.23.1

## [0.23.1] — 2026-06-23

### Documentation

- Shorten Contents row labels to fit one line
- Sharpen README intro, cut redundancy, improve navigability (#192)
- Update CHANGELOG.md for v0.23.0

## [0.23.0] — 2026-06-23

### Features

- **prompts:** Enrich prompts with vault health, graph data, and actionable instructions (#189)
- **tools:** Tool_result logging sweep, input validation, memory bytes (#187)

### Documentation

- Align server.json and package.json descriptions with README positioning (#190)
- Sync AGENTS.md with tool group modules + TDQS lifts (#186)
- Update CHANGELOG.md for v0.22.0

### Other Changes

- Tighten assertions, fix naming, and add table-driven patterns across 23 test files (#188)

## [0.22.0] — 2026-06-22

### Features

- **tools:** Modular tool registration + memory layer opt-out (#185)

### Documentation

- Restructure README opening, add Why section, GIF context, and security positioning (#184)
- Update CHANGELOG.md for v0.21.1

## [0.21.1] — 2026-06-22

### Features

- **search:** Log filters and result count for vault_search (#174)

### Bug Fixes

- **ci:** Scope GHCR cleanup token to job-level packages:write (#181)
- **logging:** Include anchors in vault_delete_span log output (#180)

### Refactoring

- **utils:** Extract describeError + ENOENT fs helpers into src/utils (#171)
- **parsing:** Consolidate the fence state machine into lines.ts; memory sections via the shared parser (#169)
- **structure:** Split pure parsers into obsidian-markdown/ and MCP wiring into mcp-core/ (#168)

### Documentation

- **wiki:** Surface OAuth, TDQS, security toolchain, and awesome-mcp-servers listing (#183)
- Fix v0.21.0 changelog entry and delete orphan v0.20.3 tag (#182)
- Add .devin/wiki.json to steer DeepWiki page generation (#179)
- **jwt:** Clarify intentional avoidance of Luxon (#177)
- **agents:** Document module layering, dependency direction, and export conventions (#172)
- Add DeepWiki badge for auto-reindexing (#170)
- Update CHANGELOG.md for v0.21.0

### CI / Infrastructure

- Add scheduled GHCR cleanup for untagged image digests (#178)

### Maintenance

- Gitignore .DS_Store
- Revert CONFLICT_STRATEGY default from conflict to merge (#175)
- **deploy:** Set LOG_RETENTION_DAYS=365 for production (#173)

## [0.21.0] — 2026-06-21

### Features

- Add vault_delete_span for anchor-based block deletion (#166)

## [0.20.2] — 2026-06-21

### Features

- **patch:** Reject content that duplicates the target heading (#167)
- Add WINDOWS_MODE for a vault on a Windows C: drive (#164)

### Refactoring

- **links:** Extract Obsidian link domain into shared module (#165)

### Documentation

- Update CHANGELOG.md for v0.20.1

## [0.20.1] — 2026-06-21

### Features

- **vault:** Opt-in empty-folder pruning for delete and move (#163)

### Bug Fixes

- **assets:** Inline icon vector and embed font in social preview (#162)

### Documentation

- Update CHANGELOG.md for v0.20.0

## [0.20.0] — 2026-06-20

### Features

- **tools:** Add vault_move_note with vault-wide link rewriting (#160)

### Documentation

- **memory:** Document leading callouts, add created + related to templates (#161)
- Add demo GIFs to README (#159)
- Update CHANGELOG.md for v0.19.6

### Maintenance

- **deps-dev:** Bump the development group across 1 directory with 5 updates (#158)

## [0.19.6] — 2026-06-19

### Documentation

- Update CHANGELOG.md for v0.19.5

### Maintenance

- **deps:** Bump node from `21f403a` to `156b55f` (#156)
- **deps:** Bump actions/checkout from 6.0.3 to 7.0.0 (#155)
- **deps:** Bump better-sqlite3 from 12.10.0 to 12.11.1 in the production group (#154)

## [0.19.5] — 2026-06-18

### Features

- **search:** Include frontmatter in FTS5 search index (#153)

### Documentation

- Update CHANGELOG.md for v0.19.4

## [0.19.4] — 2026-06-18

### Bug Fixes

- **search:** Resolve relative (path-from-current-file) links (#152)

### Documentation

- Update CHANGELOG.md for v0.19.3

## [0.19.3] — 2026-06-18

### Bug Fixes

- **search:** Count frontmatter wikilinks in the link graph (#151)

### Documentation

- Update CHANGELOG.md for v0.19.2

## [0.19.2] — 2026-06-18

### Features

- **search:** Surface file size (bytes) in discovery tool responses (#150)

### Documentation

- Claude Desktop supports prompts (Chat + Cowork) (#149)
- Document promoted properties and fix prompt client support claims (#148)
- Update CHANGELOG.md for v0.19.1

## [0.19.1] — 2026-06-17

### ⚠ BREAKING CHANGES

- vault_read_note outline mode now returns { leading_callout?, headings } …

### Bug Fixes

- **registry:** Shorten server.json description under the 100-char cap (#147)

### Documentation

- Surface 3 guided prompts in CLI README + fix stale memory-template lists (#145)
- Update CHANGELOG.md for v0.19.0

### CI / Infrastructure

- **release:** De-duplicate identical breaking-change lines in release notes (#146)

## [0.19.0] — 2026-06-17

### ⚠ BREAKING CHANGES

- vault_read_note outline mode now returns { leading_callout?, headings } instead of a bare array of headings; clients parsing it as an array must read .headings.

### Features

- Add MCP prompts (vault-orientation, memory-review, daily-review) (#139)
- **callouts:** Surface note leading-callouts + self-documenting memory files (#140)

### Documentation

- Callout/outline docs, breaking-change release flow, tech-agnostic Phase 2 (#142)
- Update CHANGELOG.md for v0.18.2

### CI / Infrastructure

- **release:** Detect breaking changes from the merged PR, not the squash body (#143)

### Maintenance

- Bump node:24-alpine base image to clear trivy CVE (#144)

### Other Changes

- Disable CodeRabbit auto reviews (#141)

## [0.18.2] — 2026-06-15

### Bug Fixes

- **security:** Override js-yaml to 4.2.0, drop ignore files (#138)
- **security:** Eliminate js-yaml runtime path (GHSA-h67p-54hq-rp68) (#137)

### Documentation

- Foreground vault_search filter API in tool description (#136)
- Update CHANGELOG.md for v0.18.1

## [0.18.1] — 2026-06-15

### Bug Fixes

- **memory:** Resolve section names with or without the "(newest first)" suffix (#132)

### Documentation

- **coderabbit:** Clarify the scope of auto_incremental_review (#135)
- Document vault_read_note section-scoped read modes (#133)
- Update CHANGELOG.md for v0.18.0

### Other Changes

- Serialize memory writes and gate vault-mcp on sync health (#134)

## [0.18.0] — 2026-06-15

### Features

- **vault_read_note:** Add outline and section-scoped reads (#130)

### Documentation

- Update CHANGELOG.md for v0.17.8

### Maintenance

- **coderabbit:** Disable per-push incremental reviews (#131)

## [0.17.8] — 2026-06-14

### Features

- **memory:** Harden writes against partial-write and clobber data loss (#128)

### Documentation

- Update CHANGELOG.md for v0.17.7

### CI / Infrastructure

- Verify gitleaks download checksum before extracting (#129)

## [0.17.7] — 2026-06-14

### Features

- Switch obsidian-sync to the forked image, drop init-config-perms (#127)

### Documentation

- Update CHANGELOG.md for v0.17.6

## [0.17.6] — 2026-06-13

### Bug Fixes

- **cli:** Copyable, mode-consistent `init` connect output + PUBLIC_URL validation (#126)

### Documentation

- Update CHANGELOG.md for v0.17.5

## [0.17.5] — 2026-06-13

### Bug Fixes

- **cli:** Expand ~ in config dir and suggest user-scoped mcp add (#125)

### Documentation

- Update CHANGELOG.md for v0.17.4

## [0.17.4] — 2026-06-13

### Bug Fixes

- **auth:** Tolerate whitespace in consent-page token submission (#124)

### Documentation

- Update CHANGELOG.md for v0.17.3

## [0.17.3] — 2026-06-13

### Documentation

- Reroute localhost connect instructions for Claude's https-only connector dialog (#123)
- Update CHANGELOG.md for v0.17.2

## [0.17.2] — 2026-06-13

### Bug Fixes

- **deploy:** Return 401 for tokenless requests to enable MCP connect flow (#121)

### Documentation

- Update CHANGELOG.md for v0.17.1

### Maintenance

- **deps:** Bump esbuild from 0.28.0 to 0.28.1 (#122)

## [0.17.1] — 2026-06-12

### Documentation

- Update CHANGELOG.md for v0.17.0

### CI / Infrastructure

- Add Force Deploy dispatch workflow (redeploy current release) (#119)
- **deploy:** Stop emitting instance identifiers as SST outputs (#118)

## [0.17.0] — 2026-06-12

### Features

- **deploy:** Optional custom domain for API Gateway (#117)

### Documentation

- **readme:** Restructure quick start — CLI-first remote, shared connect section (#116)
- Update CHANGELOG.md for v0.16.3

## [0.16.3] — 2026-06-11

### Documentation

- Reflect Trivy PR gating and Scorecard publishing (#115)
- Update CHANGELOG.md for v0.16.2

### CI / Infrastructure

- Publish Scorecard results to the OpenSSF API (#114)
- Flip trivy-pr scan from report-only to gating (#113)
- Move workflow token writes from top level to job level (#112)
- Tool-prefixed job IDs for scan jobs (gitleaks, trivy-pr, trivy-published) (#111)

### Maintenance

- **deps-dev:** Bump the development group across 1 directory with 4 updates (#110)

## [0.16.2] — 2026-06-11

### Bug Fixes

- **deps:** Move sst to devDependencies (#100)

### Documentation

- Release flows reflect PR-only main (branch ruleset) (#108)
- Document security scanning workflows across contributor docs (#98)
- Remove mcpx feature badge from README hero (#99)
- Update CHANGELOG.md for v0.16.1

### Maintenance

- **deps:** Ignore major bumps for commander and the node base image (#109)
- **deps:** Bump yaml from 2.8.4 to 2.9.0 in the production group (#105)
- **deps:** Bump docker/setup-qemu-action from 3.7.0 to 4.1.0 (#104)
- **deps:** Bump aquasecurity/trivy-action from 0.35.0 to 0.36.0 (#103)

### Other Changes

- **docker:** Harden runtime image — apk security upgrades, drop npm (#107)
- **docker:** Pin base images by digest, add Dependabot docker updates (#101)

## [0.16.1] — 2026-06-11

### Documentation

- **readme:** Swap Glama score badge for card badge + 12h shields cache (#92)
- Update CHANGELOG.md for v0.16.0

### CI / Infrastructure

- Run Trivy published-image scan on pushes to main (#97)
- Add OpenSSF Scorecard analysis workflow (#96)
- Add Trivy image scanning + README badge (#95)
- Pin all GitHub Actions to commit SHAs (#94)

### Maintenance

- **cli:** Expand npm keywords for discoverability (#93)

## [0.16.0] — 2026-06-11

### Features

- Add `npx vault-cortex init` CLI scaffolding tool (#89)

### Bug Fixes

- Server image build broken by cli build coupling + release-notes tag filter (#91)

### Documentation

- Update CHANGELOG.md for v0.15.23

### CI / Infrastructure

- Create GitHub releases for CLI versions (#90)

## [0.15.23] — 2026-06-10

### Features

- Surface server icon and website URL in MCP serverInfo (SEP-973) (#87)

### Bug Fixes

- Vault_update_properties treats null as property deletion (#88)

### Documentation

- Update CHANGELOG.md for v0.15.22

## [0.15.22] — 2026-06-10

### Bug Fixes

- Prevent FTS5 syntax errors on punctuated vault_search terms (#86)

### Documentation

- Update CHANGELOG.md for v0.15.21

## [0.15.21] — 2026-06-10

### Bug Fixes

- Preserve frontmatter datetimes verbatim via string-preserving YAML engine (#85)

### Documentation

- Update CHANGELOG.md for v0.15.20

## [0.15.20] — 2026-06-09

### Documentation

- Promote obsidian-vault skill to dedicated README section (#84)
- Update CHANGELOG.md for v0.15.19

## [0.15.19] — 2026-06-09

### Documentation

- Update CHANGELOG.md for v0.15.18

### Other Changes

- Standardize human-readable display name to "Vault Cortex" (#83)

## [0.15.18] — 2026-06-09

### Documentation

- Update CHANGELOG.md for v0.15.17

### CI / Infrastructure

- Migrate release workflows to app client-id (#82)

## [0.15.17] — 2026-06-09

### Documentation

- Update CHANGELOG.md for v0.15.16

### Other Changes

- Lift Glama TDQS on the three lowest-scoring tools (#81)

## [0.15.16] — 2026-06-08

### Other Changes

- Add OCI image metadata so the GHCR package shows a description (#80)

## [0.15.14] — 2026-06-08

### Bug Fixes

- Build release image from the version tag so its stamp matches (#78)

### Documentation

- Update CHANGELOG.md for v0.15.13

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

# Contributing

Thanks for your interest in Vault Cortex! This guide covers everything you need
to get started.

## Quick Start

1. **Prerequisites:** Node.js >= 24 (see `.nvmrc`), Docker (optional, for
   container mode)

2. **Clone and install:**

   ```bash
   git clone https://github.com/aliasunder/vault-cortex.git
   cd vault-cortex
   npm install
   npx sst install
   ```

   **Windows:** this repo uses symlinks (`CLAUDE.md → AGENTS.md`). Run
   `git config core.symlinks true` before cloning, or re-clone after
   setting it — otherwise Git checks out symlinks as plain text files
   containing the target path.

   `npx sst install` fetches the SST platform types that `npm run build`
   typechecks `sst.config.ts` against.

3. **Run the checks:**

   ```bash
   npm test
   npm run lint
   npm run build
   ```

`npm test` runs the full suite: unit tests for individual modules, and
integration tests that boot a real server as a child process and call
every tool and prompt over real HTTP. The integration tests verify that
each config combination serves the correct tool surface, that auth
rejects invalid tokens, that write operations actually mutate the vault
(read-back verified), and that misconfiguration fails fast at boot.

`npm run test:coverage` runs the same suite with a statement-coverage
report (V8 provider); the `coverage/` output directory is gitignored.

## Development Modes

Vault Cortex can run in three modes during development:

### MCP server (no Docker)

The fastest feedback loop — runs the MCP server directly with hot reload:

```bash
PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/your-vault npm run dev:mcp
```

### Docker (local)

Runs the MCP server in Docker against your local vault (the Dockerfile's
`local` target — no Lightsail, no Obsidian Sync):

```bash
npm run dev:docker
```

### MCP Inspector

Interactive browser UI for testing all tools:

```bash
# Terminal 1 — start the server
PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/your-vault npm run dev:mcp

# Terminal 2 — launch the inspector
npx @modelcontextprotocol/inspector
```

See the [README](./README.md#development) for full details on each mode.

## The `cli/` Package

`cli/` is a separate npm package (`npx vault-cortex@latest init`) that scaffolds the
[deploy quickstarts](./deploy/). It is **not** an npm workspace — its two
runtime dependencies (`commander`, `@clack/prompts`) are also pinned in the
root `devDependencies` at identical versions, so the root `npm ci` covers
development. A test fails if the versions drift.

- Build: `npm run build` compiles both the server and `cli/` (or
  `npx tsc -p cli/tsconfig.json` alone)
- Test: `npm test` includes `cli/src/**/*.test.ts`
- Try it: `node cli/dist/bin.js init --help`

**Template sync rule:** `cli/templates/` holds verbatim copies of
The optional env blocks in `cli/src/env.ts` are derived from `deploy/*/.env.example`.
If you change any `.env.example`, run
`npm run sync:cli-env-blocks` in the same PR — drift tests fail CI otherwise.

**Publishing:** CLI releases are explicit and independent of server releases —
nothing publishes to npm as a side effect of a server release. The maintainer
runs the **"Release CLI"** workflow (Actions tab), choosing a
`patch`/`minor`/`major` bump (or `none` to publish the current version); it
bumps `cli/package.json` on `main`, tags `cli-v<version>`, publishes to npm
via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) —
no npm token secret is stored in the repo — and creates a `cli-v<version>`
GitHub release (marked non-latest so server releases keep the "Latest"
badge). The trusted publisher is
configured in the npm package settings for this repo + `cli_release.yml`. PRs
that change `cli/` should **not** bump the version — the release workflow owns
it. The npm package is deliberately absent from `server.json` — it's a
scaffolder, not a way to run the server.

**Beta testing:** The same **"Release CLI"** workflow supports a `beta` bump
option that publishes a prerelease under the `beta` dist-tag for testing CLI
changes before a real release. Dispatch from any branch — the version is set
to `{current}-beta.{run_number}` ephemerally (no commits, no tags, no GitHub
release). Test with `npx vault-cortex@beta`. The `latest` dist-tag is never
touched.

## Code Conventions

All code conventions — style, naming, logging, test patterns, MCP tool naming —
are documented in [AGENTS.md](./AGENTS.md). That file is the single source of
truth. Key points:

- Functional over OOP, arrow functions, factory/closure pattern
- TypeScript strict mode, Zod for MCP schemas, no `any`
- MCP wire format uses `snake_case`; internal TypeScript uses `camelCase`
- Tests read as a behavioral spec — one focused `it()` per behavior

## Pull Request Process

1. **Branch from `main`** — use a descriptive prefix (`feat/`, `fix/`, `docs/`,
   `refactor/`, `chore/`)
2. **Keep PRs focused** — one logical change per PR
3. **Run the full check suite** before pushing:

   ```bash
   npm run prettier:check && npm run lint && npm run markdownlint && npm run knip && npm test && npm run build
   ```

4. **Fill out the PR template** — the checklist mirrors CI
5. **Required checks must pass** — the `main` ruleset requires all eight;
   each blocks the merge and the finding details are in its job log:
   - `checks` — prettier, lint, markdownlint, knip, test, and build
   - `cli-smoke (20)` / `cli-smoke (22)` / `cli-smoke (24)` — builds the
     CLI and runs `init` on each supported Node major, catching APIs too
     new for the CLI's `engines` range
   - `arch-smoke (amd64)` / `arch-smoke (arm64)` — builds the Docker image
     and boots it on a native runner for each architecture, then boots the
     remote image with a stubbed Sync client to run its init chain
     end-to-end (`npm run test:remote-boot`)
   - `gitleaks` — secret detection over `main` plus the PR's commits, so a
     finding on `main` fails every open PR until it is cleaned up
   - `trivy-pr` — vulnerability scan of the Docker image built from your
     branch; a fixable CRITICAL/HIGH CVE fails it

## Issues

- **Bug reports:** use the bug report template — include steps to reproduce and
  your environment
- **Feature requests:** use the feature request template — describe the problem
  before the solution
- **Security issues:** see [SECURITY.md](./SECURITY.md) — report privately, not
  as a public issue

## Breaking changes

Release notes (`.github/scripts/generate-notes.sh`) lead with a **⚠ BREAKING
CHANGES** section. Breaking changes are detected from the **merged PR**, read
via the API at release time — the reliable source: a squash commit's body is
often dropped at merge (e.g. the GitHub mobile app), but the PR body and labels
always survive.

To mark a PR as breaking, add a **`BREAKING CHANGE:` footer** (its own
paragraph) at the **end of the PR description**. Its text becomes the
descriptive line in the ⚠ section. Example:

> BREAKING CHANGE: `vault_read_note` outline mode now returns an object
> `{ leading_callout?, headings }` instead of a bare array; clients parsing it
> as an array must read `.headings`.

Also recognized as breaking signals: a **`breaking-change` PR label** (optional —
create it once under repo Settings → Labels if you want a clickable flag) and a
**`!` type marker** in the squash subject (`feat(scope)!: …`), which survives the
merge even when the body is dropped. The `BREAKING CHANGE:` footer is preferred
because it carries the descriptive line; the label and `!` only flag that a change
is breaking.

## Release Process

Releases are cut by the maintainer. Two paths:

- **Manual Release:** Actions tab → "Manual Release" → choose
  `patch`/`minor`/`major`. Bumps version, deploys, creates GitHub Release.
- **Tag push:** merge a version-bump PR into `main`, then
  `git tag v<version> && git push --tags`

Direct commits to `main` are blocked by a branch ruleset — all changes,
version bumps included, land via PR.

The CLI releases separately: Actions tab → "Release CLI" (see
[The `cli/` Package](#the-cli-package)).

See the [DEPLOY.md CI/CD section](./DEPLOY.md#cicd) for details on each workflow.

## Railway template

The Railway one-click template (`railway.com/deploy/vault-cortex`) lives in
Railway's Template Composer, not in this repository; `deploy/railway/README.md`
is the user-facing guide. Re-creating the template from scratch is mechanical —
these are its settings:

| Setting           | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| Service name      | `vault-cortex`                                        |
| Source            | Docker image `ghcr.io/aliasunder/vault-cortex:remote` |
| Volume            | mount path `/persist`                                 |
| Public networking | HTTP, port `8000`                                     |
| Healthcheck path  | `/healthz`                                            |
| Restart policy    | On failure (Railway's default)                        |

Variables, in the order the deploy form shows them (everything after the six inputs sits under **Pre-Configured Environment Variables**, collapsed):

| Variable                          | Value                                 | Description shown on the deploy form                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                              | _(optional input)_                    | Your timezone as an [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List) (`America/Toronto`) — decides what "today" means for daily notes, task due dates, and memory timestamps. Leave empty for UTC |
| `VAULT_NAME`                      | _(required input)_                    | Your vault's name, exactly as it appears in Obsidian Sync                                                                                                                                                                       |
| `VAULT_PASSWORD`                  | _(optional input)_                    | Only if your vault uses end-to-end encryption; otherwise leave empty                                                                                                                                                            |
| `SYNC_FILE_TYPES`                 | _(optional input)_                    | Attachment types to sync: image, audio, video, pdf, unsupported — the same toggles as Obsidian's Sync → Selective sync. Leave empty to keep the Sync client's default                                                           |
| `OBSIDIAN_AUTH_TOKEN`             | _(optional input)_                    | Leave empty to sign in through the `/setup` page after deploy, or paste a token from `npx vault-cortex@latest get-sync-token`                                                                                                   |
| `SYNC_EXCLUDED_FOLDERS`           | _(optional input)_                    | Folders to leave out of sync, comma-separated — the same list as Obsidian's Sync → Excluded folders. Leave empty to exclude nothing                                                                                             |
| `MCP_AUTH_TOKEN`                  | `${{secret(64, "0123456789abcdef")}}` | Generated for you — the token your MCP client enters on the consent page                                                                                                                                                        |
| `PORT`                            | `8000`                                | The port the image listens on. Leave as is.                                                                                                                                                                                     |
| `STORAGE_ROOT`                    | `/persist`                            | Where the volume is mounted — vault, search index, Sync device state, and logs live under it. Leave as is.                                                                                                                      |
| `DEVICE_NAME`                     | `vault-cortex`                        | The device name that labels this container's changes in Obsidian's sync log                                                                                                                                                     |
| `TRUST_PROXY_HOPS`                | `2`                                   | Railway proxies between a visitor and the container, so the server sees the visitor's real address                                                                                                                              |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `900`                                 | How long Railway waits for the first health check — the first start downloads the vault and builds the index                                                                                                                    |
| `MEMORY_ENABLED`                  | `true`                                | The About Me/ memory layer and its tools. Set false to hide them and skip creating the folder                                                                                                                                   |
| `EMBEDDING_ENABLED`               | `true`                                | Semantic search. Set false to skip the models and use keyword search only — fits in much less memory                                                                                                                            |
| `READONLY_MODE`                   | `false`                               | Set true to hide every tool that changes the vault — clients can only read and search                                                                                                                                           |
| `FILE_TOOLS_ENABLED`              | `true`                                | vault_read_file and vault_list_files. Set false when Obsidian Sync has attachment syncing off                                                                                                                                   |
| `SYNC_MODE`                       | `bidirectional`                       | Sync direction: bidirectional, pull-only (server edits are kept locally but never uploaded), or mirror-remote (server edits are undone; the server is an exact copy)                                                            |
| `CONFLICT_STRATEGY`               | `merge`                               | Obsidian Sync conflict resolution: merge integrates changes automatically; conflict writes a separate conflict file                                                                                                             |

Update the template whenever the image tag, a boot-required variable, the
port, or the health path changes, then re-publish; existing deployments keep
their settings until their owners redeploy.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE). Note that the published `:remote` image bundles
Obsidian's proprietary `obsidian-headless` CLI (see the README license note) —
the MIT license covers this repository's code, not that component.

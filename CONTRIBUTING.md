# Contributing

Thanks for your interest in Vault Cortex! This guide covers everything you need
to get started.

## Quick Start

1. **Prerequisites:** Node.js >= 24 (see `.nvmrc`), Docker (optional, for
   container mode), `curl`, and `tar` with xz support (both preinstalled on
   macOS and most Linux distributions). The first `npm run lint:shell`, or
   the first commit that changes a shell script, uses them to download the
   [ShellCheck](https://www.shellcheck.net) release the repo pins for macOS
   and Linux on x86_64 and arm64

   **Windows:** work from
   [WSL](https://learn.microsoft.com/windows/wsl/install). Native Windows
   can't run the server outside Docker, because its path handling assumes
   `/` separators. No ShellCheck build is pinned for Windows either, so
   `npm run lint:shell` and commits that change a shell script fail there.

2. **Clone and install:**

   ```bash
   git clone https://github.com/aliasunder/vault-cortex.git
   cd vault-cortex
   npm install
   npx sst install
   ```

   **Linux (x64):** run the install as
   `ONNXRUNTIME_NODE_INSTALL=skip npm install`. Without the variable,
   `onnxruntime-node`'s install script downloads GPU binaries the server
   never uses, and the download fails — its archive extractor (`adm-zip`)
   is stubbed out to resolve a security advisory. macOS and arm64 Linux
   skip the download on their own.

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

Some tests deny access to a file and expect the access to fail. Root
ignores file permissions, so those tests skip when you run the suite as
root (inside a container, for example). To run them from a root shell,
use `npm run test:as-nobody`, which runs the suite as the `nobody` user.

`npm run test:coverage` runs the same suite with a statement-coverage
report (V8 provider); the `coverage/` output directory is gitignored.

`npm run test:remote-boot` boots the `:remote` image with a stubbed Sync
client and needs Docker. Each run builds its own image unless
`REMOTE_IMAGE` names an image you built (`npm run build:remote-image`
builds `vault-cortex:remote-ci`). The run labels every container and
named volume it creates with `vault-cortex.test-run=<run ID>` (the ID is
printed when the run starts), and removes them and any image it built
when it ends. If a run is killed before it ends, remove what it left with
its ID (the last command applies only to a run that built its own image):

```bash
RUN_ID=<run ID>
for container in $(docker ps -aq --filter "label=vault-cortex.test-run=$RUN_ID"); do docker rm -f -v "$container"; done
for volume in $(docker volume ls -q --filter "label=vault-cortex.test-run=$RUN_ID"); do docker volume rm -f "$volume"; done
docker image rm "vault-cortex:remote-boot-$RUN_ID"
```

## Development Modes

Vault Cortex can run in three modes during development:

### MCP server (no Docker)

The fastest feedback loop — runs the MCP server directly with hot reload:

```bash
mkdir -p .data && PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/your-vault INDEX_DB_PATH=.data/index.db npm run dev:mcp
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
mkdir -p .data && PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/your-vault INDEX_DB_PATH=.data/index.db npm run dev:mcp

# Terminal 2 — launch the inspector
npx @modelcontextprotocol/inspector
```

The [README's Development section](./README.md#development) also gives the full
check suite command, plus the URL and token the MCP Inspector asks for.

## Agent command setup

Claude Code uses the committed session/worktree hook. Other clients can opt in
through `.claude/hooks/prepare-command.sh`:

| Operation     | Behavior                                          |
| ------------- | ------------------------------------------------- |
| `environment` | Select Node without writing install state         |
| `prepare`     | Select Node and wait for dependency and SST setup |

1. Invoke the entry point with the chosen operation. Send JSON with the
   checkout's `cwd` and `hook_event_name: "PreToolUse"` on stdin.
2. Require a successful exit and stdout containing one nonempty absolute
   directory with an executable `node`. Both operations print only the
   selected physical Node bin directory.
3. Prepend the validated directory to the original command's PATH.

Ordinary `install-deps.sh` calls keep empty stdout and their existing behavior.
With nvm, selection uses the checkout's `.nvmrc` version when installed, then
nvm's default alias. If neither lookup finds an executable, or nvm is
unavailable, selection uses the current PATH. Setup never downloads Node.

Setup keeps the existing per-worktree lock and nonblocking failure behavior;
an exit of zero does not prove dependencies are ready. Check the actual test or
build result. Callers must allow time for setup and its lock wait. A checkout
without this entry point has not opted in.

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

**Env block sync:** The optional env blocks in `cli/src/rules/env-templates.ts` are derived
from `deploy/*/.env.example`. If you change any `.env.example`, run
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

**Releases with nothing to list:** A `patch`, `minor` or `major` release whose
[notes](#release-process) would list no commit since the last CLI release stops before anything is
tagged or published. The maintainer can dispatch it again with `force` to
release anyway.

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

**Before a feature PR:** a new feature (a tool, a prompt, a setting, a
parameter, a change to what a tool does) starts as a
[feature request](https://github.com/aliasunder/vault-cortex/issues/new?template=feature_request.yml),
so the design is agreed with the maintainer before you write code. A bug fix
can go straight to a PR. A feature PR ships with the tests
[AGENTS.md](./AGENTS.md) asks for and walks the checklist under
[Files that track feature surface](./AGENTS.md#files-that-track-feature-surface),
updating each doc or generated file the change affects.

1. **Branch from `main`** — use a descriptive prefix (`feat/`, `fix/`, `docs/`,
   `refactor/`, `chore/`)
2. **Keep PRs focused** — one logical change per PR
3. **Check before pushing** — every commit runs the pre-commit hook: the
   typecheck, knip, and ESLint, Prettier, markdownlint and ShellCheck on
   the staged files. Before pushing, run the two checks it leaves out:

   ```bash
   npm test && npm run build
   ```

4. **Fill out the PR template** — its checklist repeats step 3
5. **Required checks must pass** — the `main` ruleset requires all seven;
   each blocks the merge and the finding details are in its job log:
   - `checks` — prettier, lint, markdownlint, lint:shell, knip, test, and
     build
   - `cli-smoke (22)` / `cli-smoke (24)` — builds the
     CLI and runs `init` on the engines floor (22.12) and the newest
     major (24), catching APIs too new for the CLI's `engines` range;
     the floor row also asserts the too-old refusal on Node 20
   - `arch-smoke (amd64)` / `arch-smoke (arm64)` — builds the Docker image
     and boots it on a native runner for each architecture, then boots the
     remote image with a stubbed Sync client to run its init chain
     end-to-end (`npm run test:remote-boot`)
   - `gitleaks` — secret detection over `main` plus the PR's commits, so a
     finding on `main` fails every open PR until it is cleaned up
   - `trivy-pr` — vulnerability scan of the Docker image built from your
     branch; a fixable CRITICAL/HIGH CVE fails it

## Issues

- **Bug reports:** use the
  [bug report template](https://github.com/aliasunder/vault-cortex/issues/new?template=bug_report.yml)
  — include steps to reproduce and your environment
- **Feature requests:** use the
  [feature request template](https://github.com/aliasunder/vault-cortex/issues/new?template=feature_request.yml)
  — describe the problem before the solution; required before a feature PR
- **Security issues:** see [SECURITY.md](./SECURITY.md) — report privately, not
  as a public issue

## Breaking changes

Server and CLI release notes (`.github/scripts/generate-notes.sh` and
`.github/scripts/generate-cli-notes.sh`) lead with a **⚠ BREAKING CHANGES**
section when a commit they list is breaking; [Release Process](#release-process)
says which commits each script lists. Breaking changes are detected
from the **merged PR**, read via the API at release time — the reliable
source: a squash commit's body is often dropped at merge (e.g. the GitHub
mobile app), but the PR body and labels always survive.

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

The committed tool-surface baseline
(`src/vault-mcp/mcp-core/__tests__/__snapshots__/tool-surface/`) is the
byte-level record of the MCP wire surface. A PR that changes tool schemas,
descriptions, prompts, or server instructions regenerates it with
`npm run snapshot:update`, and the baseline diff is where reviewers judge
whether the change is breaking, against the covered surfaces in
[VERSIONING.md](./VERSIONING.md). The baseline captured at each release
commit is the regression reference for the next.

`tool-surface-snapshot.test.ts`, which checks the baseline, also caps the tool
list's size, because some clients load every tool definition into each
conversation. Each checked combo's total must stay within a per-tool allowance
(`CHARS_PER_TOOL_ALLOWANCE`) times its tool count.
`npm run report:tool-surface-size` prints per-tool sizes, and a PR that raises
the allowance states why.

## Release Process

Releases are cut by the maintainer: Actions tab → "Manual Release" → choose
`patch`/`minor`/`major`. The workflow bumps the version, deploys, and creates
the GitHub Release.

Direct commits to `main` are blocked by a branch ruleset — all changes land
via PR. Only the release workflows push to `main` directly, for their
version-bump and CHANGELOG commits.

The CLI releases separately: Actions tab → "Release CLI" (see
[The `cli/` Package](#the-cli-package)).

What each release's notes list:

- **Server releases** (`.github/scripts/generate-notes.sh`): every commit
  since the last release, except:
  - release bumps
  - dev-dependency bumps: commits with the `deps-dev` scope, and commits that
    change only `devDependencies` or `overrides` in the root `package.json`,
    and in `package-lock.json` only packages marked `"dev": true`
  - Claude Code hook changes (commit scope `hooks`)
  - commits that change only these files:
    - `AGENTS.md` and `CHANGELOG.md`
    - dotfiles at the repository root, such as `.gitignore` and
      `.trivyignore`, except `.dockerignore` (it decides what the image
      build copies) and `.env.example` (DEPLOY.md has deployers copy it)
    - files under `.claude/`, `.devin/` or `.husky/`
- **CLI releases** (`.github/scripts/generate-cli-notes.sh`): every commit
  that changes `cli/`, including dependency bumps that edit
  `cli/package.json`, except commits whose added and removed lines under
  `cli/` are all:
  - blank
  - in files under any `__tests__/` folder in `cli/src/`
  - the `"version"` line of `cli/package.json` (the release bump)
  - lines in `.ts` files that start, after any indent, with `#`, `//`, `/*`
    or `*`, taken as comments (a code line that starts the same way, such as
    a `#private` field, is skipped too). The `#` case covers the comment text
    of the `.env` templates in `cli/src/rules/env-templates.ts`. A `#` line shaped like a setting (`# KEY=value`) still
    counts: the templates ship optional settings commented out, for the user
    to uncomment.

  The comment rule covers only `.ts` files: in `cli/README.md` and every
  other file, a line starting with `#`, `//`, `/*` or `*` counts.

See the [DEPLOY.md CI/CD section](./DEPLOY.md#cicd) for details on each workflow.

## Upgrading pinned dependencies

Three pins track something outside this repo. Treat each bump as a potential
regression and re-verify that package's contract below before merging.

| Package             | Pinned in                                                     | Tracks                                                                             | Dependabot       |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| `rrule`             | root `package.json`                                           | the version the Tasks plugin declares                                              | excluded         |
| `remark-parse`      | root `package.json`, with `overrides` for its dependency tree | the release Obsidian's metadata cache forked                                       | excluded         |
| `obsidian-headless` | `obsidian-headless/package.json` and its lockfile             | the Sync CLI whose observed behaviour the `:remote` image's init scripts depend on | a PR per release |

### Upgrading rrule (recurrence parity)

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

### Upgrading remark-parse (body-tag parity)

`obsidian-markdown/body-tags.ts` finds a note's `#tags` with
`remark-parse@8.0.3`, the version Obsidian's metadata cache forked, plus
Obsidian's syntax as tokenizers in `obsidian-remark-parser.ts`. The pin is
excluded from Dependabot, and 8.0.3 is the last 8.x release, so an advisory
anywhere in its dependency tree is answered with an `overrides` entry, as
`trim` is.

Never open, read or copy Obsidian's app code (`worker.js`, `app.js`) when
editing `obsidian-remark-parser.ts`, `body-tags.ts` or `remark-ports/`:
Obsidian is proprietary and this repo is MIT, so those files are written from
Obsidian's observed behaviour only. The scripts below are the only permitted
contact; they run `worker.js` as a black box and print its answers.
[AGENTS.md](./AGENTS.md#upgrading-pinned-dependencies) states the same rule
for agents.

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

### Upgrading obsidian-headless

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
- In `pull-only`, `init-first-sync` also drops a queued download whose
  `hash` equals the local record's `synchash`, which would replay the synced
  version over a local edit. The oracle scenarios named in parentheses cover
  their behaviour; re-check by hand behaviours 1 and 5, the upload half of 3
  and the cursor half of 4:
  1. The re-queue in the `sync-setup` bullet above includes files this
     device already downloaded (`ss()`, `changeFilter`).
  2. `pull-only` and `mirror-remote` download a queued file over a differing
     local copy, and two-way sync keeps the copy ("edited, synced version
     queued" in each of the three modes).
  3. A download, or an upload, sets `synchash` to the SHA-256 hex of the
     bytes, equal to the record's `hash`; a local edit leaves it
     ("downloaded, pull-only", "edited, not queued, pull-only").
  4. `pull-only` runs neither an upload nor a deletion scan after the
     pending loop ("edited, not queued, pull-only", "not queued,
     pull-only"), and the sync cursor is past a dropped row, so the server
     never sends that row again.
  5. Pending rows load once, when the engine starts, in `uid` order, and a
     later row for the same path supersedes an earlier one.

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

| Variable                          | Value                                 | Description shown on the deploy form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TZ`                              | _(optional input)_                    | Your timezone as an [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List) (`America/Toronto`) — decides what "today" means for daily notes, task due dates, and memory timestamps. Leave empty for UTC                                                                                                                                                                                                                                                                                                                                                                      |
| `VAULT_NAME`                      | _(required input)_                    | Your vault's name, the same as it is in Obsidian                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `VAULT_PASSWORD`                  | _(optional input)_                    | Only if your vault uses end-to-end encryption; otherwise leave empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SYNC_FILE_TYPES`                 | _(optional input)_                    | Attachment types to sync, comma-separated — the same toggles as Obsidian's Sync → Selective sync. **Valid values:** image, audio, video, pdf, unsupported. **Leave empty for the default:** image,audio,video,pdf,unsupported; a value you enter replaces the whole list. Text files such as CSV, JSON, TXT, HTML and scripts fall under unsupported, Obsidian's **Sync all other types**. The server uploads the ones an agent writes, and other devices send and receive them only with that option turned on in their own Sync settings. To keep them off the server, enter image,audio,video,pdf |
| `OBSIDIAN_AUTH_TOKEN`             | _(optional input)_                    | Leave empty to sign in through the `/setup` page after deploy, or paste a token from `npx vault-cortex@latest get-sync-token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SYNC_EXCLUDED_FOLDERS`           | _(optional input)_                    | Folders to leave out of sync, comma-separated — the same list as Obsidian's Sync → Excluded folders. Leave empty to exclude nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MCP_AUTH_TOKEN`                  | `${{secret(64, "0123456789abcdef")}}` | Generated for you — the token your MCP client enters on the consent page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PORT`                            | `8000`                                | The port the image listens on. Leave as is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `STORAGE_ROOT`                    | `/persist`                            | Where the volume is mounted — vault, search index and its models, Sync device state, and logs live under it. Leave as is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DEVICE_NAME`                     | `vault-cortex`                        | The device name that labels this container's changes in Obsidian's sync log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TRUST_PROXY_HOPS`                | `2`                                   | Railway proxies between a visitor and the container, so the server sees the visitor's real address                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `900`                                 | How long Railway waits for the first health check — the first start downloads the vault and builds the index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MEMORY_ENABLED`                  | `true`                                | The About Me/ memory layer and its tools. Set false to hide them and skip creating the folder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `EMBEDDING_ENABLED`               | `true`                                | Semantic search. Set false to skip the models and use keyword search only — fits in much less memory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `READONLY_MODE`                   | `false`                               | Set true to hide every tool that changes the vault — clients can only read and search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `FILE_TOOLS_ENABLED`              | `true`                                | vault_read_file, vault_write_file, vault_delete_file and vault_list_files. Set false to hide them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SYNC_MODE`                       | `bidirectional`                       | Sync direction: bidirectional, pull-only (edits made on the server stay on the server and are never uploaded), or mirror-remote (Obsidian Sync overwrites edits made on the server, so the server always matches your vault). An invalid value stops the container at boot                                                                                                                                                                                                                                                                                                                           |
| `CONFLICT_STRATEGY`               | `merge`                               | Obsidian Sync conflict resolution: merge integrates changes automatically; conflict writes a separate conflict file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Any edit to these two tables is a change to the live template, whether it is
the image tag, a variable's presence, default or description, the port, or the
health path. No test checks the live template, and only the maintainer can
re-publish it, so a pull request that edits either table says so in its
description; the maintainer re-publishes the template in the Composer when the
pull request merges (its Apply is the publish, with no separate step), or the
deploy form keeps showing the old text. Existing deployments keep their
settings until their owners redeploy.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE). Note that the published `:remote` image bundles
Obsidian's proprietary `obsidian-headless` CLI (see the README license note) —
the MIT license covers this repository's code, not that component.

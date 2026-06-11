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
   ```

3. **Run the checks:**
   ```bash
   npm test
   npm run lint
   npm run build
   ```

## Development Modes

Vault Cortex can run in three modes during development:

### MCP server (no Docker)

The fastest feedback loop — runs the MCP server directly with hot reload:

```bash
PUBLIC_URL=http://localhost:8000 MCP_AUTH_TOKEN=local-dev-token VAULT_PATH=~/your-vault npm run dev:mcp
```

### Docker (local)

Runs vault-mcp in Docker against your local vault (no Lightsail, no
obsidian-sync):

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

`cli/` is a separate npm package (`npx vault-cortex init`) that scaffolds the
[deploy quickstarts](./deploy/). It is **not** an npm workspace — its two
runtime dependencies (`commander`, `@clack/prompts`) are also pinned in the
root `devDependencies` at identical versions, so the root `npm ci` covers
development. A test fails if the versions drift.

- Build: `npm run build` compiles both the server and `cli/` (or
  `npx tsc -p cli/tsconfig.json` alone)
- Test: `npm test` includes `cli/src/**/*.test.ts`
- Try it: `node cli/dist/bin.js init --help`

**Template sync rule:** `cli/templates/` holds verbatim copies of
`deploy/local/docker-compose.yml` and `deploy/remote/docker-compose.yml` so the
npm tarball can ship them. If you change either deploy compose file, run
`npm run sync:cli-templates` in the same PR — a byte-equality test fails CI
otherwise.

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
   npm run prettier:check && npm run lint && npm test && npm run build
   ```
4. **Fill out the PR template** — the checklist mirrors CI
5. **CI must pass** — the `CI` workflow runs prettier, lint, test, and build on
   every PR. Two security scans also run on PRs: **Gitleaks** (secret
   detection) and **Trivy** (vulnerability scan of the Docker image built from
   your branch — findings appear in the PR's Checks tab)

## Issues

- **Bug reports:** use the bug report template — include steps to reproduce and
  your environment
- **Feature requests:** use the feature request template — describe the problem
  before the solution
- **Security issues:** see [SECURITY.md](./SECURITY.md) — report privately, not
  as a public issue

## Release Process

Releases are cut by the maintainer. Two paths:

- **Manual Release:** Actions tab → "Manual Release" → choose
  `patch`/`minor`/`major`. Bumps version, deploys, creates GitHub Release.
- **Tag push:** bump `package.json`, commit on `main`, then
  `git tag v<version> && git push --tags`

The CLI releases separately: Actions tab → "Release CLI" (see
[The `cli/` Package](#the-cli-package)).

See the [DEPLOY.md CI/CD section](./DEPLOY.md#cicd) for details on each workflow.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).

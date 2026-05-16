# Contributing

Thanks for your interest in vault-cortex! This guide covers everything you need
to get started.

## Quick Start

1. **Prerequisites:** Node.js >= 22 (see `.nvmrc`), Docker (optional, for
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

vault-cortex can run in three modes during development:

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
   every PR

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

See the [DEPLOY.md CI/CD section](./DEPLOY.md#cicd) for details on each workflow.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).

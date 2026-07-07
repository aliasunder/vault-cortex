# Security Policy

## Scope

Vault Cortex is a remote MCP server that exposes an Obsidian vault over HTTPS.
The attack surface includes:

- **Authentication and authorization** — OAuth 2.1 (Authorization Code + PKCE),
  JWT tokens (HS256), static bearer token fallback, Lambda authorizer, Express
  middleware (defense in depth)
- **API Gateway** — HTTP API fronting the Lightsail instance, path-aware
  authorization (OAuth discovery endpoints pass through, `/mcp` requires valid
  bearer)
- **Express server** — handles MCP protocol messages, OAuth flows, consent page
- **SQLite** — FTS5 search index and OAuth token persistence. User-supplied
  search queries are parameterized, not interpolated
- **File system access** — vault reads and writes. Path traversal is blocked by
  `resolveSafePath()` (resolve + prefix check). Protected paths prevent deletion
  of sensitive folders
- **Docker Compose** — two long-running containers on Lightsail sharing a
  `/vault` volume (UID 1000)
- **CI/CD workflows** — GitHub Actions with OIDC AWS auth, SSH to Lightsail,
  GHCR image push

## Runtime Hardening

Beyond the authentication and scanning protections described above, the
following runtime patterns address specific attack classes. See
[ARCHITECTURE.md → Data Integrity](./ARCHITECTURE.md#data-integrity) for
mechanism-level detail.

### Path traversal

- `resolveSafePath()` resolves then prefix-checks every user-supplied
  path — `../../etc/passwd` throws before any filesystem access
- `toVaultRelativePath()` normalizes backslashes and collapses `../`
  before protected-path checks (prevents evasion via
  `X/../Protected/file.md`)
- `vaultFolderName` Zod schema rejects `..`, absolute paths, and blank
  names at config parse time
- Memory file names reject `/` and `\` — prevents `../../outside`-style
  escapes from the memory directory

### TOCTOU race prevention

- `atomicWriteFileExclusive()` uses `link()` (POSIX no-clobber) to
  atomically create the destination — no check-then-write window
- `moveNote` reads and plans every rewrite before writing anything;
  existence checks run inside the lock so the vault state is stable
  during the entire read-plan-write span
- `deleteNote` checks existence inside the lock — prevents racing with a
  concurrent patch that could recreate the file after unlink

### Injection

- **SQL:** all queries use parameterized statements.
  `sanitizeFtsQuery()` strips FTS5 metacharacters and reserved words.
  `escapeLikeWildcards()` escapes `\`, `%`, `_` in LIKE clauses
- **Prompt (tag breakout):** `escapeVaultContentClosingTag()` prevents
  vault content from breaking out of the `<vault-content>` data boundary
  in assembled prompts — relevant in shared/synced vaults where
  untrusted content could reach an LLM context
- **XSS:** `escapeHtml()` on the OAuth consent page escapes `&`, `<`,
  `>`, `"` in client-supplied values (client name, client ID, scopes,
  error messages, request ID)

### Data corruption prevention

- Atomic writes: temp-then-rename — readers never see partial content
- Per-file mutex: three modes (serializing, fail-fast, multi-file)
  prevent concurrent writes from corrupting each other
- Memory shrink guard: refuses writes that would remove >50% of a file's
  bytes — catches template-clobber bugs during the Obsidian Sync startup
  race
- Memory idempotency guard: exact-bullet dedup prevents duplicates from
  retried writes after gateway timeouts
- Memory line-break rejection: entry, date, and section reject `\r`/`\n`
  — prevents format corruption that would evade the duplicate guard
- Content-hash gating: SHA-256 per chunk ensures only changed content
  re-embeds

### Information leak prevention

- `safeHandler()` catches all exceptions and returns `.message` only —
  no stack traces reach the client
- In-lock existence checks return vault-relative "not found" instead of
  ENOENT (whose message leaks the container's absolute path)
- Error middleware returns `"internal server error"` to clients;
  request metadata and the error message are logged server-side only

### Container hardening

- Non-root user (`USER node`, UID 1000)
- PID 1 init (`tini`) — forwards SIGTERM for clean SQLite WAL closure
- Package-manager removal (`npm`/`npx`/`corepack`/`yarn` stripped from
  runtime)
- Multi-stage build — build deps (`python3`, `make`, `g++`) never enter
  the runtime image
- Digest-pinned base image (`node:24-slim@sha256:...`)
- Debian security fixes applied at build time (`apt-get upgrade`)
- Log rotation per service (Compose: `max-size: 10m`, `max-file: 3`)
- Graceful shutdown: SIGTERM handler drains in-flight requests (10s
  timeout) before exiting

### Symlink safety

- `filterValidSymlinks()` excludes broken symlinks and symlinks to
  non-file targets from directory listings before indexing or tool output
- Bounded concurrency (16) prevents resource exhaustion on large
  directories with many symlinks

## Automated Scanning

Several scanners already run against this repository:

- **CodeQL** — static analysis on every PR and push (GitHub default setup)
- **Gitleaks** — secret detection on every PR and push to main
- **Trivy** — vulnerability scan of the Docker image: PR-built images on every
  PR (fixable CRITICAL/HIGH findings block the merge), the published GHCR
  image on pushes to main and a weekly schedule. Findings report to the
  repository's
  [Security tab](https://github.com/aliasunder/vault-cortex/security)
- **OpenSSF Scorecard** — supply-chain posture analysis, weekly and on pushes
  to main; results publish to the
  [OpenSSF API](https://api.securityscorecards.dev/projects/github.com/aliasunder/vault-cortex)
- **Dependabot** — weekly dependency update PRs for npm, GitHub Actions, and
  the Docker base image

Base-image CVEs surfaced by Trivy are typically already tracked in the
Security tab and handled through image updates. A report is still welcome if
you've found a Vault Cortex–specific exploit path for one.

## Reporting a Vulnerability

If you discover a security issue, please report it through
[GitHub's private vulnerability reporting](https://github.com/aliasunder/vault-cortex/security/advisories/new)
rather than opening a public issue.

Please include:

- A description of the vulnerability
- Steps to reproduce or a proof of concept
- The potential impact

You should receive an acknowledgment within **48 hours**. I'll work with you to
understand the issue and coordinate a fix before any public disclosure.

## Supported Versions

Only the latest release is actively maintained. If you're using an older
version, please upgrade before reporting.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

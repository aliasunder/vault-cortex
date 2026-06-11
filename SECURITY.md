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

# Security Policy

## Scope

vault-cortex is a remote MCP server that exposes an Obsidian vault over HTTPS.
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

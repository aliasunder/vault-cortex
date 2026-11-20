# Versioning

vault-cortex follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This document says which parts of the project a version number protects,
how a protected part is retired, and how the server and CLI versions
relate. The policy takes effect at v1.0.0. Until then, a 0.x minor release
may include a breaking change, flagged as described below.

## What a version number promises

| Release | May contain                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------ |
| Major   | Breaking changes to a covered surface, each listed under ⚠ BREAKING CHANGES in the release notes |
| Minor   | New tools, prompts, parameters, response fields and settings; changes to anything not covered    |
| Patch   | Bug fixes and dependency updates                                                                 |

A change is breaking when a documented, supported call, setting or read
stops working or returns a different shape. These are not breaking:

- A new tool, prompt, optional parameter, response field or setting
- A fix to behavior that only ever worked by accident and was never
  documented, such as a path form a tool's description always rejected
- A change to anything listed under "Not covered" below

## Covered

These change only in a major release:

- **MCP tool surface** — tool names, parameter names and shapes, which
  parameters are required, response shapes, and the rejection of unknown
  parameters
- **Error contracts** — a call that a tool's `Errors:` section says is
  refused stays refused, and the message keeps naming the fix
- **Settings** — environment variable names, their accepted values, what
  each value does, and their defaults. A numeric limit's default may be
  raised in a minor, because a raise refuses nothing that worked before;
  lowering one is breaking
- **Deployment contract** — the image name and tags (`:latest`, `:remote`,
  `:vX.Y.Z`, `:vX.Y.Z-remote`), the container's port, the volume paths,
  `PUID`/`PGID`, and the HTTP routes (`/mcp`, `/healthz`, the OAuth
  endpoints, `/setup`)
- **CLI** — command names, flags, the files `init` writes and where it
  writes them, and the minimum Node.js version
- **Vault conventions the server reads** — memory files as dated bullets
  under headings, the Tasks plugin's emoji and Dataview fields, Kanban
  boards with lanes as headings, `^block-id` references, every Obsidian
  link form, and the daily-notes settings in `.obsidian/`

## Not covered

These may change in any release:

- The wording of tool descriptions and parameter descriptions
- The exact text of an error message
- The text of MCP prompts, and the server instructions sent to each session
- Search result order — a tuning or model change may rank notes
  differently; each result's fields keep their shape
- Ranking weights, fusion tuning, and the embedding and reranking models
- Log format and log fields
- Internal module layout and the search index's schema

## How a covered part is retired

Nothing is deprecated today. When a covered tool, parameter, setting or
flag has to go:

1. Its replacement ships first.
2. The old form keeps working, and its tool description, setting
   documentation or `--help` text says it is deprecated and names the
   replacement. The release's changelog entry says the same.
3. Both forms stay available for at least one minor release.
4. The old form is removed in the next major release, listed under
   ⚠ BREAKING CHANGES.

## How breaking changes are flagged

A breaking change is marked on its pull request with a `BREAKING CHANGE:`
footer, a `breaking-change` label or a `!` in the commit subject, and
the release notes lead with every change flagged that way. The mechanics
are in [CONTRIBUTING.md → Breaking changes](./CONTRIBUTING.md#breaking-changes).

## Server and CLI versions

The server image and the `vault-cortex` npm package are versioned
separately, each under this policy:

- **Server** — the version of the Docker image
  `ghcr.io/aliasunder/vault-cortex`. `:latest` and `:remote` move with
  every release, including a major, so a deployment that must not take a
  major pins a `:vX.Y.Z` or `:vX.Y.Z-remote` tag.
- **CLI** — the version of the npm package. The CLI starts the server
  from the moving `:latest` and `:remote` tags, so any CLI release works
  with the current server image. A CLI major is cut when a command, flag
  or generated file changes incompatibly, or when its minimum Node.js
  version rises.

Only the latest release of each is maintained; fixes are not backported.
See [SECURITY.md → Supported Versions](./SECURITY.md#supported-versions).

## What enforces this

| Covered surface           | Check                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool surface              | A committed snapshot of every tool's schema, description and annotations, the prompts, and the server instructions, per configuration. CI fails on any drift; the baseline at each release commit is the reference for the next |
| Response and error shapes | Integration tests call every tool over real HTTP and assert whole responses and exact error messages                                                                                                                            |
| Settings                  | Config-loading tests, plus drift tests that keep the deploy templates, compose files and CLI-generated `.env` files listing the same settings                                                                                   |
| Deployment contract       | Boot tests of the built `:remote` image check the init chain, the settings it derives and the volume layout; a test pins `render.yaml`                                                                                          |
| CLI                       | Pseudo-terminal tests drive each interactive command before a CLI release; CI builds and runs `init` on the minimum and newest supported Node.js                                                                                |

Whether a snapshot diff is breaking is still a reviewer's judgment, made
against the lists above.

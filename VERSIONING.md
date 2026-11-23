# Versioning

vault-cortex follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
It ships as two things with their own version numbers: the server (a
Docker image) and the `vault-cortex` npm package (a CLI that sets the
server up and runs it). This document says which parts of each a version
number covers, how a covered part is retired, and how the two versions
relate.

The policy applies from v1.0.0 onward. The 0.x releases before it carried
no compatibility promise.

## What a version number promises

| Release | May contain                                                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Major   | Breaking changes to a covered part, each listed under ⚠ BREAKING CHANGES in the release notes                                                                                                        |
| Minor   | New tools, prompts (the guided workflows a client lists), optional parameters and prompt arguments, response fields and settings, and a required parameter, prompt argument or setting made optional |
| Patch   | Bug fixes and dependency updates                                                                                                                                                                     |

Each row may also contain what the rows below it list, and any change the
"Not covered" list allows. A dependency update that changes a covered part,
such as the CLI's minimum Node.js version, takes that part's rule.

A change is breaking when a documented call, setting or read stops working,
returns different fields, or changes a field's type. These are not
breaking:

- A new tool, prompt, optional parameter or prompt argument, response field
  or setting
- A required parameter, prompt argument or setting made optional, because
  every call that worked before still works; making an optional one
  required is a breaking change
- A fix to behavior that only ever worked by accident and was never
  documented, such as a path spelling the tool's description already said
  is refused
- A change to anything listed under "Not covered" below

## Covered

These change only in a major release:

- **MCP tool surface** — tool names, parameter names and types, response
  fields, the refusal of unknown parameters by every tool that takes any,
  prompt names and their arguments, and the MCP protocol versions the
  server accepts. An optional parameter or prompt argument becomes required
  only in a major release; a required one may become optional in a minor,
  as the list above says
- **Error contracts** — each tool's description, which your MCP client
  shows, lists its failures under `Errors:`. A listed failure stays
  refused, and its message keeps naming the fix; the exact wording may
  change in any release
- **Settings** — environment variable names, their accepted values, what
  each value does, and their defaults, except that a numeric limit's
  default may rise and `SYNC_FILE_TYPES`'s default may gain a file type, as
  "Not covered" says
- **Deployment contract** — the image name, its Docker Hub mirror and the
  tags (`:latest` is the server alone, `:remote` bundles Obsidian Sync,
  `:vX.Y.Z` and `:vX.Y.Z-remote` pin a release), the container's port
  `8000`, the volume paths (`/vault` and `/data`, plus
  `/home/obsidian/.config` for Sync state in `:remote`, or one
  `STORAGE_ROOT` volume), the `PUID`/`PGID` settings of the `:remote`
  image, and the HTTP routes: `/mcp`, `/healthz`, `/setup`, and the OAuth
  routes `/authorize`, `/token`, `/register`, `/revoke`, `/oauth/decide`
  and the `/.well-known/` discovery documents
- **CLI** — command names, flags, the files `init` writes and where it
  writes them, and the minimum Node.js version
- **Vault conventions the server reads and writes** — memory files (dated
  entries under headings in the `About Me/` folder), the Tasks plugin's
  emoji and Dataview fields, Kanban boards with lanes as headings,
  `^block-id` references, the Obsidian link forms the server resolves, and
  the settings it reads in `.obsidian/`: daily notes, the trash setting,
  and the Tasks plugin's format, statuses and date stamping

## Not covered

These may change in any release:

- The wording of tool descriptions and parameter descriptions
- The text of MCP prompts, and the instructions the server sends a client
  when it connects
- Search result order: ranking weights, fusion tuning, and the embedding
  and reranking models may change, so notes may rank differently, while
  each result's fields stay as covered above
- Raising a numeric limit's default, because a raise refuses nothing that
  worked before; lowering one is a breaking change
- Adding a file type to `SYNC_FILE_TYPES`'s default. More of your vault's
  files then reach the server, and the server uploads files of that type
  that an agent writes, but nothing that synced before stops syncing; removing a type is a
  breaking change
- Log format and log fields
- Internal module layout and the search index's schema. The index is
  rebuilt from the vault at every start, so a schema change needs nothing
  from you

## How a covered part is retired

No retirement is in progress; when one starts, the release notes say so.
When a covered part (a tool, parameter, setting, flag, route, tag, path or
convention) has to go:

1. Its replacement ships first.
2. The old form keeps working, and its tool description, its row in the
   README's configuration table, or its `--help` text says it is deprecated
   and names the replacement. The release notes say the same.
3. Both forms stay available for at least one minor release after the one
   that deprecates the old form.
4. The old form is removed in the next major release, listed under
   ⚠ BREAKING CHANGES.

## How breaking changes are announced

Every breaking server change is listed first in its release's notes, under
⚠ BREAKING CHANGES, with a line saying what to change. Release notes are
published on [GitHub Releases](https://github.com/aliasunder/vault-cortex/releases)
and mirrored in [CHANGELOG.md](./CHANGELOG.md). Contributors mark the pull
request so the notes pick the change up; the marks are in
[CONTRIBUTING.md → Breaking changes](./CONTRIBUTING.md#breaking-changes).

A CLI release's notes list each change by its commit subject, with no
separate section, so a breaking CLI change carries `!` in its subject
(`feat(cli)!: …`) and the list shows it.

## Server and CLI versions

The server image and the CLI are versioned separately, each under this
policy:

- **Server** — the version of the Docker image
  `ghcr.io/aliasunder/vault-cortex`. `:latest` and `:remote` move with
  every release, including a major. A deployment that must not take a
  major pins a `:vX.Y.Z` or `:vX.Y.Z-remote` tag, and then takes no fixes
  either: only the latest release is maintained, and fixes are not
  backported (see
  [SECURITY.md → Supported Versions](./SECURITY.md#supported-versions)).
- **CLI** — the version of the npm package. `init` and `upgrade` pull the
  moving `:latest` and `:remote` tags, so a server major reaches a CLI
  install on its next `upgrade`; to pin a release, run the image with
  Docker directly, as the deploy guides show. A CLI major is cut when a
  command, flag or generated file changes incompatibly, or when its
  minimum Node.js version rises.

## What enforces this

Every check below detects a change; whether the change is breaking is a
reviewer's judgment against the Covered and Not covered lists.

| Covered part        | Check                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool surface        | A committed snapshot of every tool's schema, description and annotations, the prompts, and the connect-time instructions, for each combination of the settings that hide tools. A change must update the snapshot in the same pull request, so the diff is in review; the snapshot at each release commit is the reference for the next |
| Error contracts     | Integration tests call every tool over real HTTP, asserting each success response whole and each documented failure by its message, so a changed field or a dropped failure fails the suite                                                                                                                                             |
| Settings            | Config-loading tests pin each setting's accepted values and defaults, and drift tests keep the deploy templates, compose files and CLI-generated `.env` files listing the same settings, so a rename or a new setting reaches review on every surface at once                                                                           |
| Deployment contract | Boot tests of the built `:remote` image check the container's startup scripts, the values they derive and the volume layout; a test pins the Render deploy template                                                                                                                                                                     |
| CLI                 | Pseudo-terminal tests drive each interactive command before a CLI release; every pull request builds the CLI and runs `init` on the minimum and newest supported Node.js                                                                                                                                                                |
| Vault conventions   | Parser tests with vectors taken from the Tasks plugin's own test suite and from Obsidian's tag parser, and an integration suite over a fixture vault                                                                                                                                                                                    |

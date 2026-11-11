# Roadmap

Where vault-cortex is heading over roughly the next year — and what it
deliberately won't do. Priorities shift with real-world usage, and this
document is updated when they do.

_Last updated: 2026-11-11._

## Direction

vault-cortex exists so that anyone can give their AI tools ready access
to their personal knowledge base, task management, and durable memory on
top of an Obsidian vault they own. A vault holds years of accumulated
knowledge — knowledge that should be reachable from
wherever the person works, in a shape AI tools can navigate, and
findable by meaning as well as by exact keywords. The planned work
clusters around those goals: making setup accessible, deepening the task
layer, matching what Obsidian itself can do, and hardening the project
for long-term use.

## Delivered

The foundations the planned work builds on:

- Vault reads, writes, and surgical edits, with hybrid search (keyword +
  semantic + cross-encoder reranking) and a memory layer of dated entries
  in an About Me/ folder, recalled entry by entry
- A vault-wide task layer — structured queries and one-call updates in
  both Tasks-plugin formats (emoji and Dataview)
- OAuth 2.1 alongside static token auth
- One self-contained image for every deployment path — the MCP server
  and Obsidian Sync in a single container, runnable by any OCI runtime
  (Docker, Podman, nerdctl)
- A guided CLI (`npx vault-cortex`) that walks through setup and handles
  configuration, upgrades, restarts, and logs
- One-click Render and Railway deploys, with browser-based Obsidian Sync
  sign-in when no Sync token is configured

## Planned

### Setup without a terminal

The remaining work is the rough edges early adopters hit as they work
through the setup guides. The one-click deploys (Render, Railway), the
browser sign-in page for Obsidian Sync, and a CLI `init` that boots the
server straight to that page when you have no Sync token cover everything
else.

### Guided vault onboarding

A vault that works well with AI needs structure — memory files, session
protocols (the routine an agent follows at the start and end of a working
session), a task board. The companion project
[vault-onboarding](https://github.com/aliasunder/vault-onboarding)
scaffolds that structure through a conversational interview, with
per-client instructions for Claude Code, Cursor, Perplexity, Copilot, and
others. Expect the two projects to pair more tightly: a scaffolded vault
that vault-cortex can use as it is, on day one.

### Deeper task management

Finding a task by its subject without listing the whole board: a text
query on task listings, and the same for tags by meaning.

### v1.0.0 — a stability contract

A v1 release that MCP clients can build on:

- Unknown input fields rejected, inside nested objects too, instead of
  silently ignored
- A written compatibility policy for what future versions may change

### Obsidian parity after 1.0

Features Obsidian users reach for that the server does not offer yet,
planned for the 1.x releases:

- Folder create, rename and move, with links rewritten
- Periodic notes (weekly, monthly, quarterly, yearly) beside daily notes
- Creating today's daily note from the vault's template
- Vault-wide tag rename
- Templates on note creation, with the core plugin's date, time and
  title placeholders

### Files beyond markdown

The server reads Obsidian canvas and Bases files, and other non-markdown
files, but cannot write them. Planned:

- Write support for non-markdown text files, canvas and Bases first
  because they are Obsidian's own formats
- Whether a file can be written or deleted decided by its content, not by
  a list of allowed extensions
- Image and PDF attachments through the same write tool, in a later step

### Supply-chain hardening

- A software bill of materials (SBOM) published with each release
- Fuzzing for the markdown parser layer

## Exploring — not committed

- Atomic markdown table row operations instead of find-and-replace
  splices
- Graph queries over the vault's wikilink graph (multi-hop paths,
  neighborhoods)
- MCP resources as a third primitive alongside tools and prompts
- Large-vault performance: result pagination, incremental startup
  indexing

## Not planned

- **Native Windows execution** — Docker is the supported runtime on every
  platform
- **A hosted service** — vault-cortex is self-hosted by design; your
  vault stays on infrastructure you control
- **Becoming an Obsidian plugin, or requiring one** — the server works on
  vault files directly and stays useful even where Obsidian isn't running
- **Note systems other than Obsidian** — the server is deliberately
  Obsidian-first: its link resolution, properties, and plugin-format
  support match what Obsidian does

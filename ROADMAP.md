# Roadmap

Where vault-cortex is heading over roughly the next year — and what it
deliberately won't do. Priorities shift with real-world usage, and this
document is updated when they do.

_Last updated: 2026-09-02._

## Direction

vault-cortex exists so that anyone — not just developers — can give their
AI tools durable memory, real task management, and ready access to their
personal knowledge base on top of an Obsidian vault they own. A vault
holds years of accumulated knowledge, not just tasks and memory — that
knowledge should be reachable from wherever the person works, in a shape
AI tools can navigate, and findable by meaning rather than exact
keywords. The planned work clusters around those goals: making setup
accessible, deepening the task and memory layers, and hardening the
project for long-term use.

## Delivered

The foundations the planned work builds on:

- Vault reads, writes, and surgical edits, with hybrid search (keyword +
  semantic + cross-encoder reranking) and the About Me/ memory layer
  with entry-level recall
- A vault-wide task layer — structured queries and one-call updates in
  both Tasks-plugin formats (emoji and Dataview)
- OAuth 2.1 alongside static token auth
- One-click Render and Railway deploys, with browser-based Obsidian Sync
  sign-in when no token is configured

## Planned

### Setup without a terminal

One-click deploys (Render, Railway) and browser-based Obsidian Sync
sign-in already remove most of the command line from remote setup. Next:

- `vault-cortex init` starts the container into setup mode when no Sync
  token is available, so the browser flow covers the CLI path too
- Platform-aware hints on the setup page (where to find your token on
  Render vs Railway)
- Friction fixes as early adopters work through the guides

### Guided vault onboarding

A vault that works well with AI needs structure — memory files, session
protocols, a task board. The companion project
[vault-onboarding](https://github.com/aliasunder/vault-onboarding)
scaffolds that structure through a conversational interview, with
per-client instructions for Claude Code, Cursor, Perplexity, Copilot, and
others. Expect the two projects to pair more tightly: onboarding output
that is ready to serve through vault-cortex on day one.

### Deeper task management

- Checklist progress on task listings, so filtered board reads show how
  far along each card is
- Safer structured edits — atomic markdown table row operations instead
  of find-and-replace splices

### v1.0.0 — a stability contract

A v1 release that MCP clients can build on:

- A final naming sweep across tool inputs and outputs
- Unknown input parameters rejected instead of silently ignored
- A written compatibility policy for what future versions may change

### Files beyond markdown

Write support for canvas, base, and other text files, closing the gap
where remote vaults can read but not edit them.

### Supply-chain hardening

- A software bill of materials (SBOM) published with each release
- Fuzzing for the markdown parser layer

## Exploring — not committed

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

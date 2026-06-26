# Usage Guide

Vault Cortex is running and your AI client is connected — now what?

This guide covers what you can do with your vault through AI: searching,
reading, writing, navigating links, building a memory layer, and reviewing
your day. Everything here is **client-agnostic** — it works the same whether
you're using Claude Code, Claude Desktop, Cursor, or any other MCP client.

**Not set up yet?** See the [local](../deploy/local/) or
[remote](../deploy/remote/) quickstart guides. For configuration options, see
the [README](../README.md#configuration).

## Getting started

The best way to start your first session is to run the **vault-orientation**
prompt. How you trigger it depends on your client — in Claude Code it's a
slash command, in Claude Desktop it's the **+** menu under your connector,
and other clients vary.

Vault-orientation gives you a bird's-eye view of your vault:

- **Note count and folder distribution** — how big your vault is and where
  things live
- **Tags** — your most-used tags, ranked by count
- **Properties** — what frontmatter keys your notes use, how widely adopted
  each one is (low-adoption keys are flagged so you can decide whether to
  standardize or clean them up)
- **Orphans** — notes that nothing else links to, which may be worth
  connecting or reviewing
- **Broken links** — links pointing to notes that don't exist
- **Recent activity** — recently modified notes
- **Memory layer** — if enabled, an outline of what the AI already knows
  about your preferences

Think of this as the AI getting to know your vault. The results include
suggestions for what to explore next — follow whichever catches your
interest.

## What you can ask your AI to do

Your AI has full read/write access to your vault's markdown files. Here's
what that means in practice.

### Finding things

Ask in natural language and the AI searches your vault:

- **"Find everything I've written about [topic]"** — searches note content
  across your entire vault. Multiple words narrow the results (all must
  appear). Put phrases in quotes for exact matches.
- **"Show me notes tagged [tag]"** — finds notes with a specific tag,
  including child tags (asking for `project` also finds `project/website`,
  `project/app`, etc.).
- **"What notes are in my [folder]?"** — browses a folder with metadata
  (title, tags, size, creation date) so you can see what's there without
  opening each note.
- **"What have I written recently?"** — shows recently modified or created
  notes, sorted by date.
- **"Find notes where [property] is [value]"** — searches by frontmatter
  metadata. Useful if your vault uses structured properties like `type:
meeting` or `status: draft`.

**How search works:** Vault Cortex uses full-text search with automatic word
stemming — so "running" also matches "run" and "runs." You can combine text
queries with filters (tags, folders, properties, note type) to narrow
results. The AI handles this automatically based on how you phrase your
request.

### Discovering your vault's metadata

If you're curious about how your vault is structured:

- **"What tags exist in my vault?"** — lists every tag with a usage count,
  including the full hierarchy.
- **"What properties do my notes use?"** — discovers all frontmatter keys
  across your vault, with sample values and adoption rates. Useful for
  understanding your vault's metadata schema.
- **"What values does [property] have?"** — shows the distinct values for a
  specific property. For example, asking about `type` might reveal you have
  `meeting`, `person`, `session-log`, and `reference` as values.

### Reading and exploring notes

You can read notes at different levels of detail:

- **"Read [note]"** — the AI reads the full content of a note.
- **"What's in [large note]?"** — for long notes, the AI automatically scans
  the structure first (headings and their sizes) and then reads the sections
  that are relevant to your question. You don't need to manage this — it
  handles large notes efficiently on its own.
- **"Show me the [section] of [note]"** — reads just the section you care
  about, from its heading down to the next section at the same level.
- **"What metadata does [note] have?"** — reads only the frontmatter
  properties without loading the body.

The AI is smart about reading efficiently. For a note with dozens of
sections, it won't dump everything — it'll scan the structure and target what
matters. This keeps conversations focused and avoids wasting context on
content you didn't ask about.

### Creating and editing notes

The AI can create and modify notes using valid Obsidian markdown:

- **"Create a note about [topic] in [folder]"** — creates a new note with
  content and frontmatter properties. Parent folders are created
  automatically if they don't exist.
- **"Add [content] to the [section] of [note]"** — appends, prepends, or
  inserts content in a specific section without touching the rest of the
  note. Great for building up notes incrementally.
- **"Replace [old text] with [new text] in [note]"** — exact find-and-replace
  in the note body. Properties are preserved.
- **"Move [note] to [new location]"** — moves or renames the file **and**
  rewrites every link to it across your entire vault. This mirrors Obsidian's
  built-in rename behavior — wikilinks, markdown links, embeds, and
  frontmatter links all update automatically.
- **"Update the tags on [note]"** or **"Change the type to [value]"** —
  updates frontmatter properties without touching the note body.
- **"Delete [note]"** — permanently removes the note. Your memory folder and
  Daily Notes folder are protected by default, so you can't accidentally
  delete those.

**Obsidian syntax:** The AI understands Obsidian-flavored markdown. Content it
writes uses proper wikilinks (`[[note]]`), callouts (`> [!info]`), embeds
(`![[note]]`), and frontmatter. You can ask it to use any of these in notes
it creates or edits.

### Exploring your vault's link graph

Your vault's connections are fully accessible:

- **"What links to [note]?"** — finds every note that references the given
  note, across all link formats: `[[wikilinks]]`, `[markdown](links)`,
  `![[embeds]]`, and even links in frontmatter properties like `related:`.
- **"What does [note] link to?"** — shows all outgoing links from a note,
  including whether each target exists. Broken links (pointing to notes that
  haven't been created yet) are flagged.
- **"Find orphaned notes"** — discovers notes that nothing else links to.
  Daily Notes, Templates, and your memory folder are excluded by default
  (since they're not meant to be linked).

## The memory layer

When you first start vault-cortex, it creates a set of files in your vault
(by default in an `About Me/` folder) where the AI can store what it learns
about you. Over time, this makes conversations more personalized — the AI
remembers your preferences, working style, and context without you having to
repeat yourself.

### How it works

The AI stores dated entries under topic headings. When you say something like
"I prefer dark themes" or "I always test before committing," it can save that
as a dated entry in the appropriate file. The next time you start a
conversation — even days later, even from a different device — the AI reads
your memory and adjusts its behavior accordingly.

### The four default files

| File           | What it stores                                                             |
| -------------- | -------------------------------------------------------------------------- |
| **Me**         | Identity, interests, and situational context — who you are                 |
| **Principles** | Stable values, decision heuristics, and non-negotiables — how you think    |
| **Opinions**   | Evolving views on tools, patterns, and methods — what you prefer right now |
| **Routines**   | Recurring habits and cadences — what you do regularly                      |

You're not limited to these — the AI can create new memory files and sections
as needed.

### What you can ask

- **"Remember that I prefer [X]"** — the AI stores a dated entry in the
  right file and section.
- **"What do you know about my preferences?"** — reads the memory layer and
  summarizes what it knows.
- Run the **memory-review** prompt to actively review and evolve your stored
  preferences. It shows your memory entries as a timeline — including how
  your views have changed over time — and surfaces gaps or entries that might
  belong in a different file.

### Key things to know

- **Append-only by design.** When a preference changes, the new entry sits
  alongside the old one. This is intentional — the timeline shows how your
  thinking evolved, which is useful context. If something is genuinely wrong
  (not just outdated), you can ask the AI to remove it.
- **Opt-out available.** Set `MEMORY_ENABLED=false` in your configuration to
  disable the memory layer entirely. Memory tools will be hidden and the
  `About Me/` folder won't be created.
- **Your vault, your data.** Memory files are regular markdown notes in your
  vault. You can read, edit, or delete them directly in Obsidian at any time.

## Daily notes

Vault Cortex reads your Obsidian [Daily Notes](https://help.obsidian.md/Plugins/Daily+notes)
plugin configuration (folder path and date format) automatically, so it
respects whatever setup you already use.

- **"Show me today's daily note"** — reads your daily note using your
  configured folder and date format.
- **"Show me my daily note from [date]"** — reads a past day's note.
- Run the **daily-review** prompt to review a day's note in context: what it
  links to (with broken-link detection), what links back to it, and what
  other notes changed that same day. Guides you through reconciliation, task
  extraction, and pattern spotting.

## Prompts

Prompts are different from regular conversation — you trigger them explicitly
and they assemble **live vault data** into a guided workflow. Each one queries
your search index, link graph, and memory layer at the moment you run it, so
the session starts grounded in your vault's actual state.

| Prompt                | What it does                                                                                                   | When to use it                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **vault-orientation** | Surveys your vault: stats, folders, tags, properties (flags low adoption), orphans, broken links, recent notes | First session, periodic health checks                 |
| **memory-review**     | Reviews memory as a dated timeline, surfaces gaps and scope-fit issues, proposes additions                     | When you want to maintain what the AI knows about you |
| **daily-review**      | Reviews a day's note with outgoing links, backlinks, and same-day activity                                     | End of day, or reviewing a past day                   |

**How to trigger:** Depends on your client. Claude Code uses slash commands.
Claude Desktop uses the **+** menu under your connector. Other clients vary —
see the [MCP clients matrix](https://modelcontextprotocol.io/clients) for
prompt support.

Prompts adapt to your configuration (`MEMORY_DIR`, daily-notes settings) and
work with any vault out of the box.

## What the AI can see and do

### Capabilities

- Read any `.md` file in your vault
- Create, edit, move, and delete notes (with protections)
- Search full-text with tag, folder, property, and type filters
- Navigate your link graph — backlinks, outgoing links, orphan detection
- Read and write to the memory layer
- Read your daily note using your Obsidian config

### Boundaries

- **Non-markdown files** — the AI cannot read the _content_ of images, PDFs,
  or Canvas files, but it does track links to them (so it knows they exist
  and can tell you what references them).
- **Obsidian plugins** — the AI cannot run plugins or access plugin-specific
  data. The exception is Daily Notes, whose configuration (folder and date
  format) is read automatically.
- **Container dependency** — the AI can only access your vault while the
  Docker container is running.
- **Protected paths** — your memory folder and Daily Notes folder are
  protected from deletion by default. This is configurable via
  `PROTECTED_PATHS`.

### Privacy

Your vault data stays on your machine (local setup) or your server (remote
setup). Vault Cortex does not send data to any third party — the only
external communication is between your MCP client and the vault-cortex
container, secured by OAuth 2.1 or a static bearer token.

The search index and memory layer live inside the container's data volume.

## Tips for getting better results

- **Be specific about locations.** "In my Projects folder" or "the note
  called Meeting Notes" helps the AI find the right thing faster than a
  vague reference.
- **Mention tags and properties.** If your vault uses them, include them in
  your requests: "notes tagged `#meeting` from this month" or "notes where
  type is `reference`."
- **Memory compounds over time.** The more the AI knows about your
  preferences, the better its suggestions get. Run memory-review
  periodically to keep things current.
- **Large notes are handled efficiently.** The AI scans structure first and
  reads only what's needed, so don't worry about note size.
- **Leading callouts make notes self-describing.** A `> [!info]` callout at
  the top of a note gets surfaced in search results, helping the AI
  understand what each note is _for_ before reading the full content.
- **Consistent properties enable structured queries.** If you use `type:
meeting` on some meeting notes and `category: meeting` on others, the AI
  can't reliably filter by either one. Pick a convention and stick with it.
- **Protected paths prevent accidents.** Daily Notes and your memory folder
  can't be deleted through the AI by default. You can customize which paths
  are protected via `PROTECTED_PATHS`.

## Tool reference

For power users and debugging — the 25 tools your AI uses behind the scenes,
grouped by category. See the [README](../README.md#tools-25) for the full
table.

**Vault CRUD** — `vault_read_note`, `vault_write_note`, `vault_patch_note`,
`vault_replace_in_note`, `vault_delete_span`, `vault_list_notes`,
`vault_delete_note`, `vault_move_note`, `vault_update_properties`

**Search** — `vault_search`, `vault_search_by_tag`, `vault_search_by_folder`,
`vault_recent_notes`, `vault_list_tags`, `vault_list_property_keys`,
`vault_list_property_values`, `vault_search_by_property`

**Links** — `vault_get_backlinks`, `vault_get_outgoing_links`,
`vault_find_orphans`

**Memory** — `vault_get_memory`, `vault_update_memory`,
`vault_list_memory_files`, `vault_delete_memory`

**Daily Notes** — `vault_get_daily_note`

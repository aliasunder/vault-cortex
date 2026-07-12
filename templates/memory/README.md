# Memory Templates

These example files show the expected structure for Vault Cortex's memory system.
On first startup, the server creates these files automatically if your vault
doesn't already have a memory folder — no manual setup needed.

## Setup (manual alternative)

If you prefer to set up memory files manually instead of using the auto-created
templates:

1. Copy the example files into your vault's memory folder (default: `About Me/`):

```bash
cp templates/memory/Me.md ~/your-vault/About\ Me/
cp templates/memory/Principles.md ~/your-vault/About\ Me/
cp templates/memory/Opinions.md ~/your-vault/About\ Me/
cp templates/memory/Agents.md ~/your-vault/About\ Me/
cp templates/memory/Routines.md ~/your-vault/About\ Me/    # optional
```

2. If you use a different folder name, set `MEMORY_DIR` in your `.env`:

```bash
MEMORY_DIR=Profile
```

Then copy into that folder instead.

## Structure

Memory files use a specific format that Vault Cortex tools understand:

- **H1 heading**: file title (one per file)
- **Scope callout** (recommended): an Obsidian `> [!info] Scope of this file`
  block right below the H1, describing what the file contains and what it
  doesn't. Surfaced by `vault_read_note` (outline) and `vault_list_memory_files`
  so an agent can see a file's purpose without reading it. Edit it with
  `vault_patch_note` (operation `prepend`, no heading).
- **H2 headings**: sections (topics, categories)
- **Dated bullets**: entries under each section, in `- **YYYY-MM-DD**: text` format
- **`entry-policy` frontmatter** (recommended): how the file's entries may be
  maintained — see [Entry policy](#entry-policy) below

## Which file gets an entry?

One split matters more than the others: **facts about the user vs directives
for agents**. The test — _who is the subject of the entry?_

- An imperative addressed to agents ("verify before claiming success",
  "answer every question explicitly") → **Agents.md**
- A fact or preference about the user ("prefers written docs over video",
  "meeting-free Wednesdays") → **Me / Principles / Opinions / Routines**,
  per each file's scope callout

Mixing the two is the most common drift in a lived-in memory layer: directives
accumulate inside Principles and Me because they _feel_ like values. Route them
to Agents.md from the start — it doubles as the highest-value always-read file
for any agent session.

## Entry policy

Memory files are **append-only by default**: entries are never edited or
deleted, and corrections arrive as new dated entries. A file can opt out by
declaring the policy in frontmatter:

```yaml
entry-policy: append-only # the default — may be omitted
entry-policy: living # current-state snapshot — expired entries are pruned
```

`living` is for files that describe _what's current_ rather than _what has been
true_ — the Routines template ships this way. When an entry there expires (the
date passes, the commitment ends), delete it and, if the outcome is worth
keeping, append it to a history section (Recent past). Without pruning, a
current-state file accumulates expired plans that mislead every agent reading
it.

`vault_list_memory_files` surfaces each file's policy as `entry_policy`
(defaulting to `append-only` when the property is absent), so agents can check
it before pruning anything.

The `vault_update_memory` tool appends dated entries automatically. The `vault_get_memory` tool reads them back, either a full file, a single section, or all files concatenated. The `vault_memory_recall` tool retrieves entries by topic — every relevant dated entry across all files, oldest first.

## Customization

These templates are starting points. You can:

- Rename files to match your needs
- Add or remove H2 sections
- Change section names
- Add YAML frontmatter (tags, type, etc.)

The only requirement is the H2 heading structure and the dated bullet format for entries.

## Why dated entries?

The `- **YYYY-MM-DD**: text` format is an intentional design choice, not just a
convention:

1. **Temporal context** — agents see when a preference was recorded and can
   weigh recent entries over older ones when they conflict
2. **Evolution tracking** — beliefs and opinions change over time.
   Contradictions are natural; the timeline tells the story. An entry from six
   months ago saying "prefers tabs" followed by a recent one saying "switched to
   spaces" is more useful than a single overwritten value
3. **Semantic retrieval** — dated entries are the corpus for
   `vault_memory_recall`, which answers temporal queries ("how has the user's
   stance on X evolved?", "what did they believe about Y last month?") with
   the full dated arc, keyword- and semantically-matched

This is append-only by design (for files with the default `entry-policy`).
Entries are never overwritten — new entries are added at the top (newest
first), and the full history is preserved. Agents read the most recent entries
for current context and recall the full timeline by topic via
`vault_memory_recall`. Files marked `entry-policy: living` trade the complete timeline
for an accurate current state — their dated entries record when something was
captured, not a full history.

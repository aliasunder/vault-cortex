# Memory Templates

These example files show the expected structure for vault-cortex's memory system.
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
cp templates/memory/Routines.md ~/your-vault/About\ Me/    # optional
```

2. If you use a different folder name, set `MEMORY_DIR` in your `.env`:

```bash
MEMORY_DIR=Profile
```

Then copy into that folder instead.

## Structure

Memory files use a specific format that vault-cortex tools understand:

- **H1 heading**: file title (one per file)
- **H2 headings**: sections (topics, categories)
- **Dated bullets**: entries under each section, in `- **YYYY-MM-DD**: text` format

The `vault_update_memory` tool appends dated entries automatically. The `vault_get_memory` tool reads them back, either a full file, a single section, or all files concatenated.

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
3. **Semantic retrieval (Phase 2)** — dated entries become the corpus for
   LightRAG's knowledge graph, enabling temporal queries ("how has the user's
   stance on X evolved?", "what did they believe about Y last month?")

This is append-only by design. Entries are never overwritten — new entries are
added at the top (newest first), and the full history is preserved. Agents
retrieve context by reading the most recent entries, but the timeline remains
available for deeper understanding.

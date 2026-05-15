# Memory Templates

These example files show the expected structure for vault-cortex's memory system.

## Setup

1. Copy the example files into your vault's memory folder (default: `About Me/`):

```bash
cp templates/memory/Principles.md ~/your-vault/About Me/
cp templates/memory/Opinions.md ~/your-vault/About Me/
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

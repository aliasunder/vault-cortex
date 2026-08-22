export type LocalEnvAnswers = {
  mcpAuthToken: string
  vaultPath: string
}

export type RemoteEnvAnswers = {
  mcpAuthToken: string
  publicUrl: string
  /** Empty string when the user chose to fill it in later. */
  obsidianAuthToken: string
  vaultName: string
  /** Only set when the vault uses end-to-end encryption. */
  vaultPassword?: string
}

// Optional env blocks are synced from deploy/<mode>/.env.example by
// npm run sync:cli-env-blocks. Edit the deploy/ files, then re-run the script.
// cli/src/templates.test.ts asserts the CLI optional block vars match the
// deploy/ .env.example optional vars, so a new var breaks CI until both
// surfaces carry it.

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ GENERATED — do not edit between sync markers.                          │
// │ Source: deploy/local/.env.example → npm run sync:cli-env-blocks         │
// │ The script replaces everything between :begin and :end on each run.    │
// └─────────────────────────────────────────────────────────────────────────┘
// sync:local-optional:begin
const LOCAL_OPTIONAL_BLOCK = `# Optional ──────────────────────────────────────────────────
# To change a setting: run "npx vault-cortex@latest configure", or edit
# its value here (uncommenting it first if needed) and apply with
# "npx vault-cortex@latest restart" (plain docker restart does not
# re-read this file).

# Public URL for OAuth issuer URL in discovery metadata (default: http://localhost:8000).
# Override if you expose the server on a different URL (e.g. via a reverse proxy).
PUBLIC_URL=http://localhost:8000

# Largest file vault_read_file will read, in bytes (default: 52428800 = 50 MiB).
# Reading a larger file returns an error instead of content.
MAX_FILE_BYTES=52428800

# Byte budget for images returned by vault_read_file, in binary bytes before
# base64 encoding (default: 49152 = 48 KiB, sized for Claude Code's response cap).
# Images exceeding the budget are downscaled/recompressed to fit. Raise it for clients
# that accept larger tool responses.
MAX_IMAGE_OUTPUT_BYTES=49152

# Maximum number of PDF pages to render as images when raw: true is set on
# vault_read_file (default: 5). The per-page byte budget is MAX_IMAGE_OUTPUT_BYTES
# divided evenly across the rendered pages. Fewer pages = higher quality each.
MAX_PDF_RENDER_PAGES=5

# Your IANA timezone — affects daily note resolution and memory timestamps.
# TZ=America/New_York

# Enable or disable the embedding pipeline (default: true).
# When true, notes are chunked and embedded via a local ONNX model
# (bge-small-en-v1.5) for hybrid search — FTS5 keyword + vector semantic
# similarity fused via RRF. First startup is slow (~5min for 700 notes);
# subsequent starts are fast via content-hash caching.
# Set to false to disable model download and use FTS5 search only.
EMBEDDING_ENABLED=true

# Reranking mode for hybrid search results (default: blended).
# "blended" uses a cross-encoder to refine result ordering with
# position-aware score blending (~200ms added latency).
# "none" skips reranking for lower latency.
# Only takes effect when EMBEDDING_ENABLED=true.
RERANK_MODE=blended

# Enable or disable the memory layer (default: true).
# Set to false to hide memory tools and skip About Me/ creation.
MEMORY_ENABLED=true
# Enable or disable file tools — vault_read_file and vault_list_files (default: true).
# Set to false when Obsidian Sync has attachment syncing disabled.
FILE_TOOLS_ENABLED=true
# Run the server in read-only mode (default: false).
# Set to true to hide every tool that changes the vault — clients can only
# read and search. The memory folder is not auto-created in this mode.
READONLY_MODE=false
# Hide individual tools by name, comma-separated (default: none hidden).
# Names match the README tools table: https://github.com/aliasunder/vault-cortex#tools
# Subtractive only — it cannot re-enable a tool another setting hides; an
# unknown tool name stops the server at startup so typos surface immediately.
# DISABLED_TOOLS=vault_delete_note,vault_move_note
# Memory folder name in your vault (default: About Me).
MEMORY_DIR=About Me

# Daily notes folder and filename format (default: read from the
# vault's .obsidian/daily-notes.json, falling back to "Daily Notes" and
# YYYY-MM-DD). Folder is any vault-relative path (Journal, Planner/Daily);
# format takes the same tokens as Obsidian's date format setting.
# DAILY_NOTES_FOLDER=Journal
# DAILY_NOTES_FORMAT=YYYY-MM-DD

# Comma-separated folders protected from deletion (default: MEMORY_DIR plus
# the daily notes folder — DAILY_NOTES_FOLDER when set, otherwise "Daily Notes").
# A custom folder set only in daily-notes.json is not auto-protected.
# PROTECTED_PATHS=About Me,Daily Notes

# Comma-separated folders excluded from orphan detection (default: the daily
# notes folder — DAILY_NOTES_FOLDER when set, otherwise "Daily Notes" — plus
# Templates and MEMORY_DIR).
# ORPHAN_EXCLUDE_FOLDERS=Daily Notes,Templates,About Me

# URL shown in OAuth discovery metadata
# (default: https://github.com/aliasunder/vault-cortex).
# SERVICE_DOCUMENTATION_URL=https://github.com/youruser/your-fork

# Host port to expose (default: 8000).
PORT=8000

# Client-IP trust for OAuth rate limiting and logs (defaults shown).
# With nothing in front of the server, leave both untouched — each visitor
# is identified by their own connection, and faked Forwarded/X-Forwarded-For
# headers are ignored.
# With a proxy or tunnel you control in front (Caddy, nginx, Cloudflare
# Tunnel), set TRUST_PROXY_HOPS=1 so visitors are told apart by their real
# IP — otherwise they all share one rate-limit budget.
# Set TRUST_FORWARDED_HEADER=true only if the proxy reports each visitor's
# IP in the RFC 7239 Forwarded header (e.g. AWS API Gateway).
# TRUST_PROXY_HOPS=0
# TRUST_FORWARDED_HEADER=false

# Log verbosity: debug | info | warn | error (default: info).
LOG_LEVEL=info

# Directory for persistent log files inside the container (default: none).
# The container's own log (what \`docker logs\` shows) is always written, but
# Docker discards it whenever the container is recreated — on image updates
# or compose changes. Set a path (e.g. /data/logs) to also write date-stamped
# log files there; the /data volume keeps them.
LOG_DIR=none

# Days to keep log files before cleanup on startup (default: 90). Only
# applies once LOG_DIR is a path.
# LOG_RETENTION_DAYS=90

# Windows users: set this to true. Makes a vault stored on a C: drive work
# through Docker Desktop (switches the file watcher to polling and note moves
# to rename-based writes). Only strictly needed when your vault is on a C:
# drive rather than inside WSL2, but harmless to enable for any Windows setup.
WINDOWS_MODE=false
`

// sync:local-optional:end

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ GENERATED — do not edit between sync markers.                          │
// │ Source: deploy/remote/.env.example → npm run sync:cli-env-blocks        │
// │ VAULT_PASSWORD is excluded (handled conditionally in buildRemoteEnv).  │
// └─────────────────────────────────────────────────────────────────────────┘
// sync:remote-optional:begin
const REMOTE_OPTIONAL_BLOCK = `# Optional ──────────────────────────────────────────────────
# To change a setting: run "npx vault-cortex@latest configure", or edit
# its value here (uncommenting it first if needed) and apply with
# "npx vault-cortex@latest restart" (plain docker restart does not
# re-read this file).

# Your IANA timezone — affects daily note resolution and memory timestamps.
# TZ=America/New_York

# Enable or disable the embedding pipeline (default: true).
# When true, notes are chunked and embedded via a local ONNX model
# (bge-small-en-v1.5) for hybrid search — FTS5 keyword + vector semantic
# similarity fused via RRF. First startup is slow (~5min for 700 notes);
# subsequent starts are fast via content-hash caching.
# Set to false to disable model download and use FTS5 search only.
EMBEDDING_ENABLED=true

# Reranking mode for hybrid search results (default: blended).
# "blended" uses a cross-encoder to refine result ordering with
# position-aware score blending (~200ms added latency).
# "none" skips reranking for lower latency.
# Only takes effect when EMBEDDING_ENABLED=true.
RERANK_MODE=blended

# Windows bind-mount mode (default: false).
# Set to true when your vault is on a Windows drive (Docker Desktop).
# Enables polling for the file watcher and rename-based moves across
# the Docker Desktop/WSL2 bridge.
WINDOWS_MODE=false

# Largest file vault_read_file will read, in bytes (default: 52428800 = 50 MiB).
# Reading a larger file returns an error instead of content.
MAX_FILE_BYTES=52428800

# Byte budget for images returned by vault_read_file, in binary bytes before
# base64 encoding (default: 49152 = 48 KiB, sized for Claude Code's response cap).
# Images exceeding the budget are downscaled/recompressed to fit. Raise it for clients
# that accept larger tool responses.
MAX_IMAGE_OUTPUT_BYTES=49152

# Maximum number of PDF pages to render as images when raw: true is set on
# vault_read_file (default: 5). The per-page byte budget is MAX_IMAGE_OUTPUT_BYTES
# divided evenly across the rendered pages. Fewer pages = higher quality each.
MAX_PDF_RENDER_PAGES=5

# Enable or disable the memory layer (default: true).
# Set to false to hide memory tools and skip About Me/ creation.
MEMORY_ENABLED=true
# Enable or disable file tools — vault_read_file and vault_list_files (default: true).
# Set to false when Obsidian Sync has attachment syncing disabled.
FILE_TOOLS_ENABLED=true
# Run the server in read-only mode (default: false).
# Set to true to hide every tool that changes the vault — clients can only
# read and search. The memory folder is not auto-created in this mode.
READONLY_MODE=false
# Hide individual tools by name, comma-separated (default: none hidden).
# Names match the README tools table: https://github.com/aliasunder/vault-cortex#tools
# Subtractive only — it cannot re-enable a tool another setting hides; an
# unknown tool name stops the server at startup so typos surface immediately.
# DISABLED_TOOLS=vault_delete_note,vault_move_note
# Memory folder name in your vault (default: About Me).
MEMORY_DIR=About Me

# Daily notes folder and filename format (default: read from the
# vault's .obsidian/daily-notes.json, synced to the server via SYNC_CONFIGS
# below; falls back to "Daily Notes" and YYYY-MM-DD). Folder is any
# vault-relative path (Journal, Planner/Daily); format takes the same tokens
# as Obsidian's date format setting.
# DAILY_NOTES_FOLDER=Journal
# DAILY_NOTES_FORMAT=YYYY-MM-DD

# Comma-separated folders protected from deletion (default: MEMORY_DIR plus
# the daily notes folder — DAILY_NOTES_FOLDER when set, otherwise "Daily Notes").
# A custom folder set only in daily-notes.json is not auto-protected.
# PROTECTED_PATHS=About Me,Daily Notes

# Comma-separated folders excluded from orphan detection (default: the daily
# notes folder — DAILY_NOTES_FOLDER when set, otherwise "Daily Notes" — plus
# Templates and MEMORY_DIR).
# ORPHAN_EXCLUDE_FOLDERS=Daily Notes,Templates,About Me

# URL shown in OAuth discovery metadata
# (default: https://github.com/aliasunder/vault-cortex).
# SERVICE_DOCUMENTATION_URL=https://github.com/youruser/your-fork

# Host port to expose (default: 8000).
PORT=8000

# Client-IP trust for OAuth rate limiting and logs (defaults shown).
# With nothing in front of the server, leave both untouched — each visitor
# is identified by their own connection, and faked Forwarded/X-Forwarded-For
# headers are ignored.
# With a proxy or tunnel you control in front (Caddy, nginx, Cloudflare
# Tunnel), set TRUST_PROXY_HOPS=1 so visitors are told apart by their real
# IP — otherwise they all share one rate-limit budget.
# Set TRUST_FORWARDED_HEADER=true only if the proxy reports each visitor's
# IP in the RFC 7239 Forwarded header (e.g. AWS API Gateway).
# TRUST_PROXY_HOPS=0
# TRUST_FORWARDED_HEADER=false

# Log verbosity: debug | info | warn | error (default: info).
LOG_LEVEL=info

# Directory for persistent log files inside the container (default: /data/logs).
# The container's own log (what \`docker logs\` shows) is always written, but
# Docker discards it whenever the container is recreated — on image updates
# or compose changes. Log files under LOG_DIR live on the data volume and
# survive. Set to "none" to keep only the container log.
LOG_DIR=/data/logs

# Days to retain persistent log files before cleanup (default: 90).
LOG_RETENTION_DAYS=90

# User/group IDs for obsidian-sync (default: 1000).
PUID=1000
PGID=1000

# Device name the container reports to Obsidian Sync — labels its changes in the sync log.
DEVICE_NAME=vault-cortex

# Obsidian Sync conflict resolution: merge | conflict (default: merge).
# 'merge' integrates changes automatically; 'conflict' writes a separate conflict file.
CONFLICT_STRATEGY=merge

# Sync direction: bidirectional | pull-only | mirror-remote (default: bidirectional).
# 'pull-only': server edits are kept locally but never uploaded;
# 'mirror-remote': server edits are undone, so the server is an exact copy.
SYNC_MODE=bidirectional

# Folders to leave out of sync, comma-separated — the same list as Obsidian's
# Sync → "Excluded folders". Empty keeps the Sync client's default (nothing excluded).
EXCLUDED_FOLDERS=

# Attachment types to sync, comma-separated: image, audio, video, pdf, unsupported —
# the same toggles as Obsidian's Sync → "Selective sync". Empty keeps the Sync
# client's default.
FILE_TYPES=

# Obsidian settings categories to sync into the server's .obsidian/ folder
# (default: the two the server reads — daily notes settings and community
# plugin settings such as the Tasks plugin's format; "none" disables).
# A category only syncs after your desktop pushes it: Obsidian Settings →
# Sync → "Vault configuration sync" (per device). Some community plugins
# keep API keys in their settings — server tools never read .obsidian/,
# but synced settings do live on the server volume. Values: app,
# appearance, appearance-data, hotkey, core-plugin, core-plugin-data,
# community-plugin, community-plugin-data — comma-separated.
SYNC_CONFIGS=core-plugin-data,community-plugin-data
`

// sync:remote-optional:end

export const buildLocalEnv = (
  answers: LocalEnvAnswers,
): string => `# vault-cortex — local quickstart
# Generated by \`npx vault-cortex@latest init\`. Full option reference:
# https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/.env.example

# Required ──────────────────────────────────────────────────

# Bearer token for MCP authentication (auto-generated).
MCP_AUTH_TOKEN=${answers.mcpAuthToken}

# Absolute path to your Obsidian vault on this machine.
VAULT_PATH=${answers.vaultPath}

${LOCAL_OPTIONAL_BLOCK}`

export const buildRemoteEnv = (answers: RemoteEnvAnswers): string => {
  const vaultPasswordLines =
    answers.vaultPassword === undefined
      ? `# Only if your vault has end-to-end encryption enabled.
# VAULT_PASSWORD=`
      : `# Vault end-to-end encryption password.
VAULT_PASSWORD=${answers.vaultPassword}`

  const obsidianTokenComment =
    answers.obsidianAuthToken === ""
      ? `# Obsidian Sync auth token — FILL THIS IN before starting the server.
# Generate once with:
#   npx vault-cortex@latest get-sync-token`
      : `# Obsidian Sync auth token.`

  return `# vault-cortex — remote quickstart (Obsidian Sync)
# Generated by \`npx vault-cortex@latest init\`. Full option reference:
# https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/.env.example

# Required ──────────────────────────────────────────────────

# Bearer token for MCP authentication (auto-generated).
MCP_AUTH_TOKEN=${answers.mcpAuthToken}

# Public URL that MCP clients use to reach this server.
# Used as the OAuth issuer URL in discovery metadata.
PUBLIC_URL=${answers.publicUrl}

${obsidianTokenComment}
OBSIDIAN_AUTH_TOKEN=${answers.obsidianAuthToken}

# Exact name of your Obsidian vault (case-sensitive).
VAULT_NAME=${answers.vaultName}

${vaultPasswordLines}

${REMOTE_OPTIONAL_BLOCK}`
}

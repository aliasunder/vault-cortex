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
# To change a setting: edit its value (uncommenting it first if needed),
# then apply with "npx vault-cortex upgrade" (restart alone does not
# re-read this file).

# Public URL for OAuth issuer URL in discovery metadata (default: http://localhost:8000).
# Override if you expose the server on a different URL (e.g. via a reverse proxy).
PUBLIC_URL=http://localhost:8000

# Largest asset file vault_read_asset will read, in bytes (default: 52428800 = 50 MiB).
# Reading a larger file returns an error instead of content.
MAX_ASSET_BYTES=52428800

# Byte budget for images returned by vault_read_asset, in binary bytes before
# base64 encoding (default: 49152 = 48 KiB, sized for Claude Code's response cap).
# Images exceeding the budget are downscaled/recompressed to fit. Raise it for clients
# that accept larger tool responses.
MAX_IMAGE_OUTPUT_BYTES=49152

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
# Memory folder name in your vault (default: About Me).
MEMORY_DIR=About Me

# Comma-separated folders protected from deletion (default: MEMORY_DIR, Daily Notes).
# If your daily notes folder has a custom name (e.g. "Journal"), override to include it.
# PROTECTED_PATHS=About Me,Daily Notes

# Comma-separated folders excluded from orphan detection
# (default: Daily Notes, Templates, MEMORY_DIR).
# ORPHAN_EXCLUDE_FOLDERS=Daily Notes,Templates,About Me

# URL shown in OAuth discovery metadata
# (default: https://github.com/aliasunder/vault-cortex).
# SERVICE_DOCUMENTATION_URL=https://github.com/youruser/your-fork

# Host port to expose (default: 8000).
PORT=8000

# Log verbosity: debug | info | warn | error (default: info).
LOG_LEVEL=info

# Directory for persistent log files inside the container.
# Unset by default — logs go to stdout only. Set a path to also write
# date-stamped log files there (the /data volume persists them).
# LOG_DIR=/data/logs

# Days to retain persistent log files before cleanup (default: 30).
LOG_RETENTION_DAYS=30

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
# To change a setting: edit its value (uncommenting it first if needed),
# then apply with "npx vault-cortex upgrade" (restart alone does not
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

# Largest asset file vault_read_asset will read, in bytes (default: 52428800 = 50 MiB).
# Reading a larger file returns an error instead of content.
MAX_ASSET_BYTES=52428800

# Byte budget for images returned by vault_read_asset, in binary bytes before
# base64 encoding (default: 49152 = 48 KiB, sized for Claude Code's response cap).
# Images exceeding the budget are downscaled/recompressed to fit. Raise it for clients
# that accept larger tool responses.
MAX_IMAGE_OUTPUT_BYTES=49152

# Enable or disable the memory layer (default: true).
# Set to false to hide memory tools and skip About Me/ creation.
MEMORY_ENABLED=true
# Memory folder name in your vault (default: About Me).
MEMORY_DIR=About Me

# Comma-separated folders protected from deletion (default: MEMORY_DIR, Daily Notes).
# If your daily notes folder has a custom name (e.g. "Journal"), override to include it.
# PROTECTED_PATHS=About Me,Daily Notes

# Comma-separated folders excluded from orphan detection
# (default: Daily Notes, Templates, MEMORY_DIR).
# ORPHAN_EXCLUDE_FOLDERS=Daily Notes,Templates,About Me

# URL shown in OAuth discovery metadata
# (default: https://github.com/aliasunder/vault-cortex).
# SERVICE_DOCUMENTATION_URL=https://github.com/youruser/your-fork

# Host port to expose (default: 8000).
PORT=8000

# Log verbosity: debug | info | warn | error (default: info).
LOG_LEVEL=info

# Directory for persistent log files inside the container (default: /data/logs).
# Set to empty to disable file logging (logs still go to stdout either way).
LOG_DIR=/data/logs

# Days to retain persistent log files before cleanup (default: 30).
LOG_RETENTION_DAYS=30

# User/group IDs for obsidian-sync (default: 1000).
PUID=1000
PGID=1000

# Device name shown in Obsidian Sync settings.
DEVICE_NAME=vault-cortex

# Obsidian Sync conflict resolution: merge | conflict (default: merge).
# 'merge' integrates changes automatically; 'conflict' writes a separate conflict file.
CONFLICT_STRATEGY=merge

# Sync direction: bidirectional | pull-only | push-only (default: bidirectional).
SYNC_MODE=bidirectional
`

// sync:remote-optional:end

export const buildLocalEnv = (
  answers: LocalEnvAnswers,
): string => `# vault-cortex — local quickstart
# Generated by \`npx vault-cortex init\`. Full option reference:
# https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/.env.example

# Required ──────────────────────────────────────────────────

# Bearer token for MCP authentication (auto-generated).
MCP_AUTH_TOKEN=${answers.mcpAuthToken}

# Absolute path to your Obsidian vault on this machine.
VAULT_PATH=${answers.vaultPath}

# Public URL for OAuth issuer URL in discovery metadata.
# Override if you expose the server on a different URL (e.g. via a reverse proxy).
PUBLIC_URL=http://localhost:8000

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
#   npx vault-cortex get-sync-token`
      : `# Obsidian Sync auth token.`

  return `# vault-cortex — remote quickstart (Obsidian Sync)
# Generated by \`npx vault-cortex init\`. Full option reference:
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

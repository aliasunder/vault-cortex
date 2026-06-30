# Architecture

Vault Cortex is a remote MCP server that exposes an Obsidian vault over HTTPS
via the Model Context Protocol. Any MCP client — Claude Desktop, Claude Code,
Cursor, OpenCode — can read, write, and search your vault from anywhere.

## Why This Exists

The typical Obsidian + MCP setup requires three moving parts running
simultaneously: Obsidian open → Local REST API plugin installed → a separate
MCP server wrapping the REST API. That chain is local-only.

Vault Cortex replaces it:

- **Docker-based** — no Obsidian desktop required to be running, no plugins, works with `.md` files on disk
- **Remote access** — Obsidian Sync in Docker keeps the vault current; works from your phone, a remote server, or any MCP client
- **MCP spec-compliant** — streamable-http transport, OAuth 2.1

See the [README](./README.md) for the full value proposition.

This document covers the architecture of the reference deployment — Lightsail,
API Gateway, SST — but Vault Cortex runs anywhere Docker does.

## Phasing

**Phase 1** delivers vault CRUD, full-text search (SQLite FTS5), and the
About Me/ memory layer. The MCP surface is **tools + prompts** — model-driven
tools plus user-initiated prompt workflows (see [MCP Prompts](#mcp-prompts)).
This alone makes any MCP client vault-aware and personalized across
conversations.

**Phase 2** is in progress. It adds hybrid search (FTS5 + sqlite-vec
vector search with RRF fusion) to the existing `vault_search` tool —
embeddings generated locally by a small ONNX model running in-process,
no external API required. The file watcher gains a second hook for
embedding ingestion. Additive, no rewrites. The Docker image uses Debian
slim (`node:24-slim`) instead of Alpine because `onnxruntime-node`
requires glibc.

## User Requirements

| ID  | Requirement                     | Phase | Summary                                                                                   |
| --- | ------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| R1  | Bidirectional sync              | 1     | Obsidian Sync + obsidian-headless. One vault, always current.                             |
| R2  | Remote vault read access        | 1     | Any MCP client can read any note by path, list notes in any folder.                       |
| R3  | Remote vault write access       | 1     | Writes sync back to all Obsidian apps automatically via R1.                               |
| R4  | Full-text and structured search | 1     | SQLite FTS5 — ranked results, filter by tags/type/folder.                                 |
| R5  | Memory tools                    | 1     | Read/append to configurable memory folder (default: `About Me/`).                         |
| R6  | Secure remote access            | 1     | HTTPS via API Gateway. OAuth 2.1 + static bearer token.                                   |
| R7  | Low operational overhead        | 1     | Always-on, no manual intervention. ~$12/mo. IaC via SST.                                  |
| R8  | Extensible for semantic search  | 2     | Hybrid search (sqlite-vec + local embeddings) plugs into existing watcher. Not a rewrite. |

## Component Diagram

```mermaid
graph TB
    subgraph devices ["Your Devices"]
        OBS_PHONE["Obsidian Mobile"]
        OBS_LAPTOP["Obsidian Desktop"]
    end

    subgraph cloud ["Obsidian Cloud"]
        SYNC["Obsidian Sync"]
    end

    subgraph apigw_grp ["AWS — API Gateway"]
        APIGW["API Gateway HTTP API<br/>HTTPS + auto URL"]
        AUTH_FN["Lambda Authorizer<br/>protected routes only:<br/>validates static + JWT"]
        APIGW -->|validate| AUTH_FN
    end

    subgraph lightsail ["AWS — Lightsail $12/mo"]
        subgraph compose ["Docker Compose"]
            OB_HEADLESS["obsidian-sync<br/>ob sync --continuous"]
            VAULT_FS[("/vault<br/>SOURCE OF TRUTH")]
            MCP_SERVER["vault-mcp :8000<br/>MCP streamable-http"]
            SQLITE[("SQLite FTS5")]
            WATCHER["chokidar watcher"]
        end
    end

    subgraph phase2 ["Phase 2"]
        HYBRID["sqlite-vec<br/>hybrid search (FTS5 + vector)"]
    end

    subgraph clients ["MCP Clients"]
        CC["Claude Code"]
        CD["Claude Desktop"]
        CU["Cursor / OpenCode"]
    end

    OBS_PHONE <-->|edit| SYNC
    OBS_LAPTOP <-->|edit| SYNC
    SYNC <-->|bidirectional| OB_HEADLESS
    OB_HEADLESS -->|read/write .md| VAULT_FS
    VAULT_FS -->|watch| WATCHER
    WATCHER -->|index| SQLITE
    WATCHER -.->|Phase 2: embed| HYBRID
    MCP_SERVER -->|read/write| VAULT_FS
    MCP_SERVER -->|query| SQLITE
    MCP_SERVER -.->|Phase 2: hybrid query| HYBRID
    CC -->|OAuth 2.1 / Bearer token| APIGW
    CD -->|OAuth 2.1| APIGW
    CU -->|OAuth 2.1 / Bearer token| APIGW
    APIGW -->|proxy| MCP_SERVER
```

## Auth Flow

```mermaid
sequenceDiagram
    participant C as MCP Client
    participant AG as API Gateway
    participant L as Lambda Authorizer
    participant E as Express (vault-mcp)
    participant DB as SQLite (oauth.db)

    Note over C,E: First-time OAuth Authorization
    C->>AG: POST /mcp (no token — initial probe)
    AG-->>C: 401 Unauthorized (identity source missing — Lambda not invoked)
    Note over C: 401 → client enters OAuth flow,<br/>falls back to default discovery location
    C->>AG: GET /.well-known/oauth-protected-resource
    Note over AG: Open route — no authorizer
    AG->>E: Forward
    E-->>C: {authorization_servers: [...]}

    C->>E: POST /register (dynamic client registration)
    E->>DB: Store client credentials
    E-->>C: {client_id, client_secret}

    C->>E: GET /authorize (opens browser)
    E-->>C: Consent page HTML
    Note over C: User enters MCP_AUTH_TOKEN
    C->>E: POST /oauth/decide (token + approve)
    E-->>C: 302 redirect with auth code

    C->>E: POST /token (code + code_verifier)
    E->>DB: Store refresh token
    E-->>C: {access_token: JWT, refresh_token}

    Note over C,E: Subsequent MCP Requests (dual-validated)
    C->>AG: POST /mcp (Bearer JWT)
    AG->>L: Authorize request
    L->>L: Verify JWT signature (HMAC)
    L-->>AG: isAuthorized: true
    AG->>E: Forward
    E->>E: requireBearerAuth (verify JWT again)
    E-->>C: MCP response

    Note over C,E: Silent Token Refresh (24h cycle)
    C->>E: POST /token (refresh_token)
    E->>DB: Consume old, store new refresh token
    E-->>C: {access_token: new JWT, refresh_token: new}
```

## Docker Compose Startup

```mermaid
graph LR
    B["obsidian-sync<br/>(UID 1000)<br/>Obsidian Sync → /vault"] --> C["vault-mcp<br/>(UID 1000)<br/>MCP server :8000"]
    B -.->|shared volume| D[("/vault<br/>source of truth")]
    C -.->|shared volume| D
    C -.->|index + OAuth| E[("/data<br/>index.db + oauth.db")]
    B -.->|sync state| F[("config volume<br/>/home/obsidian/.config<br/>owned obsidian:obsidian at build time")]
```

## Data Flow

**Read:** MCP client → API Gateway (TLS + auth) → vault-mcp → filesystem or SQLite → response.

**Write:** MCP client → API Gateway → vault-mcp → filesystem write → obsidian-headless detects → Obsidian Sync propagates. Watcher also updates SQLite index.

**Sync (from apps):** Obsidian app → Obsidian Sync → obsidian-headless → `/vault/` → watcher → SQLite. Now searchable via MCP.

**Hybrid query (Phase 2):** MCP client → `vault_search` → FTS5 BM25 ranks + sqlite-vec KNN ranks → RRF fusion → response.

## Invariant: Vault Is Source of Truth

The vault `.md` files are canonical. SQLite FTS5 is derived — rebuildable from scratch. Never write to the index directly. This extends to Phase 2: the vector embeddings in sqlite-vec are also derived from vault files, not the other way around.

## MCP Tools

### Phase 1: Vault Read/Write (R2, R3)

| Tool                      | Input                                                        | Annotation      |
| ------------------------- | ------------------------------------------------------------ | --------------- |
| `vault_read_note`         | `path, properties_only?, outline?, heading?, heading_level?` | readOnlyHint    |
| `vault_write_note`        | `path, body, properties?`                                    | destructiveHint |
| `vault_patch_note`        | `path, operation, content, heading?, heading_level?`         | destructiveHint |
| `vault_replace_in_note`   | `path, old_text, new_text, replace_all_occurrences?`         | destructiveHint |
| `vault_delete_span`       | `path, start_anchor, end_anchor?, first_match?`              | destructiveHint |
| `vault_list_notes`        | `folder?, glob?`                                             | readOnlyHint    |
| `vault_delete_note`       | `path, prune_empty_folders?`                                 | destructiveHint |
| `vault_move_note`         | `old_path, new_path, prune_empty_folders?`                   | destructiveHint |
| `vault_update_properties` | `path, properties`                                           | destructiveHint |

`vault_read_note` returns full content by default; optional `properties_only`, `outline`, or `heading` (with `heading_level` to disambiguate) modes return just the properties, the structure, or a single section — cheap partial reads for large notes. `outline` returns an object `{ leading_callout?, headings }` — the heading tree plus any top-of-file callout (a `> [!type]` block) when present.

`vault_patch_note` supports 4 operations: `append`, `prepend`, `replace`, `insert_before` — heading-targeted with optional file-level mode. `vault_replace_in_note` does exact text find-and-replace in the note body. `vault_delete_span` deletes a contiguous block of lines by short anchor substrings — more reliable than reproducing the full block as `old_text`, and the complement to `vault_replace_in_note` for deletion.

`vault_delete_note` refuses paths under folders listed in `PROTECTED_PATHS` (default: the memory dir + `Daily Notes/`) as a server-side guardrail; use `vault_delete_memory` for individual entries in memory files. `vault_update_properties` merges properties without touching the body — sets new keys, overwrites matching keys, deletes keys set to `null`.

`vault_move_note` moves or renames a note and rewrites every link across the vault that resolves to it — wikilinks (including aliases, heading anchors, and embeds), markdown links, and frontmatter links — mirroring Obsidian's built-in rename. It reuses the same link-resolution logic as the link-graph tools, only rewrites a link when leaving it would break it, and refuses to overwrite an existing destination or touch `PROTECTED_PATHS`. Both `vault_delete_note` and `vault_move_note` support `prune_empty_folders` to clean up parent directories left empty by the operation.

### Phase 1: Search (R4)

| Tool                     | Input                        | Annotation   |
| ------------------------ | ---------------------------- | ------------ |
| `vault_search`           | `query, filters?`            | readOnlyHint |
| `vault_search_by_tag`    | `tag, exact?`                | readOnlyHint |
| `vault_search_by_folder` | `folder, recursive?, limit?` | readOnlyHint |
| `vault_list_tags`        | —                            | readOnlyHint |
| `vault_recent_notes`     | `sort_by?, limit?`           | readOnlyHint |

`filters` covers `folder`, `tags`, `related`, `type`, `properties` (arbitrary frontmatter keys), `limit`, `snippet_tokens`, and `include_leading_callout` (opt-in; adds each result's top-of-file callout). All discovery tools (`vault_search`, `vault_search_by_tag`, `vault_search_by_folder`, `vault_recent_notes`, `vault_search_by_property`, `vault_find_orphans`) include `bytes` (on-disk file size) and each note's `leading_callout` in its metadata when present — `bytes` lets agents decide whether to read in full or use `outline`/`heading` mode before committing to a read. `sort_by` is `"created" | "modified"` (default `"modified"`).

**Promoted properties:** Five frontmatter keys — `title`, `tags`, `type`, `created`, `related` — get dedicated columns in the `notes` table for direct `WHERE`-clause filtering (no `json_extract` needed). In tool responses, these appear as top-level fields; remaining frontmatter keys are returned under `additional_properties` (via `formatNoteMetadata` in `tool-definitions.ts`). All other properties live in a JSON `properties` column, queryable via `json_extract` — functional for any schema, but without dedicated columns.

### Phase 1: Property Discovery + Daily Notes

| Tool                         | Input                         | Annotation   |
| ---------------------------- | ----------------------------- | ------------ |
| `vault_get_daily_note`       | `date?`                       | readOnlyHint |
| `vault_list_property_keys`   | `folder?`                     | readOnlyHint |
| `vault_list_property_values` | `key, folder?, limit?`        | readOnlyHint |
| `vault_search_by_property`   | `key, value, folder?, limit?` | readOnlyHint |

`vault_get_daily_note` reads `.obsidian/daily-notes.json` for the vault's folder and date format, falling back to `Daily Notes/YYYY-MM-DD.md`. Property tools query the `properties` JSON column in the notes table via `json_each`/`json_extract`, handling both scalar and array-valued properties.

### Phase 1: Memory (R5)

| Tool                      | Input                            | Annotation       |
| ------------------------- | -------------------------------- | ---------------- |
| `vault_get_memory`        | `file?, section?`                | readOnlyHint     |
| `vault_update_memory`     | `file, section, entry, options?` | !destructiveHint |
| `vault_delete_memory`     | `file, section, date, entry`     | destructiveHint  |
| `vault_list_memory_files` | —                                | readOnlyHint     |

**Auto-initialization:** On first startup, if the memory folder (default: `About Me/`) doesn't exist, the server creates it with template files (Me.md, Opinions.md, Principles.md), each opening with a `> [!info] Scope of this file` callout so agents discover a ready, self-documenting structure. `vault_update_memory` also auto-creates files and sections on write — agents can save preferences without manual setup, and a newly-created file is seeded with a placeholder scope callout to fill in. This is the two-layer bootstrap: startup seeds the default structure, write-time handles growth beyond templates.

**Opt-out:** The memory layer is opt-out: set `MEMORY_ENABLED=false` to hide all memory tools and prompts, skip auto-initialization, and strip memory references from server metadata. The vault CRUD and search layers continue to work normally.

### Phase 1: Link Queries

| Tool                       | Input                      | Annotation   |
| -------------------------- | -------------------------- | ------------ |
| `vault_get_backlinks`      | `path`                     | readOnlyHint |
| `vault_get_outgoing_links` | `path`                     | readOnlyHint |
| `vault_find_orphans`       | `exclude_folders?, limit?` | readOnlyHint |

Link queries use a `links` table populated during indexing:

- **Sources:** `[[wikilink]]` and `[text](path.md)` links in the note body (fence-aware parsing skips code blocks), plus `[[wikilink]]`s in frontmatter property values (e.g. `related:`).
- **Resolution:** Each target is resolved against all known note paths covering Obsidian's three "New link format" modes:
  1. Exact vault-relative path (path from vault folder)
  2. Path relative to the linking note (path from current file, including upward `../`)
  3. Basename (shortest-path-first for ambiguous basenames)
- **Non-markdown assets:** Targets that don't resolve to a note are checked against a `non_md_files` table (populated during rebuild, maintained by the file watcher). Wikilinks to `.canvas`, `.base`, images, PDFs, and other non-markdown assets resolve as `kind: "asset"` instead of being counted as broken.
- **Outgoing links:** `vault_get_outgoing_links` returns a `kind` discriminator (`"note"` or `"asset"`) so clients can distinguish retrievable notes from non-retrievable asset references.
- **Orphans:** `vault_find_orphans` excludes folders listed in `ORPHAN_EXCLUDE_FOLDERS` (default: `Daily Notes`, `Templates`, and the memory dir).

### Phase 2: Hybrid Search (R8)

Enhances the existing `vault_search` tool with vector similarity via sqlite-vec, fused with FTS5 keyword results using Reciprocal Rank Fusion (RRF). Embeddings generated locally by a small ONNX model (bge-small-en-v1.5, 33M params, INT8 quantized) running in-process — no external API, fully rebuildable from vault files, and a progressive enhancement (FTS5 works identically if embeddings are absent).

**Embedding pipeline:** Controlled by `EMBEDDING_ENABLED` (default: `true`). When enabled, `createEmbedder(logger)` lazy-loads the ONNX model on first use (1.3s cold start, ~25MB download cached by transformers). Notes are chunked via heading-aware splitting (`chunker.ts`) with paragraph sub-splitting for oversized sections (MAX_CHUNK_TOKENS = 450). Markdown syntax is stripped before embedding (`plaintext.ts`). Each chunk is prefixed with the note title for context. Content-hash gating (SHA-256 per chunk) skips re-embedding unchanged content on both incremental file-watcher updates and full rebuilds. Vector tables persist across rebuilds (only FTS, notes, links, and non-md tables are cleared) — Pass 3 cleans up vectors for deleted notes, then embeds only new or modified chunks.

**Vector schema:** Two tables in the same SQLite database as FTS5:

- `note_chunks`: stores chunk text, position index, and content hash per note
- `note_vectors` (vec0): stores 384-dim Float32 embeddings keyed by chunk ID

**Indexing flow:** `rebuildFromVault` runs three passes — Pass 1 (FTS + metadata), Pass 2 (links with complete path list), then returns so the server can start accepting requests. Pass 3 (embedding) runs in the background — search works with FTS-only until vectors are ready. Vector tables are persistent across restarts; content-hash gating skips unchanged chunks on incremental file-watcher updates. The file watcher calls `embedNote` after `upsertNote`; `removeNote` cleans up both vectors and chunks.

**Hybrid search:** `vault_search` calls `hybridSearch`, which runs FTS5 and vector search in parallel, then merges via RRF. The flow:

1. FTS5 keyword search (synchronous, existing `fullTextSearch`)
2. Vector search: embed the query → sqlite-vec KNN → deduplicate to best chunk per note
3. RRF fusion (`computeRrfScores`): score = Σ(1/(k+rank)) across both lists, k=60, with top-rank bonuses (+0.05 rank 1, +0.02 ranks 2–3)
4. Build merged results: FTS results keep their metadata and snippet (score replaced with RRF score); vector-only results get metadata from the notes table and a snippet from their best-matching chunk text
5. Apply user filters (folder, tags, type, related, properties) to vector-only results — FTS results are already filtered via SQL

Graceful fallback: when no embedder is configured (`EMBEDDING_ENABLED=false`), no vectors are indexed yet (startup), or the embedding model fails, `hybridSearch` returns FTS-only results silently. The response includes `search_mode: "hybrid" | "fts"` so clients know which ranking produced the scores. The tool description is also conditional — hybrid-aware when embeddings are enabled, keyword-only when disabled.

**Hybrid query flow:**

```mermaid
flowchart LR
    Q[Query] --> FTS[FTS5 BM25]
    Q --> EMB[Embed Query]
    EMB --> KNN[sqlite-vec KNN]
    FTS --> |ranked paths| RRF[RRF Fusion\nk=60 + bonuses]
    KNN --> |ranked paths| RRF
    RRF --> R[Results]

    style Q fill:#f9f,stroke:#333
    style RRF fill:#bbf,stroke:#333
    style R fill:#bfb,stroke:#333
```

**Indexing pipeline (startup + incremental):**

```mermaid
flowchart TD
    VF[Vault Files] --> RB[rebuildFromVault]
    RB --> P1[Pass 1: Index Notes\nFTS5 + metadata]
    P1 --> P2[Pass 2: Extract Links\nresolve with full path list]
    P2 --> P3[Pass 3: Embed Notes\nchunk → hash → embed → store]

    FW[File Watcher\nchokidar] --> |add/change| UP[upsertNote]
    UP --> FTS[Update FTS5]
    UP --> LK[Update Links]
    UP --> EM[embedAndStoreChunks]
    EM --> CH{Content\nhash match?}
    CH --> |unchanged| SK[Skip]
    CH --> |changed| EMB[Embed chunk\nbge-small q8]
    EMB --> VEC[Store in\nnote_vectors]

    FW --> |delete| RM[removeNote]
    RM --> D1[Delete FTS + links]
    RM --> D2[Delete chunks + vectors]

    style VF fill:#f9f,stroke:#333
    style FW fill:#f9f,stroke:#333
    style CH fill:#ffd,stroke:#333
    style SK fill:#dfd,stroke:#333
```

## MCP Prompts

Alongside tools, the server registers MCP **prompts** (`prompts/list` / `prompts/get`) in `prompt-definitions.ts`, mirroring the tool factory and registered per session in `mcp-router.ts`. Prompts are user-initiated — clients that support the `prompts/list` capability surface them via a **+** menu (Claude Desktop), slash commands (Claude Code), or similar (OpenCode, Zed); support varies by client and some (Cursor, Windsurf) currently expose tools only. Handlers assemble live vault content at invocation time over the same data layer the tools use, so there is no embedded procedure that can drift, only live content plus thin, durable instruction.

| Prompt              | Arguments             | Purpose                                                                                                                                                                                                                                                                     |
| ------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault-orientation` | —                     | Vault stats, folder note counts, property adoption rates, orphan detection, broken link count, tags, recent notes, memory outline, and contextual tool suggestions. Uses `findOrphans`, `brokenLinkCount`, `vaultStats` alongside the existing tag/property/recent queries. |
| `memory-review`     | `file?`, `max_chars?` | Structural overview (scope callouts from `listMemoryFiles`, section entry counts) + dated content as a timeline. Guided reflection: evolution narrative, scope-fit against declared scopes, backfill gaps, coverage analysis. Append-only by design.                        |
| `daily-review`      | `date?`, `max_chars?` | Daily note content + outgoing links (via `getOutgoingLinks`, with broken-link flags) + backlinks (via `getBacklinks`) + date-specific activity (via `modifiedOnDate`). Guides reconciliation, link following, and pattern recognition.                                      |

Each handler degrades to a valid message rather than throwing, so a prompt never hard-fails the client. `memory-review` is deliberately append-only: it reads dated entries as a timeline (each entry true when written), never as "newest supersedes older," and never prunes "stale" entries — matching the memory layer's design. `daily-review` uses `modifiedOnDate` instead of `recentNotes`, so past-date reviews show activity from _that_ date — not today's globally recent notes.

## Infrastructure

See `sst.config.ts` for full IaC.

### Auth: OAuth 2.1 + defense in depth

Two authentication methods, both validated at two layers:

| Method                                | Used by                                                      | Token format                | Lifetime                                    |
| ------------------------------------- | ------------------------------------------------------------ | --------------------------- | ------------------------------------------- |
| OAuth 2.1 (Authorization Code + PKCE) | Claude Desktop, Claude Code, Claude Mobile, any OAuth client | JWT (HS256)                 | 24h access, 60-day sliding refresh (SQLite) |
| Static bearer token                   | Claude Code, MCP Inspector, curl                             | Raw string (MCP_AUTH_TOKEN) | No expiry                                   |

**Layer 1 — API Gateway Lambda authorizer** (`src/functions/authorizer.ts`):
Attached to protected routes only. OAuth discovery paths (`/.well-known/*`,
`/authorize`, `/token`, `/register`, `/revoke`, `/oauth/*`, `/healthz`) are
separate unauthenticated routes in `sst.config.ts` (required by the
OAuth/MCP spec) and never invoke the Lambda. On protected routes the
authorizer validates the bearer token — accepts both the static
`MCP_AUTH_TOKEN` (via `safeEqual`) and JWT access tokens signed with it
(via `verifyJwt`). The Authorization header is the route's identity
source, so a tokenless request gets an automatic **401** from API Gateway
without invoking the Lambda — this is what lets MCP clients (Claude
Desktop/web, etc.) enter the OAuth connect flow on their first
unauthenticated probe. A Lambda deny is a fixed, uncustomizable **403**
on HTTP APIs, which MCP clients treat as a broken server rather than a
sign-in prompt.

**Layer 2 — Express middleware** (MCP SDK's `requireBearerAuth` in `server.ts`):
The OAuth provider's `verifyAccessToken()` accepts both static tokens and
JWTs. Same validation as the Lambda, independent second check.

Both layers share the same HMAC key (`MCP_AUTH_TOKEN`) for JWT verification
and `safeEqual`/`parseBearer` from `src/auth.ts`.

**OAuth flow:**

```
1. Client → GET /.well-known/oauth-protected-resource    → discover auth server
2. Client → GET /.well-known/oauth-authorization-server   → discover endpoints
3. Client → POST /register                                → dynamic client registration
4. Client → GET /authorize?...&code_challenge=...         → consent page in browser
5. User enters MCP_AUTH_TOKEN in consent page → POST /oauth/decide → redirect with auth code
6. Client → POST /token (code + code_verifier)            → JWT access token + refresh token
7. Client → POST /mcp (Authorization: Bearer <JWT>)       → MCP requests (dual-validated)
8. Token expires → POST /token (refresh_token)             → new JWT (silent, no browser)
```

**JWT payload:** `{ sub: clientId, scope: "vault", exp: <unix>, iss: "vault-cortex" }`
Signed with HMAC-SHA256 using `MCP_AUTH_TOKEN` as the key. Both the Lambda
authorizer and Express can verify independently — no shared state needed.

**Token storage:** Refresh tokens and registered clients are persisted in
SQLite (`/data/oauth.db`) — survives container restarts, no re-authentication
needed after deploys for active clients. Auth codes are in-memory (short-lived,
10 minutes). Access tokens are JWTs (stateless, no storage needed). Revoked
tokens are tracked in SQLite.

**Refresh token expiry:** 60-day sliding (inactivity) window. Each successful
use rotates the token AND extends the window by another 60 days, so a daily
client never sees expiry. A client dormant for >60 days is forced through the
full OAuth flow on its next attempt. The schema column is `expires_at INTEGER
NOT NULL`; rows past `expires_at` are deleted on read so the table self-cleans.
This bounds the blast radius of a leaked refresh token without inconveniencing
active sessions.

**Rate limiting:** OAuth endpoints (`/token`, `/register`, `/authorize`,
`/revoke`) are rate-limited at 5 req/min per client IP. A custom key
generator extracts the real client IP from API Gateway's `Forwarded` header
(express-rate-limit's built-in validators are disabled — they assume
direct-to-server traffic, not reverse-proxy deployments).

**Why both layers:** Lightsail port 8000 is publicly bound by default. If the
API Gateway authorizer is misconfigured, or someone hits the public IP
directly, Express still rejects. `/healthz` bypasses auth for docker-compose
healthchecks.

**Optional: close port 8000.** Set `ORIGIN_URL` to route API Gateway through
a tunnel or reverse proxy (e.g., Cloudflare Tunnel), then set
`MCP_PORT_CIDRS=none` to block direct access. With this configuration, bearer
tokens never travel in plaintext on any network segment — all traffic is
HTTPS end-to-end. See [`DEPLOY.md`](./DEPLOY.md#port-8000-hardening-optional).

**Optional: restrict SSH.** Set `SSH_CIDRS=none` to block public SSH and
reach the instance exclusively via a Tailscale WireGuard mesh (Tailscale
traffic bypasses the public-IP firewall). See
[`DEPLOY.md`](./DEPLOY.md#ssh-hardening-with-tailscale-optional).

**Optional: custom domain.** Set `CUSTOM_DOMAIN` + `CUSTOM_DOMAIN_CERT_ARN`
to serve the API Gateway on your own hostname instead of the auto-generated
execute-api URL (which stays active alongside it). The ACM cert and DNS
records are managed outside SST — any DNS provider works. See
[`DEPLOY.md`](./DEPLOY.md#custom-domain-optional).

**Rotation:** Update the SST secret AND the Lightsail `.env`, then redeploy
both. Existing JWTs signed with the old key become invalid immediately.
Refresh tokens in SQLite are unaffected — clients silently get new JWTs
signed with the new key on their next token refresh.

### Docker Compose: startup sequence

Two services run in order via `depends_on`:

1. **`obsidian-sync`** — bidirectional Obsidian Sync. Stores sync state in
   the config volume at `/home/obsidian/.config` (persists across restarts
   for incremental sync — critical for Phase 2 embedding ingestion). The
   forked sync image owns `/home/obsidian/.config` as `obsidian:obsidian`
   at build time, so named-volume mounts are writable by UID 1000 without a
   separate init container.
2. **`vault-mcp`** — MCP server. Runs as the `node` user (UID 1000),
   matching obsidian-sync's `PUID` so both containers can read/write the
   shared `/vault` volume. On startup: builds the FTS5 search index,
   bootstraps memory templates if the memory folder doesn't exist and
   `MEMORY_ENABLED` is not `false`, then starts the file watcher.

`depends_on` uses `condition: service_healthy`, so vault-mcp waits for
obsidian-sync's healthcheck to pass before starting — not merely for the
container to be created. This matters on a fresh volume: it keeps the memory
bootstrap from racing the first sync and writing skeleton templates over files
that are about to arrive from the cloud. The healthcheck verifies the `ob sync`
process is running and `/vault` exists (`pgrep -f 'ob sync'`), not that the
initial sync has _completed_ — so the guarantee is "sync is up and has had its
`start_period` to land files", not "sync is finished". Combined with the
memory-write shrink guard, that's enough to prevent the fresh-volume clobber.

### Durability

Four layers cover different failure classes:

| Layer                                 | What it does                                                                                                                | Where                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| App-level `removal: "retain"`         | Blocks `sst remove` from destroying the stack                                                                               | `sst.config.ts` `app()`       |
| Resource-level `protect: true`        | Refuses any Pulumi op that would destroy or replace the Instance                                                            | `sst.config.ts` instance opts |
| Resource-level `retainOnDelete: true` | If SST does decide to delete (stage rename), orphan the AWS resource instead of destroying                                  | `sst.config.ts` instance opts |
| Lightsail auto-snapshot (`addOn`)     | Daily disk image at 03:00 UTC, 7-day rolling retention. Captures the full boot disk including ad-hoc SSH-installed packages | `addOn` on the Instance       |

The auto-snapshot is the only one that protects against AWS-side events
(hardware failure, AZ outage) and against in-VM mistakes (fat-finger
`rm -rf`, container compromise). The IaC seatbelts only protect against
Pulumi-driven replacement.

Restore procedures, the intentional-replace flow (unprotect → deploy →
re-protect, e.g. for a Phase 2 bundle upgrade), SST state reconciliation,
and auth implications post-restore live in [`RECOVERY.md`](./RECOVERY.md).

## Cost

| Component                          | Phase 1                                    | Phase 2       |
| ---------------------------------- | ------------------------------------------ | ------------- |
| Lightsail                          | $12/mo (2 GB)                              | $24/mo (4 GB) |
| Lightsail auto-snapshots           | ~$0.50–1.50/mo (used disk × 7d × $0.05/GB) | same          |
| API Gateway                        | ~$0                                        | ~$0           |
| Obsidian Sync                      | existing                                   | same          |
| Local embeddings (in-process ONNX) | —                                          | $0 (no API)   |
| **Total**                          | **~$13/mo**                                | **~$25/mo**   |

## Key Decisions

| Decision                            | Rationale                                                                                                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lightsail over ECS                  | $12 vs ~$50+. Single-user server.                                                                                                                                                                                                                              |
| API Gateway over Caddy              | Free HTTPS URL without a custom domain, SST native, and a Lambda authorizer for path-aware auth (OAuth endpoints pass through, `/mcp` validates). Tradeoff: 10-minute idle timeout on HTTP connections can cause `Connection closed` on first call after idle. |
| Obsidian Sync over git-based sync   | Bidirectional real-time sync to all devices, automatic conflict resolution, no manual push/pull. Tradeoff: dependency on Obsidian's proprietary cloud service.                                                                                                 |
| Forked obsidian-headless-sync       | Upstream image lacked `DEVICE_NAME` support and had config-dir ownership issues. Fork adds both — `--device-name` parameter and `chown` at build time — so named-volume mounts work without an init container.                                                 |
| OAuth 2.1 + static token            | OAuth for all clients. Static bearer token as CLI alternative.                                                                                                                                                                                                 |
| Custom JWT over jose                | 50-line HS256 implementation vs 200KB+ jose bundle. Lambda authorizer stays tiny. Constant-time comparison prevents timing attacks. Acceptable for a single-algorithm use case.                                                                                |
| JWT over opaque tokens              | Verifiable at Lambda edge without shared state. HS256 with MCP_AUTH_TOKEN.                                                                                                                                                                                     |
| 60-day sliding refresh              | Active clients never re-auth; leaked tokens bounded. Standard OAuth practice.                                                                                                                                                                                  |
| Auto-snapshot (`addOn`)             | Native Lightsail primitive over hand-rolled cron + S3. Daily, 7-day retention, captures full boot disk including SSH-installed state.                                                                                                                          |
| Pulumi `protect` + `retainOnDelete` | IaC seatbelt over `replaceOnChanges` gymnastics. Intentional replaces require explicit unprotect — the friction is the feature.                                                                                                                                |
| Debian slim over Alpine             | `onnxruntime-node` (bundled by `@huggingface/transformers` for local embeddings) requires glibc. Alpine uses musl — no musl build exists. Hard architectural constraint, not a preference.                                                                     |
| SQLite FTS5                         | Zero services, embedded, personal scale.                                                                                                                                                                                                                       |
| chokidar                            | Node-native, same process as SQLite. Phase 2: adds embedding hook.                                                                                                                                                                                             |
| Streamable HTTP                     | Current MCP spec (2025-11-25). SSE is deprecated.                                                                                                                                                                                                              |
| GHCR over ECR                       | GITHUB_TOKEN auth, no AWS IAM for images.                                                                                                                                                                                                                      |
| Express 5 over Fastify/Hono         | Ecosystem maturity, middleware compatibility. Express 5's native async error handling eliminated wrapper boilerplate. MCP SDK reference implementation uses Express.                                                                                           |
| Atomic writes + per-file mutex      | MCP handlers are concurrent — two tools could write the same file. Write-to-tmp-then-rename prevents partial writes; per-file mutex prevents conflicting operations (fail-fast for intent-based writes, serializing for read-inside-lock writes).              |
| Factory over class                  | Functional style. Closure holds db ref, no `this`.                                                                                                                                                                                                             |
| `type` over `interface`             | Preferred unless `interface` specifically required.                                                                                                                                                                                                            |

/**
 * MCP server entry point.
 *
 * Sets up Express with the MCP SDK's StreamableHTTPServerTransport.
 * Each MCP session gets its own transport instance, tracked by the
 * Mcp-Session-Id header that the SDK manages automatically.
 *
 * Routes:
 *   POST   /mcp      — client → server messages (tool calls, etc)
 *   GET    /mcp      — SSE channel for server → client notifications
 *   DELETE /mcp      — session termination
 *   GET    /healthz  — health check for Docker Compose (no auth)
 *
 * ── Auth (defense in depth) ────────────────────────────────────
 * The Lambda authorizer in src/functions/authorizer.ts validates
 * the bearer token at the API Gateway edge. This server ALSO
 * validates the same token via the requireBearerToken middleware
 * below — Swiss-cheese defense so that if API Gateway is bypassed
 * (misconfiguration, direct connection to the Lightsail public IP,
 * etc) the server still rejects unauthenticated requests.
 *
 * The same MCP_AUTH_TOKEN secret is provisioned in two places:
 *   - SST secret McpAuthToken → Lambda authorizer env
 *   - Lightsail .env MCP_AUTH_TOKEN → vault-mcp container env
 * Rotation is a two-step flip (SST secret + Lightsail .env redeploy).
 *
 * Wiring:
 *   - Creates a SearchIndex (search-index.ts) on startup
 *   - Runs a full reindex of the vault
 *   - Starts the file watcher to keep the index current
 *   - Passes the index + vault path into each MCP session's tools
 */

// TODO: implement — see ARCHITECTURE.md for the full design
//
// Key imports needed:
//   express, randomUUID from "node:crypto"
//   timingSafeEqual from "node:crypto"
//   McpServer from "@modelcontextprotocol/sdk/server/mcp.js"
//   StreamableHTTPServerTransport from "@modelcontextprotocol/sdk/server/streamableHttp.js"
//   isInitializeRequest from "@modelcontextprotocol/sdk/types.js"
//   createSearchIndex from "./search-index.js"
//   registerTools from "./tool-definitions.js"
//   startFileWatcher from "./file-watcher.js"

/**
 * Express middleware: require a valid Bearer token on every request
 * except `/healthz`. Mirrors the constant-time-compare pattern from
 * src/functions/authorizer.ts so both layers behave identically.
 *
 * Reads the expected token from process.env.MCP_AUTH_TOKEN at startup
 * (fail-fast if missing — refuse to boot rather than serve unauth'd).
 *
 * Example wiring (in app setup):
 *   app.get("/healthz", (_req, res) => res.json({ ok: true }));
 *   app.use(requireBearerToken);  // applies to /mcp routes only
 *   app.post("/mcp", ...);
 *
 * Example reject (missing header):
 *   POST /mcp  →  401 { error: "missing or malformed Authorization" }
 *
 * Example reject (token mismatch):
 *   POST /mcp Authorization: Bearer wrong  →  401 { error: "invalid token" }
 *
 * Example accept:
 *   POST /mcp Authorization: Bearer <valid>  →  passes through
 */
// TODO: implement requireBearerToken middleware
// - Read MCP_AUTH_TOKEN from process.env at module load; throw if absent
// - Parse `Authorization: Bearer <token>` (case-insensitive header lookup;
//   Express lowercases headers but be defensive)
// - timingSafeEqual against the expected token (handle length-mismatch
//   without leaking via early return — see authorizer.ts safeEqual)
// - On reject: res.status(401).json({ error: "..." }); console.warn(...)
// - On accept: next()
// - DO NOT log the token value, even on reject

export {}

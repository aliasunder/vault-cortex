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
 *   GET    /healthz  — health check for Docker Compose
 *
 * Auth is handled upstream by API Gateway's Lambda authorizer.
 * This server trusts all requests that reach it on :8000.
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
//   McpServer from "@modelcontextprotocol/sdk/server/mcp.js"
//   StreamableHTTPServerTransport from "@modelcontextprotocol/sdk/server/streamableHttp.js"
//   isInitializeRequest from "@modelcontextprotocol/sdk/types.js"
//   createSearchIndex from "./search-index.js"
//   registerTools from "./tool-definitions.js"
//   startFileWatcher from "./file-watcher.js"

export {};

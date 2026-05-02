/**
 * MCP server entry point.
 *
 * Express app exposing the MCP streamable-http transport:
 *   - POST   /mcp  — client -> server messages
 *   - GET    /mcp  — SSE channel for server -> client notifications
 *   - DELETE /mcp  — session termination
 *   - GET    /healthz — health check for Docker
 *
 * Auth is handled upstream by API Gateway's Lambda authorizer.
 * This server trusts all requests that reach it.
 *
 * One transport per session, tracked by Mcp-Session-Id header.
 * The MCP SDK manages session lifecycle automatically.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";
import { createSearchIndex } from "./search.js";
import { startWatcher } from "./watcher.js";

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || "0.0.0.0";
const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const INDEX_DB_PATH = process.env.INDEX_DB_PATH || "/data/index.db";

// ── Initialize ─────────────────────────────────────────────────────
const search = createSearchIndex(INDEX_DB_PATH);
await search.reindex(VAULT_PATH);
startWatcher(VAULT_PATH, search);

// ── MCP server factory ─────────────────────────────────────────────
// Each MCP session gets its own McpServer instance. The factory
// wires the shared search index and vault path into every session.
const createMcp = (): McpServer => {
  const server = new McpServer(
    { name: "vault-cortex", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  registerTools(server, VAULT_PATH, search);
  return server;
};

// ── Express ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Session map: Mcp-Session-Id -> transport
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Existing session — reuse transport
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session — create transport + wire up MCP server
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    await createMcp().connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE for server-initiated notifications on existing session
app.get("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !transports[sid]) {
    res.status(400).send("Invalid session");
    return;
  }
  await transports[sid].handleRequest(req, res);
});

// DELETE /mcp — session teardown
app.delete("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !transports[sid]) {
    res.status(400).send("Invalid session");
    return;
  }
  await transports[sid].handleRequest(req, res);
});

// Health check for Docker Compose healthcheck directive
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", vault: VAULT_PATH });
});

app.listen(PORT, HOST, () => {
  console.log(`vault-cortex MCP server listening on ${HOST}:${PORT}`);
  console.log(`Vault: ${VAULT_PATH} | Index: ${INDEX_DB_PATH}`);
});

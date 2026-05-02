/**
 * MCP server entry point.
 *
 * Express app with:
 *   - POST /mcp  — MCP streamable-http endpoint (client → server)
 *   - GET  /mcp  — SSE channel for server → client notifications
 *   - DELETE /mcp — session termination
 *   - GET /healthz — health check for Docker + monitoring
 *
 * The MCP SDK's StreamableHTTPServerTransport handles the protocol.
 * We create one transport per session (tracked by Mcp-Session-Id header).
 *
 * Auth is handled upstream by API Gateway's Lambda authorizer —
 * this server trusts all requests that reach it.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";
import { VaultSearch } from "./search.js";
import { startWatcher } from "./watcher.js";

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || "0.0.0.0";
const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const INDEX_DB_PATH = process.env.INDEX_DB_PATH || "/data/index.db";

// -- Initialize services ------------------------------------------------
const search = new VaultSearch(INDEX_DB_PATH);

// Build FTS5 index from vault on startup, then watch for changes
await search.reindex(VAULT_PATH);
startWatcher(VAULT_PATH, search);

// -- MCP server factory -------------------------------------------------
function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "vault-cortex", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  registerTools(server, VAULT_PATH, search);
  return server;
}

// -- Express app --------------------------------------------------------
const app = express();
app.use(express.json());

// Session tracking for stateful MCP connections
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = createMcpServer();
    await server.connect(transport);
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

// GET /mcp — SSE channel for server-initiated notifications
app.get("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !transports[sid]) {
    res.status(400).send("Invalid session");
    return;
  }
  await transports[sid].handleRequest(req, res);
});

// DELETE /mcp — session termination
app.delete("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !transports[sid]) {
    res.status(400).send("Invalid session");
    return;
  }
  await transports[sid].handleRequest(req, res);
});

// Health check for Docker Compose healthcheck
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", vault: VAULT_PATH });
});

app.listen(PORT, HOST, () => {
  console.log(`vault-cortex MCP server listening on ${HOST}:${PORT}`);
  console.log(`Vault path: ${VAULT_PATH}`);
  console.log(`Index DB: ${INDEX_DB_PATH}`);
});

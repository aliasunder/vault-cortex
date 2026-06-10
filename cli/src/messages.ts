export const buildLocalPayoff = (params: {
  targetDir: string
  token: string
  started: boolean
}): string => {
  const startLine = params.started
    ? "The server is running."
    : `Start the server:\n  cd ${params.targetDir} && docker compose up -d`

  return `${startLine}

Connect your MCP client:
  URL:        http://localhost:8000/mcp
  Auth token: ${params.token}

OAuth clients (Claude Desktop, Claude Code, most MCP clients): add
that URL as a remote MCP server — "remote" is the connection type
(HTTP); this server still runs entirely on your machine. Leave Client
ID/Secret empty — the OAuth consent page opens in your browser;
approve with the token above. The client then holds auto-refreshing
access tokens, so the token never sits in client config.

Clients without OAuth, scripts, and curl send the token directly:
  curl -H "Authorization: Bearer <token>" http://localhost:8000/mcp

Note: claude.ai (web) cannot reach localhost — use Claude Desktop or
Claude Code for a local server.

Smoke test:
  curl http://localhost:8000/healthz

Full docs: https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/README.md`
}

export const buildRemotePayoff = (params: {
  targetDir: string
  token: string
  publicUrl: string
  started: boolean
  obsidianTokenMissing: boolean
}): string => {
  const startLine = params.started
    ? "The server is running."
    : params.obsidianTokenMissing
      ? `Fill in OBSIDIAN_AUTH_TOKEN in ${params.targetDir}/.env, then start the server:\n  cd ${params.targetDir} && docker compose up -d`
      : `Start the server:\n  cd ${params.targetDir} && docker compose up -d`

  return `${startLine}

Connect your MCP client:
  URL: ${params.publicUrl}/mcp

OAuth clients (Claude Desktop, Claude Code, claude.ai): add a remote MCP
server with that URL and leave Client ID/Secret empty — a consent page
opens; approve with your MCP_AUTH_TOKEN:
  ${params.token}

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access`
}

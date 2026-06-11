/**
 * Local-mode "Connect" payoff. tokenWritten distinguishes whether this run's
 * generated token actually landed in .env — when an existing .env was kept,
 * the payoff must point at the token on disk instead of one that was never
 * saved (pasting it would fail auth with no hint why). port comes from the
 * .env on disk for the same reason: a kept file may override the default.
 */
export const buildLocalPayoff = (params: {
  targetDir: string
  token: string
  started: boolean
  port: number
  tokenWritten: boolean
}): string => {
  const { targetDir, token, started, port, tokenWritten } = params

  const startLine = started
    ? "The server is running."
    : `Start the server:\n  cd ${targetDir} && docker compose up -d`

  const tokenLine = tokenWritten
    ? `Auth token: ${token}`
    : `Auth token: use the existing MCP_AUTH_TOKEN in ${targetDir}/.env`

  // Flush-left on purpose: template literals keep leading whitespace, so
  // indenting these lines would indent the rendered output.
  const payoff = `${startLine}

Connect your MCP client:
  URL:        http://localhost:${port}/mcp
  ${tokenLine}

OAuth clients (Claude Desktop, Claude Code, most MCP clients):
  1. Add the URL above as a remote MCP server, leaving Client
     ID/Secret empty ("remote" = HTTP — the server still runs on
     your machine)
  2. Approve the browser consent page with the token above
  3. Done — the client holds auto-refreshing access tokens; the
     token never sits in client config

Clients without OAuth, scripts, and curl send the token directly:
  curl -H "Authorization: Bearer <token>" http://localhost:${port}/mcp

Note: claude.ai (web) cannot reach localhost — use Claude Desktop or
Claude Code for a local server.

Smoke test:
  curl http://localhost:${port}/healthz

Full docs: https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/README.md`

  return payoff
}

/**
 * Remote-mode "Connect" payoff. See buildLocalPayoff for the tokenWritten
 * rationale; remote URLs come from PUBLIC_URL, so no port handling here.
 */
export const buildRemotePayoff = (params: {
  targetDir: string
  token: string
  publicUrl: string
  started: boolean
  obsidianTokenMissing: boolean
  tokenWritten: boolean
}): string => {
  const {
    targetDir,
    token,
    publicUrl,
    started,
    obsidianTokenMissing,
    tokenWritten,
  } = params

  const startLine = started
    ? "The server is running."
    : obsidianTokenMissing
      ? `Fill in OBSIDIAN_AUTH_TOKEN in ${targetDir}/.env, then start the server:\n  cd ${targetDir} && docker compose up -d`
      : `Start the server:\n  cd ${targetDir} && docker compose up -d`

  const approveLine = tokenWritten
    ? `approve with your MCP_AUTH_TOKEN:\n  ${token}`
    : `approve with the existing MCP_AUTH_TOKEN in ${targetDir}/.env`

  // Flush-left on purpose: template literals keep leading whitespace, so
  // indenting these lines would indent the rendered output.
  const payoff = `${startLine}

Connect your MCP client:
  URL: ${publicUrl}/mcp

OAuth clients (Claude Desktop, Claude Code, claude.ai): add a remote MCP
server with that URL and leave Client ID/Secret empty — a consent page
opens; ${approveLine}

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access`

  return payoff
}

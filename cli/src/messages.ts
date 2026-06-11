const composeUpCommand = (targetDir: string): string =>
  `cd ${targetDir} && docker compose up -d`

const startServerLine = (targetDir: string): string =>
  `Start the server:\n  ${composeUpCommand(targetDir)}`

/** Remote start line: running, blocked on the missing sync token, or ready to start. */
const remoteStartLine = (params: {
  targetDir: string
  started: boolean
  obsidianTokenMissing: boolean
}): string => {
  const { targetDir, started, obsidianTokenMissing } = params
  if (started) return "The server is running."
  if (obsidianTokenMissing) {
    return `Fill in OBSIDIAN_AUTH_TOKEN in ${targetDir}/.env, then start the server:\n  ${composeUpCommand(targetDir)}`
  }
  return startServerLine(targetDir)
}

/**
 * Local-mode "Connect" message. tokenWritten distinguishes whether this run's
 * generated token actually landed in .env — when an existing .env was kept,
 * the connect message must point at the token on disk instead of one that was never
 * saved (pasting it would fail auth with no hint why). port comes from the
 * .env on disk for the same reason: a kept file may override the default.
 */
export const buildLocalConnectMessage = (params: {
  targetDir: string
  token: string
  started: boolean
  port: number
  tokenWritten: boolean
}): string => {
  const { targetDir, token, started, port, tokenWritten } = params

  const startLine = started
    ? "The server is running."
    : startServerLine(targetDir)

  const tokenLine = tokenWritten
    ? `Auth token: ${token}`
    : `Auth token: use the existing MCP_AUTH_TOKEN in ${targetDir}/.env`

  // Flush-left on purpose: template literals keep leading whitespace, so
  // indenting these lines would indent the rendered output.
  const connectMessage = `${startLine}

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

  return connectMessage
}

/**
 * Remote-mode "Connect" message. See buildLocalConnectMessage for the tokenWritten
 * rationale; remote URLs come from PUBLIC_URL, so no port handling here.
 */
export const buildRemoteConnectMessage = (params: {
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

  const startLine = remoteStartLine({
    targetDir,
    started,
    obsidianTokenMissing,
  })

  const approveLine = tokenWritten
    ? `approve with your MCP_AUTH_TOKEN:\n  ${token}`
    : `approve with the existing MCP_AUTH_TOKEN in ${targetDir}/.env`

  // Flush-left on purpose: template literals keep leading whitespace, so
  // indenting these lines would indent the rendered output.
  const connectMessage = `${startLine}

Connect your MCP client:
  URL: ${publicUrl}/mcp

OAuth clients (Claude Desktop, Claude Code, claude.ai): add a remote MCP
server with that URL and leave Client ID/Secret empty — a consent page
opens; ${approveLine}

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access`

  return connectMessage
}

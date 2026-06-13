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

Claude Code:
  1. claude mcp add --transport http vault-cortex http://localhost:${port}/mcp
  2. Approve the browser consent page with the token above
  3. Done. The client holds auto-refreshing access tokens; the
     token never sits in client config

Claude Desktop only accepts https URLs in its connector dialog, so
register the server in claude_desktop_config.json via the mcp-remote
bridge instead:
  "vault-cortex": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "http://localhost:${port}/mcp",
      "--header", "Authorization: Bearer <token above>"]
  }

Other OAuth clients (Cursor, most MCP clients) add the URL above as a
remote MCP server, leaving Client ID/Secret empty ("remote" = HTTP —
the server still runs on your machine), then approve the consent page.

Clients without OAuth, scripts, and curl send the token directly:
  curl -H "Authorization: Bearer <token>" http://localhost:${port}/mcp

Note: claude.ai (web) cannot reach localhost — use Claude Code for local
access, or Claude Desktop with the mcp-remote bridge.

Smoke test:
  curl http://localhost:${port}/healthz

Optional settings (timezone, memory folder, port, logging) are commented
out in ${targetDir}/.env — uncomment, set a value, then apply with
"docker compose up -d" (restart alone does not re-read .env).

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

  const httpUrlWarning = publicUrl.startsWith("https://")
    ? ""
    : `

Note: claude.ai and Claude Desktop only accept https URLs — set up
HTTPS when you're ready for those clients (see the HTTPS section in
the remote guide). Claude Code works with http:
  claude mcp add --transport http vault-cortex ${publicUrl}/mcp`

  // Flush-left on purpose: template literals keep leading whitespace, so
  // indenting these lines would indent the rendered output.
  const connectMessage = `${startLine}

Connect your MCP client:
  URL: ${publicUrl}/mcp

OAuth clients (Claude Desktop, Claude Code, claude.ai): add a remote MCP
server with that URL and leave Client ID/Secret empty — a consent page
opens; ${approveLine}${httpUrlWarning}

Optional settings (timezone, memory folder, port, logging, sync
behavior) are commented out in ${targetDir}/.env — uncomment, set a
value, then apply with "docker compose up -d" (restart alone does not
re-read .env).

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access`

  return connectMessage
}

import { styleText } from "node:util"

// Connect instructions are printed as plain text (not a clack note box) so the
// terminal soft-wraps long commands instead of hard-wrapping them behind a
// "│ " border. A boxed command can't be copied without dragging in the border
// characters, which then break the paste in a shell. Styling here is
// display-only: ANSI escape codes are never part of a terminal text selection,
// so a colored URL or token still copies clean.
type TextStyle = Parameters<typeof styleText>[0]

// Strip styling when stdout isn't a color TTY (piped output, NO_COLOR, CI) so
// captured/redirected output stays plain — no stray escape codes in copied
// commands or logs.
const paint = (style: TextStyle, text: string): string =>
  process.stdout.isTTY && !process.env.NO_COLOR ? styleText(style, text) : text

// Section header that replaces the old clack note box: a bold title over a
// dim rule. The rule is its own line (not a per-line prefix), so it never
// touches a copyable command.
const connectHeader = (): string =>
  `${paint("bold", "Connect")}\n${paint("dim", "─".repeat(56))}`

// The displayed URL already includes the server's /mcp endpoint path. A
// client (or a user) that appends /mcp a second time produces /mcp/mcp, which
// 404s — called out in both connect messages so the URL is pasted as-is.
const mcpPathNote =
  "The URL above already ends in /mcp — paste it exactly. Adding /mcp\nagain (yourself or in a client field) makes /mcp/mcp and won't connect."

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
 * Auth-token block shared by both modes. tokenWritten distinguishes whether
 * this run's generated token actually landed in .env — when an existing .env
 * was kept, the connect message must point at the token on disk instead of one
 * that was never saved (pasting it would fail auth with no hint why). When the
 * token was written, it goes alone on its own line so selecting that line
 * copies just the token — no "Auth token: " prefix to trim.
 */
const tokenBlock = (params: {
  targetDir: string
  token: string
  tokenWritten: boolean
}): string => {
  const { targetDir, token, tokenWritten } = params
  return tokenWritten
    ? `${paint("dim", "Auth token:")}\n  ${paint("cyan", token)}`
    : `${paint("dim", "Auth token:")} use the existing MCP_AUTH_TOKEN in ${targetDir}/.env`
}

/**
 * Local-mode "Connect" message. port comes from the .env on disk: a kept file
 * may override the default, so the message must describe the server that will
 * actually run.
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

  const tokenLine = tokenBlock({ targetDir, token, tokenWritten })

  // Flush-left on purpose: this is printed as plain text (see paint), so
  // leading whitespace would render as literal indentation.
  const connectMessage = `${connectHeader()}

${startLine}

Connect your MCP client:
  ${paint("dim", "URL:")}        ${paint("cyan", `http://localhost:${port}/mcp`)}
  ${tokenLine}

${mcpPathNote}

Claude Code:
  1. claude mcp add --scope user --transport http vault-cortex http://localhost:${port}/mcp
     (--scope user registers it for every project; drop it to scope
     the server to the current directory only)
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
 * Remote-mode "Connect" message. See buildLocalConnectMessage for the
 * tokenWritten rationale; remote URLs come from PUBLIC_URL, so no port
 * handling here.
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

  const tokenLine = tokenBlock({ targetDir, token, tokenWritten })

  // Only Claude Code accepts an http URL in its connector flow; claude.ai and
  // Claude Desktop require https. The warning rides under the OAuth section so
  // it caveats the client list right where it's read.
  const httpUrlWarning = publicUrl.startsWith("https://")
    ? ""
    : `

Using an http URL? claude.ai and Claude Desktop only accept https URLs —
set up HTTPS for those (see "For HTTPS options" below). Claude Code works
with http:
  claude mcp add --scope user --transport http vault-cortex ${publicUrl}/mcp`

  // Flush-left on purpose: this is printed as plain text (see paint), so
  // leading whitespace would render as literal indentation.
  const connectMessage = `${connectHeader()}

${startLine}

Connect your MCP client:
  ${paint("dim", "URL:")}        ${paint("cyan", `${publicUrl}/mcp`)}
  ${tokenLine}

${mcpPathNote}

OAuth clients (Claude Code, Claude Desktop, claude.ai, Cursor):
  Add the URL above as a remote MCP server, leaving Client ID/Secret
  empty, then approve the consent page with the auth token above. The
  client holds auto-refreshing access tokens; the token never sits in
  client config.${httpUrlWarning}

Clients without OAuth, scripts, and curl send the token directly:
  curl -H "Authorization: Bearer <token>" ${publicUrl}/mcp

Smoke test:
  curl ${publicUrl}/healthz

Optional settings (timezone, memory folder, port, logging, sync
behavior) are commented out in ${targetDir}/.env — uncomment, set a
value, then apply with "docker compose up -d" (restart alone does not
re-read .env).

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access`

  return connectMessage
}

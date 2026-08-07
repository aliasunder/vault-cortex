import { styleText } from "node:util"

// Connect instructions are printed as plain text (not a clack note box) so the
// terminal soft-wraps long commands instead of hard-wrapping them behind a
// "│ " border. A boxed command can't be copied without dragging in the border
// characters, which then break the paste in a shell. Styling here is
// display-only: ANSI escape codes are never part of a terminal text selection,
// so a colored URL or token still copies clean.
type TextStyle = Parameters<typeof styleText>[0]

// Strip styling when stdout isn't a color TTY (piped output, CI) or NO_COLOR
// is set (any value, including empty — per the NO_COLOR spec) so
// captured/redirected output stays plain — no stray escape codes in copied
// commands or logs.
const paint = (style: TextStyle, text: string): string =>
  process.stdout.isTTY && !("NO_COLOR" in process.env)
    ? styleText(style, text)
    : text

const RULE_WIDTH = 56

const topRule = (label: string): string =>
  paint(
    "dim",
    `╭── ${label} ${"─".repeat(Math.max(0, RULE_WIDTH - label.length - 6))}╮`,
  )

const bottomRule = (): string => paint("dim", `╰${"─".repeat(RULE_WIDTH - 2)}╯`)

const sectionRule = (label: string): string =>
  paint(
    "dim",
    `── ${label} ${"─".repeat(Math.max(0, RULE_WIDTH - label.length - 4))}`,
  )

/**
 * Daemon-stopped guidance shared by every command that needs the container
 * runtime. `nextStep` finishes the message per command — appended verbatim
 * (".", " and try again.", or a ", then run:" continuation).
 */
export const buildDaemonNotRunningMessage = (nextStep: string): string =>
  "Container runtime not running — start Docker Desktop, Colima,\n" +
  `OrbStack, or another Docker-compatible runtime${nextStep}`

/**
 * Per-platform install pointer — a docs link only, no install method
 * suggestions: the CLI doesn't install anything, so the official docs (which
 * cover every method) are the hand-off. Peers are named in the message above
 * this line.
 */
const dockerInstallLine = (platform: NodeJS.Platform): string => {
  if (platform === "darwin" || platform === "win32") {
    return "Install Docker Desktop: https://docs.docker.com/get-docker/"
  }
  return "Install Docker Engine: https://docs.docker.com/engine/install/"
}

/**
 * "No runtime at all" guidance — distinct from the daemon-stopped message so
 * the user isn't told to start something that isn't installed. platform is a
 * defaulted param (mirroring buildObsidianLoginArgs) so each branch stays
 * testable; `nextStep` is appended verbatim, as in
 * buildDaemonNotRunningMessage.
 */
export const buildDockerNotInstalledMessage = (params: {
  nextStep: string
  platform?: NodeJS.Platform
}): string => {
  const { nextStep, platform = process.platform } = params
  return (
    "No container runtime found — the server runs in Docker, so you need\n" +
    "Docker or a Docker-compatible runtime (OrbStack, Colima, Podman).\n" +
    `${dockerInstallLine(platform)}${nextStep}`
  )
}

// targetDir is quoted: these lines are meant to be copy-pasted into a
// shell, and an unquoted path breaks on spaces or special characters.
const upgradeCommand = (targetDir: string): string =>
  `npx vault-cortex@latest upgrade --dir "${targetDir}"`

// Start guidance prints `start`, not `upgrade` — telling a user who has never
// started anything to run "upgrade" reads as updating something they don't
// have. `start` runs the same re-create cycle and pulls the image on demand.
export const startCommand = (targetDir: string): string =>
  `npx vault-cortex@latest start --dir "${targetDir}"`

const startServerLine = (targetDir: string): string =>
  `Start the server:\n  ${startCommand(targetDir)}`

/** Remote start line: running, blocked on the missing sync token, or ready to start. */
const remoteStartLine = (params: {
  targetDir: string
  started: boolean
  obsidianTokenMissing: boolean
}): string => {
  const { targetDir, started, obsidianTokenMissing } = params
  if (started) return "The server is running."
  if (obsidianTokenMissing) {
    return `Fill in OBSIDIAN_AUTH_TOKEN in ${targetDir}/.env, then start the server:\n  ${startCommand(targetDir)}`
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

// ── Shared connect-message blocks ───────────────────────────────────────────
// Both modes print the same skeleton; only the URL and the bits the topology
// forces apart (start line, the Claude-apps caveat, optional-settings list,
// docs link) differ. Sharing these blocks keeps the two messages in lockstep.
// `mcpUrl` is the full endpoint (`<base>/mcp`); `healthUrl` is `<base>/healthz`.

const connectUrlBlock = (mcpUrl: string, tokenLine: string): string =>
  `Connect your MCP client:
  ${paint("dim", "URL:")}        ${paint("cyan", mcpUrl)}
  ${tokenLine}`

// OAuth connect instruction + the Claude Code walkthrough — shared by every
// variant. You register the server by its URL however your MCP client allows:
// a CLI (`claude mcp add`, `opencode mcp add`), a connector dialog, or a
// config file — then approve the consent page. Claude Code is the worked
// example. The per-mode caveats (which clients need https, the localhost
// bridge) are appended by the builders.
const connectGuidance = (mcpUrl: string): string =>
  `Add the URL above as a remote MCP server (leave Client ID/Secret empty),
then approve the consent page with the token. For example, Claude Code:
  1. claude mcp add --scope user --transport http vault-cortex ${mcpUrl}
  2. approve the browser consent page with the token above
  3. done — the client holds auto-refreshing access tokens; the token
     never sits in client config`

const curlGuidance = (mcpUrl: string): string =>
  `Clients without OAuth, scripts, and curl send the token directly:
  curl -H "Authorization: Bearer <token>" ${mcpUrl}`

const smokeTest = (healthUrl: string): string =>
  `Smoke test:
  curl ${healthUrl}`

/**
 * Remote health-check block. Started: the CLI verified localhost on the VPS,
 * but the public URL is a different check (ingress — DNS, TLS, proxy), so the
 * command stays, reworded as the works-from-any-device check. Not started:
 * the plain smoke test to run after starting.
 */
const remoteHealthCheckBlock = (
  healthUrl: string,
  started: boolean,
): string => {
  if (started) {
    return `Health check — works from any device that can reach the URL:
  curl ${healthUrl}`
  }
  return smokeTest(healthUrl)
}

const updateGuidance = (targetDir: string): string =>
  `Update to the latest release:
  ${upgradeCommand(targetDir)}`

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

  const baseUrl = `http://localhost:${port}`

  const startLine = started
    ? "The server is running."
    : startServerLine(targetDir)

  const tokenLine = tokenBlock({ targetDir, token, tokenWritten })

  // Once the server is confirmed up, the smoke test is dropped — the CLI just
  // verified this exact URL, so re-printing it reads as leftover homework.
  // Assembled as a filtered list so the omission leaves no stray blank line.
  const nonOauthBlocks = [
    curlGuidance(`${baseUrl}/mcp`),
    started ? undefined : smokeTest(`${baseUrl}/healthz`),
  ]
    .filter(Boolean)
    .join("\n\n")

  // Flush-left on purpose: this is printed as plain text (see paint), so
  // leading whitespace would render as literal indentation. Local is always
  // localhost http, so it shares the http guidance; its only divergences are
  // that claude.ai can't reach localhost at all and Claude Desktop needs the
  // mcp-remote bridge (the dialog rejects http, but mcp-remote exempts
  // localhost, so no --allow-http).
  const connectMessage = `${topRule("Connect")}

${startLine}

${sectionRule("MCP client")}

${connectUrlBlock(`${baseUrl}/mcp`, tokenLine)}

${connectGuidance(`${baseUrl}/mcp`)}

Other clients (opencode, Cursor, …) take the URL above too. claude.ai
(web) can't reach localhost — connect from a client on this machine.
Claude Desktop only accepts https URLs in its connector dialog, so bridge
it with mcp-remote:
  "vault-cortex": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "${baseUrl}/mcp",
      "--header", "Authorization: Bearer <token above>"]
  }

${sectionRule("Non-OAuth")}

${nonOauthBlocks}

${sectionRule("Settings")}

Adjust optional settings (memory layer and folder, file tools,
semantic search, port, timezone):
  npx vault-cortex@latest configure --dir "${targetDir}"

Or edit ${targetDir}/.env directly — change a value (uncommenting it
first if needed), then apply with "npx vault-cortex@latest restart" (plain
docker restart does not re-read .env).

${updateGuidance(targetDir)}

Full docs: https://github.com/aliasunder/vault-cortex

${bottomRule()}`

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

  // Both branches share the connect walkthrough; only the caveat differs. Over
  // https every client converges — nothing to set up. Over http the Claude
  // apps' connector dialog needs TLS while other clients are fine. We already
  // know which case it is, so the http branch states it rather than asking.
  // Case-insensitive: askPublicUrl stores the scheme as typed, so an HTTPS://
  // input is valid and must still route to the https branch.
  const isHttps = publicUrl.toLowerCase().startsWith("https://")
  const clientGuidance = isHttps
    ? `${connectGuidance(`${publicUrl}/mcp`)}

Reachable over https from any MCP client — Claude Desktop, claude.ai (web
and mobile), opencode, Cursor — from any device.`
    : `${connectGuidance(`${publicUrl}/mcp`)}

Other clients (opencode, Cursor, …) work over http too. claude.ai and
Claude Desktop only accept https URLs — set up HTTPS for those clients
(see the HTTPS section in the remote guide).`

  // Flush-left on purpose: this is printed as plain text (see paint), so
  // leading whitespace would render as literal indentation.
  const connectMessage = `${topRule("Connect")}

${startLine}

${sectionRule("MCP client")}

${connectUrlBlock(`${publicUrl}/mcp`, tokenLine)}

${clientGuidance}

${sectionRule("Non-OAuth")}

${curlGuidance(`${publicUrl}/mcp`)}

${remoteHealthCheckBlock(`${publicUrl}/healthz`, started)}

${sectionRule("Settings")}

Adjust optional settings (memory layer and folder, file tools,
semantic search, port, timezone, sync direction):
  npx vault-cortex@latest configure --dir "${targetDir}"

Or edit ${targetDir}/.env directly — change a value (uncommenting it
first if needed), then apply with "npx vault-cortex@latest restart" (plain
docker restart does not re-read .env).

${updateGuidance(targetDir)}

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access

${bottomRule()}`

  return connectMessage
}

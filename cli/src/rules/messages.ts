import { styleText } from "node:util"

import type { DaemonStatus } from "../adapters/docker.js"

export type StartStatus = "running" | "starting" | "not-started"

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
  process.stdout.isTTY && !("NO_COLOR" in process.env) ? styleText(style, text) : text

// The connect message is framed by a top and a bottom rule only. With no side
// border, every line between them still copies clean. 56 columns keeps a rule
// inside an 80-column terminal.
const RULE_WIDTH = 56

const topRule = (label: string): string => {
  const labelPart = `╭── ${label} `
  const fillWidth = Math.max(0, RULE_WIDTH - labelPart.length - "╮".length)
  return paint("dim", `${labelPart}${"─".repeat(fillWidth)}╮`)
}

const bottomRule = (): string => paint("dim", `╰${"─".repeat(RULE_WIDTH - "╰╯".length)}╯`)

const sectionRule = (label: string): string => {
  const labelPart = `── ${label} `
  const fillWidth = Math.max(0, RULE_WIDTH - labelPart.length)
  return paint("dim", `${labelPart}${"─".repeat(fillWidth)}`)
}

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
 * The guidance for a container runtime that is stopped or absent:
 * - a missing runtime gets install guidance rather than an instruction to
 *   start something that isn't installed;
 * - with a start command, the message ends by telling the user to run it once
 *   the runtime is up; without one, it ends at the guidance;
 * - platform is a defaulted param so each platform's install line is testable.
 */
export const buildDaemonUnavailableMessage = (params: {
  daemonStatus: Exclude<DaemonStatus, "running">
  startCommand?: string
  platform?: NodeJS.Platform
}): string => {
  const { daemonStatus, startCommand, platform = process.platform } = params

  switch (daemonStatus) {
    case "not-installed": {
      const nextStep = startCommand ? `\nThen start the server with:\n  ${startCommand}` : ""
      return (
        "No container runtime found — the server runs in Docker, so you need\n" +
        "Docker or a Docker-compatible runtime (OrbStack, Colima, Podman).\n" +
        `${dockerInstallLine(platform)}${nextStep}`
      )
    }
    case "not-running": {
      const nextStep = startCommand ? `, then run:\n  ${startCommand}` : "."
      return (
        "Container runtime not running — start Docker Desktop, Colima,\n" +
        `OrbStack, or another Docker-compatible runtime${nextStep}`
      )
    }
  }
}

/**
 * The short warning configure gives when its settings are saved but no
 * runtime is up to apply them. The command it points at prints the full
 * install or start guidance when run.
 */
export const buildSettingsSavedWithoutRuntimeMessage = (params: {
  daemonStatus: Exclude<DaemonStatus, "running">
  restartHint: string
}): string => {
  const { daemonStatus, restartHint } = params

  switch (daemonStatus) {
    case "not-installed":
      return `No container runtime found — settings saved.\n${restartHint}`
    case "not-running":
      return `Container runtime not running — settings saved.\n${restartHint}`
  }
}

type CliCommand = "init" | "start" | "restart" | "configure" | "upgrade" | "down" | "get-sync-token"

/**
 * The command line a message tells the user to run, pinned to the latest
 * release. targetDir is quoted: these lines are meant to be copy-pasted into
 * a shell, and an unquoted path breaks on spaces or on characters such as `&` and `*`.
 */
export const vaultCortexCommand = (command: CliCommand, targetDir?: string): string => {
  const dirOption = targetDir ? ` --dir "${targetDir}"` : ""
  return `npx vault-cortex@latest ${command}${dirOption}`
}

/** A problem in a .env value, with where to fix it. */
export const describeEnvFix = (params: { problem: string; targetDir: string }): string => {
  return `${params.problem} Fix it in ${params.targetDir}/.env.`
}

export const buildContainerRemovalFailedMessage = (instanceName: string): string => {
  return `Could not remove the container — check: docker rm -f ${instanceName}`
}

// Start guidance prints `start`, not `upgrade` — telling a user who has never
// started anything to run "upgrade" reads as updating something they don't
// have. `start` runs the same re-create cycle and pulls the image on demand.
export const startServerLine = (targetDir: string): string => {
  return `Start the server:\n  ${vaultCortexCommand("start", targetDir)}`
}

const startingInBackgroundLine = (instanceName: string): string =>
  `The server is starting in the background — check progress:\n  docker logs ${instanceName}`

const startStatusLine = (params: {
  startStatus: StartStatus
  instanceName: string
  targetDir: string
}): string => {
  const { startStatus, instanceName, targetDir } = params

  switch (startStatus) {
    case "running":
      return "The server is running."
    case "starting":
      return startingInBackgroundLine(instanceName)
    case "not-started":
      return startServerLine(targetDir)
  }
}

const isHttpsUrl = (url: string): boolean => url.toLowerCase().startsWith("https://")

/**
 * Without a Sync token in .env, a container that has never signed in serves
 * its sign-in page at PUBLIC_URL; one that signed in there before keeps that
 * login. The page asks for the MCP auth token and the Obsidian password.
 */
const syncSignInLines = (publicUrl: string): string => {
  const signInLines =
    "Until it's signed in to Obsidian Sync, it shows a sign-in page instead of\n" +
    `syncing. Open the page:\n  ${publicUrl}\n` +
    "It asks for the auth token below and your Obsidian password."

  if (isHttpsUrl(publicUrl)) return signInLines
  return `${signInLines}\nSet up HTTPS first: the page sends your Obsidian password to the server.`
}

/** Remote start line: running, starting, or ready to start, plus sign-in steps when .env has no Sync token. */
const remoteStartLine = (params: {
  targetDir: string
  instanceName: string
  publicUrl: string
  startStatus: StartStatus
  obsidianTokenMissing: boolean
}): string => {
  const { targetDir, instanceName, publicUrl, startStatus, obsidianTokenMissing } = params
  const statusLine = startStatusLine({ startStatus, instanceName, targetDir })

  if (!obsidianTokenMissing) return statusLine
  return `${statusLine}\n${syncSignInLines(publicUrl)}`
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
// bridge) are appended by the builders. The connector is named after the
// instance, so a second instance gets its own entry instead of replacing the first.
const connectGuidance = (mcpUrl: string, instanceName: string): string =>
  `Add the URL above as a remote MCP server (leave Client ID/Secret empty),
then approve the consent page with the token. For example, Claude Code:
  1. claude mcp add --scope user --transport http ${instanceName} ${mcpUrl}
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
 * Remote health-check block. Running or starting: the CLI verified localhost
 * on the VPS (or the container is still coming up), but the public URL is a
 * different check (ingress — DNS, TLS, proxy), so the command stays, reworded
 * as the works-from-any-device check. Not started: the plain smoke test to
 * run after starting.
 */
const remoteHealthCheckBlock = (healthUrl: string, startStatus: StartStatus): string => {
  if (startStatus === "running" || startStatus === "starting") {
    return `Health check — works from any device that can reach the URL:
  curl ${healthUrl}`
  }
  return smokeTest(healthUrl)
}

// The restart command goes on its own line: it quotes targetDir, so wrapping
// it in quotes inside a sentence would break the copy-paste.
const editEnvGuidance = (targetDir: string): string =>
  `Or edit ${targetDir}/.env directly — change a value (uncommenting it
first if needed), then apply it (plain docker restart does not re-read .env):
  ${vaultCortexCommand("restart", targetDir)}`

const updateGuidance = (targetDir: string): string =>
  `Update to the latest release:
  ${vaultCortexCommand("upgrade", targetDir)}`

/**
 * Local-mode "Connect" message. port comes from the .env on disk: a kept file
 * may override the default, so the message must describe the server that will
 * actually run.
 */
export const buildLocalConnectMessage = (params: {
  targetDir: string
  instanceName: string
  token: string
  startStatus: StartStatus
  port: number
  tokenWritten: boolean
}): string => {
  const { targetDir, instanceName, token, startStatus, port, tokenWritten } = params

  const baseUrl = `http://localhost:${port}`

  const startLine = startStatusLine({ startStatus, instanceName, targetDir })

  const tokenLine = tokenBlock({ targetDir, token, tokenWritten })

  // Once the server is confirmed up, the smoke test is dropped — the CLI just
  // verified this exact URL, so re-printing it reads as leftover homework.
  // Assembled as a filtered list so the omission leaves no stray blank line.
  const nonOauthBlocks = [
    curlGuidance(`${baseUrl}/mcp`),
    startStatus === "running" ? undefined : smokeTest(`${baseUrl}/healthz`),
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

${connectGuidance(`${baseUrl}/mcp`, instanceName)}

Other clients (opencode, Cursor, …) take the URL above too. claude.ai
(web) can't reach localhost — connect from a client on this machine.
Claude Desktop only accepts https URLs in its connector dialog, so bridge
it with mcp-remote:
  "${instanceName}": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "${baseUrl}/mcp",
      "--header", "Authorization: Bearer <token above>"]
  }

${sectionRule("Non-OAuth")}

${nonOauthBlocks}

${sectionRule("Settings")}

Adjust optional settings (memory layer and folder, daily notes
folder and format, file tools, semantic search, port, timezone):
  ${vaultCortexCommand("configure", targetDir)}

${editEnvGuidance(targetDir)}

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
  instanceName: string
  token: string
  publicUrl: string
  startStatus: StartStatus
  obsidianTokenMissing: boolean
  tokenWritten: boolean
}): string => {
  const {
    targetDir,
    instanceName,
    token,
    publicUrl,
    startStatus,
    obsidianTokenMissing,
    tokenWritten,
  } = params

  const startLine = remoteStartLine({
    targetDir,
    instanceName,
    publicUrl,
    startStatus,
    obsidianTokenMissing,
  })

  const tokenLine = tokenBlock({ targetDir, token, tokenWritten })

  // Both branches share the connect walkthrough; only the caveat differs. Over
  // https every client converges — nothing to set up. Over http the Claude
  // apps' connector dialog needs TLS while other clients are fine. We already
  // know which case it is, so the http branch states it rather than asking.
  // Case-insensitive: askPublicUrl stores the scheme as typed, so an HTTPS://
  // input is valid and must still route to the https branch.
  const clientGuidance = isHttpsUrl(publicUrl)
    ? `${connectGuidance(`${publicUrl}/mcp`, instanceName)}

Reachable over https from any MCP client — Claude Desktop, claude.ai (web
and mobile), opencode, Cursor — from any device.`
    : `${connectGuidance(`${publicUrl}/mcp`, instanceName)}

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

${remoteHealthCheckBlock(`${publicUrl}/healthz`, startStatus)}

${sectionRule("Settings")}

Adjust optional settings (memory layer and folder, daily notes
folder and format, file tools, semantic search, port, timezone,
sync direction):
  ${vaultCortexCommand("configure", targetDir)}

${editEnvGuidance(targetDir)}

${updateGuidance(targetDir)}

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access

${bottomRule()}`

  return connectMessage
}

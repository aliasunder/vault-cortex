import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

import {
  buildDaemonUnavailableMessage,
  buildLocalConnectMessage,
  buildRemoteConnectMessage,
  describeUnprintableInstallFolder,
  describeUntrustedInstallFolder,
  healthPollTimeoutMs,
  healthTimeoutMessage,
  vaultCortexCommand,
} from "../messages.js"

describe("vaultCortexCommand", () => {
  it("prints the command alone when no folder is given", () => {
    expect(vaultCortexCommand("init")).toBe("npx vault-cortex@latest init")
  })

  it("single-quotes the folder on macOS and Linux", () => {
    expect(vaultCortexCommand("restart", "/home/me/My Notes (2024)/vault-cortex", "linux")).toBe(
      "npx vault-cortex@latest restart --dir '/home/me/My Notes (2024)/vault-cortex'",
    )
  })

  it("keeps an apostrophe in a Windows folder, which double quotes keep literal", () => {
    expect(vaultCortexCommand("start", "C:\\Users\\O'Brien\\Sam’s notes", "win32")).toBe(
      `npx vault-cortex@latest start --dir "C:\\Users\\O'Brien\\Sam’s notes"`,
    )
  })

  it("double-quotes the folder on Windows, the only quoting cmd.exe understands", () => {
    expect(vaultCortexCommand("start", "C:\\Users\\me\\R&D\\vault-cortex", "win32")).toBe(
      'npx vault-cortex@latest start --dir "C:\\Users\\me\\R&D\\vault-cortex"',
    )
  })

  it.each([
    { label: "a dollar sign", folderPath: "/home/me/a$b", platform: "linux" as const },
    { label: "a backtick", folderPath: "/home/me/a`b", platform: "darwin" as const },
    { label: "a single quote", folderPath: "/home/me/Sam's vault", platform: "linux" as const },
    { label: "a double quote", folderPath: '/home/me/a"b', platform: "linux" as const },
    { label: "a curly quote", folderPath: "/home/me/Sam’s vault", platform: "darwin" as const },
    { label: "an exclamation mark", folderPath: "/home/me/a!b", platform: "linux" as const },
    {
      label: "a backslash outside Windows",
      folderPath: "/home/me/a\\b",
      platform: "linux" as const,
    },
    { label: "a control character", folderPath: "/home/me/a\u001bb", platform: "linux" as const },
    { label: "a dollar sign on Windows", folderPath: "C:\\me\\a$b", platform: "win32" as const },
    { label: "a percent sign on Windows", folderPath: "C:\\me\\a%b%", platform: "win32" as const },
    {
      label: "a curly double quote on Windows",
      folderPath: "C:\\me\\a”b",
      platform: "win32" as const,
    },
  ])(
    "prints a placeholder for a folder holding $label, which some shell would not keep literal",
    ({ folderPath, platform }) => {
      expect(vaultCortexCommand("start", folderPath, platform)).toBe(
        "npx vault-cortex@latest start --dir <install folder>",
      )
    },
  )

  it.skipIf(process.platform === "win32")("gives a POSIX shell back the exact folder", () => {
    const folderPath = "/tmp/My Notes (2024) & more #1 [x] {y} ~é, a+b=c@d:e/vault-cortex"
    const printed = vaultCortexCommand("start", folderPath, "linux")
    const quotedFolder = printed.slice(printed.indexOf("--dir ") + "--dir ".length)

    const shellOutput = execFileSync("sh", ["-c", `printf '%s' ${quotedFolder}`], {
      encoding: "utf8",
    })

    expect(shellOutput).toBe(folderPath)
  })
})

describe("describeUntrustedInstallFolder", () => {
  const targetDir = "/home/me/vault-cortex"

  it.each([
    { label: "the user's own folder", folder: { ownerUid: 501, mode: 0o40755 } },
    { label: "a folder root owns", folder: { ownerUid: 0, mode: 0o40755 } },
    { label: "a folder only its group can also change", folder: { ownerUid: 501, mode: 0o40775 } },
    { label: "a folder that does not exist yet", folder: undefined },
  ])("accepts $label", ({ folder }) => {
    expect(
      describeUntrustedInstallFolder({ targetDir, folder, trustedOwnerIds: [0, 501] }),
    ).toBeUndefined()
  })

  it("accepts any folder where files have no Unix owner", () => {
    expect(
      describeUntrustedInstallFolder({
        targetDir,
        folder: { ownerUid: 4242, mode: 0o40777 },
        trustedOwnerIds: undefined,
      }),
    ).toBeUndefined()
  })

  it("refuses a folder another user owns", () => {
    expect(
      describeUntrustedInstallFolder({
        targetDir,
        folder: { ownerUid: 4242, mode: 0o40755 },
        trustedOwnerIds: [0, 501],
      }),
    ).toBe(
      "/home/me/vault-cortex belongs to another user, and the CLI uses only an install folder that you or root own. Choose a folder of your own with --dir.",
    )
  })

  it("refuses a folder every user can change", () => {
    expect(
      describeUntrustedInstallFolder({
        targetDir,
        folder: { ownerUid: 501, mode: 0o40777 },
        trustedOwnerIds: [0, 501],
      }),
    ).toBe(
      "Every user on this machine can change /home/me/vault-cortex, so the CLI won't use it. Remove other users' write permission from it, or choose another folder with --dir.",
    )
  })
})

describe("describeUnprintableInstallFolder", () => {
  it.each([
    { label: "a carriage return", targetDir: "/home/me/notes\r" },
    { label: "an escape", targetDir: "/home/me/notes\u001b[8m" },
    { label: "a tab", targetDir: "/home/me/no\ttes" },
  ])("refuses a path holding $label", ({ targetDir }) => {
    expect(describeUnprintableInstallFolder(targetDir)).toBe(
      "The install folder's path contains a control character, which a terminal cannot show. Choose another folder with --dir.",
    )
  })

  it("accepts a path with spaces, accents and punctuation", () => {
    expect(describeUnprintableInstallFolder("/home/me/Sam's Notes (é) $1/vault-cortex")).toBe(
      undefined,
    )
  })
})

// ── Expected rules (mirrors the module-private helpers at RULE_WIDTH = 56) ────
// Tests run in non-TTY, so paint() is a no-op — these are the raw strings.

const RULE_WIDTH = 56

const expectedTopRule = (label: string): string =>
  `╭── ${label} ${"─".repeat(Math.max(0, RULE_WIDTH - label.length - 6))}╮`

const expectedBottomRule = (): string => `╰${"─".repeat(RULE_WIDTH - 2)}╯`

const expectedSectionRule = (label: string): string =>
  `── ${label} ${"─".repeat(Math.max(0, RULE_WIDTH - label.length - 4))}`

// ── Helpers ────────────────────────────────────────────────────────────────────

const localDefaults = {
  targetDir: "/home/user/vault-cortex",
  instanceName: "vault-cortex",
  token: "abc123deadbeef",
  startStatus: "not-started" as const,
  publicUrl: "http://localhost:8000",
  tokenWritten: true,
}

const remoteDefaults = {
  targetDir: "/home/user/vault-cortex",
  instanceName: "vault-cortex",
  token: "abc123deadbeef",
  publicUrl: "https://vault.example.com",
  startStatus: "not-started" as const,
  obsidianTokenMissing: false,
  tokenWritten: true,
}

// ── buildLocalConnectMessage ───────────────────────────────────────────────────

describe("buildLocalConnectMessage", () => {
  it("prints the whole connect message for a server that has not started", () => {
    const message = buildLocalConnectMessage({
      targetDir: "/home/user/vault-cortex",
      instanceName: "vault-cortex",
      token: "abc123deadbeef",
      startStatus: "not-started",
      publicUrl: "http://localhost:8123",
      tokenWritten: true,
    })

    expect(message).toBe(`${expectedTopRule("Connect")}

Start the server:
  npx vault-cortex@latest start --dir '/home/user/vault-cortex'

${expectedSectionRule("MCP client")}

Connect your MCP client:
  URL:        http://localhost:8123/mcp
  Auth token:
  abc123deadbeef

Add the URL above as a remote MCP server (leave Client ID/Secret empty),
then approve the consent page with the token. For example, Claude Code:
  1. claude mcp add --scope user --transport http vault-cortex http://localhost:8123/mcp
  2. approve the browser consent page with the token above
  3. done — the client holds auto-refreshing access tokens; the token
     never sits in client config

Other clients (opencode, Cursor, …) take the URL above too. claude.ai
and Claude Mobile can't reach a localhost or home-network address.
Claude Desktop only accepts https URLs in its connector dialog, so bridge
it with mcp-remote:
  "vault-cortex": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "http://localhost:8123/mcp",
      "--header", "Authorization: Bearer <token above>"]
  }

${expectedSectionRule("Non-OAuth")}

Clients without OAuth, scripts, and curl send the token directly:
  curl -H "Authorization: Bearer <token>" http://localhost:8123/mcp

Smoke test:
  curl http://localhost:8123/healthz

${expectedSectionRule("Settings")}

Adjust optional settings (memory layer and folder, daily notes
folder and format, file tools, read-only mode, semantic search, port,
timezone):
  npx vault-cortex@latest configure --dir '/home/user/vault-cortex'

Or edit /home/user/vault-cortex/.env directly — change a value (uncommenting it
first if needed), then apply it (plain docker restart does not re-read .env):
  npx vault-cortex@latest restart --dir '/home/user/vault-cortex'

Update to the latest release:
  npx vault-cortex@latest upgrade --dir '/home/user/vault-cortex'

Full docs: https://github.com/aliasunder/vault-cortex

${expectedBottomRule()}`)
  })

  it("wraps the output in top and bottom box-drawing rules", () => {
    const message = buildLocalConnectMessage(localDefaults)

    const lines = message.split("\n")
    expect(lines[0]).toBe(expectedTopRule("Connect"))
    expect(lines[lines.length - 1]).toBe(expectedBottomRule())
  })

  it("includes MCP client, Non-OAuth, and Settings section dividers", () => {
    const lines = buildLocalConnectMessage(localDefaults).split("\n")

    expect(lines).toContain(expectedSectionRule("MCP client"))
    expect(lines).toContain(expectedSectionRule("Non-OAuth"))
    expect(lines).toContain(expectedSectionRule("Settings"))
  })

  it("builds URLs from PUBLIC_URL's port", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      publicUrl: "http://localhost:9999",
    })

    expect(message).toContain("http://localhost:9999/mcp")
    expect(message).toContain("http://localhost:9999/healthz")
  })

  it("builds URLs from a network PUBLIC_URL instead of localhost", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      publicUrl: "http://192.168.1.20:8000",
    })

    expect(message).toContain(
      "claude mcp add --scope user --transport http vault-cortex http://192.168.1.20:8000/mcp\n",
    )
    expect(message).toContain("curl http://192.168.1.20:8000/healthz")
    expect(message).not.toContain("localhost:8000")
  })

  it("builds URLs from PUBLIC_URL's origin, dropping any path", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      publicUrl: "https://vault.home.example/base",
    })

    expect(message).toContain("curl https://vault.home.example/healthz")
    expect(message).not.toContain("/base")
  })

  it("says claude.ai and Claude Mobile can't reach a local install's address", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain(
      "claude.ai\nand Claude Mobile can't reach a localhost or home-network address.\n",
    )
  })

  it.each([
    {
      label: "localhost",
      publicUrl: "http://localhost:8000",
      bridgeArgs: '["-y", "mcp-remote", "http://localhost:8000/mcp",\n',
    },
    {
      label: "127.0.0.1",
      publicUrl: "http://127.0.0.1:8000",
      bridgeArgs: '["-y", "mcp-remote", "http://127.0.0.1:8000/mcp",\n',
    },
    {
      label: "a plain-http network address, with --allow-http",
      publicUrl: "http://192.168.1.20:8000",
      bridgeArgs: '["-y", "mcp-remote", "http://192.168.1.20:8000/mcp", "--allow-http",\n',
    },
  ])("bridges Claude Desktop to $label", ({ publicUrl, bridgeArgs }) => {
    const message = buildLocalConnectMessage({ ...localDefaults, publicUrl })

    expect(message).toContain(`"args": ${bridgeArgs}`)
  })

  it("tells every client to connect directly to an https PUBLIC_URL, with no mcp-remote bridge", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      publicUrl: "https://vault.home.example",
    })

    expect(message).toContain(
      "  3. done — the client holds auto-refreshing access tokens; the token\n" +
        "     never sits in client config\n" +
        "\n" +
        "Reachable over https from any MCP client — Claude Desktop, claude.ai (web\n" +
        "and mobile), opencode, Cursor — from any device.\n" +
        "\n" +
        "── Non-OAuth",
    )
    expect(message).not.toContain("mcp-remote")
    expect(message).not.toContain("can't reach a localhost or home-network address")
  })

  it("routes an upper-case HTTPS PUBLIC_URL to the https guidance", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      publicUrl: "HTTPS://vault.home.example",
    })

    expect(message).toContain(
      "Reachable over https from any MCP client — Claude Desktop, claude.ai (web\n",
    )
    expect(message).not.toContain("mcp-remote")
  })

  it("shows 'The server is running.' when startStatus is running", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      startStatus: "running",
    })

    expect(message).toContain("The server is running.")
    expect(message).not.toContain("Start the server:")
  })

  it("shows the start command when startStatus is not-started", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      startStatus: "not-started",
    })

    // Bound to the start line specifically — the update-guidance block also
    // prints an npx command, so a bare command match could pass on that.
    expect(message).toContain(
      `Start the server:\n  npx vault-cortex@latest start --dir '${localDefaults.targetDir}'`,
    )
  })

  it("displays the token on its own line when tokenWritten is true", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      tokenWritten: true,
    })

    expect(message).toContain("Auth token:")
    expect(message).toContain(localDefaults.token)
    expect(message).not.toContain("use the existing MCP_AUTH_TOKEN")
  })

  it("points at the existing .env token when tokenWritten is false", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      tokenWritten: false,
    })

    expect(message).toContain(`use the existing MCP_AUTH_TOKEN in ${localDefaults.targetDir}/.env`)
  })

  it("includes the targetDir in the settings paragraph", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain(`${localDefaults.targetDir}/.env`)
  })

  it("links Full docs to the repo front page, not a deep blob URL", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain("Full docs: https://github.com/aliasunder/vault-cortex\n")
    expect(message).not.toContain("blob/main/deploy/local/README.md")
  })

  it("includes the image update command with the targetDir", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain("Update to the latest release:")
    expect(message).toContain(`npx vault-cortex@latest upgrade --dir '${localDefaults.targetDir}'`)
  })

  it("tells a .env editor to restart with the targetDir", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain(
      `then apply it (plain docker restart does not re-read .env):\n  npx vault-cortex@latest restart --dir '${localDefaults.targetDir}'`,
    )
  })

  it("includes the OAuth connect walkthrough", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain("claude mcp add")
    expect(message).toContain("approve the browser consent page")
  })

  it("includes the curl guidance for non-OAuth clients", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain('curl -H "Authorization: Bearer <token>"')
  })

  it("includes the smoke test command", () => {
    const message = buildLocalConnectMessage(localDefaults)

    expect(message).toContain("Smoke test:")
    expect(message).toContain("curl http://localhost:8000/healthz")
  })

  it("shows 'starting in the background' when startStatus is starting", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      startStatus: "starting",
    })

    expect(message).toContain("starting in the background")
    expect(message).toContain("docker logs vault-cortex")
    expect(message).not.toContain("Start the server:")
    expect(message).not.toContain("npx vault-cortex@latest start")
  })

  it("shows the smoke test when startStatus is starting", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      startStatus: "starting",
    })

    expect(message).toContain("Smoke test:")
  })

  it("omits the smoke test once the server is running", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      startStatus: "running",
    })

    // The CLI just health-checked this exact URL. The curl auth guidance must
    // survive (the omission removes one block, not the section), and the
    // triple-newline check catches a stray blank line from the assembly.
    expect(message).not.toContain("Smoke test:")
    expect(message).not.toContain("curl http://localhost:8000/healthz")
    expect(message).toContain('curl -H "Authorization: Bearer <token>"')
    expect(message).not.toMatch(/\n\n\n/)
  })

  it("names a custom instance in the logs command and both connector entries", () => {
    const message = buildLocalConnectMessage({
      ...localDefaults,
      instanceName: "work",
      publicUrl: "http://localhost:8001",
      startStatus: "starting",
    })

    expect(message).toContain("check progress:\n  docker logs work\n")
    expect(message).toContain(
      "claude mcp add --scope user --transport http work http://localhost:8001/mcp\n",
    )
    expect(message).toContain('  "work": {\n')
    expect(message).not.toContain("docker logs vault-cortex")
    expect(message).not.toContain("transport http vault-cortex")
    expect(message).not.toContain('"vault-cortex": {')
  })
})

// ── buildRemoteConnectMessage ──────────────────────────────────────────────────

describe("buildRemoteConnectMessage", () => {
  it("prints the whole connect message for a server that has not started or signed in", () => {
    const message = buildRemoteConnectMessage({
      targetDir: "/srv/vault-cortex",
      instanceName: "vault-cortex",
      token: "abc123deadbeef",
      publicUrl: "https://vault.example.com",
      startStatus: "not-started",
      obsidianTokenMissing: true,
      tokenWritten: true,
    })

    expect(message).toBe(`${expectedTopRule("Connect")}

Start the server:
  npx vault-cortex@latest start --dir '/srv/vault-cortex'
Until it's signed in to Obsidian Sync, it shows a sign-in page instead of
syncing. Open the page:
  https://vault.example.com
It asks for the auth token below and your Obsidian password.

${expectedSectionRule("MCP client")}

Connect your MCP client:
  URL:        https://vault.example.com/mcp
  Auth token:
  abc123deadbeef

Add the URL above as a remote MCP server (leave Client ID/Secret empty),
then approve the consent page with the token. For example, Claude Code:
  1. claude mcp add --scope user --transport http vault-cortex https://vault.example.com/mcp
  2. approve the browser consent page with the token above
  3. done — the client holds auto-refreshing access tokens; the token
     never sits in client config

Reachable over https from any MCP client — Claude Desktop, claude.ai (web
and mobile), opencode, Cursor — from any device.

${expectedSectionRule("Non-OAuth")}

Clients without OAuth, scripts, and curl send the token directly:
  curl -H "Authorization: Bearer <token>" https://vault.example.com/mcp

Smoke test:
  curl https://vault.example.com/healthz

${expectedSectionRule("Settings")}

Adjust optional settings (memory layer and folder, daily notes
folder and format, file tools, read-only mode, semantic search, port,
timezone, sync direction):
  npx vault-cortex@latest configure --dir '/srv/vault-cortex'

Or edit /srv/vault-cortex/.env directly — change a value (uncommenting it
first if needed), then apply it (plain docker restart does not re-read .env):
  npx vault-cortex@latest restart --dir '/srv/vault-cortex'

Update to the latest release:
  npx vault-cortex@latest upgrade --dir '/srv/vault-cortex'

For HTTPS options (API Gateway, Caddy, Cloudflare Tunnel), see:
https://github.com/aliasunder/vault-cortex/blob/main/deploy/remote/README.md#https-access

${expectedBottomRule()}`)
  })

  it("wraps the output in top and bottom box-drawing rules", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    const lines = message.split("\n")
    expect(lines[0]).toBe(expectedTopRule("Connect"))
    expect(lines[lines.length - 1]).toBe(expectedBottomRule())
  })

  it("includes MCP client, Non-OAuth, and Settings section dividers", () => {
    const lines = buildRemoteConnectMessage(remoteDefaults).split("\n")

    expect(lines).toContain(expectedSectionRule("MCP client"))
    expect(lines).toContain(expectedSectionRule("Non-OAuth"))
    expect(lines).toContain(expectedSectionRule("Settings"))
  })

  it("builds URLs from the given publicUrl", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "https://my-vault.example.com",
    })

    expect(message).toContain("https://my-vault.example.com/mcp")
    expect(message).toContain("https://my-vault.example.com/healthz")
  })

  it("shows 'The server is running.' when startStatus is running", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      startStatus: "running",
    })

    expect(message).toContain("The server is running.\n\n")
    expect(message).not.toContain("Start the server:")
    expect(message).not.toContain("sign-in page")
  })

  it("shows 'starting in the background' when startStatus is starting", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      startStatus: "starting",
    })

    expect(message).toContain("starting in the background")
    expect(message).toContain("docker logs vault-cortex")
    expect(message).not.toContain("Start the server:")
    expect(message).not.toContain("npx vault-cortex@latest start")
  })

  it("names a custom instance in the logs command and the connector entry", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      instanceName: "work",
      startStatus: "starting",
    })

    expect(message).toContain("check progress:\n  docker logs work\n")
    expect(message).toContain(
      "claude mcp add --scope user --transport http work https://vault.example.com/mcp\n",
    )
    expect(message).not.toContain("docker logs vault-cortex")
    expect(message).not.toContain("transport http vault-cortex")
  })

  it("shows the health check block when startStatus is starting", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      startStatus: "starting",
    })

    expect(message).toContain("Health check — works from any device")
    expect(message).not.toContain("Smoke test:")
  })

  it("follows the start command with the sign-in steps when .env has no Sync token", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "https://vault.example.com",
      startStatus: "not-started",
      obsidianTokenMissing: true,
    })

    expect(message).toContain(
      `Start the server:\n  npx vault-cortex@latest start --dir '${remoteDefaults.targetDir}'\n` +
        "Until it's signed in to Obsidian Sync, it shows a sign-in page instead of\n" +
        "syncing. Open the page:\n" +
        "  https://vault.example.com\n" +
        "It asks for the auth token below and your Obsidian password.\n\n",
    )
  })

  it("follows the running line with the sign-in steps when .env has no Sync token", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "https://vault.example.com",
      startStatus: "running",
      obsidianTokenMissing: true,
    })

    expect(message).toContain(
      "The server is running.\n" +
        "Until it's signed in to Obsidian Sync, it shows a sign-in page instead of\n" +
        "syncing. Open the page:\n" +
        "  https://vault.example.com\n" +
        "It asks for the auth token below and your Obsidian password.\n\n",
    )
  })

  it("asks for HTTPS before the sign-in page when PUBLIC_URL is http", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "http://203.0.113.5:8000",
      startStatus: "running",
      obsidianTokenMissing: true,
    })

    expect(message).toContain(
      "syncing. Open the page:\n" +
        "  http://203.0.113.5:8000\n" +
        "It asks for the auth token below and your Obsidian password.\n" +
        "Set up HTTPS first: the page sends your Obsidian password to the server.\n\n",
    )
  })

  it("shows the start command when not started and obsidian token present", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      startStatus: "not-started",
      obsidianTokenMissing: false,
    })

    // Bound to the start line specifically — the update-guidance block also
    // prints an npx command, so a bare command match could pass on that.
    expect(message).toContain(
      `Start the server:\n  npx vault-cortex@latest start --dir '${remoteDefaults.targetDir}'`,
    )
  })

  it("shows https guidance when publicUrl is https", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "https://vault.example.com",
    })

    expect(message).toContain("Reachable over https from any MCP client")
    expect(message).not.toContain("only accept https URLs")
  })

  it("shows http guidance when publicUrl is http", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "http://vault.example.com",
    })

    expect(message).toContain("only accept https URLs")
    expect(message).not.toContain("Reachable over https from any MCP client")
  })

  it("handles case-insensitive HTTPS scheme", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      publicUrl: "HTTPS://vault.example.com",
    })

    expect(message).toContain("Reachable over https from any MCP client")
  })

  it("displays the token on its own line when tokenWritten is true", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      tokenWritten: true,
    })

    expect(message).toContain("Auth token:")
    expect(message).toContain(remoteDefaults.token)
    expect(message).not.toContain("use the existing MCP_AUTH_TOKEN")
  })

  it("points at the existing .env token when tokenWritten is false", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      tokenWritten: false,
    })

    expect(message).toContain(`use the existing MCP_AUTH_TOKEN in ${remoteDefaults.targetDir}/.env`)
  })

  it("includes the image update command with the targetDir", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain("Update to the latest release:")
    expect(message).toContain(`npx vault-cortex@latest upgrade --dir '${remoteDefaults.targetDir}'`)
  })

  it("tells a .env editor to restart with the targetDir", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain(
      `then apply it (plain docker restart does not re-read .env):\n  npx vault-cortex@latest restart --dir '${remoteDefaults.targetDir}'`,
    )
  })

  it("includes the remote docs link", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain("deploy/remote/README.md#https-access")
  })

  it("includes the OAuth connect walkthrough", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain("claude mcp add")
    expect(message).toContain("approve the browser consent page")
  })

  it("includes the curl guidance for non-OAuth clients", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain('curl -H "Authorization: Bearer <token>"')
  })

  it("includes the smoke test command", () => {
    const message = buildRemoteConnectMessage(remoteDefaults)

    expect(message).toContain("Smoke test:")
    expect(message).toContain("curl https://vault.example.com/healthz")
    expect(message).not.toContain("works from any device")
  })

  it("rewords the health check as the any-device check once running", () => {
    const message = buildRemoteConnectMessage({
      ...remoteDefaults,
      startStatus: "running",
    })

    // Unlike local, the command survives a confirmed start: the CLI verified
    // localhost on the VPS, while the public URL exercises ingress — a
    // genuinely different check, so only the first-time framing goes.
    expect(message).toContain(
      "Health check — works from any device that can reach the URL:\n" +
        "  curl https://vault.example.com/healthz",
    )
    expect(message).not.toContain("Smoke test:")
  })
})

describe("buildDaemonUnavailableMessage", () => {
  const NOT_INSTALLED_LEAD =
    "No container runtime found — the server runs in Docker, so you need\n" +
    "Docker or a Docker-compatible runtime (OrbStack, Colima, Podman).\n"

  it("tells the user to start a stopped runtime and ends at the guidance without a start command", () => {
    expect(buildDaemonUnavailableMessage({ daemonStatus: "not-running" })).toBe(
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime.",
    )
  })

  it("ends a stopped runtime's guidance with the start command", () => {
    expect(
      buildDaemonUnavailableMessage({
        daemonStatus: "not-running",
        startCommand: "npx vault-cortex@latest start --dir '/srv/vault'",
      }),
    ).toBe(
      "Container runtime not running — start Docker Desktop, Colima,\n" +
        "OrbStack, or another Docker-compatible runtime, then run:\n" +
        "  npx vault-cortex@latest start --dir '/srv/vault'",
    )
  })

  it.each([
    {
      label: "macOS at the Docker Desktop docs",
      platform: "darwin" as const,
      installLine: "Install Docker Desktop: https://docs.docker.com/get-docker/",
    },
    {
      label: "Linux at the Docker Engine install docs",
      platform: "linux" as const,
      installLine: "Install Docker Engine: https://docs.docker.com/engine/install/",
    },
    {
      label: "Windows at the Docker Desktop docs",
      platform: "win32" as const,
      installLine: "Install Docker Desktop: https://docs.docker.com/get-docker/",
    },
  ])("points $label when no runtime is installed", ({ platform, installLine }) => {
    expect(buildDaemonUnavailableMessage({ daemonStatus: "not-installed", platform })).toBe(
      `${NOT_INSTALLED_LEAD}${installLine}`,
    )
  })

  it("ends the install guidance with the start command", () => {
    expect(
      buildDaemonUnavailableMessage({
        daemonStatus: "not-installed",
        startCommand: "npx vault-cortex@latest start --dir '/srv/vault'",
        platform: "linux",
      }),
    ).toBe(
      `${NOT_INSTALLED_LEAD}Install Docker Engine: https://docs.docker.com/engine/install/\n` +
        "Then start the server with:\n" +
        "  npx vault-cortex@latest start --dir '/srv/vault'",
    )
  })
})

describe("healthPollTimeoutMs", () => {
  it("gives remote mode a 4-minute budget for the first-sync gate", () => {
    expect(healthPollTimeoutMs("remote")).toBe(240_000)
  })

  it("keeps the local-mode budget at 2 minutes", () => {
    expect(healthPollTimeoutMs("local")).toBe(120_000)
  })
})

describe("healthTimeoutMessage", () => {
  it("renders the local budget as 2 minutes", () => {
    expect(
      healthTimeoutMessage({ mode: "local", timeoutMs: 120_000, instanceName: "vault-cortex" }),
    ).toBe("Server did not respond within 2 minutes — check: docker logs vault-cortex")
  })

  it("adds the first-sync hint to the remote 4-minute message", () => {
    expect(
      healthTimeoutMessage({ mode: "remote", timeoutMs: 240_000, instanceName: "vault-cortex" }),
    ).toBe(
      "Server did not respond within 4 minutes — check: docker logs vault-cortex (a long first sync may still be running — the container keeps starting in the background)",
    )
  })
})

describe("healthTimeoutMessage with a custom instance", () => {
  it("points the logs command at the instance's container", () => {
    expect(healthTimeoutMessage({ mode: "local", timeoutMs: 120_000, instanceName: "work" })).toBe(
      "Server did not respond within 2 minutes — check: docker logs work",
    )
  })
})

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { runInit } from "../init.js"
import { pollHealth } from "../docker.js"
import { buildDockerNotInstalledMessage } from "../messages.js"

vi.mock("../docker.js", { spy: true })
import {
  createScriptedPrompts,
  dockerDaemonOnly,
  dockerDown,
  dockerNotInstalled,
  dockerReady,
  fetchNever,
} from "./command-stubs.js"

const makeVault = (): string => {
  const vaultDir = mkdtempSync(join(tmpdir(), "vault-cli-vault-"))
  mkdirSync(join(vaultDir, ".obsidian"))
  return vaultDir
}

const makeTargetDir = (): string =>
  join(mkdtempSync(join(tmpdir(), "vault-cli-target-")), "out")

describe("runInit flag validation", () => {
  const invalidFlagScenarios = [
    {
      name: "--yes without --vault-path exits 1",
      flags: { yes: true },
      expectedError: "--yes requires --vault-path.",
    },
    {
      name: "--yes with --mode remote exits 1 (remote needs interactive prompts)",
      flags: { yes: true, mode: "remote", vaultPath: "/tmp" },
      expectedError:
        "--yes only supports local mode — remote setup needs interactive token prompts.",
    },
    {
      name: "an unknown --mode exits 1",
      flags: { mode: "cloud" },
      expectedError: 'Unknown mode "cloud" — expected "local" or "remote".',
    },
  ]

  it.each(invalidFlagScenarios)("$name", async ({ flags, expectedError }) => {
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(flags, {
      prompts: scripted.prompts,
      docker: dockerDown,
      fetchFn: fetchNever,
    })

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([expectedError])
  })
})

describe("runInit --yes (non-interactive local)", () => {
  it("scaffolds .env without any prompts", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual([])
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false)
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    expect(envContent).toMatch(/^MCP_AUTH_TOKEN=[0-9a-f]{64}$/m)
    expect(envContent).toContain(`VAULT_PATH=${vaultDir}\n`)
    expect(scripted.prints[0]).toContain(
      "Adjust optional settings (memory layer and folder, daily notes\nfolder and format, file tools, semantic search, port, timezone):",
    )
  })

  it("exits 1 when --vault-path does not exist", async () => {
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      {
        yes: true,
        vaultPath: join(tmpdir(), "vault-cli-no-such-vault"),
        dir: makeTargetDir(),
      },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `Path does not exist: ${join(tmpdir(), "vault-cli-no-such-vault")}`,
    ])
  })

  it("exits 1 on a differing existing .env and leaves it untouched", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=existing\n")
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=existing\n",
    )
    expect(scripted.errors).toEqual([
      "Existing files differ (.env) — refusing to overwrite in --yes mode.",
    ])
  })
})

describe("local connect message client routing", () => {
  it("routes Claude Code to claude mcp add and Claude Desktop to the mcp-remote bridge", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const connectMessage = scripted.prints[0]
    expect(connectMessage).toContain(
      "claude mcp add --scope user --transport http vault-cortex http://localhost:8000/mcp",
    )
    expect(connectMessage).toContain(
      '"mcp-remote", "http://localhost:8000/mcp"',
    )
    expect(connectMessage).toContain("only accepts https URLs")
    // Claude Desktop must not be grouped with the add-as-remote-server flow —
    // its connector dialog rejects http URLs.
    expect(connectMessage).not.toContain("OAuth clients (Claude Desktop")
  })

  it("prints the generated auth token alone on its own line for clean copying", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const token = /MCP_AUTH_TOKEN=(.+)/.exec(
      readFileSync(join(targetDir, ".env"), "utf8"),
    )?.[1]
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const connectMessage = scripted.prints[0]
    // The token must be on a line by itself (so a line-select grabs only it),
    // not inline after the "Auth token:" label.
    expect(connectMessage.split("\n")).toContain(`  ${token}`)
    expect(connectMessage).not.toContain(`Auth token: ${token}`)
  })
})

describe("target directory tilde expansion", () => {
  it("expands a leading ~ in --dir to the home directory instead of a literal ~ folder", async () => {
    const vaultDir = makeVault()
    const fakeHome = mkdtempSync(join(tmpdir(), "vault-cli-home-"))
    const originalHome = process.env.HOME
    process.env.HOME = fakeHome
    onTestFinished(() => {
      process.env.HOME = originalHome
    })
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: "~/vault-cortex" },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    // Files land under the expanded home, not a literal "~" directory.
    expect(existsSync(join(fakeHome, "vault-cortex", ".env"))).toBe(true)
    expect(existsSync(join(process.cwd(), "~"))).toBe(false)
  })
})

describe("remote connect message https routing", () => {
  const runRemoteInit = async (publicUrl: string) => {
    const scripted = createScriptedPrompts([
      publicUrl,
      "MyVault",
      false, // don't generate the token now (declined auto-capture)
      "", // blank sync token — fill in .env later
      false, // no encryption
      [], // no optional settings
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: makeTargetDir() },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const connectMessage = scripted.prints.find((message) =>
      message.includes("Connect your MCP client"),
    )
    if (!connectMessage) throw new Error("connect message was not printed")
    return connectMessage
  }

  it("warns and offers claude mcp add when PUBLIC_URL is http", async () => {
    const connectMessage = await runRemoteInit("http://203.0.113.10:8000")

    expect(connectMessage).toContain("only accept https URLs")
    expect(connectMessage).toContain(
      "claude mcp add --scope user --transport http vault-cortex http://203.0.113.10:8000/mcp",
    )
  })

  it("omits the http warning when PUBLIC_URL is https", async () => {
    const connectMessage = await runRemoteInit("https://vault.example.com")

    // The Claude Code walkthrough is shared by every variant, so the command
    // is present; what https omits is the http-only "set up HTTPS" caveat.
    expect(connectMessage).toContain("claude mcp add")
    expect(connectMessage).not.toContain("only accept https URLs")
    expect(connectMessage).not.toContain("set up HTTPS")
    expect(connectMessage).toContain("Reachable over https")
  })

  it("routes an uppercase HTTPS:// scheme to the https guidance", async () => {
    // PUBLIC_URL is stored as typed, so the https detection must be
    // case-insensitive — HTTPS:// is valid and must not fall to http guidance.
    const connectMessage = await runRemoteInit("HTTPS://vault.example.com")

    expect(connectMessage).toContain("Reachable over https")
    expect(connectMessage).not.toContain("only accept https URLs")
    expect(connectMessage).not.toContain("set up HTTPS")
  })

  it("rejects a trailing /mcp on PUBLIC_URL and re-prompts for the base origin", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com/mcp", // re-included the /mcp path — rejected
      "https://vault.example.com", // base origin — accepted on re-prompt
      "MyVault",
      false, // don't generate the token now (declined auto-capture)
      "", // blank sync token — fill in .env later
      false, // no encryption
      [], // no optional settings
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toHaveLength(1)
    expect(scripted.errors[0]).toContain("Leave /mcp off PUBLIC_URL")
    // The accepted base origin is stored verbatim — not silently rewritten —
    // and the connect URL appends /mcp exactly once.
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain(
      "PUBLIC_URL=https://vault.example.com\n",
    )
    const connectMessage = scripted.prints[0]
    expect(connectMessage).toContain("https://vault.example.com/mcp")
    expect(connectMessage).not.toContain("https://vault.example.com/mcp/mcp")
  })

  it("trims a trailing slash on PUBLIC_URL so the connect URL is not //mcp", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com/", // trailing slash — trimmed, not rejected
      "MyVault",
      false, // don't generate the token now (declined auto-capture)
      "", // blank sync token — fill in .env later
      false, // no encryption
      [], // no optional settings
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toHaveLength(0)
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain(
      "PUBLIC_URL=https://vault.example.com\n",
    )
    expect(scripted.prints[0]).toContain("https://vault.example.com/mcp")
    expect(scripted.prints[0]).not.toContain("https://vault.example.com//mcp")
  })

  it("prints the generated auth token alone on its own line for clean copying", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com",
      "MyVault",
      false, // don't generate the token now (declined auto-capture)
      "", // blank sync token — fill in .env later
      false, // no encryption
      [], // no optional settings
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const token = /MCP_AUTH_TOKEN=(.+)/.exec(
      readFileSync(join(targetDir, ".env"), "utf8"),
    )?.[1]
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const connectMessage = scripted.prints[0]
    // The token must be on a line by itself (so a line-select grabs only it),
    // not trailing the "Auth token:" label or buried in the OAuth paragraph.
    expect(connectMessage.split("\n")).toContain(`  ${token}`)
    expect(connectMessage).not.toContain(`Auth token: ${token}`)
  })
})

describe("runInit interactive local flow", () => {
  it("defaults the mode select to local", async () => {
    const vaultDir = makeVault()
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      makeTargetDir(),
      [], // no optional settings
    ])

    await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(scripted.selectCalls).toEqual([
      {
        message: "How do you want to run Vault Cortex?",
        options: [
          {
            value: "local",
            label: "Local",
            hint: "Docker on this machine, bind-mounted vault",
          },
          {
            value: "remote",
            label: "Remote",
            hint: "VPS + Obsidian Sync, access from anywhere",
          },
        ],
        initialValue: "local",
      },
    ])
  })

  it("re-prompts when the vault path does not exist, then succeeds", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const missingPath = join(tmpdir(), "vault-cli-no-such-vault")
    const scripted = createScriptedPrompts([
      "local",
      missingPath,
      vaultDir,
      targetDir,
      [], // no optional settings
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toEqual([`Path does not exist: ${missingPath}`])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain(
      `VAULT_PATH=${vaultDir}\n`,
    )
  })

  it("warns and skips the start offer when Docker is installed but the daemon is down", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      [], // no optional settings
    ])
    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain("Start the server now?")
    expect(scripted.warnings).toHaveLength(1)
    expect(scripted.warnings[0]).toContain("Container runtime not running")
  })

  // Message content per platform is pinned test-owned in messages.test.ts —
  // this asserts the not-installed state routes to the install guidance.
  it("warns with install guidance and skips the start offer when Docker is not installed", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      [], // no optional settings
    ])
    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerNotInstalled,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain("Start the server now?")
    expect(scripted.warnings).toEqual([
      buildDockerNotInstalledMessage({
        nextStep: `\nThen start the server with:\n  npx vault-cortex@latest start --dir "${targetDir}"`,
      }),
    ])
  })

  it("asks for confirmation on a folder without .obsidian and proceeds on yes", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "vault-cli-plain-"))
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "local",
      plainDir,
      true, // use the non-Obsidian folder anyway
      targetDir,
      [], // no optional settings
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked[2]).toContain("Use it anyway?")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain(
      `VAULT_PATH=${plainDir}\n`,
    )
  })
})

describe("runInit remote flow", () => {
  it("asks the remote sequence with auto-capture declined and writes .env", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com/", // public URL (trailing slash trimmed)
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
      "sync-token-xyz", // paste fallback — obsidian sync token
      false, // no end-to-end encryption
      [], // no optional settings
      false, // don't start the server
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDaemonOnly,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual([
      "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
      "Exact name of your Obsidian vault (case-sensitive):",
      "Generate the token now?",
      "Paste the Obsidian Sync token (leave blank to fill in .env later):",
      "Does your vault use end-to-end encryption?",
      "Any optional settings to change? (press enter to skip)",
      "Start the server now?",
    ])
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false)
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    expect(envContent).toContain("PUBLIC_URL=https://vault.example.com\n")
    expect(envContent).toContain("VAULT_NAME=MyVault\n")
    expect(envContent).toContain("OBSIDIAN_AUTH_TOKEN=sync-token-xyz\n")
    expect(scripted.prints[0]).toContain(
      "Adjust optional settings (memory layer and folder, daily notes\nfolder and format, file tools, semantic search, port, timezone,\nsync direction):",
    )
  })

  it("always offers token generation even without Docker", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
      "sync-token-xyz", // paste fallback — obsidian sync token
      false, // no end-to-end encryption
      [], // no optional settings
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerNotInstalled,
        fetchFn: fetchNever,
      },
    )

    // Token generation is always offered (uses the API, not Docker). No
    // "Start the server now?" (the install warning replaces the start offer).
    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual([
      "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
      "Exact name of your Obsidian vault (case-sensitive):",
      "Generate the token now?",
      "Paste the Obsidian Sync token (leave blank to fill in .env later):",
      "Does your vault use end-to-end encryption?",
      "Any optional settings to change? (press enter to skip)",
    ])
    expect(scripted.warnings).toEqual([
      buildDockerNotInstalledMessage({
        nextStep: `\nThen start the server with:\n  npx vault-cortex@latest start --dir "${targetDir}"`,
      }),
    ])
  })

  it("probes the public URL after a confirmed start and reports success", async () => {
    const targetDir = makeTargetDir()
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (input) => {
      fetchedUrls.push(String(input))
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
      "sync-token-xyz", // paste fallback
      false, // no end-to-end encryption
      [], // no optional settings
      true, // start the server now
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    // Order proves the probe ran after the container health poll.
    expect(fetchedUrls).toEqual([
      "http://127.0.0.1:8000/healthz",
      "https://vault.example.com/healthz",
    ])
    expect(scripted.spinnerMessages).toEqual([
      "start: Waiting for the server to come up (first run may take a moment)",
      "stop: Server is up — health check passed.",
      "start: Checking the public URL (https://vault.example.com/healthz)",
      "stop: Public URL responds — https://vault.example.com/healthz answered from this machine.",
    ])
  })

  it("keeps a successful start at exit 0 when the public URL does not answer", async () => {
    const targetDir = makeTargetDir()
    const fetchedUrls: string[] = []
    // Localhost (the container check) answers; the public URL is unreachable
    // — the state every remote init is in before HTTPS/ingress is set up.
    const fetchPublicUrlDown: typeof fetch = async (input) => {
      const url = String(input)
      fetchedUrls.push(url)
      if (url.includes("127.0.0.1")) return new Response(null, { status: 200 })
      throw new Error("ECONNREFUSED")
    }
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
      "sync-token-xyz", // paste fallback
      false, // no end-to-end encryption
      [], // no optional settings
      true, // start the server now
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchPublicUrlDown,
      },
    )

    // Exit 0 with the probe provably fired — the probe is informational,
    // never a gate — and the connect message still reports the running server.
    expect(exitCode).toBe(0)
    expect(fetchedUrls).toContain("https://vault.example.com/healthz")
    expect(scripted.spinnerMessages).toEqual([
      "start: Waiting for the server to come up (first run may take a moment)",
      "stop: Server is up — health check passed.",
      "start: Checking the public URL (https://vault.example.com/healthz)",
      "stop: No answer from https://vault.example.com/healthz yet.",
    ])
    expect(scripted.warnings).toEqual([
      "The server is up, but its public URL didn't answer from this machine.\n" +
        "That's expected until HTTPS (or direct port) access is set up — and\n" +
        "some networks keep a server from reaching its own public address even\n" +
        "when other devices can. Once access is set up, check from any device:\n" +
        "  curl https://vault.example.com/healthz",
    ])
    expect(scripted.prints[0]).toContain("The server is running.")
  })

  it("skips paste prompt when auto-capture succeeds", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com",
      "MyVault",
      true, // generate the token now
      "user@example.com", // email
      "password", // password
      false, // no end-to-end encryption
      [], // no optional settings
      false, // don't start the server
    ])
    const fetchSigninSuccess: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          token: "captured-token",
          name: "User",
          email: "user@example.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDaemonOnly,
        fetchFn: fetchSigninSuccess,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain(
      "Paste the Obsidian Sync token (leave blank to fill in .env later):",
    )
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    // Exact line match — a substring check would also pass for a commented
    // or prefixed entry (e.g. "# OBSIDIAN_AUTH_TOKEN=captured-token").
    expect(envContent.split("\n")).toContain(
      "OBSIDIAN_AUTH_TOKEN=captured-token",
    )
  })

  it("skips the start offer when the sync token was left blank", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "http://203.0.113.10:8000",
      "MyVault",
      false, // don't generate the token now (declined auto-capture)
      "", // blank token — fill in later
      false, // no encryption
      [], // no optional settings
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain("Start the server now?")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toMatch(
      /^OBSIDIAN_AUTH_TOKEN=$/m,
    )
  })

  it("asks the config dir first, then the mode-specific inputs", async () => {
    const configDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      configDir, // config dir — prompted, not passed as a flag
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
      "", // blank sync token — fill in .env later
      false, // no encryption
      [], // no optional settings
    ])

    const exitCode = await runInit(
      { mode: "remote" },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual([
      "Where should I put the config files?",
      "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
      "Exact name of your Obsidian vault (case-sensitive):",
      "Generate the token now?",
      "Paste the Obsidian Sync token (leave blank to fill in .env later):",
      "Does your vault use end-to-end encryption?",
      "Any optional settings to change? (press enter to skip)",
    ])
    expect(existsSync(join(configDir, ".env"))).toBe(true)
  })
})

describe("runInit re-init guard", () => {
  it("backs out of remote init before any mode-specific question when the dir already holds a deployment", async () => {
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=existing\n")
    const scripted = createScriptedPrompts([
      false, // existing deployment found — do not re-run setup (default)
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    // The guard must fire before the first mode-specific question — the
    // confirm is the only prompt the whole run asked.
    expect(scripted.asked).toEqual(["Re-run setup for this directory anyway?"])
    expect(scripted.confirmCalls).toEqual([
      {
        message: "Re-run setup for this directory anyway?",
        initialValue: false,
      },
    ])
    expect(scripted.logs).toEqual([
      `Found an existing deployment in ${targetDir}.`,
      `Nothing changed. To adjust settings instead: npx vault-cortex@latest configure --dir "${targetDir}"`,
    ])
    expect(scripted.outros).toEqual(["Done."])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=existing\n",
    )
  })

  it("backs out of local init after the dir prompt when it already holds a deployment", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=existing\n")
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      false, // existing deployment found — do not re-run setup (default)
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    // The guard fires on the dir answer — no settings or start questions follow.
    expect(scripted.asked).toEqual([
      "How do you want to run Vault Cortex?",
      "Path to your Obsidian vault:",
      "Where should I put the config files?",
      "Re-run setup for this directory anyway?",
    ])
    expect(scripted.logs).toEqual([
      `Found an existing deployment in ${targetDir}.`,
      `Nothing changed. To adjust settings instead: npx vault-cortex@latest configure --dir "${targetDir}"`,
    ])
    expect(scripted.outros).toEqual(["Done."])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=existing\n",
    )
  })
})

describe("runInit with a kept existing .env", () => {
  const keepEnvAnswers = (vaultDir: string, targetDir: string) => [
    "local",
    vaultDir,
    targetDir,
    true, // existing deployment found — re-run setup anyway
    [], // settings chooser — consented re-runs get the full setup
    false, // .env differs — keep the existing file
  ]

  it("points the connect message at the existing token instead of the unwritten one", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=existing\n")
    const scripted = createScriptedPrompts(keepEnvAnswers(vaultDir, targetDir))

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.prints).toHaveLength(1)
    expect(scripted.prints[0]).toContain(
      `use the existing MCP_AUTH_TOKEN in ${targetDir}/.env`,
    )
    // The freshly generated (never saved) token must not appear anywhere.
    expect(scripted.prints[0]).not.toMatch(/[0-9a-f]{64}/)
    expect(scripted.logs).not.toContain(
      "Generated MCP auth token (saved to .env).",
    )
  })

  it("polls health and prints URLs on the PORT from the .env on disk", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=existing\nPORT=9000\n",
    )
    const scripted = createScriptedPrompts([
      ...keepEnvAnswers(vaultDir, targetDir),
      true, // start the server now
    ])
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (url) => {
      fetchedUrls.push(String(url))
      return new Response(null, { status: 200 })
    }

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    expect(fetchedUrls).toEqual(["http://127.0.0.1:9000/healthz"])
    expect(scripted.prints[0]).toContain("http://localhost:9000/mcp")
  })
})

describe("runInit --vault-path flag in interactive mode", () => {
  it("surfaces an invalid flag path before falling back to the prompt", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const missingPath = join(tmpdir(), "vault-cli-no-such-vault")
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      [], // no optional settings
    ])

    const exitCode = await runInit(
      { vaultPath: missingPath },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toEqual([
      `--vault-path: Path does not exist: ${missingPath}`,
    ])
    expect(scripted.asked).toContain("Path to your Obsidian vault:")
  })
})

describe("runInit remote encryption password", () => {
  it("collects the vault password via the masked password prompt", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com",
      "MyVault",
      false, // decline auto-capture
      "sync-token-xyz", // paste fallback
      true, // vault uses end-to-end encryption
      "hunter2", // password (masked prompt)
      [], // no optional settings
      false, // don't start the server
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDaemonOnly,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).toContain("Vault encryption password:")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain(
      "VAULT_PASSWORD=hunter2\n",
    )
  })
})

describe("runInit remote with a kept existing .env", () => {
  it("probes and displays the persisted PUBLIC_URL, not the prompted one", async () => {
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    // The kept file is what the server reads — its URL must win over the
    // prompt for both the probe and the connect message (mirrors PORT).
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=existing\n" +
        "OBSIDIAN_AUTH_TOKEN=persisted-tok\n" +
        "VAULT_NAME=MyVault\n" +
        "PUBLIC_URL=https://persisted.example.com\n",
    )
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (input) => {
      fetchedUrls.push(String(input))
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      true, // existing deployment found — re-run setup anyway
      "https://prompted.example.com", // public URL prompt — differs from disk
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
      "sync-token-xyz", // paste fallback
      false, // no end-to-end encryption
      [], // settings chooser — consented re-runs get the full setup
      false, // .env differs — keep the existing file
      true, // start the server now
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    expect(fetchedUrls).toEqual([
      "http://127.0.0.1:8000/healthz",
      "https://persisted.example.com/healthz",
    ])
    expect(scripted.prints[0]).toContain("https://persisted.example.com/mcp")
    expect(scripted.prints[0]).not.toContain("prompted.example.com")
  })
})

describe("runInit sync-token auto-capture fallback", () => {
  it("falls back to paste prompt when auto-capture fails", async () => {
    const targetDir = makeTargetDir()
    const fetchSigninError: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "Invalid email or password" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    const scripted = createScriptedPrompts([
      "https://vault.example.com",
      "MyVault",
      true, // try to generate the token
      "user@example.com", // email
      "bad-password", // password
      "", // paste fallback — blank token, fill in later
      false, // no encryption
      [], // no optional settings
    ])
    await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDaemonOnly,
        fetchFn: fetchSigninError,
      },
    )

    expect(scripted.asked).toContain(
      "Paste the Obsidian Sync token (leave blank to fill in .env later):",
    )
    expect(scripted.warnings[0]).toBe(
      "Could not sign in: Invalid email or password",
    )
  })
})

describe("runInit guided optional settings", () => {
  it("applies picked settings to the written .env (toggle off + port change)", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      ["MEMORY_ENABLED", "PORT"], // picked in the chooser
      false, // disable the memory layer
      "9000", // host port
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const envLines = readFileSync(join(targetDir, ".env"), "utf8").split("\n")
    expect(envLines).toContain("MEMORY_ENABLED=false")
    // The default line must be replaced, not left behind next to an append.
    expect(envLines).not.toContain("MEMORY_ENABLED=true")
    expect(envLines).toContain("PORT=9000")
    // The derived PUBLIC_URL (the OAuth issuer) follows the port change —
    // otherwise discovery metadata would point at a dead port.
    expect(envLines).toContain("PUBLIC_URL=http://localhost:9000")
    expect(envLines).not.toContain("PUBLIC_URL=http://localhost:8000")
    // The connect message reads PORT from the .env on disk, so the chosen
    // port must flow through to the printed URLs.
    expect(scripted.prints[0]).toContain("http://localhost:9000/mcp")
  })

  it("uncomments the TZ line when the timezone is picked", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      ["TZ"],
      "America/Toronto",
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const envLines = readFileSync(join(targetDir, ".env"), "utf8").split("\n")
    expect(envLines).toContain("TZ=America/Toronto")
    expect(envLines).not.toContain("# TZ=America/New_York")
  })

  it("re-prompts on an invalid port until a valid one is given", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      ["PORT"],
      "not-a-port", // rejected
      "70000", // out of range — rejected
      "9000", // accepted
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toEqual([
      "PORT must be a whole number between 1 and 65535.",
      "PORT must be a whole number between 1 and 65535.",
    ])
    expect(readFileSync(join(targetDir, ".env"), "utf8").split("\n")).toContain(
      "PORT=9000",
    )
  })

  it("offers the settings chooser on a consented re-init over an existing .env", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=existing\n")
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      true, // existing deployment found — re-run setup anyway
      [], // settings chooser — offered because the re-run was consented
      false, // .env differs — keep the existing file
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    // "Yes, re-run setup" means the full setup — the chooser included, in
    // its usual position, with no extra questions around it.
    expect(scripted.asked).toEqual([
      "How do you want to run Vault Cortex?",
      "Path to your Obsidian vault:",
      "Where should I put the config files?",
      "Re-run setup for this directory anyway?",
      "Any optional settings to change? (press enter to skip)",
      ".env already exists and differs — overwrite?",
    ])
    // Keeping at the conflict prompt still protects the file (the write
    // report states the discard); no configure-pointer log remains.
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=existing\n",
    )
  })

  it("applies chooser answers when a consented re-init overwrites the existing .env", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=existing\n")
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      true, // existing deployment found — re-run setup anyway
      ["TZ"], // pick the timezone setting in the chooser
      "America/Toronto", // its value
      true, // .env differs — overwrite with the regenerated file
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    // The chooser's answer landed in the overwritten file as a live line
    // (line-exact: a commented-out `# TZ=...` must not pass) — the
    // motivation for offering the chooser on consented re-inits.
    expect(envContent.split("\n")).toContain("TZ=America/Toronto")
    expect(envContent).not.toContain("MCP_AUTH_TOKEN=existing")
  })

  it("writes the chosen SYNC_MODE in the remote flow", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com",
      "MyVault",
      false, // don't generate the token now (declined auto-capture)
      "", // blank sync token — fill in .env later
      false, // no encryption
      ["SYNC_MODE"],
      "pull-only",
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    // --mode remote skips the mode select, so this is the flow's only select.
    // The option list itself is pinned in optional-settings.test.ts.
    const selectsAsked = scripted.selectCalls.map(
      ({ message, initialValue }) => ({ message, initialValue }),
    )
    expect(selectsAsked).toEqual([
      {
        message: "Obsidian Sync direction:",
        initialValue: "bidirectional",
      },
    ])
    expect(readFileSync(join(targetDir, ".env"), "utf8").split("\n")).toContain(
      "SYNC_MODE=pull-only",
    )
  })
})

describe("runInit health-timeout returns starting status", () => {
  it("shows 'starting in the background' when the local health check times out", async () => {
    vi.mocked(pollHealth).mockResolvedValueOnce(false)
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "local",
      vaultDir,
      targetDir,
      [], // no optional settings
      true, // start the server now
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    // The connect message must show the "starting" copy, not "Start the server:".
    expect(scripted.prints[0]).toContain("starting in the background")
    expect(scripted.prints[0]).not.toContain("Start the server:")
  })

  it("skips the public URL probe when the remote health check times out", async () => {
    vi.mocked(pollHealth).mockResolvedValueOnce(false)
    const targetDir = makeTargetDir()
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (input) => {
      fetchedUrls.push(String(input))
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
      "sync-token-xyz", // paste fallback
      false, // no end-to-end encryption
      [], // no optional settings
      true, // start the server now
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    // pollHealth was mocked — fetchRecorder was never called. The public URL
    // probe only runs for "running", not "starting", so no URLs were fetched.
    expect(fetchedUrls).toEqual([])
    // The connect message must show "starting", not the running or not-started copy.
    expect(scripted.prints[0]).toContain("starting in the background")
    expect(scripted.prints[0]).not.toContain("Start the server:")
    expect(scripted.prints[0]).not.toContain("The server is running.")
  })
})

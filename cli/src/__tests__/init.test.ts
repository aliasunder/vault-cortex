import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { runInit, validatePublicUrl } from "../init.js"
import { pollHealth, type DockerRunner } from "../docker.js"
import { buildDaemonNotRunningMessage, buildDockerNotInstalledMessage } from "../messages.js"
import { readEnvInstanceName } from "../scaffold.js"

vi.mock("../docker.js", { spy: true })
import {
  createRecordingDocker,
  createScriptedPrompts,
  dockerDaemonOnly,
  dockerDown,
  dockerNotInstalled,
  dockerReadyEmptyHost,
  fetchNever,
  fetchOk,
} from "./command-stubs.js"

const makeVault = (): string => {
  const vaultDir = mkdtempSync(join(tmpdir(), "vault-cli-vault-"))
  mkdirSync(join(vaultDir, ".obsidian"))
  return vaultDir
}

const makeTargetDir = (): string => join(mkdtempSync(join(tmpdir(), "vault-cli-target-")), "out")

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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=existing\n")
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
    expect(connectMessage).toContain('"mcp-remote", "http://localhost:8000/mcp"')
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
    const token = /MCP_AUTH_TOKEN=(.+)/.exec(readFileSync(join(targetDir, ".env"), "utf8"))?.[1]
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
    const token = /MCP_AUTH_TOKEN=(.+)/.exec(readFileSync(join(targetDir, ".env"), "utf8"))?.[1]
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain(`VAULT_PATH=${vaultDir}\n`)
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
    expect(scripted.warnings).toEqual([
      nameCheckSkippedWarning("vault-cortex"),
      buildDaemonNotRunningMessage(
        `, then run:\n  npx vault-cortex@latest start --dir "${targetDir}"`,
      ),
    ])
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
      nameCheckSkippedWarning("vault-cortex"),
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain(`VAULT_PATH=${plainDir}\n`)
  })
})

describe("runInit remote flow", () => {
  it("leaves OBSIDIAN_AUTH_TOKEN blank when auto-capture is declined", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com/", // public URL (trailing slash trimmed)
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
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
      "Does your vault use end-to-end encryption?",
      "Any optional settings to change? (press enter to skip)",
      "Start the server now?",
    ])
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false)
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    expect(envContent).toContain("PUBLIC_URL=https://vault.example.com\n")
    expect(envContent).toContain("VAULT_NAME=MyVault\n")
    expect(envContent).toMatch(/^OBSIDIAN_AUTH_TOKEN=$/m)
    expect(scripted.logs).toContain(
      "No Sync token in .env — sign in on the server's sign-in page once it starts, or add a token with:\n" +
        `  npx vault-cortex@latest get-sync-token --dir "${targetDir}"`,
    )
  })

  it("always offers token generation even without Docker", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
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

    // Token generation is always offered (uses the API, not Docker). Without
    // Docker installed, no start offer is shown.
    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual([
      "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
      "Exact name of your Obsidian vault (case-sensitive):",
      "Generate the token now?",
      "Does your vault use end-to-end encryption?",
      "Any optional settings to change? (press enter to skip)",
    ])
    expect(scripted.asked).toContain("Generate the token now?")
  })

  it("probes the public URL after a confirmed start and reports success", async () => {
    const targetDir = makeTargetDir()
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (input) => {
      const url = String(input)
      fetchedUrls.push(url)
      // Signin API call succeeds; health/probe calls succeed
      if (url.includes("api.obsidian.md")) {
        return new Response(
          JSON.stringify({
            token: "sync-token-xyz",
            name: "User",
            email: "user@example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      true, // generate the token now
      "user@example.com", // email
      "password", // password
      false, // no end-to-end encryption
      [], // no optional settings
      true, // start the server now
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReadyEmptyHost,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    // Signin first (auto-capture), then health poll, then public URL probe.
    expect(fetchedUrls).toEqual([
      "https://api.obsidian.md/user/signin",
      "http://127.0.0.1:8000/healthz",
      "https://vault.example.com/healthz",
    ])
  })

  it("starts the server without a Sync token and points at its sign-in page", async () => {
    const targetDir = makeTargetDir()
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (input) => {
      fetchedUrls.push(String(input))
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now
      false, // no end-to-end encryption
      [], // no optional settings
      true, // start the server now
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReadyEmptyHost,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    // The health poll and the public URL probe only run after docker run.
    expect(fetchedUrls).toEqual([
      "http://127.0.0.1:8000/healthz",
      "https://vault.example.com/healthz",
    ])
    const connectMessage = scripted.prints.find((message) => {
      return message.includes("Connect your MCP client")
    })

    expect(connectMessage).toContain(
      "The server is running.\n" +
        "Until it's signed in to Obsidian Sync, it shows a sign-in page instead of\n" +
        "syncing. Open it and sign in with the auth token below:\n" +
        "  https://vault.example.com\n\n",
    )
  })

  it("keeps a successful start at exit 0 when the public URL does not answer", async () => {
    const targetDir = makeTargetDir()
    const fetchedUrls: string[] = []
    // Localhost (the container check) answers; the public URL is unreachable
    // — the state every remote init is in before HTTPS/ingress is set up.
    const fetchPublicUrlDownWithSignin: typeof fetch = async (input) => {
      const requestUrl = String(input)
      fetchedUrls.push(requestUrl)
      if (requestUrl.includes("api.obsidian.md")) {
        return new Response(
          JSON.stringify({
            token: "sync-token-xyz",
            name: "User",
            email: "user@example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      if (requestUrl.includes("127.0.0.1")) return new Response(null, { status: 200 })
      throw new Error("ECONNREFUSED")
    }
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      true, // generate the token now
      "user@example.com", // email
      "password", // password
      false, // no end-to-end encryption
      [], // no optional settings
      true, // start the server now
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReadyEmptyHost,
        fetchFn: fetchPublicUrlDownWithSignin,
      },
    )

    // Exit 0 with the probe provably fired — the probe is informational,
    // never a gate — and the connect message still reports the running server.
    expect(exitCode).toBe(0)
    expect(fetchedUrls).toContain("https://vault.example.com/healthz")
    // Signin spinner from auto-capture, then container health, then URL probe.
    expect(scripted.spinnerMessages).toEqual([
      "start: Signing in to Obsidian...",
      "stop: Signed in as user@example.com.",
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

  it("fills OBSIDIAN_AUTH_TOKEN from auto-capture when accepted", async () => {
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
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    // Exact line match — a substring check would also pass for a commented
    // or prefixed entry (e.g. "# OBSIDIAN_AUTH_TOKEN=captured-token").
    expect(envContent.split("\n")).toContain("OBSIDIAN_AUTH_TOKEN=captured-token")
  })

  it("skips the start offer when the sync token was left blank", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "http://203.0.113.10:8000",
      "MyVault",
      false, // don't generate the token now (declined auto-capture)
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toMatch(/^OBSIDIAN_AUTH_TOKEN=$/m)
  })

  it("preserves existing token and offers start when capture is declined on re-init", async () => {
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=old\nOBSIDIAN_AUTH_TOKEN=existing-token\nPUBLIC_URL=https://vault.example.com\nVAULT_NAME=MyVault\n",
    )
    const scripted = createScriptedPrompts([
      true, // re-run setup
      "https://vault.example.com",
      "MyVault",
      false, // don't generate the token now
      false, // no encryption
      [], // no optional settings
      true, // overwrite .env (content differs due to new MCP_AUTH_TOKEN)
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
    expect(scripted.asked).toContain("Start the server now?")
    expect(scripted.logs).not.toContain(expect.stringContaining("No token yet"))
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    expect(envContent).toMatch(/^OBSIDIAN_AUTH_TOKEN=existing-token$/m)
  })

  it("asks the config dir first, then the mode-specific inputs", async () => {
    const configDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      configDir, // config dir — prompted, not passed as a flag
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      false, // don't generate the token now (declined auto-capture)
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=existing\n")
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe("MCP_AUTH_TOKEN=existing\n")
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
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=existing\nVAULT_PATH=${vaultDir}\nPUBLIC_URL=http://localhost:8000\n`,
    )
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
    expect(scripted.prints[0]).toContain(`use the existing MCP_AUTH_TOKEN in ${targetDir}/.env`)
    // The freshly generated (never saved) token must not appear anywhere.
    expect(scripted.prints[0]).not.toMatch(/[0-9a-f]{64}/)
    expect(scripted.logs).not.toContain("Generated MCP auth token (saved to .env).")
  })

  it("polls health and prints URLs on the PORT from the .env on disk", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=existing\nVAULT_PATH=${vaultDir}\nPORT=9000\nPUBLIC_URL=http://localhost:9000\n`,
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
        docker: dockerReadyEmptyHost,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    expect(fetchedUrls).toEqual(["http://127.0.0.1:9000/healthz"])
    expect(scripted.prints[0]).toContain("http://localhost:9000/mcp")
  })

  it("stops instead of starting a kept .env with no PUBLIC_URL, as start does", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, ".env"), `MCP_AUTH_TOKEN=existing\nVAULT_PATH=${vaultDir}\n`)
    const scripted = createScriptedPrompts(keepEnvAnswers(vaultDir, targetDir))
    const recording = createRecordingDocker()

    const exitCode = await runInit(
      {},
      { prompts: scripted.prompts, docker: recording.docker, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `PUBLIC_URL is empty or missing in ${targetDir}/.env — the server requires it.\n` +
        "Set this line in your .env:\n  PUBLIC_URL=http://localhost:8000",
    ])
    expect(recording.runParams).toEqual([])
    expect(scripted.prints).toEqual([])
  })

  it("mounts the kept file's vault folder, not this run's, as start does", async () => {
    const promptedVaultDir = makeVault()
    const keptVaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=existing\nVAULT_PATH=${keptVaultDir}\nPUBLIC_URL=http://localhost:8000\n`,
    )
    const scripted = createScriptedPrompts([
      ...keepEnvAnswers(promptedVaultDir, targetDir),
      true, // start the server now
    ])
    const recording = createRecordingDocker()
    const fetchHealthy: typeof fetch = async () => {
      return new Response(null, { status: 200 })
    }

    const exitCode = await runInit(
      {},
      { prompts: scripted.prompts, docker: recording.docker, fetchFn: fetchHealthy },
    )

    expect(exitCode).toBe(0)
    expect(recording.runParams.map((params) => params.vaultPath)).toEqual([keptVaultDir])
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
    expect(scripted.errors).toEqual([`--vault-path: Path does not exist: ${missingPath}`])
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain("VAULT_PASSWORD=hunter2\n")
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
      const requestUrl = String(input)
      fetchedUrls.push(requestUrl)
      if (requestUrl.includes("api.obsidian.md")) {
        return new Response(
          JSON.stringify({
            token: "sync-token-xyz",
            name: "User",
            email: "user@example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      true, // existing deployment found — re-run setup anyway
      "https://prompted.example.com", // public URL prompt — differs from disk
      "MyVault", // vault name
      true, // generate the token now
      "user@example.com", // email
      "password", // password
      false, // no end-to-end encryption
      [], // settings chooser — consented re-runs get the full setup
      false, // .env differs — keep the existing file
      true, // start the server now
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReadyEmptyHost,
        fetchFn: fetchRecorder,
      },
    )

    expect(exitCode).toBe(0)
    // The signin URL is first (auto-capture), then health + public URL probe.
    expect(fetchedUrls).toEqual([
      "https://api.obsidian.md/user/signin",
      "http://127.0.0.1:8000/healthz",
      "https://persisted.example.com/healthz",
    ])
    expect(scripted.prints[0]).toContain("https://persisted.example.com/mcp")
    expect(scripted.prints[0]).not.toContain("prompted.example.com")
  })

  /** Captures a Sync token this run, then keeps an existing .env that has none, and starts. */
  const runInitCapturingTokenThenKeepingEnv = async (
    targetDir: string,
  ): Promise<{ exitCode: number; scripted: ReturnType<typeof createScriptedPrompts> }> => {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=existing\n" +
        "OBSIDIAN_AUTH_TOKEN=\n" +
        "VAULT_NAME=MyVault\n" +
        "PUBLIC_URL=https://persisted.example.com\n",
    )
    const fetchSigninSuccess: typeof fetch = async (input) => {
      if (!String(input).includes("api.obsidian.md")) return new Response(null, { status: 200 })
      return new Response(
        JSON.stringify({ token: "sync-token-xyz", name: "User", email: "user@example.com" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    const scripted = createScriptedPrompts([
      true, // existing deployment found — re-run setup anyway
      "https://prompted.example.com", // public URL
      "MyVault", // vault name
      true, // generate the token now
      "user@example.com", // email
      "password", // password
      false, // no end-to-end encryption
      [], // no optional settings
      false, // .env differs — keep the existing file
      true, // start the server now
    ])
    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReadyEmptyHost,
        fetchFn: fetchSigninSuccess,
      },
    )
    return { exitCode, scripted }
  }

  it("warns that this run's Sync token wasn't saved when the existing .env is kept", async () => {
    const targetDir = makeTargetDir()

    const { exitCode, scripted } = await runInitCapturingTokenThenKeepingEnv(targetDir)

    expect(exitCode).toBe(0)
    expect(scripted.warnings).toEqual([
      `The Sync token from this sign-in wasn't saved, because ${targetDir}/.env was kept. To add it, run:\n` +
        `  npx vault-cortex@latest get-sync-token --dir "${targetDir}"`,
    ])
  })

  it("points at the sign-in page when the kept file has no Sync token, despite this run's capture", async () => {
    const targetDir = makeTargetDir()

    const { exitCode, scripted } = await runInitCapturingTokenThenKeepingEnv(targetDir)

    expect(exitCode).toBe(0)
    expect(readFileSync(join(targetDir, ".env"), "utf8").split("\n")).toContain(
      "OBSIDIAN_AUTH_TOKEN=",
    )
    expect(scripted.prints[0]).toContain(
      "The server is running.\n" +
        "Until it's signed in to Obsidian Sync, it shows a sign-in page instead of\n" +
        "syncing. Open it and sign in with the auth token below:\n" +
        "  https://persisted.example.com\n\n",
    )
  })
})

describe("runInit sync-token auto-capture fallback", () => {
  it("logs get-sync-token guidance when capture fails", async () => {
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
      false, // no encryption
      [], // no optional settings
      false, // don't start the server
    ])
    await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerDaemonOnly,
        fetchFn: fetchSigninError,
      },
    )

    expect(scripted.warnings[0]).toBe("Could not sign in: Invalid email or password")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toMatch(/^OBSIDIAN_AUTH_TOKEN=$/m)
    expect(scripted.logs).toContain(
      "No Sync token in .env — sign in on the server's sign-in page once it starts, or add a token with:\n" +
        `  npx vault-cortex@latest get-sync-token --dir "${targetDir}"`,
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
    expect(readFileSync(join(targetDir, ".env"), "utf8").split("\n")).toContain("PORT=9000")
  })

  it("offers the settings chooser on a consented re-init over an existing .env", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    const existingEnv = `MCP_AUTH_TOKEN=existing\nVAULT_PATH=${vaultDir}\nPUBLIC_URL=http://localhost:8000\n`
    writeFileSync(join(targetDir, ".env"), existingEnv)
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
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(existingEnv)
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
    const selectsAsked = scripted.selectCalls.map(({ message, initialValue }) => ({
      message,
      initialValue,
    }))
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
        docker: dockerReadyEmptyHost,
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
    const fetchWithSignin: typeof fetch = async (input) => {
      const requestUrl = String(input)

      if (requestUrl.includes("api.obsidian.md")) {
        return new Response(
          JSON.stringify({
            token: "sync-token-xyz",
            name: "User",
            email: "user@example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      fetchedUrls.push(requestUrl)
      return new Response(null, { status: 200 })
    }
    const scripted = createScriptedPrompts([
      "https://vault.example.com", // public URL
      "MyVault", // vault name
      true, // generate the token now
      "user@example.com", // email
      "password", // password
      false, // no end-to-end encryption
      [], // no optional settings
      true, // start the server now
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReadyEmptyHost,
        fetchFn: fetchWithSignin,
      },
    )

    expect(exitCode).toBe(0)
    // pollHealth was mocked — the public URL probe only runs for "running",
    // not "starting", so no non-signin URLs were fetched.
    expect(fetchedUrls).toEqual([])
    // The connect message must show "starting", not the running or not-started copy.
    expect(scripted.prints[0]).toContain("starting in the background")
    expect(scripted.prints[0]).not.toContain("Start the server:")
    expect(scripted.prints[0]).not.toContain("The server is running.")
  })
})

describe("validatePublicUrl", () => {
  it("accepts a valid https URL", () => {
    expect(validatePublicUrl("https://vault.example.com")).toEqual({
      kind: "ok",
      url: "https://vault.example.com",
    })
  })

  it("accepts a valid http URL with port", () => {
    expect(validatePublicUrl("http://203.0.113.10:8000")).toEqual({
      kind: "ok",
      url: "http://203.0.113.10:8000",
    })
  })

  it("strips a trailing slash", () => {
    expect(validatePublicUrl("https://vault.example.com/")).toEqual({
      kind: "ok",
      url: "https://vault.example.com",
    })
  })

  it("rejects a URL with username and password", () => {
    expect(validatePublicUrl("https://user:pass@vault.example.com")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must not contain credentials (user:password@).",
    })
  })

  it("rejects a URL with username only", () => {
    expect(validatePublicUrl("https://user@vault.example.com")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must not contain credentials (user:password@).",
    })
  })

  it("rejects a URL with password only", () => {
    expect(validatePublicUrl("https://:pass@vault.example.com")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must not contain credentials (user:password@).",
    })
  })

  it("rejects a non-http URL", () => {
    expect(validatePublicUrl("ws://vault.example.com")).toEqual({
      kind: "error",
      message:
        "PUBLIC_URL must be a full http:// or https:// URL (e.g. https://vault.example.com).",
    })
  })

  it("rejects a URL with a trailing /mcp path", () => {
    expect(validatePublicUrl("https://vault.example.com/mcp")).toEqual({
      kind: "error",
      message:
        "Leave /mcp off PUBLIC_URL — it's the base URL and the server adds /mcp itself (e.g. https://vault.example.com).",
    })
  })

  it("rejects invalid syntax", () => {
    expect(validatePublicUrl("not-a-url")).toEqual({
      kind: "error",
      message:
        "PUBLIC_URL must be a full http:// or https:// URL (e.g. https://vault.example.com).",
    })
  })

  it("rejects a URL with a query string", () => {
    expect(validatePublicUrl("https://vault.example.com/?tab=2")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a URL with a hash fragment", () => {
    expect(validatePublicUrl("https://vault.example.com/#section")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a bare trailing query delimiter", () => {
    expect(validatePublicUrl("https://vault.example.com/?")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a bare trailing hash delimiter", () => {
    expect(validatePublicUrl("https://vault.example.com/#")).toEqual({
      kind: "error",
      message: "PUBLIC_URL must be a bare origin — no query string (?...) or fragment (#...).",
    })
  })

  it("rejects a URL with a path prefix", () => {
    expect(validatePublicUrl("https://vault.example.com/vault/")).toEqual({
      kind: "error",
      message:
        "PUBLIC_URL must be a bare origin — no path (e.g. https://vault.example.com, not https://vault.example.com/vault/).",
    })
  })

  it("accepts a bare origin with redundant trailing slashes", () => {
    expect(validatePublicUrl("https://vault.example.com//")).toEqual({
      kind: "ok",
      url: "https://vault.example.com",
    })
  })
})

// ── Instance names ────────────────────────────────────────────────────────────

/** A running daemon on a host where these container and volume names already exist. */
const dockerWithExisting = (existingNames: ReadonlyArray<string>): DockerRunner => {
  return {
    ...dockerDaemonOnly,
    containerExists: (instanceName) => existingNames.includes(instanceName),
    volumeExists: (volumeName) => existingNames.includes(volumeName),
  }
}

const readEnvLines = (targetDir: string): string[] => {
  return readFileSync(join(targetDir, ".env"), "utf8").split("\n")
}

const IDENTITY_KEYS = ["PUBLIC_URL", "INSTANCE_NAME", "PORT", "DEVICE_NAME"]

/**
 * Every active identity line in the written .env, in file order. The file also
 * holds a random token, so these lines stand in for the whole file; listing
 * them all catches a duplicate or leftover default line.
 */
const readIdentityLines = (targetDir: string): string[] => {
  return readEnvLines(targetDir).filter((line) => {
    return IDENTITY_KEYS.some((key) => line.startsWith(`${key}=`))
  })
}

const IN_USE_QUESTION =
  'An install named "vault-cortex" already exists on this machine (its container or data volumes are here). What should this install do?'
const NAME_QUESTION = "Name for this install (lowercase letters, digits, - and _):"
const PORT_QUESTION = "Host port for the server:"
const nameCheckSkippedWarning = (instanceName: string): string => {
  return (
    `Docker isn't running, so init can't check whether another install on this machine already uses the name "${instanceName}".\n` +
    "If one does, give this install its own INSTANCE_NAME and PORT in its .env before you start it."
  )
}
const REPLACE_START_QUESTION =
  'Start the server now? This stops and replaces the existing "vault-cortex" container. Its data volumes are kept.'

describe("runInit when the instance name is already in use", () => {
  it("gives a local install its own name and port, with PUBLIC_URL on that port", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "own-name",
      "work",
      "8001",
      [], // no optional settings
      false, // don't start now
    ])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual([
      IN_USE_QUESTION,
      NAME_QUESTION,
      PORT_QUESTION,
      "Any optional settings to change? (press enter to skip)",
      "Start the server now?",
    ])
    // The install using the default name most likely holds port 8000.
    expect(scripted.textCalls[1]).toEqual({
      message: PORT_QUESTION,
      defaultValue: "8001",
      placeholder: "8001",
    })
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8001",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
    // The chooser reads the identity, so a picked Host port starts from 8001.
    const portOption = scripted.multiselectCalls[0].options.find(
      (option) => option.value === "PORT",
    )
    expect(portOption?.hint).toBe("PORT · currently 8001")
    expect(scripted.prints[0]).toContain(
      "claude mcp add --scope user --transport http work http://localhost:8001/mcp\n",
    )
  })

  it("gives a remote install its own name, port and device name before asking the URL", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "own-name",
      "work",
      "8001",
      "https://work.example.com", // public URL
      "Work", // vault name
      false, // don't generate the token now
      false, // no encryption
      [], // no optional settings
      false, // don't start the server
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked.slice(0, 4)).toEqual([
      IN_USE_QUESTION,
      NAME_QUESTION,
      PORT_QUESTION,
      "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
    ])
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=https://work.example.com",
      "INSTANCE_NAME=work",
      "PORT=8001",
      "DEVICE_NAME=work",
    ])
  })

  it("gives a remote install the device name of a free --instance-name", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://work.example.com", // public URL
      "Work", // vault name
      false, // don't generate the token now
      false, // no encryption
      [], // no optional settings
      false, // don't start the server
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir, instanceName: "work", port: "8001" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked[0]).toBe(
      "Public base URL clients will use to reach this server (no /mcp — it's added for you):",
    )
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=https://work.example.com",
      "INSTANCE_NAME=work",
      "PORT=8001",
      "DEVICE_NAME=work",
    ])
  })

  it.each([
    { label: "the default port", port: "8000" },
    { label: "another port", port: "8001" },
  ])("asks the port of the install whose data is reused, and writes $label", async ({ port }) => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts(["reuse", port, [], false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual([
      IN_USE_QUESTION,
      PORT_QUESTION,
      "Any optional settings to change? (press enter to skip)",
      REPLACE_START_QUESTION,
    ])
    expect(readIdentityLines(targetDir)).toEqual([
      `PUBLIC_URL=http://localhost:${port}`,
      "INSTANCE_NAME=vault-cortex",
      `PORT=${port}`,
    ])
  })

  it("asks the port when --instance-name reuses an install without --yes or --port", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts(["8002", [], false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir, instanceName: "work" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked[0]).toBe(PORT_QUESTION)
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8002",
      "INSTANCE_NAME=work",
      "PORT=8002",
    ])
  })

  it("replaces the existing container when the user reuses its data and starts now", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts(["reuse", "8000", [], true])
    const recording = createRecordingDocker()

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      { prompts: scripted.prompts, docker: recording.docker, fetchFn: fetchOk },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked.at(-1)).toBe(REPLACE_START_QUESTION)
    expect(recording.calls).toEqual([
      "inspect:vault-cortex",
      "inspect:vault-cortex",
      "rm:vault-cortex",
      "run:vault-cortex",
    ])
  })

  it("starts nothing when the existing container can't be removed", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts(["reuse", "8000", [], true])
    const recording = createRecordingDocker()
    const docker: DockerRunner = { ...recording.docker, stopAndRemoveContainer: () => false }

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      { prompts: scripted.prompts, docker, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toEqual([
      "Could not remove the existing container — check: docker rm -f vault-cortex",
    ])
    expect(recording.calls).toEqual(["inspect:vault-cortex", "inspect:vault-cortex"])
  })

  it("counts a remote install as in use when only its vault volume is left", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "reuse",
      "8000",
      "https://vault.example.com",
      "MyVault",
      false,
      false,
      [],
      false,
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex_vault_data"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked[0]).toBe(IN_USE_QUESTION)
  })

  it("suggests the folder name and re-asks for an invalid or in-use name", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "own-name",
      "Work Vault", // invalid
      "out-taken", // in use
      "work",
      "8001",
      [],
      false,
    ])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "out-taken"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.textCalls[0]).toEqual({
      message: NAME_QUESTION,
      defaultValue: "out",
      placeholder: "out",
    })
    expect(scripted.errors).toEqual([
      '"Work Vault" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit.',
      '"out-taken" is already in use on this machine — pick another name.',
    ])
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8001",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
  })

  it("suggests no name when the folder's name is the one in use", async () => {
    const vaultDir = makeVault()
    const targetDir = join(makeTargetDir(), "vault-cortex")
    const scripted = createScriptedPrompts(["own-name", "work", "8001", [], false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.textCalls[0]).toEqual({
      message: NAME_QUESTION,
      defaultValue: undefined,
      placeholder: "work",
    })
  })

  it("skips the check when the Docker daemon is not running", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([[]])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: { ...dockerWithExisting(["vault-cortex"]), daemonStatus: () => "not-running" },
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).toEqual(["Any optional settings to change? (press enter to skip)"])
  })
})

describe("runInit --yes when the instance name is already in use", () => {
  it("exits 1 without --instance-name and writes nothing", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(existsSync(targetDir)).toBe(false)
    expect(scripted.errors).toEqual([
      'An install named "vault-cortex" already exists on this machine (its container or data volumes are here).\n' +
        "Re-run with --instance-name <name> (and --port <port> if vault-cortex's port is taken) to give this install its own name,\n" +
        "or with --instance-name vault-cortex (and --port <port> unless that install uses 8000) to reuse its data for the same vault.",
    ])
  })

  it("gives the install the free name from --instance-name, with --port and PUBLIC_URL on it", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: targetDir, instanceName: "work", port: "8001" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.logs).not.toContain('Reusing the data of the existing "work" install.')
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8001",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
  })

  it.each([
    { label: "the default name", instanceName: "vault-cortex" },
    { label: "a custom name", instanceName: "work" },
  ])("reuses an occupied $label named by --instance-name", async ({ instanceName }) => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: vaultDir, dir: targetDir, instanceName },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting([instanceName]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.logs).toContain(`Reusing the data of the existing "${instanceName}" install.`)
    expect(readEnvInstanceName(join(targetDir, ".env"))).toEqual({ kind: "ok", instanceName })
  })

  it("gives a remote install reusing a name from --instance-name that name as its device name", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://work.example.com", // public URL
      "Work", // vault name
      false, // don't generate the token now
      false, // no encryption
      [], // no optional settings
      false, // don't start the server
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir, instanceName: "work", port: "8001" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.logs).toContain('Reusing the data of the existing "work" install.')
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=https://work.example.com",
      "INSTANCE_NAME=work",
      "PORT=8001",
      "DEVICE_NAME=work",
    ])
  })

  it.each([
    {
      label: "an invalid --instance-name",
      flags: { instanceName: "Work" },
      expectedError:
        '--instance-name: "Work" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit.',
    },
    {
      label: "an empty --instance-name",
      flags: { instanceName: "" },
      expectedError:
        '--instance-name: "" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit.',
    },
    {
      label: "an invalid --port",
      flags: { port: "80a" },
      expectedError: "--port must be a whole number between 1 and 65535.",
    },
    {
      label: "an empty --port",
      flags: { port: "" },
      expectedError: "--port must be a whole number between 1 and 65535.",
    },
  ])("exits 1 on $label", async ({ flags, expectedError }) => {
    const scripted = createScriptedPrompts([])

    const exitCode = await runInit(
      { yes: true, vaultPath: makeVault(), dir: makeTargetDir(), ...flags },
      { prompts: scripted.prompts, docker: dockerReadyEmptyHost, fetchFn: fetchNever },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([expectedError])
  })
})

describe("runInit re-run keeps the instance identity", () => {
  const writeExistingLocalEnv = (targetDir: string, vaultDir: string): void => {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nINSTANCE_NAME=work\nPORT=8001\nPUBLIC_URL=http://localhost:8001\n`,
    )
  }

  it("keeps the name, port and URL of a local install when the new file overwrites it", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    writeExistingLocalEnv(targetDir, vaultDir)
    const scripted = createScriptedPrompts([
      true, // re-run setup anyway
      [], // no optional settings
      true, // overwrite the existing file
      false, // don't start now
    ])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain(IN_USE_QUESTION)
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8001",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
    expect(readEnvLines(targetDir)).not.toContain("MCP_AUTH_TOKEN=old")
  })

  it("points a generated PUBLIC_URL at the carried port when the old file has none", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nINSTANCE_NAME=work\nPORT=8001\n`,
    )
    const scripted = createScriptedPrompts([
      true, // re-run setup anyway
      [], // no optional settings
      true, // overwrite the existing file
      false, // don't start now
    ])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8001",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
  })

  it("points a generated PUBLIC_URL at a quoted carried port without its quotes", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nINSTANCE_NAME=work\nPORT="8001"\n`,
    )
    const scripted = createScriptedPrompts([true, [], true, false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8001",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
  })

  it("warns when a re-run's chosen port leaves a custom PUBLIC_URL as it was", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nINSTANCE_NAME=work\nPORT=8001\nPUBLIC_URL=https://vault.example.com\n`,
    )
    const scripted = createScriptedPrompts([
      true, // re-run setup anyway
      ["PORT"], // change the host port
      "9001",
      true, // overwrite the existing file
      false, // don't start now
    ])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=https://vault.example.com",
      "INSTANCE_NAME=work",
      "PORT=9001",
    ])
    expect(scripted.warnings).toEqual([
      "PORT changed — make sure PUBLIC_URL (https://vault.example.com) still reaches the server.",
    ])
  })

  it("keeps a custom PUBLIC_URL carried beside a changed port", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nINSTANCE_NAME=work\nPORT=8001\nPUBLIC_URL=https://vault.example.com\n`,
    )
    const scripted = createScriptedPrompts([true, [], true, false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=https://vault.example.com",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
  })

  it("refuses a re-run whose --instance-name renames the install, and keeps its file", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    writeExistingLocalEnv(targetDir, vaultDir)
    const existingEnv = readFileSync(join(targetDir, ".env"), "utf8")
    const scripted = createScriptedPrompts([true]) // re-run setup anyway

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir, instanceName: "other" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `--instance-name: the install in ${targetDir} is named "work", and init keeps that name.\n` +
        `To rename it, stop it first (npx vault-cortex@latest down --dir "${targetDir}"), then change INSTANCE_NAME in its .env\n` +
        "to a name no other install uses: it starts on new, empty volumes under the new name.",
    ])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(existingEnv)
  })

  it("reports an invalid kept name instead of the rename steps when --instance-name differs", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nINSTANCE_NAME=Work Vault\n`,
    )
    const scripted = createScriptedPrompts([true]) // re-run setup anyway

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir, instanceName: "work" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting([]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `INSTANCE_NAME "Work Vault" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit. Fix it in ${targetDir}/.env.`,
    ])
  })

  it("stops a re-run whose kept PORT is not a port, before asking anything more", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    const existingEnv = `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nPORT=80a\n`
    writeFileSync(join(targetDir, ".env"), existingEnv)
    const scripted = createScriptedPrompts([true]) // re-run setup anyway

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting([]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `PORT "80a" is not a valid port — use a whole number between 1 and 65535. Fix it in ${targetDir}/.env.`,
    ])
    expect(scripted.asked).toHaveLength(1)
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(existingEnv)
  })

  it("warns when --port moves a re-run off the port its custom PUBLIC_URL serves", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nPUBLIC_URL=https://vault.example.com\n`,
    )
    // re-run anyway, no optional settings, overwrite .env, don't start
    const scripted = createScriptedPrompts([true, [], true, false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir, port: "9000" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting([]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.warnings).toEqual([
      "PORT changed — make sure PUBLIC_URL (https://vault.example.com) still reaches the server.",
    ])
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=https://vault.example.com",
      "INSTANCE_NAME=vault-cortex",
      "PORT=9000",
    ])
  })

  it("lets --port replace a kept PORT that is not a port, moving the localhost PUBLIC_URL with it", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nPORT=80a\nPUBLIC_URL=http://localhost:80a\n`,
    )
    // re-run anyway, no optional settings, overwrite .env, don't start
    const scripted = createScriptedPrompts([true, [], true, false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir, port: "9000" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting([]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toEqual([])
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:9000",
      "INSTANCE_NAME=vault-cortex",
      "PORT=9000",
    ])
  })

  it("accepts a re-run whose --instance-name repeats the install's name", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    writeExistingLocalEnv(targetDir, vaultDir)
    const scripted = createScriptedPrompts([true, [], true, false])

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir, instanceName: "work" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.errors).toEqual([])
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=http://localhost:8001",
      "INSTANCE_NAME=work",
      "PORT=8001",
    ])
  })

  it("prints commands for the kept file's port, not this run's --port", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    writeExistingLocalEnv(targetDir, vaultDir)
    const scripted = createScriptedPrompts([
      true, // re-run setup anyway
      [], // no optional settings
      false, // keep the existing file
      false, // don't start now
    ])

    // --port makes this run's generated .env differ from the kept one, so the
    // printed commands show which file they were read from.
    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir, port: "8002" },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(readEnvLines(targetDir)).toContain("MCP_AUTH_TOKEN=old")
    expect(scripted.prints[0]).toContain(
      "claude mcp add --scope user --transport http work http://localhost:8001/mcp\n",
    )
  })

  it("keeps the name, port and device name of a remote install", async () => {
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, ".env"),
      "MCP_AUTH_TOKEN=old\nOBSIDIAN_AUTH_TOKEN=sync-token\nVAULT_NAME=Work\nPUBLIC_URL=https://work.example.com\nINSTANCE_NAME=work\nPORT=8001\nDEVICE_NAME=work-sync\n",
    )
    const scripted = createScriptedPrompts([
      true, // re-run setup anyway
      "https://new.example.com", // a remote PUBLIC_URL is asked again, not carried
      "Work",
      false, // don't generate a new token
      false, // no encryption
      [], // no optional settings
      true, // overwrite the existing file
      false, // don't start now
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithExisting(["vault-cortex", "work"]),
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain(IN_USE_QUESTION)
    expect(readIdentityLines(targetDir)).toEqual([
      "PUBLIC_URL=https://new.example.com",
      "INSTANCE_NAME=work",
      "PORT=8001",
      "DEVICE_NAME=work-sync",
    ])
  })

  it("stops before asking anything more when the kept file's INSTANCE_NAME is invalid", async () => {
    const vaultDir = makeVault()
    const targetDir = makeTargetDir()
    mkdirSync(targetDir, { recursive: true })
    const existingEnv = `MCP_AUTH_TOKEN=old\nVAULT_PATH=${vaultDir}\nINSTANCE_NAME=Work Vault\n`
    writeFileSync(join(targetDir, ".env"), existingEnv)
    const dockerRun = vi.fn(() => true)
    const scripted = createScriptedPrompts([true]) // re-run setup anyway

    const exitCode = await runInit(
      { mode: "local", vaultPath: vaultDir, dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: { ...dockerReadyEmptyHost, dockerRun },
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(1)
    expect(scripted.errors).toEqual([
      `INSTANCE_NAME "Work Vault" is not a valid instance name — use at least two lowercase letters, digits, hyphens or underscores, starting with a letter or digit. Fix it in ${targetDir}/.env.`,
    ])
    expect(scripted.asked).toEqual(["Re-run setup for this directory anyway?"])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(existingEnv)
    expect(scripted.prints).toEqual([])
    expect(dockerRun).not.toHaveBeenCalled()
  })
})

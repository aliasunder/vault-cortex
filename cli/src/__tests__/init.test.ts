import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

import { runInit } from "../init.js"
import type { DockerRunner } from "../docker.js"
import type { Prompts } from "../prompts.js"

type ScriptedAnswer = string | boolean

type SelectCall = { message: string; initialValue: string }

/**
 * A Prompts stub that replays canned answers in order and records what was
 * asked — lets the tests assert the exact prompt sequence per flow.
 */
const createScriptedPrompts = (answers: ScriptedAnswer[]) => {
  const remaining = [...answers]
  const asked: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const logs: string[] = []
  const notes: string[] = []
  const prints: string[] = []
  const selectCalls: SelectCall[] = []

  const nextAnswer = (message: string): ScriptedAnswer => {
    asked.push(message)
    const answer = remaining.shift()
    if (answer === undefined)
      throw new Error(`No scripted answer for prompt: ${message}`)
    return answer
  }

  const prompts: Prompts = {
    intro: () => {},
    outro: () => {},
    note: (message) => {
      notes.push(message)
    },
    print: (message) => {
      prints.push(message)
    },
    log: (message) => {
      logs.push(message)
    },
    warn: (message) => {
      warnings.push(message)
    },
    error: (message) => {
      errors.push(message)
    },
    select: async (message, _options, initialValue) => {
      selectCalls.push({ message, initialValue })
      return String(nextAnswer(message))
    },
    text: async (message, options) => {
      const answer = String(nextAnswer(message))
      // Mirrors @clack/prompts: an empty submission resolves to defaultValue.
      if (answer === "" && options?.defaultValue !== undefined)
        return options.defaultValue
      return answer
    },
    password: async (message) => String(nextAnswer(message)),
    confirm: async (message, _initialValue) => Boolean(nextAnswer(message)),
    spinner: () => ({ start: () => {}, stop: () => {} }),
  }

  return {
    prompts,
    asked,
    errors,
    warnings,
    logs,
    notes,
    prints,
    selectCalls,
    remaining,
  }
}

const dockerUnavailable: DockerRunner = {
  isDaemonRunning: () => false,
  dockerRun: () => false,
  pullImage: () => false,
  stopAndRemoveContainer: () => false,
  runObsidianLogin: () => false,
}

const fetchNever: typeof fetch = async () => {
  throw new Error("fetch must not be called in these tests")
}

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
      docker: dockerUnavailable,
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
        docker: dockerUnavailable,
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
      "Optional settings (timezone, memory folder, port, logging) are commented",
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
        docker: dockerUnavailable,
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
        docker: dockerUnavailable,
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
        docker: dockerUnavailable,
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
        docker: dockerUnavailable,
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
        docker: dockerUnavailable,
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
      "", // blank sync token — fill in .env later
      false, // no encryption
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: makeTargetDir() },
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    const connectMessage = scripted.prints.find((message) =>
      message.includes("Connect your MCP client"),
    )
    expect(connectMessage).toBeDefined()
    return connectMessage as string
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
      "", // blank sync token — fill in .env later
      false, // no encryption
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
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
      "", // blank sync token — fill in .env later
      false, // no encryption
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
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
      "", // blank sync token — fill in .env later
      false, // no encryption
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
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
    const scripted = createScriptedPrompts(["local", vaultDir, makeTargetDir()])

    await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
        fetchFn: fetchNever,
      },
    )

    expect(scripted.selectCalls).toEqual([
      {
        message: "How do you want to run Vault Cortex?",
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
    ])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
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
    const scripted = createScriptedPrompts(["local", vaultDir, targetDir])
    const dockerDaemonDown: DockerRunner = {
      ...dockerUnavailable,
      isDaemonRunning: () => false,
    }

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerDaemonDown,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain("Start the server now?")
    expect(scripted.warnings).toHaveLength(1)
    expect(scripted.warnings[0]).toContain("Container runtime not running")
  })

  it("asks for confirmation on a folder without .obsidian and proceeds on yes", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "vault-cli-plain-"))
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts(["local", plainDir, true, targetDir])

    const exitCode = await runInit(
      {},
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
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
      false, // don't start the server
    ])
    const dockerReady: DockerRunner = {
      ...dockerUnavailable,
      isDaemonRunning: () => true,
    }

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
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
      "Start the server now?",
    ])
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false)
    const envContent = readFileSync(join(targetDir, ".env"), "utf8")
    expect(envContent).toContain("PUBLIC_URL=https://vault.example.com\n")
    expect(envContent).toContain("VAULT_NAME=MyVault\n")
    expect(envContent).toContain("OBSIDIAN_AUTH_TOKEN=sync-token-xyz\n")
    expect(scripted.prints[0]).toContain("Optional settings (timezone, memory")
  })

  it("skips paste prompt when auto-capture succeeds", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com",
      "MyVault",
      true, // generate the token now
      false, // no end-to-end encryption
      false, // don't start the server
    ])
    const dockerWithCapture: DockerRunner = {
      ...dockerUnavailable,
      isDaemonRunning: () => true,
      runObsidianLogin: (configMountPath) => {
        const tokenDir = join(configMountPath, "obsidian-headless")
        mkdirSync(tokenDir, { recursive: true })
        writeFileSync(join(tokenDir, "auth_token"), "captured-token")
        return true
      },
    }

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithCapture,
        fetchFn: fetchNever,
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

  it("skips the docker-run offer when the sync token was left blank", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "http://203.0.113.10:8000",
      "MyVault",
      "", // blank token — fill in later (Docker unavailable, no capture offer)
      false, // no encryption
    ])

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
        fetchFn: fetchNever,
      },
    )

    expect(exitCode).toBe(0)
    expect(scripted.asked).not.toContain("Start the server now?")
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toMatch(
      /^OBSIDIAN_AUTH_TOKEN=$/m,
    )
  })
})

describe("runInit with a kept existing .env", () => {
  const keepEnvAnswers = (vaultDir: string, targetDir: string) => [
    "local",
    vaultDir,
    targetDir,
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
        docker: dockerUnavailable,
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
    const dockerReady: DockerRunner = {
      isDaemonRunning: () => true,
      dockerRun: () => true,
      pullImage: () => true,
      stopAndRemoveContainer: () => true,
      runObsidianLogin: () => false,
    }
    const fetchedUrls: string[] = []
    const fetchRecorder: typeof fetch = async (url) => {
      fetchedUrls.push(String(url))
      return { ok: true } as Response
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
    const scripted = createScriptedPrompts(["local", vaultDir, targetDir])

    const exitCode = await runInit(
      { vaultPath: missingPath },
      {
        prompts: scripted.prompts,
        docker: dockerUnavailable,
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
      false, // don't start the server
    ])
    const dockerReady: DockerRunner = {
      isDaemonRunning: () => true,
      dockerRun: () => false,
      pullImage: () => false,
      stopAndRemoveContainer: () => false,
      runObsidianLogin: () => false,
    }

    const exitCode = await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerReady,
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

describe("runInit sync-token auto-capture fallback", () => {
  it("falls back to paste prompt when auto-capture fails", async () => {
    const targetDir = makeTargetDir()
    const scripted = createScriptedPrompts([
      "https://vault.example.com",
      "MyVault",
      true, // try to generate the token
      "", // paste fallback — blank token, fill in later
      false, // no encryption
    ])
    const dockerWithFailingCapture: DockerRunner = {
      isDaemonRunning: () => true,
      dockerRun: () => false,
      pullImage: () => false,
      stopAndRemoveContainer: () => false,
      runObsidianLogin: () => false,
    }

    await runInit(
      { mode: "remote", dir: targetDir },
      {
        prompts: scripted.prompts,
        docker: dockerWithFailingCapture,
        fetchFn: fetchNever,
      },
    )

    expect(scripted.asked).toContain(
      "Paste the Obsidian Sync token (leave blank to fill in .env later):",
    )
    expect(scripted.warnings[0]).toContain(
      "The Obsidian login did not complete",
    )
  })
})

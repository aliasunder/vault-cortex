// PTY test harness — simulates a user running the CLI in a real terminal,
// watching for prompts and sending keystrokes in response.

import { createRequire } from "node:module"
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { onTestFinished } from "vitest"

const require = createRequire(import.meta.url)

const pty: typeof import("node-pty") = require("node-pty")

const thisDir = fileURLToPath(new URL(".", import.meta.url))
const FIXTURES_DIR = resolve(thisDir, "fixtures")
const CLI_BIN = resolve(thisDir, "../../bin.ts")

type PtyPrompt = { match: string; send: string; label: string }

type PtyOptions = {
  args: string[]
  workDir: string
  timeoutMs?: number
  prompts: PtyPrompt[]
  env?: Record<string, string>
}

type PtyResult = {
  exitCode: number
  promptsAnswered: number
  totalPrompts: number
  transcript: string
}

const stripAnsi = (text: string): string =>
  text.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B\[[?]?[0-9;]*[a-zA-Z]/g,
    "",
  )

/**
 * Produce a readable transcript from raw PTY output. Clack redraws
 * on every keystroke ("/█ /p█ /pa█ …") — we keep only the text
 * after the last cursor. Spinner animations (◒◐◓◑) get collapsed
 * to one frame.
 */
const SPINNER_GLYPHS = /(?=[◒◐◓◑⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/
const cleanTranscript = (strippedOutput: string): string => {
  const cleanedLines = strippedOutput.split("\n").flatMap((line) => {
    // Per-keystroke echo: everything before the last block cursor is a
    // stale partial render — the final state follows it.
    const cursorTrimmed = line.includes("█")
      ? line.slice(line.lastIndexOf("█") + 1)
      : line
    if (line.includes("█") && cursorTrimmed.trim() === "") return []
    // Spinner frames: identical text re-rendered behind a rotating
    // glyph — keep the first of each consecutive identical fragment.
    const fragments = cursorTrimmed.split(SPINNER_GLYPHS)
    const withoutRepeats = fragments.filter(
      (fragment, index) =>
        index === 0 ||
        fragment.slice(1).trim() !== fragments[index - 1]?.slice(1).trim(),
    )
    return [withoutRepeats.join("")]
  })
  return cleanedLines.join("\n")
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/**
 * Run the CLI in a real PTY with the fake docker shim on PATH,
 * answering prompts in order as they appear on screen.
 */
const drivePty = (options: PtyOptions): Promise<PtyResult> => {
  const {
    args,
    workDir,
    timeoutMs = 30_000,
    prompts,
    env: extraEnv = {},
  } = options

  return new Promise<PtyResult>((resolvePromise) => {
    let fullOutput = ""
    let buffer = ""
    let promptIndex = 0
    let settled = false
    let exited = false

    const npxPath = process.env.NVM_BIN ? `${process.env.NVM_BIN}/npx` : "npx"

    const envEntries = Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    )
    const childEnv: Record<string, string> = {
      ...Object.fromEntries(envEntries),
      // Fake docker shim first on PATH so the CLI finds it
      PATH: `${FIXTURES_DIR}:${process.env.PATH}`,
      ...extraEnv,
    }

    const child = pty.spawn(npxPath, ["tsx", CLI_BIN, ...args], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: workDir,
      env: childEnv,
    })

    const finish = (exitCode: number): void => {
      if (exited) return
      exited = true
      clearTimeout(timeoutHandle)
      const strippedOutput = stripAnsi(fullOutput)
      resolvePromise({
        exitCode,
        promptsAnswered: promptIndex,
        totalPrompts: prompts.length,
        transcript: cleanTranscript(strippedOutput),
      })
    }

    // Watch terminal output for the next expected prompt. Prompts are
    // matched in order; after answering one we clear the buffer and
    // look for the next. The settled flag prevents double-answering
    // while we wait for the prompt to finish rendering.
    child.onData(async (data: string) => {
      fullOutput += data
      buffer += data
      if (promptIndex >= prompts.length || settled) return
      const cleanBuffer = stripAnsi(buffer)
      const currentPrompt = prompts[promptIndex]
      if (currentPrompt && cleanBuffer.includes(currentPrompt.match)) {
        settled = true
        await sleep(400)
        child.write(currentPrompt.send)
        promptIndex++
        buffer = ""
        settled = false
      }
    })

    child.onExit(({ exitCode }: { exitCode: number }) => {
      finish(exitCode)
    })

    // Kill the process if it hangs waiting for a prompt we didn't expect
    const timeoutHandle = setTimeout(() => {
      if (!exited) {
        child.kill()
        finish(1)
      }
    }, timeoutMs)
  })
}

/**
 * Fresh workspace: a vault with .obsidian/ (so the CLI recognizes
 * it) and a config dir for the CLI's output files.
 */
const createPtyWorkDir = (): { vaultDir: string; configDir: string } => {
  const tempDir = mkdtempSync(join(tmpdir(), "pty-cli-"))
  const vaultDir = join(tempDir, "vault")
  const configDir = join(tempDir, "config")

  cpSync(join(FIXTURES_DIR, ".obsidian"), join(vaultDir, ".obsidian"), {
    recursive: true,
  })

  onTestFinished(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  return { vaultDir, configDir }
}

/** Simulate an already-initialized deployment for lifecycle commands. */
const seedEnv = (configDir: string): void => {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, ".env"),
    "MCP_AUTH_TOKEN=test-token\nVAULT_PATH=/tmp/vault\nPUBLIC_URL=http://localhost:8000\n",
  )
}

/** Stop the fake health server the docker shim starts on "docker run". */
const killHealthServer = (pidFile: string): void => {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    if (!Number.isNaN(pid)) {
      process.kill(pid, "SIGTERM")
    }
  } catch (error: unknown) {
    const hasCode =
      typeof error === "object" && error !== null && "code" in error
    if (hasCode && error.code !== "ENOENT" && error.code !== "ESRCH")
      throw error
    if (!hasCode) throw error
  }
}

export { drivePty, createPtyWorkDir, seedEnv, killHealthServer }
export type { PtyPrompt, PtyOptions, PtyResult }

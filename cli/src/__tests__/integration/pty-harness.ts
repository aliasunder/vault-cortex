// PTY test harness — spawns the CLI in a real pseudo-terminal and drives
// interactive prompts via sequential match/send pairs. Ported from the
// pty-cli-driver's proven patterns (ANSI stripping, settled flag,
// render-settle delay, transcript cleaning).

import { createRequire } from "node:module"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { onTestFinished } from "vitest"

const require = createRequire(import.meta.url)

const pty = require("node-pty") as typeof import("node-pty")

const FIXTURES_DIR = resolve(new URL(".", import.meta.url).pathname, "fixtures")

const CLI_BIN = resolve(new URL(".", import.meta.url).pathname, "../../bin.ts")

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

/** Strip ANSI escape codes for prompt matching. */
const stripAnsi = (text: string): string =>
  text.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B\[[?]?[0-9;]*[a-zA-Z]/g,
    "",
  )

/**
 * Clean per-keystroke echo redraws and spinner frame repeats from
 * stripped transcript output so the result reads like a human would
 * see the final state.
 */
const SPINNER_GLYPHS = /(?=[◒◐◓◑⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/
const cleanTranscript = (strippedOutput: string): string => {
  const cleanedLines = strippedOutput.split("\n").flatMap((line) => {
    const cursorTrimmed = line.includes("█")
      ? line.slice(line.lastIndexOf("█") + 1)
      : line
    if (line.includes("█") && cursorTrimmed.trim() === "") return []
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
 * Spawn the CLI in a real PTY and drive its interactive prompts.
 *
 * The fixtures directory is prepended to PATH so the docker-shim
 * shadows the real docker binary. The NVM_BIN-resolved npx is used
 * to run tsx against the CLI source.
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

    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
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
      const strippedOutput = stripAnsi(fullOutput)
      resolvePromise({
        exitCode,
        promptsAnswered: promptIndex,
        totalPrompts: prompts.length,
        transcript: cleanTranscript(strippedOutput),
      })
    }

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

    setTimeout(() => {
      if (!exited) {
        child.kill()
        finish(1)
      }
    }, timeoutMs)
  })
}

/**
 * Create a temp working directory with a vault subdirectory that
 * contains the .obsidian fixture, and a config subdirectory for
 * the CLI's output files. Registers cleanup via onTestFinished.
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

/**
 * Kill the background health server started by the docker shim.
 * Reads the PID from the file the shim writes, then sends SIGTERM.
 */
const killHealthServer = (pidFile: string): void => {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    if (!Number.isNaN(pid)) {
      process.kill(pid, "SIGTERM")
    }
  } catch {
    // PID file doesn't exist or process already gone — fine
  }
}

export { drivePty, createPtyWorkDir, killHealthServer }
export type { PtyPrompt, PtyOptions, PtyResult }

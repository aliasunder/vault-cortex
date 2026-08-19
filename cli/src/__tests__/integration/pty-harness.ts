// PTY test harness — spawns the CLI in a real pseudo-terminal and drives
// interactive prompts via sequential match/send pairs. Ported from the
// pty-cli-driver's proven patterns (ANSI stripping, settled flag,
// render-settle delay, transcript cleaning).

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
 *
 * Clack redraws the active line on every keystroke, producing runs like
 * "/█ /p█ /pr█ …" after ANSI stripping. Spinners likewise append one
 * glyph-prefixed fragment per frame. This function:
 *
 * 1. Trims everything before the last block cursor on each line (the
 *    final state follows it); lines that are purely cursor redraws with
 *    no trailing content are dropped entirely.
 * 2. Deduplicates consecutive spinner fragments that share the same
 *    text after the leading glyph.
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

    // npx may not be on PATH inside the PTY child's shell init —
    // resolve explicitly via NVM_BIN when available.
    const npxPath = process.env.NVM_BIN ? `${process.env.NVM_BIN}/npx` : "npx"

    // Filter undefined values from process.env so the child env
    // satisfies Record<string, string> without a type assertion.
    const envEntries = Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    )
    const childEnv: Record<string, string> = {
      ...Object.fromEntries(envEntries),
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

    // Idempotent — called from both onExit (normal) and the timeout
    // (hang). The exited flag ensures the promise resolves exactly once.
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

    // Sequential prompt matching: prompts fire in order. The buffer
    // resets after each match so a matched prompt can't re-fire. The
    // settled flag blocks re-entry while the 400ms render-settle sleep
    // is pending (onData fires frequently during Clack redraws).
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

    const timeoutHandle = setTimeout(() => {
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

/** Seed a minimal local-mode .env so lifecycle commands find an initialized deployment. */
const seedEnv = (configDir: string): void => {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, ".env"),
    "MCP_AUTH_TOKEN=test-token\nVAULT_PATH=/tmp/vault\nPUBLIC_URL=http://localhost:8000\n",
  )
}

/**
 * Kill the background health server started by the docker shim.
 * Reads the PID from the file the shim writes, then sends SIGTERM.
 */
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

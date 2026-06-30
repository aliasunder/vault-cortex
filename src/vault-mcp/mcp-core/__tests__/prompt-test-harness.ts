/** Shared test utilities for prompt group tests — types, fixtures, and
 *  harnesses used across vault-orientation, memory-review, and daily-review. */

import { vi, onTestFinished } from "vitest"
import { DateTime } from "luxon"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { registerPrompts } from "../prompt-definitions.js"
import { loadConfig } from "../../config.js"
import {
  createSearchIndex,
  type SearchIndex,
} from "../../search/search-index.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { logger, type Logger } from "../../../logger.js"

// ── Types ───────────────────────────────────────────────────────

// A captured registerPrompt(name, config, handler) call. The handler arity
// varies: vault-orientation is (extra) =>, the others are (args, extra) =>.
// Both params are optional so a single capture type covers both shapes.
export type PromptConfig = {
  title?: string
  description?: string
  argsSchema?: Record<string, unknown>
}
export type PromptResult = {
  messages: Array<{ role: string; content: { type: string; text: string } }>
}
export type PromptExtra = { requestId?: string }
export type PromptHandler = (
  argsOrExtra?: Record<string, unknown> | PromptExtra,
  extra?: PromptExtra,
) => Promise<PromptResult>
export type RegisterPromptCall = [
  name: string,
  config: PromptConfig,
  handler: PromptHandler,
]

export const fakeExtra: PromptExtra = { requestId: "1" }

// ── Recording logger ────────────────────────────────────────────

// A logger that records every call into a sink, merging child props the way the
// real logger does — so tests can assert on emitted events and their level.
export type LogCall = {
  level: "debug" | "info" | "warn" | "error"
  message: string
  data: Record<string, unknown>
}
export const recordingLogger = (sink: LogCall[]): Logger => {
  const make = (props: Record<string, unknown>): Logger => ({
    debug: (message, data = {}) =>
      sink.push({ level: "debug", message, data: { ...props, ...data } }),
    info: (message, data = {}) =>
      sink.push({ level: "info", message, data: { ...props, ...data } }),
    warn: (message, data = {}) =>
      sink.push({ level: "warn", message, data: { ...props, ...data } }),
    error: (message, data = {}) =>
      sink.push({ level: "error", message, data: { ...props, ...data } }),
    child: (childProps) => make({ ...props, ...childProps }),
  })
  return make({})
}

// ── Fixtures ────────────────────────────────────────────────────

// Self-documenting epoch ms for daily-review tests — midday on 2026-06-16
// in the system timezone, matching the modifiedOnDate TZ-aware behavior.
export const JUNE_16_MIDDAY_MS = DateTime.fromISO(
  "2026-06-16T12:00:00",
).toMillis()

// Indexed notes in distinct folders so folder derivation, tags, property
// keys, and recent-notes all have something to surface.
export const FIXTURE_NOTES: ReadonlyArray<{
  path: string
  content: string
  mtime: number
}> = [
  {
    path: "Projects/alpha.md",
    content: `---\ntitle: Alpha\ntype: project\ntags:\n  - project\nstatus: active\n---\n# Alpha\n\nProject alpha notes.\n`,
    mtime: 3000,
  },
  {
    path: "Reference/bravo.md",
    content: `---\ntitle: Bravo\ntype: reference\ntags:\n  - reference\n---\n# Bravo\n\nReference bravo notes.\n`,
    mtime: 2000,
  },
]

export const PRINCIPLES_MD = `---\ntitle: Principles\ntype: profile\ntags:\n  - memory\n  - principles\n---\n\n# Principles\n\n## Decision heuristics (newest first)\n- **2026-05-06**: Secrets invisible at every layer\n- **2026-04-22**: Earlier heuristic worth keeping\n`

export const OPINIONS_MD = `---\ntitle: Opinions\ntype: profile\ntags:\n  - memory\n  - opinions\n---\n\n# Opinions\n\n## Tools and workflows (newest first)\n- **2026-05-07**: Research current docs before configuring\n`

// ── Harnesses ───────────────────────────────────────────────────

/** Registers the prompts against a stub server, capturing the calls.
 *  No vault or index access happens at registration time, so dummies suffice. */
export const captureRegistration = (
  config = loadConfig({}),
): RegisterPromptCall[] => {
  const calls: RegisterPromptCall[] = []
  const server = {
    registerPrompt: vi.fn((...args: unknown[]) =>
      calls.push(args as RegisterPromptCall),
    ),
  }
  registerPrompts({
    server: server as unknown as McpServer,
    vaultPath: "/test-vault",
    search: {} as SearchIndex,
    logger,
    config,
  })
  return calls
}

/** Builds a temp vault with fixture notes + memory files, a real in-memory
 *  search index populated from the same notes, and the captured prompt calls. */
export const setupVault = async (
  options: {
    config?: ReturnType<typeof loadConfig>
    indexNotes?: boolean
    memoryFiles?: boolean
    logger?: Logger
  } = {},
): Promise<{
  vault: string
  search: SearchIndex
  calls: RegisterPromptCall[]
}> => {
  const config = options.config ?? loadConfig({})
  const indexNotes = options.indexNotes ?? true
  const memoryFiles = options.memoryFiles ?? true
  const log = options.logger ?? logger

  const vault = await mkdtemp(join(tmpdir(), "prompt-test-"))
  onTestFinished(async () => {
    await rm(vault, { recursive: true, force: true })
  })

  const search = createSearchIndex(":memory:")

  if (indexNotes) {
    for (const note of FIXTURE_NOTES) {
      const fullPath = join(vault, note.path)
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, note.content, "utf8")
      search.upsertNote(
        {
          filePath: note.path,
          rawContent: note.content,
          fileStat: {
            mtimeMs: note.mtime,
            size: Buffer.byteLength(note.content, "utf8"),
          },
        },
        log,
      )
    }
  }

  if (memoryFiles) {
    const memoryDirPath = join(vault, config.memoryDir)
    await mkdir(memoryDirPath, { recursive: true })
    await writeFile(join(memoryDirPath, "Principles.md"), PRINCIPLES_MD, "utf8")
    await writeFile(join(memoryDirPath, "Opinions.md"), OPINIONS_MD, "utf8")
  }

  const calls: RegisterPromptCall[] = []
  const server = {
    registerPrompt: vi.fn((...args: unknown[]) =>
      calls.push(args as RegisterPromptCall),
    ),
  }
  registerPrompts({
    server: server as unknown as McpServer,
    vaultPath: vault,
    search,
    logger: log,
    config,
  })

  return { vault, search, calls }
}

/** Registers the prompts against a real vault path and a caller-supplied
 *  search (used to inject failures), capturing the calls. */
export const registerWithSearch = (
  vaultPath: string,
  search: SearchIndex,
  log: Logger = logger,
): RegisterPromptCall[] => {
  const calls: RegisterPromptCall[] = []
  const server = {
    registerPrompt: vi.fn((...args: unknown[]) =>
      calls.push(args as RegisterPromptCall),
    ),
  }
  registerPrompts({
    server: server as unknown as McpServer,
    vaultPath,
    search,
    logger: log,
    config: loadConfig({}),
  })
  return calls
}

export const findCall = (
  calls: RegisterPromptCall[],
  name: string,
): RegisterPromptCall =>
  calls.find((call) => call[0] === name) ??
  (() => {
    throw new Error(`prompt not registered: ${name}`)
  })()

export const textOf = (result: PromptResult): string =>
  result.messages[0]!.content.text

// Re-export dependencies that per-prompt test files need without adding
// their own import of these modules.
export { PROMPT_NAMES } from "../prompt-definitions.js"
export { loadConfig } from "../../config.js"
export {
  createSearchIndex,
  type SearchIndex,
} from "../../search/search-index.js"
export { logger } from "../../../logger.js"

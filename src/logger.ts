import { env } from "node:process"
import { mkdirSync, readdirSync, unlinkSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { DateTime } from "luxon"

type LogLevel = "debug" | "info" | "warn" | "error"

type LogEntry = {
  timestamp: string
  level: LogLevel
  name: string
  message: string
  data: Record<string, unknown>
}

type LogExtension = (entry: LogEntry, line: string) => void

export type Logger = {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
  child: (props: Record<string, unknown>) => Logger
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const threshold =
  LEVELS[(env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel] ?? LEVELS.info

/** Extracts "filename.ts:line" from the call stack — the frame that called the log method. */
const getCallerSource = (): string => {
  const original = Error.prepareStackTrace
  Error.prepareStackTrace = (_err, stack) => stack
  const stack = new Error().stack as unknown as NodeJS.CallSite[]
  Error.prepareStackTrace = original
  // V8 stack: [0] getCallerSource → [1] emit → [2] debug/info/warn/error → [3] actual caller
  const frame = stack[3]
  if (!frame) return "unknown"
  const file = frame.getFileName()?.split("/").pop() ?? "unknown"
  return `${file}:${frame.getLineNumber()}`
}

// ── File sink extension ─────────────────────────────────────

const LOG_FILE_PREFIX = "vault-mcp-"
const LOG_FILE_SUFFIX = ".log"
/** Matches date-stamped log files: vault-mcp-YYYY-MM-DD.log */
const LOG_FILE_PATTERN = /^vault-mcp-(\d{4}-\d{2}-\d{2})\.log$/

const DEFAULT_RETENTION_DAYS = 30

const todayDateString = (): string => DateTime.now().toISODate()

/** Deletes log files older than retentionDays. */
export const pruneOldLogFiles = (
  logDir: string,
  retentionDays: number,
): void => {
  const cutoffDate = DateTime.now().minus({ days: retentionDays }).toISODate()

  for (const filename of readdirSync(logDir)) {
    const match = LOG_FILE_PATTERN.exec(filename)
    const [, fileDate] = match ?? []
    if (fileDate && fileDate < cutoffDate) {
      unlinkSync(join(logDir, filename))
    }
  }
}

/** Creates a LogExtension that appends each line to a date-stamped file.
 *  Rolls to a new file at midnight. Prunes files older than retentionDays on creation. */
export const createFileSinkExtension = (
  logDir: string,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): LogExtension => {
  mkdirSync(logDir, { recursive: true })
  pruneOldLogFiles(logDir, retentionDays)

  const logPath = (): string =>
    join(logDir, `${LOG_FILE_PREFIX}${todayDateString()}${LOG_FILE_SUFFIX}`)

  return (_entry: LogEntry, line: string): void => {
    appendFileSync(logPath(), line)
  }
}

// ── Logger ──────────────────────────────────────────────────

const parseRetentionDays = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined
  const parsed = parseInt(raw, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

const fileSinkExtension: LogExtension | undefined = env.LOG_DIR
  ? createFileSinkExtension(
      env.LOG_DIR,
      parseRetentionDays(env.LOG_RETENTION_DAYS),
    )
  : undefined

const defaultExtensions: LogExtension[] = fileSinkExtension
  ? [fileSinkExtension]
  : []

const createLogger = (
  name: string,
  options?: {
    props?: Record<string, unknown>
    extensions?: LogExtension[]
  },
): Logger => {
  const baseProps = options?.props ?? {}
  const extensions = options?.extensions ?? []

  const emit = (
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void => {
    if (LEVELS[level] < threshold) return

    // Capture source location for info/warn/error (skip debug to avoid overhead)
    const source = level !== "debug" ? getCallerSource() : undefined

    const mergedData = { ...baseProps, ...data }
    const entry: LogEntry = {
      timestamp: DateTime.now().toISO(),
      level,
      name,
      message,
      data: mergedData,
    }

    const line =
      JSON.stringify({
        timestamp: entry.timestamp,
        level,
        name,
        message,
        ...(source ? { source } : {}),
        ...mergedData,
      }) + "\n"
    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)

    for (const ext of extensions) {
      ext(entry, line)
    }
  }

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
    child: (props) =>
      createLogger(name, {
        props: { ...baseProps, ...props },
        extensions,
      }),
  }
}

export const logger = createLogger("vault-cortex", {
  extensions: defaultExtensions,
})

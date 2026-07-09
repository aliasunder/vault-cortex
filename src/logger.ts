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
  /** Function-valued props are resolved at emit time, per log line — use
   *  `() => value` for context not yet available when the child is created. */
  child: (props: Record<string, unknown>) => Logger
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const isLogLevel = (value: string): value is LogLevel =>
  Object.hasOwn(LEVELS, value)

const envLevel = (env.LOG_LEVEL ?? "info").toLowerCase()
const threshold = isLogLevel(envLevel) ? LEVELS[envLevel] : LEVELS.info

/** Extracts "filename.ts:line" from the call stack — the frame that called the log method. */
const getCallerSource = (): string => {
  const original = Error.prepareStackTrace
  // Mutable — captured by the prepareStackTrace callback, which V8 calls during .stack access
  let capturedStack: NodeJS.CallSite[] | undefined
  Error.prepareStackTrace = (_err, callSites) => {
    capturedStack = callSites
    return callSites
  }
  void new Error().stack
  Error.prepareStackTrace = original

  if (!capturedStack) return "unknown"
  // V8 stack: [0] getCallerSource → [1] emit → [2] debug/info/warn/error → [3] actual caller
  const frame = capturedStack[3]
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
    const logFileMatch = LOG_FILE_PATTERN.exec(filename)
    const [, fileDate] = logFileMatch ?? []
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

  // `line` is the same JSON string already written to stdout/stderr by emit()
  return (_entry: LogEntry, line: string): void => {
    appendFileSync(logPath(), line)
  }
}

// ── Logger ──────────────────────────────────────────────────

const parseRetentionDays = (
  envValue: string | undefined,
): number | undefined => {
  if (!envValue) return undefined
  const retentionDays = parseInt(envValue, 10)
  return Number.isNaN(retentionDays) ? undefined : retentionDays
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

/** Resolves function-valued child props at emit time — lets a child logger
 *  carry context that doesn't exist yet at child creation (e.g. the MCP
 *  transport's session id, generated during the initialize request). */
const resolveLazyProps = (
  props: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(props).map(([key, value]) => [
      key,
      typeof value === "function" ? value() : value,
    ]),
  )

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

    const mergedData = { ...resolveLazyProps(baseProps), ...data }
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

    for (const extension of extensions) {
      extension(entry, line)
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

import { env } from "node:process"
import { mkdirSync, readdirSync, unlinkSync, appendFileSync } from "node:fs"
import { findSourceMap, type SourceOrigin } from "node:module"
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

const isSourceOrigin = (value: SourceOrigin | object): value is SourceOrigin =>
  "fileName" in value

const envLevel = (env.LOG_LEVEL ?? "info").toLowerCase()
const threshold = isLogLevel(envLevel) ? LEVELS[envLevel] : LEVELS.info

/** Extracts "filename.ts:line" from the call stack — the frame that called the log method.
 *  Uses `node:module` source maps to resolve compiled .js locations back to the original
 *  .ts source; falls back to the .js filename when source maps are unavailable. */
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

  const compiledFile = frame.getFileName()
  const compiledLine = frame.getLineNumber()
  if (!compiledFile || !compiledLine) return "unknown"

  // Resolve .js → .ts via source map (requires --enable-source-maps at startup).
  // findOrigin takes 1-indexed input (matching CallSite) and returns 1-indexed output.
  const sourceMap = findSourceMap(compiledFile)
  const origin = sourceMap?.findOrigin(
    compiledLine,
    frame.getColumnNumber() ?? 1,
  )
  if (origin && isSourceOrigin(origin)) {
    const originalFile = URL.parse(origin.fileName)?.pathname?.split("/").pop()
    if (originalFile) return `${originalFile}:${origin.lineNumber}`
  }

  const file = compiledFile.split("/").pop() ?? "unknown"
  return `${file}:${compiledLine}`
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

/** Sentinel that turns file logging off. Deployments that default LOG_DIR on
 *  (the remote Compose file, STORAGE_ROOT single-volume mode) substitute
 *  their default for an empty value, so "empty" can't serve as the off
 *  switch — an explicit word can. */
const LOG_DIR_OFF = "none"

/** Resolves the LOG_DIR setting to a directory, or undefined when file
 *  logging is off — unset, empty, or the `none` sentinel in any casing
 *  (a literal `NONE/` log directory is never what an operator meant). */
export const resolveLogDir = (
  logDirSetting: string | undefined,
): string | undefined => {
  if (!logDirSetting || logDirSetting.toLowerCase() === LOG_DIR_OFF) {
    return undefined
  }
  return logDirSetting
}

const logDir = resolveLogDir(env.LOG_DIR)
const fileSinkExtension: LogExtension | undefined = logDir
  ? createFileSinkExtension(logDir, parseRetentionDays(env.LOG_RETENTION_DAYS))
  : undefined

const defaultExtensions: LogExtension[] = fileSinkExtension
  ? [fileSinkExtension]
  : []

/** Resolves function-valued child props at emit time — lets a child logger
 *  carry context that doesn't exist yet at child creation (e.g. the MCP
 *  transport's session id, generated during the initialize request). */
const resolveLazyProps = (
  props: Record<string, unknown>,
): Record<string, unknown> => {
  const resolvedEntries = Object.entries(props).map(
    ([key, value]): [string, unknown] => [
      key,
      typeof value === "function" ? value() : value,
    ],
  )
  return Object.fromEntries(resolvedEntries)
}

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

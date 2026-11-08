import { env } from "node:process"
import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  appendFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs"
import { findSourceMap, type SourceOrigin } from "node:module"
import { join } from "node:path"
import { DateTime } from "luxon"
import { describeError } from "./utils/describe-error.js"
import { truncateToCodePointLimit } from "./utils/truncate-to-code-point-limit.js"

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

const isLogLevel = (value: string): value is LogLevel => Object.hasOwn(LEVELS, value)

const isSourceOrigin = (value: SourceOrigin | object): value is SourceOrigin => "fileName" in value

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
  const origin = sourceMap?.findOrigin(compiledLine, frame.getColumnNumber() ?? 1)

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

const DEFAULT_RETENTION_DAYS = 90
// Bounds persisted logs while leaving room for busy days at the info level.
const DEFAULT_MAX_DAILY_MB = 25
const BYTES_PER_MB = 1_000_000
// The limit notice is under 200 bytes; the tail also includes its preceding newline.
const LIMIT_NOTICE_TAIL_BYTES = 512
/** Matches the sink's notice header, excluding quoted text in ordinary log fields. */
const LIMIT_NOTICE_PATTERN =
  /^\{"timestamp":"[^"]+","level":"warn","name":"vault-cortex","message":"file_log_daily_limit_reached",/

const endsWithApplicableLimitNotice = ({
  logPath,
  fileBytes,
  maxDailyBytes,
}: {
  logPath: string
  fileBytes: number
  maxDailyBytes: number
}): boolean => {
  // With the cap turned off, no earlier notice applies, readable or not.
  if (!fileBytes || !Number.isFinite(maxDailyBytes)) return false
  const file = openSync(logPath, "r")

  try {
    const tail = Buffer.alloc(Math.min(fileBytes, LIMIT_NOTICE_TAIL_BYTES))
    const bytesRead = readSync(file, tail, 0, tail.length, fileBytes - tail.length)
    const lastLine = tail.toString("utf8", 0, bytesRead).trimEnd().split("\n").at(-1)

    if (!lastLine || !LIMIT_NOTICE_PATTERN.test(lastLine)) return false

    const notice: unknown = (() => {
      try {
        return JSON.parse(lastLine)
      } catch (error) {
        process.stdout.write(
          consoleWarningLine("invalid_file_log_daily_limit_notice", {
            error: describeError(error),
          }),
        )
        return undefined
      }
    })()
    const recordedLimit =
      typeof notice === "object" && notice !== null && "maxDailyBytes" in notice
        ? notice.maxDailyBytes
        : undefined

    // An unreadable notice preserves the cap; only a known increase reopens the file.
    if (typeof recordedLimit !== "number" || !Number.isFinite(recordedLimit)) return true

    return maxDailyBytes <= recordedLimit
  } finally {
    closeSync(file)
  }
}

const todayDateString = (): string => DateTime.now().toISODate()

const consoleWarningLine = (message: string, data: Record<string, unknown>): string => {
  return (
    JSON.stringify({
      timestamp: DateTime.now().toISO(),
      level: "warn",
      name: "vault-cortex",
      message,
      ...data,
    }) + "\n"
  )
}

const reportFileLoggingStopped = (error: unknown): void => {
  process.stdout.write(consoleWarningLine("file_logging_stopped", { error: describeError(error) }))
}

/** Deletes log files older than retentionDays. */
export const pruneOldLogFiles = (logDir: string, retentionDays: number): void => {
  const cutoffDate = DateTime.now().minus({ days: retentionDays }).toISODate()

  for (const filename of readdirSync(logDir)) {
    const logFileMatch = LOG_FILE_PATTERN.exec(filename)
    const [, fileDate] = logFileMatch ?? []

    if (fileDate && fileDate < cutoffDate) {
      unlinkSync(join(logDir, filename))
    }
  }
}

/** Keeps the start of each day's log; console output continues after the daily cap. */
export const createFileSinkExtension = ({
  logDir,
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxDailyBytes = DEFAULT_MAX_DAILY_MB * BYTES_PER_MB,
}: {
  logDir: string
  retentionDays?: number
  maxDailyBytes?: number
}): LogExtension => {
  // Initialisation failures disable this sink before it reaches any logger.
  try {
    mkdirSync(logDir, { recursive: true })
    pruneOldLogFiles(logDir, retentionDays)
  } catch (error) {
    reportFileLoggingStopped(error)
    return () => undefined
  }

  // Each day's count starts from disk so restarting preserves the written bytes.
  const logDay = { date: "", bytes: 0, capped: false }

  // `line` is the same JSON string already written to stdout/stderr by emit()
  return (_entry: LogEntry, line: string): void => {
    const today = todayDateString()
    const logPath = join(logDir, `${LOG_FILE_PREFIX}${today}${LOG_FILE_SUFFIX}`)

    if (logDay.date !== today) {
      pruneOldLogFiles(logDir, retentionDays)
      logDay.bytes = statSync(logPath, { throwIfNoEntry: false })?.size ?? 0
      logDay.date = today
      // A notice can leave the file below the cap when the rejected line was large.
      // Exact-cap files without a notice still need one on the next rejected write.
      logDay.capped =
        logDay.bytes > maxDailyBytes ||
        endsWithApplicableLimitNotice({ logPath, fileBytes: logDay.bytes, maxDailyBytes })
    }

    if (logDay.capped) return

    const lineBytes = Buffer.byteLength(line)
    const exceedsDailyLimit = logDay.bytes + lineBytes > maxDailyBytes

    if (exceedsDailyLimit) {
      // The notice may exceed the cap so the persisted file explains why it stops.
      // Mark first so even a failing append cannot retry the notice this day.
      logDay.capped = true
      const limitLine = consoleWarningLine("file_log_daily_limit_reached", { maxDailyBytes })
      appendFileSync(logPath, limitLine)
      process.stdout.write(limitLine)
      return
    }

    appendFileSync(logPath, line)
    logDay.bytes += lineBytes
  }
}

// ── Logger ──────────────────────────────────────────────────

const parseRetentionDays = (envValue: string | undefined): number | undefined => {
  if (envValue === undefined) return undefined
  const retentionDays = Number(envValue)

  if (WHOLE_NUMBER.test(envValue) && Number.isFinite(retentionDays)) return retentionDays

  process.stdout.write(
    consoleWarningLine("invalid LOG_RETENTION_DAYS; using default", {
      retentionDays: DEFAULT_RETENTION_DAYS,
    }),
  )
  return DEFAULT_RETENTION_DAYS
}

/** Matches a whole number without signs, fractions or trailing text. */
const WHOLE_NUMBER = /^\d+$(?![\s\S])/

const parseMaxDailyBytes = (envValue: string | undefined): number => {
  if (envValue === undefined) return DEFAULT_MAX_DAILY_MB * BYTES_PER_MB
  if (envValue.toLowerCase() === "none") return Number.POSITIVE_INFINITY

  const maxDailyMb = Number(envValue)
  const maxDailyBytes = maxDailyMb * BYTES_PER_MB
  const validLimit =
    WHOLE_NUMBER.test(envValue) && maxDailyMb >= 1 && Number.isFinite(maxDailyBytes)

  if (validLimit) return maxDailyBytes

  process.stdout.write(
    consoleWarningLine("invalid LOG_MAX_DAILY_MB; using default", {
      maxDailyMb: DEFAULT_MAX_DAILY_MB,
    }),
  )
  return DEFAULT_MAX_DAILY_MB * BYTES_PER_MB
}

/** Sentinel that turns file logging off. Deployments that default LOG_DIR on
 *  (the remote Compose file, STORAGE_ROOT single-volume mode) substitute
 *  their default for an empty value, so "empty" can't serve as the off
 *  switch — an explicit word can. */
const LOG_DIR_OFF = "none"

/** Resolves the LOG_DIR setting to a directory, or undefined when file
 *  logging is off — unset, empty, or the `none` sentinel in any casing
 *  (a literal `NONE/` log directory is never what an operator meant). */
export const resolveLogDir = (logDirSetting: string | undefined): string | undefined => {
  if (!logDirSetting || logDirSetting.toLowerCase() === LOG_DIR_OFF) {
    return undefined
  }
  return logDirSetting
}

const logDir = resolveLogDir(env.LOG_DIR)
const maxDailyBytes = parseMaxDailyBytes(env.LOG_MAX_DAILY_MB)
const fileSinkExtension: LogExtension | undefined = logDir
  ? createFileSinkExtension({
      logDir,
      retentionDays: parseRetentionDays(env.LOG_RETENTION_DAYS) ?? DEFAULT_RETENTION_DAYS,
      maxDailyBytes,
    })
  : undefined

const defaultExtensions = new Set<LogExtension>(fileSinkExtension ? [fileSinkExtension] : [])

/** Resolves function-valued child props at emit time — lets a child logger
 *  carry context that doesn't exist yet at child creation (e.g. the MCP
 *  transport's session id, generated during the initialize request). */
const resolveLazyProps = (props: Record<string, unknown>): Record<string, unknown> => {
  const resolvedEntries = Object.entries(props).map(([key, value]): [string, unknown] => [
    key,
    typeof value === "function" ? value() : value,
  ])
  return Object.fromEntries(resolvedEntries)
}

// Bounds arbitrary log fields so caller-controlled text cannot flood log storage.
const LOG_FIELD_CODE_POINTS = 256
// Keeps error descriptions and stack traces useful while bounding their size.
const LOG_DIAGNOSTIC_CODE_POINTS = 4096
// Bounds recursive traversal so deeply nested log data cannot exhaust the call stack.
const LOG_FIELD_MAX_DEPTH = 64

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

const capLogField = (
  value: unknown,
  { maxCodePoints, depth }: { maxCodePoints: number; depth: number },
): unknown => {
  if (typeof value === "string") {
    const cappedValue = truncateToCodePointLimit(value, maxCodePoints)

    if (cappedValue === value) return value
    return truncateToCodePointLimit(value, maxCodePoints - 1) + "…"
  }

  if (depth >= LOG_FIELD_MAX_DEPTH && (Array.isArray(value) || isPlainObject(value))) {
    return "[nested too deep]"
  }

  if (Array.isArray(value)) {
    return value.map((element) => capLogField(element, { maxCodePoints, depth: depth + 1 }))
  }

  if (isPlainObject(value)) return capLogData(value, depth)
  return value
}

const capLogData = (
  data: Readonly<Record<string, unknown>>,
  depth = 0,
): Record<string, unknown> => {
  const cappedEntries = Object.entries(data).map(([key, value]) => {
    const isDiagnostic = key === "error" || key === "cause" || key === "stack"
    const maxCodePoints = isDiagnostic ? LOG_DIAGNOSTIC_CODE_POINTS : LOG_FIELD_CODE_POINTS

    return [key, capLogField(value, { maxCodePoints, depth: depth + 1 })]
  })
  return Object.fromEntries(cappedEntries)
}

const createLogger = (
  name: string,
  options?: {
    props?: Record<string, unknown>
    extensions?: Set<LogExtension>
  },
): Logger => {
  const baseProps = options?.props ?? {}
  const extensions = options?.extensions ?? new Set<LogExtension>()

  const emit = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold) return

    // Capture source location for info/warn/error (skip debug to avoid overhead)
    const source = level !== "debug" ? getCallerSource() : undefined

    const mergedData = capLogData({ ...resolveLazyProps(baseProps), ...data })
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
      try {
        extension(entry, line)
      } catch (error) {
        // Root and child loggers share this set, so none retries a failed sink.
        extensions.delete(extension)
        reportFileLoggingStopped(error)
      }
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

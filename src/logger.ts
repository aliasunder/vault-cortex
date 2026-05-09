import { env } from "node:process"

type LogLevel = "debug" | "info" | "warn" | "error"

type LogEntry = {
  timestamp: string
  level: LogLevel
  name: string
  message: string
  data: Record<string, unknown>
}

type LogExtension = (entry: LogEntry) => void

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
      timestamp: new Date().toISOString(),
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
      ext(entry)
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

export const logger = createLogger("vault-cortex")

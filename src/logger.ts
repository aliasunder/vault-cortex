import { env } from "node:process"

type LogLevel = "debug" | "info" | "warn" | "error"

export type LogEntry = {
  ts: string
  level: LogLevel
  name: string
  msg: string
  data: Record<string, unknown>
}

export type LogExtension = (entry: LogEntry) => void

export type Logger = {
  debug: (msg: string, data?: Record<string, unknown>) => void
  info: (msg: string, data?: Record<string, unknown>) => void
  warn: (msg: string, data?: Record<string, unknown>) => void
  error: (msg: string, data?: Record<string, unknown>) => void
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
    msg: string,
    data?: Record<string, unknown>,
  ): void => {
    if (LEVELS[level] < threshold) return

    const mergedData = { ...baseProps, ...data }
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      name,
      msg,
      data: mergedData,
    }

    // Flatten data into the JSON line for grep-friendly structured logs
    const line =
      JSON.stringify({ ts: entry.ts, level, name, msg, ...mergedData }) + "\n"
    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)

    for (const ext of extensions) {
      ext(entry)
    }
  }

  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    child: (props) =>
      createLogger(name, {
        props: { ...baseProps, ...props },
        extensions,
      }),
  }
}

export const logger = createLogger("vault-cortex")

import { truncateToCodePointLimit } from "./truncate-to-code-point-limit.js"

// Request metadata must not turn a short rejection into an arbitrarily large log line.
const LOG_FIELD_CODE_POINTS = 256

export const capLogField = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const cappedValue = truncateToCodePointLimit(value, LOG_FIELD_CODE_POINTS)

  if (cappedValue === value) return value
  return truncateToCodePointLimit(value, LOG_FIELD_CODE_POINTS - 1) + "…"
}

// Request metadata must not turn a short rejection into an arbitrarily large log line.
const LOG_FIELD_CODE_POINTS = 256

export const capLogField = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const codePoints = Array.from(value)

  if (codePoints.length <= LOG_FIELD_CODE_POINTS) return value
  return codePoints.slice(0, LOG_FIELD_CODE_POINTS - 1).join("") + "…"
}

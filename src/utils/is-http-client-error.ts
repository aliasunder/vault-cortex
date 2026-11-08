type HttpClientError = {
  status: number
  expose: true
}

/** Recognises public 4xx errors from http-errors without trusting their message. */
export const isHttpClientError = (error: unknown): error is HttpClientError => {
  if (typeof error !== "object" || error === null) return false
  if (!("status" in error) || !("expose" in error)) return false
  return (
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.expose === true
  )
}

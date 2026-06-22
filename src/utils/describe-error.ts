/** Returns a human-readable message from an unknown thrown value, for structured
 *  logs and error wrapping. An Error yields its `message`; anything else is
 *  stringified. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

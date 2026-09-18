/** Returns a human-readable message from an unknown thrown value, for structured
 *  logs and error wrapping. An Error yields `[name]: message`; anything else is
 *  stringified. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? `[${error.name}]: ${error.message}` : String(error)

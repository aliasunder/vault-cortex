/** Runtime type guard for Node.js filesystem errors (ENOENT, EEXIST, EACCES, etc.).
 *  Narrows an unknown catch value to `NodeJS.ErrnoException`, optionally matching
 *  a specific `code` literal. When `code` is supplied, the return type narrows
 *  `error.code` to that literal — so downstream branches don't need a second check. */
export const isErrnoException = <C extends string = string>(
  error: unknown,
  code?: C,
): error is NodeJS.ErrnoException & { code: C } =>
  error instanceof Error &&
  "code" in error &&
  (code === undefined || error.code === code)

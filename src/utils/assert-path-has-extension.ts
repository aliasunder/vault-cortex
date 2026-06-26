/** Throws when `path` does not end in `extension`. A generic path-extension
 *  guard — the caller supplies the required extension (e.g. ".md"). Keeps no
 *  domain knowledge: it knows nothing about vaults, Markdown, or MCP. */
export const assertPathHasExtension = (
  path: string,
  extension: string,
): void => {
  if (path.endsWith(extension)) return
  throw new Error(`path must end in "${extension}" (received "${path}")`)
}

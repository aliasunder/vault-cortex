/** Throws when `path` does not end in any of the given extension(s). A
 *  generic path-extension guard — the caller supplies the required
 *  extension(s) (e.g. ".md" or [".md", ".canvas"]). Keeps no domain
 *  knowledge: it knows nothing about vaults, Markdown, or MCP. */
export const assertPathHasExtension = (
  path: string,
  extension: string | readonly string[],
): void => {
  const extensions = typeof extension === "string" ? [extension] : extension
  if (extensions.some((ext) => path.endsWith(ext))) return
  const extensionList = extensions.map((ext) => `"${ext}"`).join(" or ")
  throw new Error(`path must end in ${extensionList} (received "${path}")`)
}

import { posix } from "node:path"
import { isMap } from "yaml"
import { assertCanvasTopLevel } from "./canvas.js"
import { parseYamlWithFirstError, stripLeadingBom } from "./frontmatter.js"

const assertJsonSyntax = (jsonText: string): void => {
  try {
    // JSON.parse rejects a leading byte-order mark, and RFC 8259 §8.1 lets a JSON parser skip it:
    // https://www.rfc-editor.org/rfc/rfc8259#section-8.1
    JSON.parse(stripLeadingBom(jsonText))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid JSON: ${message}`, { cause: error })
  }
}

/** A Bases file is YAML whose top level is a mapping, or an empty document. */
const assertBaseSyntax = (baseText: string): void => {
  // The YAML parser skips a leading byte-order mark but counts it as a column,
  // so an error on the first line would be reported one column late.
  const { document, firstError } = parseYamlWithFirstError(stripLeadingBom(baseText))

  if (firstError) {
    throw new Error(
      `invalid .base YAML at line ${firstError.line}, column ${firstError.column}: ${firstError.error.message}`,
      { cause: firstError.error },
    )
  }

  const isEmptyDocument = document.contents === null

  if (!isEmptyDocument && !isMap(document.contents)) {
    throw new Error("invalid .base YAML: the top level must be a mapping")
  }

  try {
    // The parse accepts an alias whose anchor the file never sets; converting
    // the document throws on it, as it does for a note's properties block.
    document.toJS()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid .base YAML: ${message}`, { cause: error })
  }
}

/**
 * Throws when a file's text would break the format its extension names:
 * `.canvas` and `.json` must parse as JSON (a canvas as an object whose
 * `nodes` and `edges`, when present, are arrays), and `.base` as YAML with a
 * mapping or nothing at the top level.
 * Any other extension passes. A leading byte-order mark is accepted.
 */
export const assertTextFileSyntax = (params: { path: string; content: string }): void => {
  const extension = posix.extname(params.path).toLowerCase()

  switch (extension) {
    case ".canvas":
      return assertCanvasTopLevel(params.content)
    case ".json":
      return assertJsonSyntax(params.content)
    case ".base":
      return assertBaseSyntax(params.content)
  }
}

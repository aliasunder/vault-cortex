import { posix } from "node:path"
import { isMap, LineCounter, parseDocument } from "yaml"
import { assertCanvasTopLevel } from "./canvas.js"
import { findFirstDuplicateKey } from "./frontmatter.js"

const assertJsonSyntax = (jsonText: string): void => {
  // JSON.parse rejects a leading byte-order mark, and RFC 8259 §8.1 lets a JSON parser skip it:
  // https://www.rfc-editor.org/rfc/rfc8259#section-8.1
  const textWithoutMark = jsonText.startsWith("﻿") ? jsonText.slice(1) : jsonText

  try {
    JSON.parse(textWithoutMark)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid JSON: ${message}`, { cause: error })
  }
}

/** A Bases file is YAML whose top level is a mapping, or an empty document. */
const assertBaseSyntax = (baseText: string): void => {
  const lineCounter = new LineCounter()
  // - uniqueKeys: false turns off the library's duplicate-key check, which
  //   compares each key with every earlier key in its map, so a large mapping
  //   would take minutes; findFirstDuplicateKey finds the same first
  //   duplicate in one pass.
  // - keepSourceTokens keeps the tokens findFirstDuplicateKey reads to place
  //   its error.
  const document = parseDocument(baseText, {
    prettyErrors: false,
    lineCounter,
    uniqueKeys: false,
    keepSourceTokens: true,
  })
  const firstError = document.errors[0] ?? findFirstDuplicateKey(document)

  if (firstError) {
    const { line, col } = lineCounter.linePos(firstError.pos[0])
    throw new Error(`invalid .base YAML at line ${line}, column ${col}: ${firstError.message}`, {
      cause: firstError,
    })
  }

  const isEmptyDocument = document.contents === null

  if (!isEmptyDocument && !isMap(document.contents)) {
    throw new Error("invalid .base YAML: the top level must be a mapping")
  }
}

/**
 * Throws when a file's text would break the format its extension names:
 * `.canvas` and `.json` must parse as JSON (a canvas as an object with array
 * `nodes` and `edges`), and `.base` as YAML with a mapping at the top level.
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

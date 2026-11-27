/**
 * Builds long strings from many pieces in bounded memory. A global `replace`,
 * a `replaceAll` or one `join` over every piece keeps all the pieces alive
 * until the result is built, at about 30 bytes of heap per piece, so a long
 * text dense with pieces is joined in batches instead. These helpers sit in
 * the parser layer because obsidian-markdown/ imports no other internal
 * module.
 */

/** How many pieces a joiner holds before it joins them into one run; a batch
 *  this size stays under a megabyte of pieces. */
const PIECES_PER_JOIN = 4096

type TextJoiner = { push: (piece: string) => void; join: () => string }

/** Collects pieces of text and joins every PIECES_PER_JOIN of them into one
 *  run, so a long result never holds all its pieces at once. */
export const createTextJoiner = (): TextJoiner => {
  const runs: string[] = []
  const pendingPieces: string[] = []

  return {
    push: (piece) => {
      pendingPieces.push(piece)
      if (pendingPieces.length < PIECES_PER_JOIN) return
      runs.push(pendingPieces.join(""))
      pendingPieces.length = 0
    },
    join: () => [...runs, pendingPieces.join("")].join(""),
  }
}

/** Replaces each match of `pattern`, a global regular expression, with what
 *  `replacement` returns for it, as String.prototype.replace does, holding
 *  the result in batches. Text with no match comes back unchanged. */
export const replaceAllInBatches = (params: {
  text: string
  pattern: RegExp
  replacement: (match: RegExpExecArray) => string
}): string => {
  const { text, pattern, replacement } = params

  if (text.search(pattern) === -1) return text
  const joiner = createTextJoiner()
  // How much of the text the joiner already holds.
  let copiedThrough = 0

  // matchAll starts at the regex's lastIndex, which an earlier exec may have
  // left past 0; a copy starts at 0, as replace does.
  for (const match of text.matchAll(new RegExp(pattern))) {
    joiner.push(text.slice(copiedThrough, match.index))
    joiner.push(replacement(match))
    copiedThrough = match.index + match[0].length
  }
  joiner.push(text.slice(copiedThrough))
  return joiner.join()
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The longest prefix of `text` that holds at most `maxCodePoints` code points
 *  and ends between two graphemes, or `text` itself when it fits.
 *  - Counting code points bounds the prefix's size; a single grapheme can carry
 *    any number of combining marks, so a grapheme count would not.
 *  - Backing up to a grapheme boundary never leaves part of a flag, a joined
 *    emoji, or a letter without its accents. A first grapheme longer than the
 *    limit leaves an empty prefix. */
export const truncateToCodePointLimit = (text: string, maxCodePoints: number): string => {
  // A string never holds more code points than UTF-16 units.
  if (text.length <= maxCodePoints) return text

  const codePointPrefix = text[Symbol.iterator]().take(maxCodePoints).toArray().join("")
  const cutIndex = codePointPrefix.length

  if (cutIndex === text.length) return text

  // Whether the cut splits a grapheme depends on the text before it and the one
  // code point after it, at most two UTF-16 units.
  const graphemeAtCut = graphemeSegmenter.segment(text.slice(0, cutIndex + 2)).containing(cutIndex)

  // cutIndex is inside the segmented text, so a segment always contains it.
  if (!graphemeAtCut) throw new Error(`no grapheme contains index ${cutIndex}`)
  return text.slice(0, graphemeAtCut.index)
}

/** A code point that would cross the byte limit is omitted in full. */
export const getUtf8BytePrefix = (content: string, maxBytes: number): string => {
  // Byte and UTF-16 offsets advance together while walking Unicode code points.
  let usedBytes = 0
  let endIndex = 0
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, "utf8")

    if (usedBytes + characterBytes > maxBytes) break
    usedBytes += characterBytes
    endIndex += character.length
  }
  return content.slice(0, endIndex)
}

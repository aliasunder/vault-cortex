import { isUtf8 } from "node:buffer"

/** How many leading bytes are searched for a NUL byte. Git calls a file binary
 *  when its first 8,000 bytes hold one (FIRST_FEW_BYTES in xdiff-interface.c):
 *  https://github.com/git/git/blob/master/xdiff-interface.c */
export const NUL_SEARCH_WINDOW_BYTES = 8_000

type DecodedTextBuffer =
  | Readonly<{ status: "text"; text: string }>
  | Readonly<{ status: "binary" }>
  | Readonly<{ status: "invalid-utf8" }>

// Decoding is stateless outside streaming mode, so one decoder serves every call.
// ignoreBOM keeps a leading byte-order mark, which TextDecoder drops by default.
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true })

/** Decodes bytes as UTF-8, or returns null when any byte sequence is not
 *  UTF-8. A leading byte-order mark is kept, so the text matches the bytes. */
export const decodeUtf8OrNull = (buffer: Uint8Array): string | null => {
  return isUtf8(buffer) ? utf8Decoder.decode(buffer) : null
}

/** Decodes bytes as UTF-8 text with decodeUtf8OrNull, after one more check:
 *  a NUL byte within the first NUL_SEARCH_WINDOW_BYTES marks them binary. */
export const decodeTextBuffer = (buffer: Uint8Array): DecodedTextBuffer => {
  const holdsEarlyNulByte = buffer.subarray(0, NUL_SEARCH_WINDOW_BYTES).includes(0)

  if (holdsEarlyNulByte) return { status: "binary" }

  const text = decodeUtf8OrNull(buffer)

  if (text === null) return { status: "invalid-utf8" }
  return { status: "text", text }
}

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
const utf8Decoder = new TextDecoder("utf-8")

/** Decodes bytes as UTF-8 text.
 *  - A NUL byte within the first NUL_SEARCH_WINDOW_BYTES marks them binary.
 *  - Any byte sequence that is not UTF-8 marks them invalid.
 *  - A leading byte-order mark is dropped, as TextDecoder does by default. */
export const decodeTextBuffer = (buffer: Uint8Array): DecodedTextBuffer => {
  const holdsEarlyNulByte = buffer.subarray(0, NUL_SEARCH_WINDOW_BYTES).includes(0)

  if (holdsEarlyNulByte) return { status: "binary" }
  if (!isUtf8(buffer)) return { status: "invalid-utf8" }
  return { status: "text", text: utf8Decoder.decode(buffer) }
}

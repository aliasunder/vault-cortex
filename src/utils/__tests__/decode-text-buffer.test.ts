import { describe, it, expect } from "vitest"
import { decodeTextBuffer } from "../decode-text-buffer.js"

/** `length` bytes of ASCII "a" with a NUL byte at `nulIndex`. */
const buildBufferWithNulAt = (params: { length: number; nulIndex: number }): Buffer => {
  const buffer = Buffer.alloc(params.length, "a")
  buffer[params.nulIndex] = 0
  return buffer
}

describe("decodeTextBuffer", () => {
  it("decodes UTF-8 text, multibyte characters included", () => {
    expect(decodeTextBuffer(Buffer.from("café — ✓\n", "utf8"))).toEqual({
      status: "text",
      text: "café — ✓\n",
    })
  })

  it("decodes an empty buffer as empty text", () => {
    expect(decodeTextBuffer(Buffer.alloc(0))).toEqual({ status: "text", text: "" })
  })

  it("calls bytes binary when a NUL byte is the first byte", () => {
    expect(decodeTextBuffer(buildBufferWithNulAt({ length: 10, nulIndex: 0 }))).toEqual({
      status: "binary",
    })
  })

  it("calls bytes binary when a NUL byte is the last byte of the first 8,000", () => {
    expect(decodeTextBuffer(buildBufferWithNulAt({ length: 9_000, nulIndex: 7_999 }))).toEqual({
      status: "binary",
    })
  })

  it("decodes bytes whose first NUL byte sits just past the first 8,000", () => {
    const buffer = buildBufferWithNulAt({ length: 8_001, nulIndex: 8_000 })

    expect(decodeTextBuffer(buffer)).toEqual({
      status: "text",
      text: `${"a".repeat(8_000)}\u0000`,
    })
  })

  it("calls BOM-less UTF-16 text binary, since its ASCII characters carry NUL bytes", () => {
    expect(decodeTextBuffer(Buffer.from("hi", "utf16le"))).toEqual({ status: "binary" })
  })

  it("calls bytes that are not UTF-8 invalid", () => {
    // 0xE9 is "é" in Latin-1 and never a complete UTF-8 sequence
    expect(decodeTextBuffer(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toEqual({
      status: "invalid-utf8",
    })
  })

  it("calls an encoded UTF-16 surrogate invalid, as a strict UTF-8 decoder does", () => {
    expect(decodeTextBuffer(Buffer.from([0xed, 0xa0, 0x80]))).toEqual({ status: "invalid-utf8" })
  })

  it("drops a leading byte-order mark", () => {
    const withByteOrderMark = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])

    expect(decodeTextBuffer(withByteOrderMark)).toEqual({ status: "text", text: "hi" })
  })
})

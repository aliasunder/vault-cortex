/** C0 controls (except tab/LF/CR), DEL, and C1 controls. */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this guard
const CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/

/**
 * Rejects content containing non-printable control characters. A control byte
 * in a markdown note is invisible in read output but physically present on
 * disk — exact-match edits (old_text) can never target it because the byte
 * doesn't survive a round-trip through the MCP transport, leaving the file
 * stuck with an unmatchable character. Rejecting at the write boundary
 * prevents the stuck-byte scenario entirely.
 */
export const assertNoControlCharacters = (
  value: string,
  paramName: string,
): void => {
  const match = CONTROL_CHARACTER_PATTERN.exec(value)
  if (!match) return

  const charCode = match[0].codePointAt(0)
  if (charCode === undefined) return
  const codePoint = charCode.toString(16).toUpperCase().padStart(4, "0")

  throw new Error(
    `${paramName} contains a control character (U+${codePoint} at position ${match.index}) — control characters other than tab, LF, and CR are not allowed in note content`,
  )
}

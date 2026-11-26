import { describe, it, expect } from "vitest"
import { caseFoldPath } from "../case-fold-path.js"

describe("caseFoldPath", () => {
  it("folds ASCII case", () => {
    expect(caseFoldPath("About Me/Notes.md")).toBe("about me/notes.md")
  })

  it("returns an already-folded path unchanged", () => {
    expect(caseFoldPath("about me/notes.md")).toBe("about me/notes.md")
  })

  it("folds final and medial sigma to the same key", () => {
    expect([caseFoldPath("λόγος.md"), caseFoldPath("λόγοσ.md")]).toEqual(["λόγοσ.md", "λόγοσ.md"])
  })

  it("folds sharp s and ss to the same key", () => {
    expect([caseFoldPath("Straße.md"), caseFoldPath("strasse.md")]).toEqual([
      "strasse.md",
      "strasse.md",
    ])
  })

  it("folds capital sharp s to the same key as ss", () => {
    // U+1E9E lowers to "ß" on the first map and reaches "ss" only on the
    // second, so a single map would keep this spelling apart from the others.
    // The escape pins U+1E9E, which looks like "ß" when typed as a literal.
    expect(caseFoldPath("Stra\u1E9Ee.md")).toBe("strasse.md")
  })

  it("folds a vowel's marks to one key whatever order they were typed in", () => {
    // Composed first, "ᾳ̣" (alpha with iota subscript, then a dot below) and
    // "α̣ι" (alpha, dot below, iota) fold to two keys, because the case map
    // turns the subscript into an iota in one order and not the other. A
    // case-insensitive filesystem opens both spellings as one name.
    const subscriptFirst = "ᾳ̣ Arch/plan.md"
    const dotFirst = "α̣ι Arch/plan.md"
    expect([caseFoldPath(subscriptFirst), caseFoldPath(dotFirst)]).toEqual([
      "α̣ι arch/plan.md",
      "α̣ι arch/plan.md",
    ])
  })

  it("folds every code point to a fixed point", () => {
    const unstable = []

    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue
      const folded = caseFoldPath(String.fromCodePoint(codePoint))

      if (caseFoldPath(folded) !== folded) unstable.push(codePoint.toString(16))
    }
    expect(unstable).toEqual([])
  })

  it("folds decomposed and precomposed accents to one composed key", () => {
    // Escapes pin the normalization forms — plain literals can both be saved
    // in NFC by the editor, which would make this pass without normalizing.
    const decomposed = "Cafe\u0301.md"
    const precomposed = "Caf\u00e9.md"
    expect([caseFoldPath(decomposed), caseFoldPath(precomposed)]).toEqual([
      "caf\u00e9.md",
      "caf\u00e9.md",
    ])
  })
})

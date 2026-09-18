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
    expect(caseFoldPath("λόγος.md")).toBe(caseFoldPath("λόγοσ.md"))
  })

  it("folds sharp s and ss to the same key", () => {
    expect(caseFoldPath("Straße.md")).toBe(caseFoldPath("strasse.md"))
  })

  it("folds decomposed and precomposed accents to the same key", () => {
    // Escapes pin the normalization forms — plain literals can both be saved
    // in NFC by the editor, which would make this pass without normalizing.
    const decomposed = "Cafe\u0301.md"
    const precomposed = "Caf\u00e9.md"
    expect(caseFoldPath(decomposed)).toBe(caseFoldPath(precomposed))
  })
})

import { describe, it, expect } from "vitest"
import { getExtensionsOfKind, getFileKind, isCanvasPath } from "../file-kinds.js"

// Test-owned, so a change to the production map has to change this table too
const EXPECTED_KINDS = [
  { extension: ".png", kind: "image" },
  { extension: ".jpg", kind: "image" },
  { extension: ".jpeg", kind: "image" },
  { extension: ".gif", kind: "image" },
  { extension: ".webp", kind: "image" },
  { extension: ".canvas", kind: "canvas" },
  { extension: ".pdf", kind: "pdf" },
  { extension: ".txt", kind: "text" },
  { extension: ".csv", kind: "text" },
  { extension: ".json", kind: "text" },
  { extension: ".xml", kind: "text" },
  { extension: ".svg", kind: "text" },
  { extension: ".log", kind: "text" },
  { extension: ".yaml", kind: "text" },
  { extension: ".yml", kind: "text" },
  { extension: ".base", kind: "text" },
  { extension: ".html", kind: "html" },
  { extension: ".htm", kind: "html" },
  { extension: ".py", kind: "script" },
  { extension: ".sh", kind: "script" },
  { extension: ".ps1", kind: "script" },
] as const

/** Uppercases every second letter of an extension: ".canvas" becomes ".cAnVaS". */
const toMixedCase = (extension: string): string => {
  return [...extension]
    .map((character, index) => (index % 2 === 0 ? character.toUpperCase() : character))
    .join("")
}

describe("getFileKind", () => {
  it.each(EXPECTED_KINDS)("maps $extension to $kind", ({ extension, kind }) => {
    expect(getFileKind(`Folder/file${extension}`)).toBe(kind)
  })

  it.each(EXPECTED_KINDS)("maps an uppercase $extension to $kind", ({ extension, kind }) => {
    expect(getFileKind(`Folder/FILE${extension.toUpperCase()}`)).toBe(kind)
  })

  it.each(EXPECTED_KINDS)("maps a mixed-case $extension to $kind", ({ extension, kind }) => {
    expect(getFileKind(`Folder/file${toMixedCase(extension)}`)).toBe(kind)
  })

  it("maps a file with no extension to other", () => {
    expect(getFileKind("scripts/Makefile")).toBe("other")
  })

  it("maps an extension the map does not list to other", () => {
    expect(getFileKind("audio/song.mp3")).toBe("other")
  })

  it("maps a markdown note to other, since notes are not files", () => {
    expect(getFileKind("Projects/plan.md")).toBe("other")
  })

  it("reads the kind from the last extension only", () => {
    expect(getFileKind("exports/report.pdf.txt")).toBe("text")
  })

  it("maps a dot-prefixed name with no other dot to other", () => {
    expect(getFileKind("config/.pdf")).toBe("other")
  })
})

describe("isCanvasPath", () => {
  it("accepts a canvas in any letter case", () => {
    expect(["Board.canvas", "Board.Canvas", "Board.CANVAS"].map(isCanvasPath)).toEqual([
      true,
      true,
      true,
    ])
  })

  it("rejects a note and other files", () => {
    expect(["Board.md", "Board.canvas.md", "Board.json"].map(isCanvasPath)).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe("getExtensionsOfKind", () => {
  it("lists the image extensions in order", () => {
    expect(getExtensionsOfKind("image")).toEqual([".png", ".jpg", ".jpeg", ".gif", ".webp"])
  })

  it("lists nothing for other, which covers unlisted extensions", () => {
    expect(getExtensionsOfKind("other")).toEqual([])
  })
})

import { describe, it, expect } from "vitest"
import { findAliasesKey, parseFrontmatterAliases } from "../aliases.js"

describe("parseFrontmatterAliases", () => {
  it("reads a list's text elements in document order", () => {
    expect(parseFrontmatterAliases({ aliases: ["Avery", "Mom"] })).toEqual(["Avery", "Mom"])
  })

  it("reads a text value as one alias", () => {
    expect(parseFrontmatterAliases({ aliases: "Mom" })).toEqual(["Mom"])
  })

  it("keeps a comma-joined text value as one alias", () => {
    expect(parseFrontmatterAliases({ aliases: "Mom, Avery" })).toEqual(["Mom, Avery"])
  })

  it("reads the aliases key in any letter case", () => {
    expect(parseFrontmatterAliases({ Aliases: ["Mom"] })).toEqual(["Mom"])
  })

  it("reads only the first key spelled aliases", () => {
    expect(parseFrontmatterAliases({ aliases: ["First"], ALIASES: ["Second"] })).toEqual(["First"])
  })

  it("trims each alias and drops blank ones", () => {
    expect(parseFrontmatterAliases({ aliases: [" Mom ", "", "   "] })).toEqual(["Mom"])
  })

  it("drops a text value that is blank", () => {
    expect(parseFrontmatterAliases({ aliases: "   " })).toEqual([])
  })

  it("drops list elements that are not text", () => {
    expect(
      parseFrontmatterAliases({ aliases: ["Mom", 42, null, { name: "Pup" }, ["Nested"], true] }),
    ).toEqual(["Mom"])
  })

  it.each([
    { label: "a number", value: 42 },
    { label: "a mapping", value: { name: "Mom" } },
    { label: "a checkbox", value: true },
    { label: "null", value: null },
  ])("reads no alias from $label", ({ value }) => {
    expect(parseFrontmatterAliases({ aliases: value })).toEqual([])
  })

  it("does not read the singular alias key", () => {
    expect(parseFrontmatterAliases({ alias: "Mom" })).toEqual([])
  })

  it("reads no alias when there is no aliases key", () => {
    expect(parseFrontmatterAliases({ title: "Avery Quinn" })).toEqual([])
  })
})

describe("findAliasesKey", () => {
  it("returns the first key spelled aliases, as written", () => {
    expect(findAliasesKey({ title: "Note", Aliases: ["A"], aliases: ["B"] })).toBe("Aliases")
  })

  it("returns undefined when no key is spelled aliases", () => {
    expect(findAliasesKey({ alias: "A", tags: ["b"] })).toBeUndefined()
  })
})

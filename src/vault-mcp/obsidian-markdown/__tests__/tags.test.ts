import { describe, it, expect } from "vitest"
import { isObsidianTagName, isTagsKey, parseFrontmatterTags } from "../tags.js"

describe("isTagsKey", () => {
  it.each(["tags", "Tags", "TAGS"])("accepts %s", (key) => {
    expect(isTagsKey(key)).toBe(true)
  })

  it.each(["tag", "tags ", "#tags", "related"])("rejects %j", (key) => {
    expect(isTagsKey(key)).toBe(false)
  })
})

describe("isObsidianTagName", () => {
  it.each([
    { label: "letters", name: "project" },
    { label: "letters with digits", name: "y1984" },
    { label: "a nested path", name: "project/vault-cortex" },
    { label: "underscore and hyphen", name: "my_tag-2" },
    { label: "accented letters and an emoji", name: "émoji✨" },
    { label: "a name ending in a slash", name: "foo/" },
  ])("accepts $label", ({ name }) => {
    expect(isObsidianTagName(name)).toBe(true)
  })

  it.each([
    { label: "an empty name", name: "" },
    { label: "a space", name: "a b" },
    { label: "a comma", name: "alpha,beta" },
    { label: "a plus sign", name: "c++" },
    { label: "a colon", name: "a:b" },
    { label: "a hash inside the name", name: "#x" },
    { label: "digits only", name: "1984" },
    { label: "a zero-width joiner, which sits in the General Punctuation block", name: "a‍b" },
  ])("rejects $label", ({ name }) => {
    expect(isObsidianTagName(name)).toBe(false)
  })
})

describe("parseFrontmatterTags", () => {
  it("reads a text value as one tag", () => {
    expect(parseFrontmatterTags({ tags: "my-tag" })).toEqual(["my-tag"])
  })

  it("reads no tag from a comma-joined text value", () => {
    expect(parseFrontmatterTags({ tags: "alpha, beta" })).toEqual([])
  })

  it("keeps the list entries Obsidian's Tags view keeps, trimmed, without a leading # or a trailing /", () => {
    const tags = [
      "Project",
      "#Alpha",
      " padded ",
      2024,
      true,
      3.5,
      "a b",
      "c++",
      "a:b",
      "##x",
      "y1984",
      "émoji✨",
      "nested/child/",
      "1984",
    ]

    expect(parseFrontmatterTags({ tags })).toEqual([
      "Project",
      "Alpha",
      "padded",
      "y1984",
      "émoji✨",
      "nested/child",
    ])
  })

  it("removes one trailing slash only, so a double slash leaves a slash", () => {
    expect(parseFrontmatterTags({ tags: ["foo//"] })).toEqual(["foo/"])
  })

  it("keeps a repeated tag once per occurrence", () => {
    expect(parseFrontmatterTags({ tags: ["project", "Project", "project"] })).toEqual([
      "project",
      "Project",
      "project",
    ])
  })

  it.each([
    { label: "a mapping", tags: { project: true } },
    { label: "a number", tags: 2024 },
    { label: "a boolean", tags: true },
    { label: "null", tags: null },
  ])("reads no tag from $label", ({ tags }) => {
    expect(parseFrontmatterTags({ tags })).toEqual([])
  })

  it("reads the tags key in any letter case", () => {
    expect(parseFrontmatterTags({ Tags: ["x"] })).toEqual(["x"])
    expect(parseFrontmatterTags({ TAGS: "y" })).toEqual(["y"])
  })

  it("reads only the first key spelled tags, even when its value is empty", () => {
    expect(parseFrontmatterTags({ Tags: null, tags: ["x"] })).toEqual([])
  })

  it("reads no tag when the note has no tags key", () => {
    expect(parseFrontmatterTags({ title: "No tags" })).toEqual([])
  })
})

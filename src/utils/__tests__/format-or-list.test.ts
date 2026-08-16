import { describe, it, expect } from "vitest"
import { formatOrList } from "../format-or-list.js"

describe("formatOrList", () => {
  it("returns an empty string for no items", () => {
    expect(formatOrList([])).toBe("")
  })

  it("returns the item alone for one item", () => {
    expect(formatOrList(["vault_get_memory"])).toBe("vault_get_memory")
  })

  it("joins two items with 'or' and no comma", () => {
    expect(formatOrList(["vault_get_memory", "vault_delete_memory"])).toBe(
      "vault_get_memory or vault_delete_memory",
    )
  })

  it("uses the serial comma before the final 'or' from three items", () => {
    expect(
      formatOrList([
        "vault_get_memory",
        "vault_update_memory",
        "vault_delete_memory",
      ]),
    ).toBe("vault_get_memory, vault_update_memory, or vault_delete_memory")
  })

  it("commas every item but the last for four items", () => {
    expect(formatOrList(["one", "two", "three", "four"])).toBe(
      "one, two, three, or four",
    )
  })
})

import { describe, expect, it } from "vitest"
import { capLogField } from "../cap-log-field.js"

describe("capLogField", () => {
  it("preserves absent, empty and short fields", () => {
    expect([capLogField(undefined), capLogField(""), capLogField("/mcp")]).toEqual([
      undefined,
      "",
      "/mcp",
    ])
  })

  it("keeps a field at the limit", () => {
    expect(capLogField("🎉".repeat(256))).toBe("🎉".repeat(256))
  })

  it("preserves the ASCII prefix including the ellipsis", () => {
    expect(capLogField("a".repeat(300))).toBe("a".repeat(255) + "…")
  })

  it("drops a whole joined emoji when the cut would split it", () => {
    expect(capLogField("a".repeat(254) + "👩‍💻" + "suffix")).toBe("a".repeat(254) + "…")
  })

  it("caps by code points including the ellipsis", () => {
    expect(capLogField("🎉".repeat(300))).toBe("🎉".repeat(255) + "…")
  })
})

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

  it("caps by code points including the ellipsis", () => {
    expect(capLogField("🎉".repeat(300))).toBe("🎉".repeat(255) + "…")
  })
})

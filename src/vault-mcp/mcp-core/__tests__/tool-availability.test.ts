import { describe, it, expect } from "vitest"
import { createToolAvailability } from "../tool-availability.js"
import type { ToolName } from "../tool-registry.js"

const availabilityFor = (...enabled: ToolName[]) =>
  createToolAvailability(new Set(enabled))

describe("isToolEnabled", () => {
  it("is true for a served tool", () => {
    expect(
      availabilityFor("vault_get_memory").isToolEnabled("vault_get_memory"),
    ).toBe(true)
  })

  it("is false for a tool this config does not serve", () => {
    expect(
      availabilityFor("vault_get_memory").isToolEnabled("vault_update_memory"),
    ).toBe(false)
  })
})

describe("whenToolEnabledText", () => {
  it("returns the text when the tool is served", () => {
    expect(
      availabilityFor("vault_delete_memory").whenToolEnabledText(
        "vault_delete_memory",
        " or vault_delete_memory",
      ),
    ).toBe(" or vault_delete_memory")
  })

  it("returns an empty string when the tool is not served", () => {
    expect(
      availabilityFor("vault_get_memory").whenToolEnabledText(
        "vault_delete_memory",
        " or vault_delete_memory",
      ),
    ).toBe("")
  })
})

describe("formatEnabledToolList", () => {
  it("drops the names this config does not serve", () => {
    const availability = availabilityFor(
      "vault_get_memory",
      "vault_delete_memory",
    )

    expect(
      availability.formatEnabledToolList([
        "vault_get_memory",
        "vault_update_memory",
        "vault_delete_memory",
      ]),
    ).toBe("vault_get_memory or vault_delete_memory")
  })

  it("returns the name alone when only one survives", () => {
    expect(
      availabilityFor("vault_delete_memory").formatEnabledToolList([
        "vault_get_memory",
        "vault_delete_memory",
      ]),
    ).toBe("vault_delete_memory")
  })

  it("joins three served names with a serial comma before 'or'", () => {
    const availability = availabilityFor(
      "vault_get_memory",
      "vault_update_memory",
      "vault_delete_memory",
    )

    expect(
      availability.formatEnabledToolList([
        "vault_get_memory",
        "vault_update_memory",
        "vault_delete_memory",
      ]),
    ).toBe("vault_get_memory, vault_update_memory, or vault_delete_memory")
  })

  it("preserves the order given, not the order enabled", () => {
    const availability = availabilityFor(
      "vault_delete_memory",
      "vault_get_memory",
    )

    expect(
      availability.formatEnabledToolList([
        "vault_get_memory",
        "vault_delete_memory",
      ]),
    ).toBe("vault_get_memory or vault_delete_memory")
  })

  // The contract every caller builds its fallback sentence on: with nothing
  // served the clause has to vanish, not trail off mid-sentence.
  it("returns an empty string when no name survives", () => {
    expect(
      availabilityFor("vault_read_note").formatEnabledToolList([
        "vault_get_memory",
        "vault_update_memory",
      ]),
    ).toBe("")
  })

  it("returns an empty string for an empty name list", () => {
    expect(availabilityFor("vault_get_memory").formatEnabledToolList([])).toBe(
      "",
    )
  })
})

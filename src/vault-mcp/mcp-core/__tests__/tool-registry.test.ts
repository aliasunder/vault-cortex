import { describe, expect, it } from "vitest"
import {
  TOOL_NAMES,
  TOOL_REGISTRY,
  TOOL_REGISTRY_BY_NAME,
} from "../tool-registry.js"

describe("TOOL_REGISTRY", () => {
  it("registry names are unique", () => {
    const names = TOOL_REGISTRY.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("registry entries and TOOL_NAMES values are the same set", () => {
    const registryNames = TOOL_REGISTRY.map((entry) => entry.name).toSorted()
    const nameConstants = Object.values(TOOL_NAMES).toSorted()
    expect(registryNames).toEqual(nameConstants)
  })

  it("the by-name lookup covers every registry entry", () => {
    for (const entry of TOOL_REGISTRY) {
      expect(TOOL_REGISTRY_BY_NAME.get(entry.name)).toBe(entry)
    }
  })

  // Literal spot-checks so a registry typo cannot self-certify through
  // tests that derive their expectations from the registry itself.
  it("vault_read_note is a read-only vault-crud tool", () => {
    expect(TOOL_REGISTRY_BY_NAME.get("vault_read_note")).toEqual({
      name: "vault_read_note",
      group: "vault-crud",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })
  })

  it("vault_write_note is a destructive write", () => {
    expect(TOOL_REGISTRY_BY_NAME.get("vault_write_note")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    })
  })

  it("vault_update_memory is an additive, replay-safe write", () => {
    expect(
      TOOL_REGISTRY_BY_NAME.get("vault_update_memory")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  it("vault_update_properties is a destructive but idempotent write", () => {
    expect(
      TOOL_REGISTRY_BY_NAME.get("vault_update_properties")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  it("vault_insert_at_anchor is an additive, non-idempotent write", () => {
    expect(
      TOOL_REGISTRY_BY_NAME.get("vault_insert_at_anchor")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    })
  })

  it("vault_replace_span is a destructive, non-idempotent write", () => {
    expect(
      TOOL_REGISTRY_BY_NAME.get("vault_replace_span")?.annotations,
    ).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    })
  })

  it("vault_update_task is a destructive, non-idempotent write", () => {
    expect(TOOL_REGISTRY_BY_NAME.get("vault_update_task")?.annotations).toEqual(
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    )
  })

  it("the flag-gated groups contain exactly the memory and asset tools", () => {
    const memoryTools = TOOL_REGISTRY.filter(
      (entry) => entry.group === "memory",
    ).map((entry) => entry.name)
    const assetTools = TOOL_REGISTRY.filter(
      (entry) => entry.group === "asset",
    ).map((entry) => entry.name)
    expect(memoryTools.toSorted()).toEqual([
      "vault_delete_memory",
      "vault_get_memory",
      "vault_list_memory_files",
      "vault_memory_recall",
      "vault_update_memory",
    ])
    expect(assetTools.toSorted()).toEqual([
      "vault_list_files",
      "vault_read_file",
    ])
  })
})

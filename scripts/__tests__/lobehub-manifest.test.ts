import { describe, it, expect } from "vitest"
import { readFile } from "node:fs/promises"
import {
  buildLobehubManifest,
  serializeLobehubManifest,
  LOBEHUB_MANIFEST_PATH,
} from "../lobehub-manifest.js"
import { TOOL_NAMES } from "../../src/vault-mcp/mcp-core/tool-definitions.js"
import { PROMPT_NAMES } from "../../src/vault-mcp/mcp-core/prompt-definitions.js"
import packageJson from "../../package.json" with { type: "json" }

describe("buildLobehubManifest", () => {
  it("advertises every registered tool", async () => {
    const manifest = await buildLobehubManifest()
    expect(manifest.tools.map((tool) => tool.name).toSorted()).toEqual(
      Object.values(TOOL_NAMES).toSorted(),
    )
  })

  it("advertises every registered prompt", async () => {
    const manifest = await buildLobehubManifest()
    expect(manifest.prompts.map((prompt) => prompt.name).toSorted()).toEqual(
      Object.values(PROMPT_NAMES).toSorted(),
    )
  })

  it("gives every tool a description and an object input schema", async () => {
    const manifest = await buildLobehubManifest()
    const incomplete = manifest.tools.filter(
      (tool) => !tool.description || !tool.inputSchema,
    )
    expect(incomplete.map((tool) => tool.name)).toEqual([])
  })

  it("takes its version from package.json", async () => {
    const manifest = await buildLobehubManifest()
    expect(manifest.version).toBe(packageJson.version)
  })
})

describe("lhm.plugin.json", () => {
  // The marketplace listing is only as accurate as this committed file — the
  // publish step reads it verbatim. Regenerate with:
  //   npm run sync:lobehub-manifest
  it("matches what the sync script would write", async () => {
    const [committed, manifest] = await Promise.all([
      readFile(LOBEHUB_MANIFEST_PATH, "utf8"),
      buildLobehubManifest(),
    ])
    expect(committed).toBe(serializeLobehubManifest(manifest))
  })
})

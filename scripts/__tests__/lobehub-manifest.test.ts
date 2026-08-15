import { describe, it, expect, vi, onTestFinished } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  buildLobehubManifest,
  serializeLobehubManifest,
  type LobehubManifest,
} from "../lobehub-manifest.js"
import { loadConfig } from "../../src/vault-mcp/config.js"
import { TOOL_NAMES } from "../../src/vault-mcp/mcp-core/tool-registry.js"
import { PROMPT_NAMES } from "../../src/vault-mcp/mcp-core/prompt-definitions.js"
import packageJson from "../../package.json" with { type: "json" }
import serverJson from "../../server.json" with { type: "json" }

type ListToolsResult = Awaited<ReturnType<Client["listTools"]>>
type ListPromptsResult = Awaited<ReturnType<Client["listPrompts"]>>

/** Bends only the tools/list response so the real server, real registration, and
 *  real in-memory transport still run — the guards under test are unreachable
 *  through a correctly registered server, which is the point of them. */
const stubListTools = (result: ListToolsResult): void => {
  const spy = vi.spyOn(Client.prototype, "listTools").mockResolvedValue(result)
  onTestFinished(() => spy.mockRestore())
}

/** Prompt-side counterpart to stubListTools. */
const stubListPrompts = (result: ListPromptsResult): void => {
  const spy = vi
    .spyOn(Client.prototype, "listPrompts")
    .mockResolvedValue(result)
  onTestFinished(() => spy.mockRestore())
}

const OBJECT_SCHEMA = { type: "object" } as const

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

  it("advertises an object input schema for every tool", async () => {
    const manifest = await buildLobehubManifest()
    const schemaTypes = manifest.tools.map((tool) => tool.inputSchema?.type)
    expect([...new Set(schemaTypes)]).toEqual(["object"])
  })

  it("derives its identity fields from package.json and server.json", async () => {
    const manifest = await buildLobehubManifest()
    // Rest-destructured rather than picked field by field, so a new manifest
    // field that nobody wired up fails this test instead of passing unnoticed.
    const { tools: _tools, prompts: _prompts, ...identity } = manifest
    expect(identity).toEqual({
      author: "aliasunder",
      authorUrl: "https://github.com/aliasunder",
      description: serverJson.description,
      identifier: "aliasunder-vault-cortex",
      name: serverJson.title,
      tags: packageJson.keywords,
      version: packageJson.version,
    })
  })

  it("advertises the full surface even when the ambient env disables tool groups", async () => {
    vi.stubEnv("MEMORY_ENABLED", "false")
    vi.stubEnv("FILE_TOOLS_ENABLED", "false")
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })

    // Proves the stubbed env is genuinely hostile. Without this, a renamed env
    // var would make the stubs inert and leave the assertion below passing for
    // no reason at all.
    const ambientConfig = loadConfig(process.env)
    expect({
      memoryEnabled: ambientConfig.memoryEnabled,
      fileToolsEnabled: ambientConfig.fileToolsEnabled,
    }).toEqual({ memoryEnabled: false, fileToolsEnabled: false })

    const manifest = await buildLobehubManifest()
    expect(manifest.tools.map((tool) => tool.name).toSorted()).toEqual(
      Object.values(TOOL_NAMES).toSorted(),
    )
  })

  it("throws naming the tool when a tool has no description", async () => {
    stubListTools({
      tools: [{ name: "vault_read_note", inputSchema: OBJECT_SCHEMA }],
    })

    await expect(buildLobehubManifest()).rejects.toThrow(
      'tool "vault_read_note" has no description; every tool and prompt must declare one',
    )
  })

  it("throws naming the prompt when a prompt has no description", async () => {
    stubListPrompts({ prompts: [{ name: "vault-orientation" }] })

    await expect(buildLobehubManifest()).rejects.toThrow(
      'prompt "vault-orientation" has no description; every tool and prompt must declare one',
    )
  })

  it("throws when tools/list returns a paginated response", async () => {
    // No tools: the pagination guard must be the only reachable rejection.
    stubListTools({ tools: [], nextCursor: "page-2" })

    await expect(buildLobehubManifest()).rejects.toThrow(
      "tools/list returned a paginated response; the manifest builder reads one page only",
    )
  })

  it("throws when prompts/list returns a paginated response", async () => {
    stubListPrompts({ prompts: [], nextCursor: "page-2" })

    await expect(buildLobehubManifest()).rejects.toThrow(
      "prompts/list returned a paginated response; the manifest builder reads one page only",
    )
  })

  it("closes the client before failing the pagination check", async () => {
    stubListTools({ tools: [], nextCursor: "page-2" })
    const closeSpy = vi.spyOn(Client.prototype, "close")
    onTestFinished(() => closeSpy.mockRestore())

    await expect(buildLobehubManifest()).rejects.toThrow(
      "tools/list returned a paginated response; the manifest builder reads one page only",
    )
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})

describe("serializeLobehubManifest", () => {
  it("emits two-space-indented JSON with a trailing newline", () => {
    const manifest: LobehubManifest = {
      author: "aliasunder",
      authorUrl: "https://github.com/aliasunder",
      description: "A vault server",
      identifier: "aliasunder-vault-cortex",
      name: "Vault Cortex",
      prompts: [{ name: "vault-orientation", description: "Survey the vault" }],
      tags: ["mcp"],
      tools: [
        {
          name: "vault_read_note",
          description: "Read a note",
          inputSchema: { type: "object" },
        },
      ],
      version: "1.2.3",
    }

    expect(serializeLobehubManifest(manifest)).toBe(
      `{
  "author": "aliasunder",
  "authorUrl": "https://github.com/aliasunder",
  "description": "A vault server",
  "identifier": "aliasunder-vault-cortex",
  "name": "Vault Cortex",
  "prompts": [
    {
      "name": "vault-orientation",
      "description": "Survey the vault"
    }
  ],
  "tags": [
    "mcp"
  ],
  "tools": [
    {
      "name": "vault_read_note",
      "description": "Read a note",
      "inputSchema": {
        "type": "object"
      }
    }
  ],
  "version": "1.2.3"
}
`,
    )
  })
})

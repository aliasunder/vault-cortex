// Builds the LobeHub Marketplace manifest (lhm.plugin.json) from the server
// itself. Split from the sync script so the tests can exercise the builder
// without writing to disk.
//
// The tool and prompt arrays come from a real McpServer wired through the real
// registration path and queried over an in-memory MCP transport (the same
// capture the snapshot test pins), so the published listing describes the
// same surface a connected client sees — no hand-maintained copy to fall out
// of date.

import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js"
import { fileURLToPath } from "node:url"
import { captureToolSurface } from "./tool-surface-capture.js"
import packageJson from "../package.json" with { type: "json" }
import serverJson from "../server.json" with { type: "json" }

/** Marketplace-assigned listing id, copied from the lobehub.com/mcp/<id> URL.
 *  LobeHub assigns it at import time — publishing against an invented id 404s. */
export const LOBEHUB_IDENTIFIER = "aliasunder-vault-cortex"

const GITHUB_OWNER = "aliasunder"

/** Absolute path of the manifest `lhm plugin publish` reads. Generated, not
 *  committed — `npm run publish:lobehub` regenerates it before every publish. */
export const LOBEHUB_MANIFEST_PATH = fileURLToPath(new URL("../lhm.plugin.json", import.meta.url))

type ManifestTool = {
  name: string
  description: string
  inputSchema: Tool["inputSchema"]
}

type ManifestPrompt = {
  name: string
  description: string
}

export type LobehubManifest = {
  author: string
  authorUrl: string
  description: string
  identifier: string
  name: string
  prompts: ManifestPrompt[]
  tags: string[]
  tools: ManifestTool[]
  version: string
}

/**
 * The SDK types `description` as optional, but every registration in this repo
 * sets one — an absent description is a registration bug, and failing the build
 * beats publishing a listing entry the marketplace renders blank.
 */
const requireDescription = ({
  description,
  subject,
}: {
  description: string | undefined
  subject: string
}): string => {
  if (!description) {
    throw new Error(`${subject} has no description; every tool and prompt must declare one`)
  }
  return description
}

/** Carries only the fields the marketplace listing renders — the SDK's
 *  outputSchema, annotations, and icons have nowhere to surface there. */
const toManifestTool = (tool: Tool): ManifestTool => {
  return {
    name: tool.name,
    description: requireDescription({
      description: tool.description,
      subject: `tool "${tool.name}"`,
    }),
    inputSchema: tool.inputSchema,
  }
}

/** Prompt arguments aren't part of a marketplace entry, so the listing carries
 *  the name and description only. */
const toManifestPrompt = (prompt: Prompt): ManifestPrompt => {
  return {
    name: prompt.name,
    description: requireDescription({
      description: prompt.description,
      subject: `prompt "${prompt.name}"`,
    }),
  }
}

/**
 * Assembles the manifest from the server's own advertised tools and prompts.
 * The identity fields come from package.json and server.json, so the listing
 * tracks the same metadata as the npm package and the MCP registry entry.
 */
export const buildLobehubManifest = async (): Promise<LobehubManifest> => {
  // An empty env rather than process.env: MEMORY_ENABLED and FILE_TOOLS_ENABLED
  // default on, so the listing advertises the full surface and whoever runs the
  // sync can't narrow what gets published with their own shell exports.
  const capture = await captureToolSurface({ name: "default", env: {} })

  return {
    author: GITHUB_OWNER,
    authorUrl: `https://github.com/${GITHUB_OWNER}`,
    description: serverJson.description,
    identifier: LOBEHUB_IDENTIFIER,
    name: serverJson.title,
    prompts: capture.prompts.map(toManifestPrompt),
    tags: packageJson.keywords,
    tools: capture.tools.map(toManifestTool),
    version: packageJson.version,
  }
}

/** Serializes the manifest exactly as `lhm plugin publish` reads it, so the
 *  format is pinned in one place rather than re-implemented by each caller.
 *  Prettier skips the file because it is gitignored (.gitignore is part of
 *  Prettier's default ignore path), so nothing reformats it after this. */
export const serializeLobehubManifest = (manifest: LobehubManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`

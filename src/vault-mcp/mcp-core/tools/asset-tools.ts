/** Asset tool registration — reading and discovering non-markdown vault files. */

import { z } from "zod"
import { assetOperations } from "../../vault-operations/asset-operations.js"
import type { FittedImage } from "../../../utils/fit-image-to-byte-budget.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { safeHandler, safeHandlerContent } from "./tool-helpers.js"

const TOOL_NAMES = {
  VAULT_READ_ASSET: "vault_read_asset",
  VAULT_LIST_ASSETS: "vault_list_assets",
} as const

export { TOOL_NAMES as ASSET_TOOL_NAMES }

/** One-line, model-facing summary accompanying an image block: what file it
 *  is, what was delivered, and whether/how it was shrunk to fit. */
const describeDeliveredImage = (result: {
  fitted: FittedImage
  originalBytes: number
  path: string
}): string => {
  const { fitted, originalBytes, path } = result
  const delivered = `${path} — ${fitted.mimeType}, ${fitted.width}×${fitted.height}, ${fitted.data.length} bytes`
  if (!fitted.recompressed)
    return `${delivered} (original file, not recompressed)`
  return `${delivered} (recompressed from ${fitted.originalWidth}×${fitted.originalHeight}, ${originalBytes} bytes)`
}

export const registerAssetTools = ({
  server,
  vaultPath,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  server.registerTool(
    TOOL_NAMES.VAULT_READ_ASSET,
    {
      title: "Read Asset",
      description: `Read a non-markdown vault file (an asset) in its most useful form per type — the read-side companion to vault_read_note for everything that isn't a note.

Example: vault_read_asset({ path: "attachments/diagram.png" }) — the image itself, shrunk to fit response limits when needed
Example: vault_read_asset({ path: "Boards/Roadmap.canvas" }) — a readable outline of the canvas
Example: vault_read_asset({ path: "Boards/Roadmap.canvas", raw: true }) — the canvas's exact JSON source
Example: vault_read_asset({ path: "exports/data.json" }) — the file content as text
Example: vault_read_asset({ path: "papers/research.pdf" }) — structured text with title, headings, and links
Example: vault_read_asset({ path: "papers/research.pdf", raw: true }) — each page rendered as an image block

What each type returns:
- Images (.png/.jpg/.jpeg/.gif/.webp): the image as a viewable image block — downscaled and recompressed server-side when it exceeds client response limits, delivered untouched otherwise — plus a text line stating the path, delivered format/dimensions/bytes, and the original dimensions when shrunk. Animated GIFs are reduced to their first frame when recompressed to fit the budget.
- Canvas (.canvas): a readable markdown outline per JSON Canvas 1.0 — groups (by visual containment), node content in reading order, and a connections list with edge labels. Set raw: true for the exact JSON source instead (geometry, ids, colors — full fidelity).
- PDFs (.pdf): structured text with document metadata — title, page count, heading hierarchy (from font sizes), fenced code blocks (from monospace fonts), page separators, and a deduplicated links footer. Richer than flat text extraction: headings, code, and hyperlinks that flat extraction loses are preserved. Set raw: true for page images instead — each page rendered and returned as an image block, showing layout, diagrams, tables, and formatting that text extraction cannot preserve. Image-only and scanned PDFs work in raw mode. Up to 5 pages are rendered.
- Text formats (.svg/.json/.txt/.csv/.xml/.log/.base): the file content verbatim as text. .svg is returned as its XML source; .base as its YAML source.

When to use: whenever a note references an asset you need to actually see or read — an embedded diagram, a linked canvas, data file, or PDF. Find the assets a note links to (with byte sizes) via vault_get_outgoing_links; browse a folder's assets via vault_list_assets. For .md notes use vault_read_note — this tool rejects them.

Errors:
- "not an asset" — the path ends in .md; read notes with vault_read_note
- "asset not found" — nothing exists at that path; discover valid paths via vault_list_assets
- "asset too large" — the file exceeds the server's read cap (MAX_ASSET_BYTES, default 50 MiB)
- "text output too large" — a text asset or PDF renders past the output cap; only smaller files can be returned whole
- "not valid UTF-8" — the file's bytes aren't UTF-8 text; returning them would silently corrupt the content
- "PDF has no extractable text" — the PDF exists but contains no text content (scanned or image-only); states the page count. Set raw: true to render pages as images instead
- "PDF page rendering failed" — raw: true was set but no pages could be rendered; the PDF may be corrupt
- "image cannot be fitted" — the image could not be compressed under the output budget (MAX_IMAGE_OUTPUT_BYTES)
- "raw source is not available for images" — raw applies to text-representable files; an image's delivered form is its image block
- unsupported types (audio, archives, …) return an error naming the readable types plus the file's existence and size

Returns: for images, an image content block plus a one-line metadata text block; for PDFs with raw: true, a metadata text block followed by alternating image and text blocks (one pair per page); for every other supported type, a single text content block.

Search coverage: vault_search indexes markdown notes; find assets by browsing (vault_list_assets) or through a note's links (vault_get_outgoing_links).`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the asset, including its extension (e.g. "attachments/photo.png", "Boards/Roadmap.canvas"). Must NOT end in ".md" — notes are read with vault_read_note.',
          ),
        raw: z
          .boolean()
          .optional()
          .describe(
            "Return an alternative representation of the file. For .canvas this is the JSON Canvas source (geometry, ids, colors); for .pdf this renders pages as images instead of extracting text — useful for scanned documents, diagrams, and layout-sensitive content. Text formats already return their source, so raw changes nothing there. Images have no text source — raw returns an error.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, raw }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_READ_ASSET,
      })
      reqLogger.info("tool_call", { path, raw })
      return safeHandlerContent(
        reqLogger,
        () =>
          assetOperations.readAssetContent(
            {
              vaultPath,
              path,
              raw,
              maxAssetBytes: config.maxAssetBytes,
              maxImageOutputBytes: config.maxImageOutputBytes,
              maxPdfRenderPages: config.maxPdfRenderPages,
            },
            reqLogger,
          ),
        (result) => {
          if (result.kind === "image") {
            reqLogger.info("tool_result", {
              path,
              mimeType: result.fitted.mimeType,
              deliveredBytes: result.fitted.data.length,
              originalBytes: result.originalBytes,
              width: result.fitted.width,
              height: result.fitted.height,
              originalWidth: result.fitted.originalWidth,
              originalHeight: result.fitted.originalHeight,
              recompressed: result.fitted.recompressed,
            })
            return [
              {
                type: "image" as const,
                data: result.fitted.data.toString("base64"),
                mimeType: result.fitted.mimeType,
              },
              { type: "text" as const, text: describeDeliveredImage(result) },
            ]
          }
          if (result.kind === "pages") {
            reqLogger.info("tool_result", {
              path,
              totalPages: result.totalPages,
              pagesRendered: result.pagesRendered,
            })
            const titleSegment = result.title ? `, "${result.title}"` : ""
            const metadataLine =
              `${result.path} — PDF, ${result.totalPages} pages` +
              titleSegment +
              ` — rendered ${result.pagesRendered} ` +
              `page${result.pagesRendered === 1 ? "" : "s"} as images`
            const blocks: Array<
              | { type: "text"; text: string }
              | { type: "image"; data: string; mimeType: string }
            > = [{ type: "text" as const, text: metadataLine }]
            for (const page of result.pages) {
              blocks.push(
                {
                  type: "image" as const,
                  data: page.fitted.data.toString("base64"),
                  mimeType: page.fitted.mimeType,
                },
                {
                  type: "text" as const,
                  text:
                    `Page ${page.pageNumber} — ${page.fitted.mimeType}, ` +
                    `${page.fitted.width}×${page.fitted.height}, ` +
                    `${page.fitted.data.length} bytes`,
                },
              )
            }
            return blocks
          }
          reqLogger.info("tool_result", {
            path,
            textBytes: Buffer.byteLength(result.text, "utf8"),
          })
          return [{ type: "text" as const, text: result.text }]
        },
      )
    },
  )

  server.registerTool(
    TOOL_NAMES.VAULT_LIST_ASSETS,
    {
      title: "List Assets",
      description: `List non-markdown files (assets) in the vault or a folder — images, canvases, PDFs, data files — with per-file byte sizes and per-extension counts.

Example: vault_list_assets({}) — every asset in the vault
Example: vault_list_assets({ folder: "attachments" })
Example: vault_list_assets({ extensions: [".png", ".jpg"], limit: 20 })

When to use: discovering what assets exist before reading them with vault_read_asset. vault_search, vault_list_notes, and vault_search_by_folder cover only markdown notes, so this is the discovery surface for everything else. For the assets one specific note links to, prefer vault_get_outgoing_links.

Parameters:
- folder: folder path filter (e.g. "attachments" or "Projects/media"), searched recursively; omit for the whole vault
- extensions: restrict to these extensions — case-insensitive, with or without the leading dot (".png" and "png" both work)
- limit: maximum entries returned (default 50). extension_counts and total always reflect the full filtered set, not just the returned page.

Errors:
- A folder containing no assets — or a folder that doesn't exist — returns an empty listing, not an error.
- A folder path escaping the vault (e.g. "../elsewhere") is rejected with a path-traversal error.

Returns: JSON with assets (array of { path, extension, bytes }, sorted by path), extension_counts (per-extension totals over the full filtered set), total (full filtered count), and truncated (true when total exceeds limit). bytes is the on-disk file size, not the delivery cost: reading an image via vault_read_asset returns a copy shrunk to fit when needed, so a large listed image is still cheap to read. Text formats return verbatim, so their listed size is what a read delivers. Assets of supported types are readable via vault_read_asset; vault_search covers markdown notes.`,
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Folder path to search recursively (e.g. "attachments"). Omit to list the whole vault.',
          ),
        extensions: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Only include these extensions, case-insensitive, leading dot optional (e.g. [".png", "jpg"]).',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Max entries returned (default 50)."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder, extensions, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_LIST_ASSETS,
      })
      reqLogger.info("tool_call", { folder, extensions, limit })
      return safeHandler(
        reqLogger,
        async () => {
          const listing = await assetOperations.buildAssetListing(
            { vaultPath, folder, extensions, limit: limit ?? 50 },
            reqLogger,
          )
          return {
            assets: listing.assets,
            extension_counts: listing.extensionCounts,
            total: listing.total,
            truncated: listing.truncated,
          }
        },
        (result) => {
          reqLogger.info("tool_result", {
            total: result.total,
            returned: result.assets.length,
          })
          return JSON.stringify(result)
        },
      )
    },
  )
}

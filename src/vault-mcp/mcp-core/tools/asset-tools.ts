/** Asset tool registration — reading and discovering non-markdown vault files. */

import { z } from "zod"
import { assetOperations } from "../../vault-operations/asset-operations.js"
import type { AssetReadResult } from "../../vault-operations/asset-operations.js"
import type { FittedImage } from "../../../utils/fit-image-to-byte-budget.js"
import { TOOL_NAMES } from "../tool-registry.js"
import type { ToolRegistrationContext } from "./tool-helpers.js"
import { describeTextWindow } from "./tool-helpers.js"

type ContentBlock =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

/** One-line, model-facing summary accompanying an image block: what file it
 *  is, what was delivered, and whether/how it was shrunk to fit. */
const describeDeliveredImage = (result: {
  fitted: FittedImage
  originalBytes: number
  path: string
}): string => {
  const { fitted, originalBytes, path } = result
  const delivered = `${path} — ${fitted.mimeType}, ${fitted.width}×${fitted.height}, ${fitted.data.length} bytes`

  if (!fitted.recompressed) return `${delivered} (original file, not recompressed)`
  return `${delivered} (recompressed from ${fitted.originalWidth}×${fitted.originalHeight}, ${originalBytes} bytes)`
}

/** Formats an asset read result into MCP content blocks — the image, pages,
 *  or text representation the model sees. */
const formatAssetReadResult = (result: AssetReadResult): ContentBlock[] => {
  if (result.kind === "image") {
    return [
      {
        type: "image",
        data: result.fitted.data.toString("base64"),
        mimeType: result.fitted.mimeType,
      },
      { type: "text", text: describeDeliveredImage(result) },
    ]
  }
  if (result.kind === "pages") {
    const titleSegment = result.title ? `, "${result.title}"` : ""
    const metadataLine =
      `${result.path} — PDF, ${result.totalPages} pages` +
      titleSegment +
      ` — rendered ${result.pagesRendered} ` +
      `page${result.pagesRendered === 1 ? "" : "s"} as images`
    const pageBlocks = result.pages.flatMap((page) => [
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
    ])
    return [{ type: "text", text: metadataLine }, ...pageBlocks]
  }
  if (result.lineWindow) {
    const metadataBlock = {
      type: "text" as const,
      text: describeTextWindow(result.path, result.lineWindow),
    }
    const contentBlock = { type: "text" as const, text: result.text }
    return [metadataBlock, contentBlock]
  }
  return [{ type: "text", text: result.text }]
}

export const registerAssetTools = ({
  registerTool,
  safeHandler,
  safeHandlerContent,
  vaultPath,
  logger: sessionLogger,
  config,
}: ToolRegistrationContext): void => {
  registerTool(
    TOOL_NAMES.VAULT_READ_FILE,
    {
      title: "Read File",
      description: `Read a non-markdown vault file in its most useful form per type — the read-side companion to vault_read_note for everything that isn't a note.

Example: vault_read_file({ path: "attachments/diagram.png" }) — the image itself, shrunk when too large
Example: vault_read_file({ path: "Boards/Roadmap.canvas" }) — a readable outline of the canvas
Example: vault_read_file({ path: "exports/data.json" }) — the file content as text
Example: vault_read_file({ path: "exports/big.csv", limit: 500 }) — the first 500 lines, preceded by a metadata line stating the window and total line count
Example: vault_read_file({ path: "papers/research.pdf" }) — structured text with title, headings, and links

What each file type returns:
- Images (.png/.jpg/.jpeg/.gif/.webp): the image as a viewable image block — downscaled and recompressed server-side when it exceeds the image output budget (MAX_IMAGE_OUTPUT_BYTES, ${config.maxImageOutputBytes} bytes) or 1568 pixels on its longer side, delivered untouched otherwise — plus a text line stating the path, delivered format/dimensions/bytes, and the original dimensions when shrunk. Animated GIFs are reduced to their first frame when recompressed.
- Canvas (.canvas): a readable markdown outline per JSON Canvas 1.0 — groups (by visual containment), node content in reading order, and a connections list with edge labels.
- PDFs (.pdf): structured text with document metadata — title, page count, heading hierarchy (from font sizes relative to the body text), code blocks and inline code (from monospace fonts), page separators, and a deduplicated links footer. Richer than flat text extraction: headings, code, and hyperlinks that flat extraction loses are preserved.
- Text formats (.svg/.json/.txt/.csv/.xml/.log/.yaml/.yml/.base): the file content verbatim as text. .svg is returned as its XML source; .base as its YAML source.

raw: true switches a canvas or PDF to its other form:
- Canvas: the exact JSON source (geometry, ids, colors — full fidelity) instead of the outline.
- PDF: each page rendered and returned as an image block instead of extracted text, showing layout, diagrams, tables, and formatting that text extraction cannot preserve. Image-only and scanned PDFs work in raw mode. Only the first ${config.maxPdfRenderPages} pages are rendered; the text read (without raw) covers every page.

Line paging: start_line and limit page any text result — text formats, canvas outlines and raw JSON, PDF-extracted text — as a 1-based line window, preceded by a metadata line stating the window, the total line count, and where to continue ("data.csv — lines 51–100 of 400 (continue with start_line: 101)"). The text output cap (100 KiB) applies to each window, so one very long line can still overflow it; paging never gets around the file-size cap. Paged windows come back with \\n line endings and no trailing newline; a read without paging inputs stays byte-exact.

When to use: whenever a note references a file you need to actually see or read — an embedded diagram, a linked canvas, data file, or PDF. Find the files a note links to (with byte sizes) via vault_get_outgoing_links; browse a folder's files via vault_list_files. vault_search also indexes canvas, PDF, and text-format content, but not images or other files. For .md notes use vault_read_note — this tool rejects them. To check a large file's line count before reading it whole, request start_line: 1 with limit: 1 — one line plus the total.

Errors:
- "not a file" — the path ends in .md; read notes with vault_read_note
- "file not found" — nothing exists at that path; discover valid paths via vault_list_files
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — use a vault-relative path with no hidden (dot-prefixed) file or folder in it (hidden files are not readable, matching Obsidian)
- "file too large" — the file exceeds the file-size cap (MAX_FILE_BYTES, default 50 MiB)
- "text output too large" — a text file, canvas, or PDF renders past the text output cap; page it with start_line and limit, or reduce limit when a single window overflows
- "start line past the end" — start_line exceeds the file's line count; the error states the total, so retry with a smaller start_line
- "line range is not available" (start_line or limit on an image, or on a PDF read with raw: true) / "raw source is not available for images" (raw on an image) — drop that input; paging applies only to text results, and an image always comes back as its image block
- "not valid UTF-8" — the file's bytes aren't UTF-8 text; returning them would silently corrupt the content
- "invalid .canvas JSON" — the canvas file is empty or not valid JSON, so no outline can be built; set raw: true to read its source as text
- "PDF has no extractable text" — the PDF contains no text (scanned or image-only); the error states the page count. Set raw: true to render pages as images instead
- "PDF is password-protected" — the PDF needs a password, which this tool cannot supply; read an unprotected copy instead
- "PDF is damaged or not a PDF" — the file does not parse as a PDF; replace or re-export it
- "PDF page rendering failed" — raw: true was set but no pages could be rendered; the PDF may be corrupt
- "image cannot be fitted" — the image could not be compressed under the image output budget
- "could not decode image" — the file is empty, damaged, not an image despite its extension, or over about 268 million pixels; replace or re-export it
- "EACCES: …" or another filesystem error code — the file can't be read (permissions, a symbolic link loop); ask the vault's owner to fix it
- unsupported types (audio, archives, …) return an error naming the readable types plus the file's existence and size

Returns: for images, an image content block plus a one-line metadata text block; for PDFs with raw: true, a metadata text block followed by alternating image and text blocks (one pair per page); for every other supported type, a single text content block — preceded by a window-metadata text block when start_line or limit was given.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Vault-relative path to the file, including its extension (e.g. "attachments/photo.png", "Boards/Roadmap.canvas"). Must NOT end in ".md" — notes are read with vault_read_note. Use the exact letter case.',
          ),
        raw: z
          .boolean()
          .optional()
          .describe(
            "Return the file's alternative form: JSON source for .canvas, page images for .pdf. Changes nothing for text formats, which already return their source. Rejected for images.",
          ),
        start_line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("First line to return, 1-based (default 1)."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum lines returned (default: all remaining)."),
      },
    },
    async ({ path, raw, start_line, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_READ_FILE,
      })
      reqLogger.info("tool_call", { path, raw, startLine: start_line, limit })
      return safeHandlerContent(
        reqLogger,
        () =>
          assetOperations.readAssetContent(
            {
              vaultPath,
              path,
              raw,
              startLine: start_line,
              limit,
              maxFileBytes: config.maxFileBytes,
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
          } else if (result.kind === "pages") {
            reqLogger.info("tool_result", {
              path,
              totalPages: result.totalPages,
              pagesRendered: result.pagesRendered,
            })
          } else {
            reqLogger.info("tool_result", {
              path,
              textBytes: Buffer.byteLength(result.text, "utf8"),
              ...(result.lineWindow ?? {}),
            })
          }
          return formatAssetReadResult(result)
        },
      )
    },
  )

  registerTool(
    TOOL_NAMES.VAULT_LIST_FILES,
    {
      title: "List Files",
      description: `List non-markdown files in the vault or a folder — images, canvases, PDFs, data files — with per-file byte sizes and per-extension counts.

Example: vault_list_files({}) — every non-markdown file in the vault
Example: vault_list_files({ folder: "attachments" })
Example: vault_list_files({ extensions: [".png", ".jpg"], limit: 20 })

When to use: discovering what files exist before reading them with vault_read_file. vault_list_notes and vault_search_by_folder cover only markdown notes, and beyond notes vault_search indexes only canvas, PDF, and text-format files, so this is the discovery surface for everything else. For the files one specific note links to, prefer vault_get_outgoing_links.

Behavior: Reads the filesystem rather than the search index, so use the folder's exact letter case; on a case-sensitive filesystem a different case finds nothing.

Errors:
- A visible folder containing no files — or one that doesn't exist — returns an empty listing, not an error.
- "absolute path blocked" / "path traversal blocked" / "hidden path blocked" — the folder starts at the filesystem root, escapes the vault (e.g. "../elsewhere") or names the vault root itself (e.g. "."), or is hidden like ".obsidian" (hidden folders are not listable, matching Obsidian); use a vault-relative folder outside hidden folders, and omit folder to list the whole vault.

Returns: JSON with files (array of { path, extension, bytes }, sorted by path; extension is "(none)" for a file without one), extension_counts (per-extension totals over the full filtered set), total (full filtered count), and truncated (true when total exceeds limit). bytes is the on-disk file size, not the delivery cost: reading an image via vault_read_file returns a copy shrunk to fit when needed, so a large listed image is still cheap to read. Text formats return verbatim, so their listed size is what a read delivers; one over 100 KiB must be read in windows with vault_read_file's start_line and limit. Only supported types are readable via vault_read_file.`,
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Folder path to search recursively (e.g. "attachments" or "Projects/media"). Omit to list the whole vault.',
          ),
        extensions: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'Only include these extensions, case-insensitive, leading dot optional (e.g. [".png", "jpg"]).',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .default(50)
          .describe("Max entries returned (default 50)."),
      },
    },
    async ({ folder, extensions, limit }, extra) => {
      const reqLogger = sessionLogger.child({
        requestId: extra.requestId,
        tool: TOOL_NAMES.VAULT_LIST_FILES,
      })
      reqLogger.info("tool_call", { folder, extensions, limit })
      return safeHandler(
        reqLogger,
        async () => {
          const listing = await assetOperations.buildAssetListing(
            { vaultPath, folder, extensions, limit },
            reqLogger,
          )
          return {
            files: listing.assets,
            extension_counts: listing.extensionCounts,
            total: listing.total,
            truncated: listing.truncated,
          }
        },
        (result) => {
          reqLogger.info("tool_result", {
            total: result.total,
            returned: result.files.length,
          })
          return JSON.stringify(result)
        },
      )
    },
  )
}

import { vaultFs } from "./vault-filesystem.js"
import { links } from "../obsidian-markdown/links.js"
import type { Logger } from "../../logger.js"

/**
 * Asset listing use-case — composes the vault filesystem's asset walk and
 * stat primitives with extension-filter semantics into the browsing surface
 * behind vault_list_assets: filter, per-extension counts over the full
 * filtered set, and a size-capped result slice. There is no pagination —
 * `limit` caps the returned entries, and counts/total over the full set tell
 * the caller to narrow with folder/extensions when the cap is hit.
 */

/** Display extension for listings: lowercased with its dot, or "(none)" for
 *  extensionless files. */
const extensionOf = (assetPath: string): string =>
  links.getExtension(assetPath).toLowerCase() || "(none)"

/** Normalizes a caller-supplied extension filter entry: lowercased, leading
 *  dot ensured — so "PNG", "png", and ".png" all match ".png". */
const normalizeExtension = (extension: string): string => {
  const lowered = extension.toLowerCase()
  return lowered.startsWith(".") ? lowered : `.${lowered}`
}

export type AssetListing = Readonly<{
  assets: readonly Readonly<{
    path: string
    extension: string
    bytes: number
  }>[]
  extensionCounts: Readonly<Record<string, number>>
  total: number
  truncated: boolean
}>

/**
 * Lists a folder's (or the vault's) assets: extension-filtered, counted per
 * extension over the full filtered set, and capped to `limit` entries with
 * byte sizes statted for the returned slice only — entries beyond the cap
 * are never statted.
 */
const buildAssetListing = async (
  params: {
    vaultPath: string
    folder?: string | undefined
    extensions?: readonly string[] | undefined
    limit: number
  },
  logger: Logger,
): Promise<AssetListing> => {
  const assetPaths = await vaultFs.listAssets(
    { vaultPath: params.vaultPath, folder: params.folder },
    logger,
  )
  const extensionFilter = params.extensions
    ? new Set(params.extensions.map(normalizeExtension))
    : undefined
  const filteredPaths = extensionFilter
    ? assetPaths.filter((assetPath) =>
        extensionFilter.has(links.getExtension(assetPath).toLowerCase()),
      )
    : assetPaths

  const filteredExtensions = filteredPaths.map(extensionOf)
  const extensionCounts = filteredExtensions.reduce<Record<string, number>>(
    (counts, extension) => ({
      ...counts,
      [extension]: (counts[extension] ?? 0) + 1,
    }),
    {},
  )

  const returnedPaths = filteredPaths.slice(0, params.limit)
  const stattedAssets = await vaultFs.statAssets(
    { vaultPath: params.vaultPath, paths: returnedPaths },
    logger,
  )
  return {
    assets: stattedAssets.map((entry) => ({
      path: entry.path,
      extension: extensionOf(entry.path),
      bytes: entry.bytes,
    })),
    extensionCounts,
    total: filteredPaths.length,
    truncated: filteredPaths.length > params.limit,
  }
}

/** The asset-listing use-case surface — namespace export so call sites read
 *  `assetListing.buildAssetListing(...)`, matching the folder's operation
 *  modules (noteMover, vaultPatcher, taskUpdater). */
export const assetListing = {
  buildAssetListing,
}

/** The options a delete resolves per call before the data layer runs: the
 *  protected folders, the trash setting and the retention sweep's hooks. Both
 *  delete tools (notes and files) resolve them here, so the Obsidian Sync rule
 *  and the rule for which trash moves are recorded each have one home. */

import type { VaultConfig } from "../config.js"
import type { SearchIndex } from "../search/search-index.js"
import type { Logger } from "../../logger.js"
import { resolveEffectiveProtectedPaths } from "./vault-folder-config.js"
import { readTrashConfig } from "./trash-config.js"
import type { TrashOption } from "./trash-config.js"

export type ResolvedDeleteOptions = {
  protectedPaths: readonly string[]
  trashOption: TrashOption
  recordTrashEntry: SearchIndex["recordTrashEntry"] | undefined
  clearStaleTrashEntry: SearchIndex["deleteTrashEntry"]
}

export const resolveDeleteOptions = async (
  params: {
    config: VaultConfig
    vaultPath: string
    search: Pick<SearchIndex, "recordTrashEntry" | "deleteTrashEntry">
  },
  logger: Logger,
): Promise<ResolvedDeleteOptions> => {
  const { config, vaultPath, search } = params
  const protectedPaths = await resolveEffectiveProtectedPaths({ config, vaultPath }, logger)

  // Under Obsidian Sync the setting is skipped and the note or file is deleted
  // for good ("none", since "system" would land in .trash/): a server-side
  // .trash/ never syncs back, and Sync's version history is the recovery path.
  const trashOption = config.obsidianSyncEnabled ? "none" : await readTrashConfig(vaultPath, logger)

  return {
    protectedPaths,
    trashOption,
    // Only "system" moves are swept later, so only they are recorded; "local"
    // is Obsidian's keep-forever trash.
    recordTrashEntry: trashOption === "system" ? search.recordTrashEntry : undefined,
    // Passed for every option, not only "system":
    // - Emptying .trash/ by hand leaves trash records behind, so a stale
    //   record can sit at the path this delete lands on.
    // - A move the server does not record ("local", or a "system" move whose
    //   record failed) drops that stale record, so the retention sweep never
    //   deletes the entry just trashed.
    // - A "none" delete lands nothing in .trash/ and never calls it.
    clearStaleTrashEntry: search.deleteTrashEntry,
  }
}

/** The sentence a client gets after a raw filesystem or index error, so the
 *  message carries its own remedy and no tool description has to explain
 *  the code. Tool handlers and prompt fallbacks both call this, so it sits at
 *  `mcp-core/` root like tool-availability.ts. */

import { isErrnoException } from "../../utils/is-errno-exception.js"
import { IndexIntegrityError } from "../search/search-helpers.js"
import { TEMP_SAVE_SUFFIX_BYTES, isTempSavePath } from "../vault-operations/vault-filesystem.js"
import type { ToolName } from "./tool-registry.js"

const INDEX_REMEDY =
  "The server's search index could not be read; the call was not at fault. Retry once, then report a repeat to the server's owner."

// A Node system error names its syscall and the path it failed on, plus a
// second path (`dest`) for rename and link; a coded error without a syscall
// (an ERR_* TypeError on the arguments) is the caller's to read as it is
type SystemError = NodeJS.ErrnoException & { syscall: string; dest?: string }

const isSystemError = (error: NodeJS.ErrnoException): error is SystemError => {
  return typeof error.syscall === "string"
}

const describeTempSaveRemedy = (isToolEnabled: (name: ToolName) => boolean): string => {
  const renameToolClause = isToolEnabled("vault_move_note") ? ", with vault_move_note" : ""

  return `The name leaves no room for the temporary file a save writes beside it; save it under a name at least ${TEMP_SAVE_SUFFIX_BYTES} bytes shorter (rename an existing note${renameToolClause}).`
}

const describeSystemErrorRemedy = (
  error: SystemError,
  isToolEnabled: (name: ToolName) => boolean,
): string | undefined => {
  switch (error.code) {
    case "ENAMETOOLONG": {
      const failedPaths = [error.path, error.dest].filter((path) => path !== undefined)

      if (failedPaths.some(isTempSavePath)) return describeTempSaveRemedy(isToolEnabled)
      return "The path is too long for the filesystem; use a shorter one."
    }
    case "ENOTDIR":
    case "EEXIST": {
      if (error.syscall === "mkdir") {
        return "A folder in the path is an existing file; choose a path whose folders are folders."
      }
      if (error.syscall === "scandir") {
        return "The folder changed while it was being listed; retry."
      }
      return "The file or folder changed while the call ran; retry."
    }
    case "EACCES":
    case "EPERM":
      return "Ask the vault's owner to fix the file's or folder's permissions."
    case "EROFS":
      return "The disk is read-only; ask the vault's owner."
    case "ENOSPC":
    case "EDQUOT":
      return "The disk is full; ask the vault's owner to free space."
    case "ELOOP":
      return "The path goes through a symbolic-link loop; ask the vault's owner to fix the link."
    case "EIO":
      return "The disk failed to read or write; ask the vault's owner."
    case "EMFILE":
    case "ENFILE":
    case "EAGAIN":
    case "EBUSY":
      return "The server is busy; retry."
    // The helpers in utils/fs.ts absorb the ordinary cases of these, so a raw
    // one means the file changed between two steps of the call
    case "ENOENT":
    case "EISDIR":
      return "The file or folder changed while the call ran; retry."
    default:
      return undefined
  }
}

/** The remedy sentence for a raw coded error, or undefined for an error the
 *  table does not know (its own text stands). */
export const remedyForCodedError = (params: {
  error: unknown
  isToolEnabled: (name: ToolName) => boolean
}): string | undefined => {
  const { error, isToolEnabled } = params

  if (error instanceof IndexIntegrityError) return INDEX_REMEDY
  if (!isErrnoException(error)) return undefined
  // better-sqlite3's SqliteError carries a SQLITE_* code and no syscall
  if (error.code.startsWith("SQLITE_")) return INDEX_REMEDY
  if (!isSystemError(error)) return undefined
  return describeSystemErrorRemedy(error, isToolEnabled)
}

/** The client text for an error: its message followed by the remedy when the
 *  error has one. A message that already ends with a period gets the remedy
 *  after a space; Node's messages end with a quoted path, so they get ". ". */
export const appendCodedErrorRemedy = (params: {
  message: string
  error: unknown
  isToolEnabled: (name: ToolName) => boolean
}): string => {
  const remedy = remedyForCodedError(params)

  if (!remedy) return params.message

  const separator = params.message.endsWith(".") ? " " : ". "
  return `${params.message}${separator}${remedy}`
}

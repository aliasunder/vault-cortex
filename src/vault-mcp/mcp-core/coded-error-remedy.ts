/** The sentence a client gets after a raw filesystem or index error, so the
 *  message carries its own remedy and no tool description has to explain
 *  the code. Tool handlers and prompt fallbacks both call this, so it sits at
 *  `mcp-core/` root like tool-availability.ts. */

import { isErrnoException } from "../../utils/is-errno-exception.js"
import { IndexIntegrityError } from "../search/search-helpers.js"
import { TEMP_SAVE_SUFFIX_BYTES, isTempSavePath } from "../vault-operations/vault-filesystem.js"
import type { ToolName } from "./tool-registry.js"

const INDEX_REMEDY =
  "The server's search index could not be read; the call was not at fault. Retry once; if it fails again, tell the server's owner."

const CHANGED_DURING_CALL_REMEDY = "The file or folder changed while the call ran; retry."

// A Node system error names its syscall and the path it failed on. A coded
// error without a syscall (an ERR_* TypeError on the arguments) gets no remedy
type SystemError = NodeJS.ErrnoException & { syscall: string }

const isSystemError = (error: NodeJS.ErrnoException): error is SystemError => {
  return typeof error.syscall === "string"
}

const describeTempSaveRemedy = (isToolEnabled: (name: ToolName) => boolean): string => {
  const renameToolClause = isToolEnabled("vault_move_note") ? " with vault_move_note" : ""

  return `The name leaves no room for the temporary file a save writes beside it; save it under a name at least ${TEMP_SAVE_SUFFIX_BYTES} bytes shorter (rename an existing note${renameToolClause}).`
}

const describeSystemErrorRemedy = (
  error: SystemError,
  isToolEnabled: (name: ToolName) => boolean,
): string => {
  switch (error.code) {
    // The temp file is always the failing path: a save writes it first, and
    // the rename or link that follows targets the shorter final name
    case "ENAMETOOLONG": {
      if (error.path && isTempSavePath(error.path)) return describeTempSaveRemedy(isToolEnabled)
      return "The path is too long for the filesystem, so nothing can exist at it; check the path, or shorten it for a new file."
    }
    case "ENOTDIR":
    case "EEXIST": {
      if (error.syscall === "mkdir") {
        return "A folder in the path is an existing file; choose a path whose folders are folders."
      }
      if (error.syscall === "scandir") {
        return "The folder changed while it was being listed; retry."
      }
      // Reads treat ENOTDIR as no file (utils/fs.ts), and both callers of
      // atomicWriteFileExclusive catch its EEXIST, so any other one means a
      // folder in the path changed between two steps of the call
      return CHANGED_DURING_CALL_REMEDY
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
      return CHANGED_DURING_CALL_REMEDY
    // A code outside the table (EXDEV, ESTALE) comes from the host's disks or
    // mounts, which only the owner can change
    default:
      return "Report the error to the vault's owner."
  }
}

/** The remedy sentence for a raw filesystem error (a Node error with a
 *  syscall) or a search-index failure (a SqliteError or an
 *  IndexIntegrityError); undefined for any other error, whose own text stands. */
export const remedyForCodedError = (params: {
  error: unknown
  isToolEnabled: (name: ToolName) => boolean
}): string | undefined => {
  const { error, isToolEnabled } = params

  if (error instanceof IndexIntegrityError) return INDEX_REMEDY
  if (!isErrnoException(error)) return undefined
  // isErrnoException admits any Error with a string code, so better-sqlite3's
  // SqliteError (a SQLITE_* code and no syscall) passes it
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

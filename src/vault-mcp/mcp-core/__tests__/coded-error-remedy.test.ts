import { describe, it, expect } from "vitest"
import { appendCodedErrorRemedy, remedyForCodedError } from "../coded-error-remedy.js"
import { IndexIntegrityError } from "../../search/search-helpers.js"

const everyToolServed = (): boolean => true
const noToolServed = (): boolean => false

/** A Node system error as fs produces it: the message, plus the structured
 *  code, syscall and path fields the remedy table keys on. */
const systemError = (fields: {
  code: string
  syscall: string
  path?: string
}): NodeJS.ErrnoException => {
  const quotedPath = fields.path ? ` '${fields.path}'` : ""
  return Object.assign(new Error(`${fields.code}: failed, ${fields.syscall}${quotedPath}`), fields)
}

const TEMP_SAVE_PATH = "/vault/Notes/a.md.123e4567-e89b-12d3-a456-426614174000.tmp"

const INDEX_REMEDY =
  "The server's search index could not be read; the call was not at fault. Retry once; if it fails again, tell the server's owner."

describe("remedyForCodedError", () => {
  it.each([
    {
      label: "a too-long name on the save's temp file, rename tool served",
      error: systemError({ code: "ENAMETOOLONG", syscall: "open", path: TEMP_SAVE_PATH }),
      isToolEnabled: everyToolServed,
      remedy:
        "The name leaves no room for the temporary file a save writes beside it; save it under a name at least 41 bytes shorter (rename an existing note with vault_move_note).",
    },
    {
      label: "a too-long name on the save's temp file, rename tool not served",
      error: systemError({ code: "ENAMETOOLONG", syscall: "open", path: TEMP_SAVE_PATH }),
      isToolEnabled: noToolServed,
      remedy:
        "The name leaves no room for the temporary file a save writes beside it; save it under a name at least 41 bytes shorter (rename an existing note).",
    },
    {
      label: "a too-long name on the note itself",
      error: systemError({ code: "ENAMETOOLONG", syscall: "open", path: "/vault/Notes/a.md" }),
      isToolEnabled: everyToolServed,
      remedy:
        "The path is too long for the filesystem, so nothing can exist at it; check the path, or shorten it for a new file.",
    },
    {
      label: "a too-long name with no path on the error",
      error: systemError({ code: "ENAMETOOLONG", syscall: "open" }),
      isToolEnabled: everyToolServed,
      remedy:
        "The path is too long for the filesystem, so nothing can exist at it; check the path, or shorten it for a new file.",
    },
    {
      label: "a folder that is a file, from mkdir (EEXIST)",
      error: systemError({ code: "EEXIST", syscall: "mkdir", path: "/vault/Projects/alpha.md" }),
      isToolEnabled: everyToolServed,
      remedy: "A folder in the path is an existing file; choose a path whose folders are folders.",
    },
    {
      label: "a folder that is a file, from mkdir (ENOTDIR)",
      error: systemError({ code: "ENOTDIR", syscall: "mkdir", path: "/vault/Projects/alpha.md" }),
      isToolEnabled: everyToolServed,
      remedy: "A folder in the path is an existing file; choose a path whose folders are folders.",
    },
    {
      label: "a folder that changed during a listing (race)",
      error: systemError({ code: "ENOTDIR", syscall: "scandir", path: "/vault/Projects" }),
      isToolEnabled: everyToolServed,
      remedy: "The folder changed while it was being listed; retry.",
    },
    {
      label: "a folder in the path that became a file between two steps (race, ENOTDIR)",
      error: systemError({ code: "ENOTDIR", syscall: "rename", path: "/vault/Projects/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The file or folder changed while the call ran; retry.",
    },
    {
      label: "an EEXIST outside mkdir, which the exclusive save's callers did not catch (race)",
      error: systemError({ code: "EEXIST", syscall: "link", path: "/vault/Projects/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The file or folder changed while the call ran; retry.",
    },
    {
      label: "permission denied",
      error: systemError({ code: "EACCES", syscall: "open", path: "/vault/Locked.md" }),
      isToolEnabled: everyToolServed,
      remedy: "Ask the vault's owner to fix the file's or folder's permissions.",
    },
    {
      label: "operation not permitted",
      error: systemError({ code: "EPERM", syscall: "unlink", path: "/vault/Locked.md" }),
      isToolEnabled: everyToolServed,
      remedy: "Ask the vault's owner to fix the file's or folder's permissions.",
    },
    {
      label: "a read-only disk",
      error: systemError({ code: "EROFS", syscall: "open", path: "/vault/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The disk is read-only; ask the vault's owner.",
    },
    {
      label: "a full disk, with no path on the error",
      error: systemError({ code: "ENOSPC", syscall: "write" }),
      isToolEnabled: everyToolServed,
      remedy: "The disk is full; ask the vault's owner to free space.",
    },
    {
      label: "a quota exceeded",
      error: systemError({ code: "EDQUOT", syscall: "write" }),
      isToolEnabled: everyToolServed,
      remedy: "The disk is full; ask the vault's owner to free space.",
    },
    {
      label: "a symbolic-link loop",
      error: systemError({ code: "ELOOP", syscall: "open", path: "/vault/Loop.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The path goes through a symbolic-link loop; ask the vault's owner to fix the link.",
    },
    {
      label: "a disk I/O failure",
      error: systemError({ code: "EIO", syscall: "read" }),
      isToolEnabled: everyToolServed,
      remedy: "The disk failed to read or write; ask the vault's owner.",
    },
    {
      label: "too many open files",
      error: systemError({ code: "EMFILE", syscall: "open", path: "/vault/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The server is busy; retry.",
    },
    {
      label: "too many open files system-wide",
      error: systemError({ code: "ENFILE", syscall: "open", path: "/vault/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The server is busy; retry.",
    },
    {
      label: "a resource temporarily unavailable",
      error: systemError({ code: "EAGAIN", syscall: "read" }),
      isToolEnabled: everyToolServed,
      remedy: "The server is busy; retry.",
    },
    {
      label: "a busy file",
      error: systemError({ code: "EBUSY", syscall: "rename", path: "/vault/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The server is busy; retry.",
    },
    {
      label: "a file that vanished between two steps (race)",
      error: systemError({ code: "ENOENT", syscall: "rename", path: TEMP_SAVE_PATH }),
      isToolEnabled: everyToolServed,
      remedy: "The file or folder changed while the call ran; retry.",
    },
    {
      label: "a path that became a folder between two steps (race)",
      error: systemError({ code: "EISDIR", syscall: "open", path: "/vault/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "The file or folder changed while the call ran; retry.",
    },
    {
      label: "a system error with a code the table does not know",
      error: systemError({ code: "EXDEV", syscall: "rename", path: "/vault/a.md" }),
      isToolEnabled: everyToolServed,
      remedy: "Report the error to the vault's owner.",
    },
    {
      label: "a SQLite engine error",
      error: Object.assign(new Error("malformed JSON"), {
        name: "SqliteError",
        code: "SQLITE_ERROR",
      }),
      isToolEnabled: everyToolServed,
      remedy: INDEX_REMEDY,
    },
    {
      label: "a damaged index row",
      error: new IndexIntegrityError("expected string[] from JSON column, got: {}"),
      isToolEnabled: everyToolServed,
      remedy: INDEX_REMEDY,
    },
  ])("names the remedy for $label", ({ error, isToolEnabled, remedy }) => {
    expect(remedyForCodedError({ error, isToolEnabled })).toBe(remedy)
  })

  it.each([
    {
      label: "a coded TypeError about the arguments, which has no syscall",
      error: Object.assign(
        new TypeError("The argument 'path' must be a string without null bytes"),
        { code: "ERR_INVALID_ARG_VALUE" },
      ),
    },
    {
      label: "an error with no code",
      error: new Error("note not found"),
    },
    {
      label: "a thrown string",
      error: "boom",
    },
  ])("returns undefined for $label", ({ error }) => {
    expect(remedyForCodedError({ error, isToolEnabled: everyToolServed })).toBeUndefined()
  })
})

describe("appendCodedErrorRemedy", () => {
  it("appends the remedy after a period and a space when the message ends in a quoted path", () => {
    const error = systemError({ code: "EACCES", syscall: "open", path: "/vault/Locked.md" })

    expect(
      appendCodedErrorRemedy({
        message: "[Error]: EACCES: permission denied, open 'Locked.md'",
        error,
        isToolEnabled: everyToolServed,
      }),
    ).toBe(
      "[Error]: EACCES: permission denied, open 'Locked.md'. Ask the vault's owner to fix the file's or folder's permissions.",
    )
  })

  it("appends the remedy after one space when the message already ends with a period", () => {
    const error = systemError({ code: "EACCES", syscall: "open", path: "/vault/Locked.md" })

    expect(
      appendCodedErrorRemedy({
        message: "Nothing was written.",
        error,
        isToolEnabled: everyToolServed,
      }),
    ).toBe("Nothing was written. Ask the vault's owner to fix the file's or folder's permissions.")
  })

  it("returns the message unchanged for an error the table does not know", () => {
    expect(
      appendCodedErrorRemedy({
        message: "[Error]: note not found",
        error: new Error("note not found"),
        isToolEnabled: everyToolServed,
      }),
    ).toBe("[Error]: note not found")
  })
})

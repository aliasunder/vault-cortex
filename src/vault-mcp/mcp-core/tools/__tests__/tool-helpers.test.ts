import { describe, it, expect, expectTypeOf, onTestFinished, vi } from "vitest"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logger } from "../../../../logger.js"
import { vaultFs } from "../../../vault-operations/vault-filesystem.js"
import {
  OverwriteBlockedError,
  UnkeepableOpeningBlockError,
  UnsupportedPropertiesBlockError,
} from "../../../obsidian-markdown/frontmatter.js"
import type { ToolName } from "../../tool-registry.js"
import { z } from "zod"
import { loadConfig } from "../../../config.js"
import {
  createSafeHandlers,
  createStrictInputObject,
  describeDailyNotesConfigErrorEntry,
  describeDeleteOutcomes,
  describeDeleteResult,
  describeTextWindow,
  formatNoteMetadata,
  toolInputErrorResult,
} from "../tool-helpers.js"

const VAULT_PATH = "/srv/vault"

const CAUSE_MESSAGE = "EACCES: permission denied, open '/srv/vault/.obsidian/app.json'"

/** A handler failure whose cause carries detail the client must never see. */
const failWithCause = async (): Promise<string> => {
  throw new RangeError("limit out of range", { cause: new Error(CAUSE_MESSAGE) })
}

const everyToolServed = (): boolean => true

/** The safe handlers of a server serving the given tools from VAULT_PATH. */
const createHandlersFor = (isToolEnabled: (name: ToolName) => boolean) => {
  return createSafeHandlers({ isToolEnabled, vaultPath: VAULT_PATH })
}

const CARRY_TEXT_REPAIR_STEPS =
  "To repair it: 1. read the note in full with vault_read_note; 2. copy any text between the --- lines that is not a property; 3. call vault_update_properties with replace: true and the complete corrected properties (leave out a key to remove it; null keeps it with an empty value); 4. add the copied text back to the body with vault_patch_note, without the --- lines."

const TAG_REPAIR_STEPS =
  "To repair it, read the note in full with vault_read_note, then call vault_update_properties with replace: true and the complete corrected properties (leave out a key to remove it; null keeps it with an empty value). The tag cannot be kept; write the value without it."

const OBSIDIAN_ONLY_STEP = "Fix the properties block in Obsidian."

const OVERWRITE_REPAIR_STEPS =
  "To overwrite it, read the note in full with vault_read_note, call vault_update_properties with replace: true and the properties to keep ({} for none), then run this write again."

const OPENING_BLOCK_STEP =
  "To write it, give the note at least one property, put a line of text above the --- lines, or remove those lines."

const OPENING_BLOCK_MESSAGE =
  "the note would open with a properties block the server cannot keep: properties block holds a single value, not key-value pairs"

const INVALID_YAML_MESSAGE =
  "properties block is not valid YAML at line 2, column 17: Flow sequence in block collection must be sufficiently indented and end with a ]"

/** A handler that fails the way a write on a broken properties block does. */
const failWithUnreadableBlock = (
  kind: UnsupportedPropertiesBlockError["kind"],
  message: string,
): (() => Promise<string>) => {
  return async () => {
    throw new UnsupportedPropertiesBlockError({ kind, message })
  }
}

/** The text a single-text-block handler returns for a failing call. */
const runFailingCall = async (params: {
  isToolEnabled: (name: ToolName) => boolean
  fail: () => Promise<string>
}): Promise<unknown> => {
  const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
  onTestFinished(() => warnSpy.mockRestore())

  const { safeHandler } = createHandlersFor(params.isToolEnabled)
  return safeHandler(logger, params.fail, (text) => text)
}

describe("safeHandlerContent", () => {
  it("returns a throw as an isError result holding only the error's name and message", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())

    const { safeHandlerContent } = createHandlersFor(everyToolServed)
    const result = await safeHandlerContent(logger, failWithCause, (text: string) => [
      { type: "text", text },
    ])

    expect(result).toEqual({
      content: [{ type: "text", text: "[RangeError]: limit out of range" }],
      isError: true,
    })
  })

  it("logs a throw and its cause as tool_error on the caller's logger", async () => {
    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn").mockImplementation(() => {})
    const rootWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => rootWarnSpy.mockRestore())

    const { safeHandlerContent } = createHandlersFor(everyToolServed)
    await safeHandlerContent(requestLogger, failWithCause, (text: string) => [
      { type: "text", text },
    ])

    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("tool_error", {
      error: "[RangeError]: limit out of range",
      cause: `[Error]: ${CAUSE_MESSAGE}`,
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })

  it("returns a filesystem error with its path vault-relative and its remedy appended, and logs it absolute", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    const failToOpenNote = async (): Promise<string> => {
      throw Object.assign(new Error("EACCES: permission denied, open '/srv/vault/Locked.md'"), {
        code: "EACCES",
        syscall: "open",
        path: "/srv/vault/Locked.md",
      })
    }

    const { safeHandlerContent } = createHandlersFor(everyToolServed)
    const result = await safeHandlerContent(logger, failToOpenNote, (text: string) => [
      { type: "text", text },
    ])

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "[Error]: EACCES: permission denied, open 'Locked.md'. Ask the vault's owner to fix the file's or folder's permissions.",
        },
      ],
      isError: true,
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith("tool_error", {
      error: "[Error]: EACCES: permission denied, open '/srv/vault/Locked.md'",
    })
  })

  it("returns the server's own error text unchanged when it quotes a path under the vault", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())
    const refuseAbsolutePath = async (): Promise<string> => {
      throw new Error('absolute path blocked: "/srv/vault/Locked.md" must be vault-relative')
    }

    const { safeHandlerContent } = createHandlersFor(everyToolServed)
    const result = await safeHandlerContent(logger, refuseAbsolutePath, (text: string) => [
      { type: "text", text },
    ])

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: '[Error]: absolute path blocked: "/srv/vault/Locked.md" must be vault-relative',
        },
      ],
      isError: true,
    })
  })

  it("appends the repair steps to an unreadable properties block", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())

    const { safeHandlerContent } = createHandlersFor(everyToolServed)
    const result = await safeHandlerContent(
      logger,
      failWithUnreadableBlock("invalid-yaml", INVALID_YAML_MESSAGE),
      (text: string) => [{ type: "text", text }],
    )

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `[Error]: ${INVALID_YAML_MESSAGE}. ${CARRY_TEXT_REPAIR_STEPS}`,
        },
      ],
      isError: true,
    })
  })

  it("logs the bare message without the repair steps", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())

    const { safeHandlerContent } = createHandlersFor(everyToolServed)
    await safeHandlerContent(
      logger,
      failWithUnreadableBlock("invalid-yaml", INVALID_YAML_MESSAGE),
      (text: string) => [{ type: "text", text }],
    )

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith("tool_error", {
      error: `[Error]: ${INVALID_YAML_MESSAGE}`,
    })
  })
})

describe("toolInputErrorResult", () => {
  it("returns the message as given in an isError result, without the [Name]: prefix a thrown error gets", () => {
    const requestLogger = logger.child({ requestId: "request-1" })
    vi.spyOn(requestLogger, "warn").mockImplementation(() => {})

    expect(
      toolInputErrorResult({ message: "on_or_after requires a file", logger: requestLogger }),
    ).toEqual({
      content: [{ type: "text", text: "on_or_after requires a file" }],
      isError: true,
    })
  })

  it("logs the message as tool_error on the caller's logger", () => {
    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn").mockImplementation(() => {})
    const rootWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => rootWarnSpy.mockRestore())

    toolInputErrorResult({ message: "on_or_after requires a file", logger: requestLogger })

    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("tool_error", {
      error: "on_or_after requires a file",
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })
})

describe("safeHandler", () => {
  it.each([
    {
      label: "invalid YAML",
      kind: "invalid-yaml" as const,
      message: INVALID_YAML_MESSAGE,
      text: `[Error]: ${INVALID_YAML_MESSAGE}. ${CARRY_TEXT_REPAIR_STEPS}`,
    },
    {
      label: "a block that is not key-value pairs",
      kind: "not-key-value" as const,
      message: "properties block holds a list, not key-value pairs",
      text: `[Error]: properties block holds a list, not key-value pairs. ${CARRY_TEXT_REPAIR_STEPS}`,
    },
    {
      label: "an explicit tag",
      kind: "explicit-tag" as const,
      message: "properties block uses the YAML tag !done",
      text: `[Error]: properties block uses the YAML tag !done. ${TAG_REPAIR_STEPS}`,
    },
    {
      label: "a message that already ends with a period",
      kind: "invalid-yaml" as const,
      message: 'move aborted: could not read "A.md": broken. Nothing was written.',
      text: `[Error]: move aborted: could not read "A.md": broken. Nothing was written. ${CARRY_TEXT_REPAIR_STEPS}`,
    },
  ])("appends the repair steps for $label", async ({ kind, message, text }) => {
    const result = await runFailingCall({
      isToolEnabled: everyToolServed,
      fail: failWithUnreadableBlock(kind, message),
    })

    expect(result).toEqual({ content: [{ type: "text", text }], isError: true })
  })

  it("adds nothing to a plain error", async () => {
    const result = await runFailingCall({
      isToolEnabled: everyToolServed,
      fail: async () => {
        throw new Error("note not found")
      },
    })

    expect(result).toEqual({
      content: [{ type: "text", text: "[Error]: note not found" }],
      isError: true,
    })
  })

  it("adds nothing to a plain error whose cause is an unreadable block", async () => {
    const result = await runFailingCall({
      isToolEnabled: everyToolServed,
      fail: async () => {
        throw new Error("cannot delete note", {
          cause: new UnsupportedPropertiesBlockError({ kind: "invalid-yaml", message: "broken" }),
        })
      },
    })

    expect(result).toEqual({
      content: [{ type: "text", text: "[Error]: cannot delete note" }],
      isError: true,
    })
  })

  it.each<{ label: string; isToolEnabled: (name: ToolName) => boolean }>([
    { label: "every repair tool is served", isToolEnabled: everyToolServed },
    { label: "no repair tool is served", isToolEnabled: () => false },
  ])(
    "appends the way around --- lines to a write that would open with them, when $label",
    async ({ isToolEnabled }) => {
      const result = await runFailingCall({
        isToolEnabled,
        fail: async () => {
          throw new UnkeepableOpeningBlockError(OPENING_BLOCK_MESSAGE, {
            cause: new UnsupportedPropertiesBlockError({ kind: "invalid-yaml", message: "broken" }),
          })
        },
      })

      expect(result).toEqual({
        content: [
          { type: "text", text: `[Error]: ${OPENING_BLOCK_MESSAGE}. ${OPENING_BLOCK_STEP}` },
        ],
        isError: true,
      })
    },
  )

  it("appends the way around --- lines after a move abort whose message already ends with a period", async () => {
    const moveAbortMessage = `move aborted: could not rewrite backlink source "A.md": ${OPENING_BLOCK_MESSAGE}. Nothing was written.`

    const result = await runFailingCall({
      isToolEnabled: everyToolServed,
      fail: async () => {
        throw new UnkeepableOpeningBlockError(moveAbortMessage)
      },
    })

    expect(result).toEqual({
      content: [{ type: "text", text: `[Error]: ${moveAbortMessage} ${OPENING_BLOCK_STEP}` }],
      isError: true,
    })
  })

  it.each<{ label: string; disabledTool: ToolName }>([
    { label: "vault_read_note", disabledTool: "vault_read_note" },
    { label: "vault_update_properties", disabledTool: "vault_update_properties" },
    { label: "vault_patch_note", disabledTool: "vault_patch_note" },
  ])("points at Obsidian when $label is not served", async ({ disabledTool }) => {
    const result = await runFailingCall({
      isToolEnabled: (name) => name !== disabledTool,
      fail: failWithUnreadableBlock("invalid-yaml", INVALID_YAML_MESSAGE),
    })

    expect(result).toEqual({
      content: [{ type: "text", text: `[Error]: ${INVALID_YAML_MESSAGE}. ${OBSIDIAN_ONLY_STEP}` }],
      isError: true,
    })
  })

  it.each([
    { label: "invalid YAML", kind: "invalid-yaml" as const },
    { label: "an explicit tag", kind: "explicit-tag" as const },
  ])(
    "gives a refused overwrite ($label) the replace-then-rerun steps, not the prose steps",
    async ({ kind }) => {
      const result = await runFailingCall({
        isToolEnabled: (name) => name !== "vault_patch_note",
        fail: async () => {
          throw new OverwriteBlockedError({ kind, message: INVALID_YAML_MESSAGE })
        },
      })

      expect(result).toEqual({
        content: [
          { type: "text", text: `[Error]: ${INVALID_YAML_MESSAGE}. ${OVERWRITE_REPAIR_STEPS}` },
        ],
        isError: true,
      })
    },
  )

  it.each<{ label: string; disabledTool: ToolName }>([
    { label: "vault_read_note", disabledTool: "vault_read_note" },
    { label: "vault_update_properties", disabledTool: "vault_update_properties" },
  ])(
    "points a refused overwrite at Obsidian when $label is not served",
    async ({ disabledTool }) => {
      const result = await runFailingCall({
        isToolEnabled: (name) => name !== disabledTool,
        fail: async () => {
          throw new OverwriteBlockedError({ kind: "invalid-yaml", message: INVALID_YAML_MESSAGE })
        },
      })

      expect(result).toEqual({
        content: [
          { type: "text", text: `[Error]: ${INVALID_YAML_MESSAGE}. ${OBSIDIAN_ONLY_STEP}` },
        ],
        isError: true,
      })
    },
  )

  it("points a list block at Obsidian when vault_patch_note is not served", async () => {
    const result = await runFailingCall({
      isToolEnabled: (name) => name !== "vault_patch_note",
      fail: failWithUnreadableBlock(
        "not-key-value",
        "properties block holds a list, not key-value pairs",
      ),
    })

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `[Error]: properties block holds a list, not key-value pairs. ${OBSIDIAN_ONLY_STEP}`,
        },
      ],
      isError: true,
    })
  })

  it("gives a tagged block its repair steps when only vault_patch_note is not served", async () => {
    const result = await runFailingCall({
      isToolEnabled: (name) => name !== "vault_patch_note",
      fail: failWithUnreadableBlock("explicit-tag", "properties block uses the YAML tag !done"),
    })

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `[Error]: properties block uses the YAML tag !done. ${TAG_REPAIR_STEPS}`,
        },
      ],
      isError: true,
    })
  })

  it.each<{ label: string; disabledTool: ToolName }>([
    { label: "vault_read_note", disabledTool: "vault_read_note" },
    { label: "vault_update_properties", disabledTool: "vault_update_properties" },
  ])("points a tagged block at Obsidian when $label is not served", async ({ disabledTool }) => {
    const result = await runFailingCall({
      isToolEnabled: (name) => name !== disabledTool,
      fail: failWithUnreadableBlock("explicit-tag", "properties block uses the YAML tag !done"),
    })

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `[Error]: properties block uses the YAML tag !done. ${OBSIDIAN_ONLY_STEP}`,
        },
      ],
      isError: true,
    })
  })

  it("returns the NUL refusal, quoting the folder as sent, for a listing under a vault path over 128 characters", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "probe-nul-listing-"))
    onTestFinished(() => rm(tempRoot, { recursive: true, force: true }))
    const vaultPath = join(tempRoot, "v".repeat(140))
    await mkdir(vaultPath)
    const requestLogger = { ...logger, warn: vi.fn() }
    const { safeHandler } = createSafeHandlers({ vaultPath, isToolEnabled: everyToolServed })

    const result = await safeHandler(
      requestLogger,
      () => vaultFs.listNotes({ vaultPath, folder: "Bad\u0000Folder" }, logger),
      (paths) => JSON.stringify(paths),
    )

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "[Error]: EINVAL: a path cannot contain a NUL character, 'Bad\u0000Folder'",
        },
      ],
      isError: true,
    })
  })
})

describe("createStrictInputObject", () => {
  const createListingInput = () => {
    return createStrictInputObject({
      folder: z.string().min(1).optional(),
      glob: z.string().min(1).optional(),
    })
  }

  const listIssues = (schema: z.ZodType, input: unknown) => {
    const result = schema.safeParse(input)

    if (result.success) throw new Error("expected the parse to fail")
    return result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
  }

  it("accepts the keys its shape declares", () => {
    const result = createListingInput().safeParse({ folder: "Projects", glob: "*.md" })
    expect(result).toEqual({ success: true, data: { folder: "Projects", glob: "*.md" } })
  })

  it("rejects an unknown key, naming it and the accepted keys", () => {
    expect(listIssues(createListingInput(), { folder: "Projects", globb: "*.md" })).toEqual([
      { path: [], message: 'unrecognized key "globb" (accepted: folder, glob)' },
    ])
  })

  it("names every unknown key in one issue", () => {
    expect(listIssues(createListingInput(), { folderr: "Projects", globb: "*.md" })).toEqual([
      { path: [], message: 'unrecognized keys "folderr", "globb" (accepted: folder, glob)' },
    ])
  })

  // Enforced by tsc, not by the test run
  it("types parsed input with only the declared keys", () => {
    expectTypeOf<z.output<ReturnType<typeof createListingInput>>>().toEqualTypeOf<{
      folder?: string | undefined
      glob?: string | undefined
    }>()
  })

  it("accepts and drops any key when the shape declares none", () => {
    const result = createStrictInputObject({}).safeParse({ random_string: "placeholder" })
    expect(result).toEqual({ success: true, data: {} })
  })

  it("reports an unknown key inside a nested strict object at that object's path", () => {
    const listingWithBounds = createStrictInputObject({
      created: createStrictInputObject({ before: z.string().optional() }).optional(),
    })
    expect(listIssues(listingWithBounds, { created: { befor: "2026-01-01" } })).toEqual([
      { path: ["created"], message: 'unrecognized key "befor" (accepted: before)' },
    ])
  })

  it("leaves a record's keys open", () => {
    const filterInput = createStrictInputObject({
      properties: z.record(z.string(), z.string()).optional(),
    })
    const result = filterInput.safeParse({ properties: { status: "active", owner: "me" } })
    expect(result).toEqual({
      success: true,
      data: { properties: { status: "active", owner: "me" } },
    })
  })

  it("keeps Zod's message for a declared key with a wrong value", () => {
    expect(listIssues(createListingInput(), { folder: 42 })).toEqual([
      { path: ["folder"], message: "Invalid input: expected string, received number" },
    ])
  })

  // A non-object input is the only other issue that reaches the object's error callback
  it("keeps Zod's message when the input is not an object", () => {
    expect(listIssues(createListingInput(), "Projects")).toEqual([
      { path: [], message: "Invalid input: expected object, received string" },
    ])
  })
})

describe("describeTextWindow", () => {
  it("reports zero lines for an empty rendition", () => {
    expect(
      describeTextWindow("empty.md", {
        startLine: 1,
        endLine: 0,
        totalLines: 0,
      }),
    ).toBe("empty.md — 0 lines (end of file)")
  })

  it("reports end of file on the final window", () => {
    expect(
      describeTextWindow("note.md", {
        startLine: 3,
        endLine: 5,
        totalLines: 5,
      }),
    ).toBe("note.md — lines 3–5 of 5 (end of file)")
  })

  it("reports the next start_line on a mid-file window", () => {
    expect(
      describeTextWindow("note.md", {
        startLine: 1,
        endLine: 20,
        totalLines: 100,
      }),
    ).toBe("note.md — lines 1–20 of 100 (continue with start_line: 21)")
  })

  it("handles a single-line window", () => {
    expect(
      describeTextWindow("one.md", {
        startLine: 3,
        endLine: 3,
        totalLines: 10,
      }),
    ).toBe("one.md — lines 3–3 of 10 (continue with start_line: 4)")
  })

  it("handles endLine equal to totalLines as end of file", () => {
    expect(
      describeTextWindow("full.md", {
        startLine: 1,
        endLine: 1,
        totalLines: 1,
      }),
    ).toBe("full.md — lines 1–1 of 1 (end of file)")
  })
})

describe("formatNoteMetadata", () => {
  it("keeps only unpromoted keys under additional_properties", () => {
    const formatted = formatNoteMetadata({
      path: "a.md",
      title: "A",
      tags: ["x"],
      leading_callout: null,
      properties: {
        title: "A",
        tags: ["x"],
        type: "note",
        created: "2026-01-01",
        related: [],
        topic: "tags",
      },
    })

    expect(formatted).toEqual({
      path: "a.md",
      title: "A",
      tags: ["x"],
      additional_properties: { topic: "tags" },
    })
  })

  it("drops the tags key the index read, in any letter case, and keeps a later one", () => {
    const formatted = formatNoteMetadata({
      path: "a.md",
      tags: ["x"],
      leading_callout: null,
      properties: { Tags: ["x"], tags: ["y"] },
    })

    expect(formatted).toEqual({
      path: "a.md",
      tags: ["x"],
      additional_properties: { tags: ["y"] },
    })
  })
})

describe("describeDeleteOutcomes", () => {
  const TRASH_OUTCOME_LINES = (singular: string, pluralCapital: string): string => {
    return [
      "",
      `- The "Deleted files" setting decides the outcome, which the caller can't choose or see in advance:`,
      `  - "Move to system trash" moves the ${singular} to \`.trash/\`. ${pluralCapital} this server moved there are deleted after its retention period (TRASH_RETENTION_DAYS: 30 days by default, never when set to none).`,
      `  - "Move to Obsidian trash" moves the ${singular} to \`.trash/\` and keeps it forever.`,
      `  - "Permanently delete" removes the ${singular} for good.`,
    ].join("\n")
  }
  const DELETE_FAILURE_LINES = (singular: string): string => {
    return [
      "",
      `- "cannot delete …" (other than a protected path) — the ${singular} stays put; ask the vault's owner to fix the cause (e.g. permissions), then retry`,
      `- "ENAMETOOLONG: …" or another filesystem error — the message says what to do; the ${singular} stays put`,
    ].join("\n")
  }

  it("describes a note's trash outcomes with the note nouns when the server does not sync", () => {
    expect(describeDeleteOutcomes({ obsidianSyncEnabled: false, pathKind: "note" })).toEqual({
      opener:
        "Delete a markdown note, moving it to the vault's .trash/ folder or removing it for good as the vault's Obsidian \"Deleted files\" setting directs.",
      trashOutcomeEntries: TRASH_OUTCOME_LINES("note", "Notes"),
      trashMoveErrorEntries:
        '\n- "cannot move to trash … — 100 collisions in .trash/" — .trash/ holds this name and 100 numbered copies; ask the vault\'s owner to clear old copies, then retry\n- "cannot move to trash …" without "100 collisions" — the note stays put; ask the vault\'s owner to fix .trash/ (e.g. a plain file blocks a needed folder), then retry',
      deleteFailureEntries: DELETE_FAILURE_LINES("note"),
      trashConfigErrorEntry:
        '\n- "cannot read trash config from .obsidian/app.json" — ask the vault\'s owner to repair it, then retry',
      returns:
        'Confirmation message naming the outcome — "Deleted <path>" for permanent removal, "Moved <path> to trash (<.trash/ path>)" when the note landed in .trash/.',
    })
  })

  it("describes a file's trash outcomes with the file nouns when the server does not sync", () => {
    expect(describeDeleteOutcomes({ obsidianSyncEnabled: false, pathKind: "file" })).toEqual({
      opener:
        "Delete a non-markdown file, moving it to the vault's .trash/ folder or removing it for good as the vault's Obsidian \"Deleted files\" setting directs.",
      trashOutcomeEntries: TRASH_OUTCOME_LINES("file", "Files"),
      trashMoveErrorEntries:
        '\n- "cannot move to trash … — 100 collisions in .trash/" — .trash/ holds this name and 100 numbered copies; ask the vault\'s owner to clear old copies, then retry\n- "cannot move to trash …" without "100 collisions" — the file stays put; ask the vault\'s owner to fix .trash/ (e.g. a plain file blocks a needed folder), then retry',
      deleteFailureEntries: DELETE_FAILURE_LINES("file"),
      trashConfigErrorEntry:
        '\n- "cannot read trash config from .obsidian/app.json" — ask the vault\'s owner to repair it, then retry',
      returns:
        'Confirmation message naming the outcome — "Deleted <path>" for permanent removal, "Moved <path> to trash (<.trash/ path>)" when the file landed in .trash/.',
    })
  })

  it("gives a note the note history's recovery sentence and no trash text under Obsidian Sync", () => {
    expect(describeDeleteOutcomes({ obsidianSyncEnabled: true, pathKind: "note" })).toEqual({
      opener:
        "Delete a markdown note for good. The vault's owner can recover it from Obsidian Sync's version history (1 month on Standard, 12 months on Plus).",
      trashOutcomeEntries: "",
      trashMoveErrorEntries: "",
      deleteFailureEntries: DELETE_FAILURE_LINES("note"),
      trashConfigErrorEntry: "",
      returns: 'Confirmation message — "Deleted <path>".',
    })
  })

  it("gives a file the attachment history's recovery sentence and no trash text under Obsidian Sync", () => {
    expect(describeDeleteOutcomes({ obsidianSyncEnabled: true, pathKind: "file" })).toEqual({
      opener:
        "Delete a non-markdown file for good. The vault's owner may recover it from Obsidian Sync's version history, which keeps attachment versions for two weeks.",
      trashOutcomeEntries: "",
      trashMoveErrorEntries: "",
      deleteFailureEntries: DELETE_FAILURE_LINES("file"),
      trashConfigErrorEntry: "",
      returns: 'Confirmation message — "Deleted <path>".',
    })
  })
})

describe("describeDailyNotesConfigErrorEntry", () => {
  it("lists the entry when the server reads daily-notes.json for the protected folder", () => {
    expect(describeDailyNotesConfigErrorEntry(loadConfig({}))).toBe(
      "\n- \"cannot read daily notes config from .obsidian/daily-notes.json\" — the file that names the protected daily notes folder can't be parsed; ask the vault's owner to repair it, or the server's operator to set DAILY_NOTES_FOLDER or PROTECTED_PATHS, then retry",
    )
  })

  it.each([
    { label: "PROTECTED_PATHS", env: { PROTECTED_PATHS: "Private" } },
    { label: "DAILY_NOTES_FOLDER", env: { DAILY_NOTES_FOLDER: "Journal" } },
  ])("is empty under $label, which bypasses the file", ({ env }) => {
    expect(describeDailyNotesConfigErrorEntry(loadConfig(env))).toBe("")
  })
})

describe("describeDeleteResult", () => {
  it.each([
    {
      label: "a permanent delete",
      params: { path: "a.png", prunedFolderCount: 0 },
      expected: "Deleted a.png",
    },
    {
      label: "a trash move",
      params: { path: "a.png", prunedFolderCount: 0, trashLocation: ".trash/a.png" },
      expected: "Moved a.png to trash (.trash/a.png)",
    },
    {
      label: "a permanent delete that pruned one folder",
      params: { path: "x/a.png", prunedFolderCount: 1 },
      expected: "Deleted x/a.png (removed 1 empty folder)",
    },
    {
      label: "a trash move that pruned two folders",
      params: { path: "x/y/a.png", prunedFolderCount: 2, trashLocation: ".trash/x/y/a.png" },
      expected: "Moved x/y/a.png to trash (.trash/x/y/a.png) (removed 2 empty folders)",
    },
  ])("describes $label", ({ params, expected }) => {
    expect(describeDeleteResult(params)).toBe(expected)
  })
})

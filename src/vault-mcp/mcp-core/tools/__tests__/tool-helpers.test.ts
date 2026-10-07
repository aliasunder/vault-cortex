import { describe, it, expect, onTestFinished, vi } from "vitest"
import { logger } from "../../../../logger.js"
import {
  OverwriteBlockedError,
  UnkeepableOpeningBlockError,
  UnsupportedPropertiesBlockError,
} from "../../../obsidian-markdown/frontmatter.js"
import type { ToolName } from "../../tool-registry.js"
import { createSafeHandlers, describeTextWindow } from "../tool-helpers.js"

/** A handler failure whose cause carries detail the client must never see. */
const failWithCause = async (): Promise<string> => {
  throw new RangeError("limit out of range", {
    cause: new Error("EACCES: permission denied, open '/srv/vault/.obsidian/app.json'"),
  })
}

const everyToolServed = (): boolean => true

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

  const { safeHandler } = createSafeHandlers(params.isToolEnabled)
  return safeHandler(logger, params.fail, (text) => text)
}

describe("safeHandlerContent", () => {
  it("returns a throw as an isError result holding only the error's name and message", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())

    const { safeHandlerContent } = createSafeHandlers(everyToolServed)
    const result = await safeHandlerContent(logger, failWithCause, (text: string) => [
      { type: "text", text },
    ])

    expect(result).toEqual({
      content: [{ type: "text", text: "[RangeError]: limit out of range" }],
      isError: true,
    })
  })

  it("logs a throw as tool_error on the caller's logger", async () => {
    const requestLogger = logger.child({ requestId: "request-1" })
    const requestWarnSpy = vi.spyOn(requestLogger, "warn").mockImplementation(() => {})
    const rootWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => rootWarnSpy.mockRestore())

    const { safeHandlerContent } = createSafeHandlers(everyToolServed)
    await safeHandlerContent(requestLogger, failWithCause, (text: string) => [
      { type: "text", text },
    ])

    expect(requestWarnSpy).toHaveBeenCalledTimes(1)
    expect(requestWarnSpy).toHaveBeenCalledWith("tool_error", {
      error: "[RangeError]: limit out of range",
    })
    expect(rootWarnSpy).not.toHaveBeenCalled()
  })

  it("appends the repair steps to an unreadable properties block", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
    onTestFinished(() => warnSpy.mockRestore())

    const { safeHandlerContent } = createSafeHandlers(everyToolServed)
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

    const { safeHandlerContent } = createSafeHandlers(everyToolServed)
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

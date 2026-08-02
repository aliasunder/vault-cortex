import { describe, expect, it } from "vitest"

import {
  applyOptionalSettings,
  askOptionalSettings,
  readOptionalValue,
} from "../optional-settings.js"
import type { Prompts, SelectOption } from "../prompts.js"

type ScriptedAnswer = string | boolean | string[]

type MultiselectCall = { message: string; options: SelectOption[] }
type ConfirmCall = { message: string; initialValue: boolean }
type SelectCall = { message: string; initialValue: string }

/**
 * A Prompts stub that replays canned answers in order and records what was
 * asked — mirrors the init.test.ts stub, plus per-kind call recording so the
 * chooser's options and each prompt's initial value can be asserted.
 */
const createScriptedPrompts = (answers: ScriptedAnswer[]) => {
  const remaining = [...answers]
  const asked: string[] = []
  const errors: string[] = []
  const multiselectCalls: MultiselectCall[] = []
  const confirmCalls: ConfirmCall[] = []
  const selectCalls: SelectCall[] = []

  const nextAnswer = (message: string): ScriptedAnswer => {
    asked.push(message)
    const answer = remaining.shift()
    if (answer === undefined)
      throw new Error(`No scripted answer for prompt: ${message}`)
    return answer
  }

  const prompts: Prompts = {
    intro: () => {},
    outro: () => {},
    note: () => {},
    print: () => {},
    log: () => {},
    warn: () => {},
    error: (message) => {
      errors.push(message)
    },
    select: async (message, _options, initialValue) => {
      selectCalls.push({ message, initialValue })
      return String(nextAnswer(message))
    },
    multiselect: async (message, options) => {
      multiselectCalls.push({ message, options })
      const answer = nextAnswer(message)
      if (!Array.isArray(answer)) {
        throw new Error(
          `multiselect needs a string[] scripted answer, got: ${String(answer)}`,
        )
      }
      return answer
    },
    text: async (message, options) => {
      const answer = String(nextAnswer(message))
      // Mirrors @clack/prompts: an empty submission resolves to defaultValue.
      if (answer === "" && options?.defaultValue !== undefined)
        return options.defaultValue
      return answer
    },
    password: async (message) => String(nextAnswer(message)),
    confirm: async (message, initialValue) => {
      confirmCalls.push({ message, initialValue })
      return Boolean(nextAnswer(message))
    },
    spinner: () => ({ start: () => {}, stop: () => {} }),
  }

  return { prompts, asked, errors, multiselectCalls, confirmCalls, selectCalls }
}

describe("readOptionalValue", () => {
  it("reads the value of an active line", () => {
    expect(readOptionalValue("PORT=9000\nTZ=UTC\n", "PORT")).toBe("9000")
  })

  it("returns undefined for a commented-out line", () => {
    expect(readOptionalValue("# TZ=America/New_York\n", "TZ")).toBeUndefined()
  })

  it("returns undefined for a missing line", () => {
    expect(readOptionalValue("PORT=9000\n", "TZ")).toBeUndefined()
  })
})

describe("applyOptionalSettings", () => {
  it("replaces the value of an active line", () => {
    const patched = applyOptionalSettings("A=1\nMEMORY_ENABLED=true\nB=2\n", {
      MEMORY_ENABLED: "false",
    })
    expect(patched).toBe("A=1\nMEMORY_ENABLED=false\nB=2\n")
  })

  it("uncomments and sets a commented-out line", () => {
    const patched = applyOptionalSettings("A=1\n# TZ=America/New_York\nB=2\n", {
      TZ: "Europe/London",
    })
    expect(patched).toBe("A=1\nTZ=Europe/London\nB=2\n")
  })

  it("appends a var that has no line at all", () => {
    const patched = applyOptionalSettings("MCP_AUTH_TOKEN=abc\n", {
      SYNC_MODE: "pull-only",
    })
    expect(patched).toBe("MCP_AUTH_TOKEN=abc\n\nSYNC_MODE=pull-only\n")
  })

  it("returns the content unchanged for empty overrides", () => {
    const content = "A=1\nB=2\n"
    expect(applyOptionalSettings(content, {})).toBe(content)
  })

  it("applies multiple overrides in one pass", () => {
    const patched = applyOptionalSettings(
      "MEMORY_ENABLED=true\nPORT=8000\n# TZ=America/New_York\n",
      { MEMORY_ENABLED: "false", PORT: "9000", TZ: "America/Toronto" },
    )
    expect(patched).toBe(
      "MEMORY_ENABLED=false\nPORT=9000\nTZ=America/Toronto\n",
    )
  })

  it("writes values containing replacement patterns literally", () => {
    // String.prototype.replace interprets $-patterns in string replacements;
    // the function replacement must keep the value byte-for-byte.
    const patched = applyOptionalSettings("TZ=UTC\n", { TZ: "A$&B" })
    expect(patched).toBe("TZ=A$&B\n")
  })
})

describe("askOptionalSettings chooser", () => {
  it("offers the local settings without SYNC_MODE in local mode", async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(
      scripted.multiselectCalls[0].options.map((option) => option.value),
    ).toEqual([
      "MEMORY_ENABLED",
      "FILE_TOOLS_ENABLED",
      "EMBEDDING_ENABLED",
      "PORT",
      "TZ",
    ])
  })

  it("adds SYNC_MODE to the chooser in remote mode", async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      { mode: "remote", envContent: "" },
      scripted.prompts,
    )

    expect(
      scripted.multiselectCalls[0].options.map((option) => option.value),
    ).toEqual([
      "MEMORY_ENABLED",
      "FILE_TOOLS_ENABLED",
      "EMBEDDING_ENABLED",
      "PORT",
      "TZ",
      "SYNC_MODE",
    ])
  })

  it("shows current values in the chooser hints, with 'not set' for absent vars", async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      { mode: "local", envContent: "MEMORY_ENABLED=false\nPORT=9000\n" },
      scripted.prompts,
    )

    expect(
      scripted.multiselectCalls[0].options.map((option) => option.hint),
    ).toEqual([
      "MEMORY_ENABLED · currently false",
      "FILE_TOOLS_ENABLED · currently not set",
      "EMBEDDING_ENABLED · currently not set",
      "PORT · currently 9000",
      "TZ · currently not set",
    ])
  })

  it("returns no overrides and asks nothing further when nothing is picked", async () => {
    const scripted = createScriptedPrompts([[]])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(overrides).toEqual({})
    expect(scripted.asked).toEqual([
      "Any optional settings to change? (press enter to skip)",
    ])
  })
})

describe("askOptionalSettings per-setting prompts", () => {
  it("seeds a toggle's confirm with the current .env value", async () => {
    const scripted = createScriptedPrompts([["MEMORY_ENABLED"], true])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "MEMORY_ENABLED=false\n" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message: "Enable the memory layer (About Me/ folder + memory tools)?",
        initialValue: false,
      },
    ])
    expect(overrides).toEqual({ MEMORY_ENABLED: "true" })
  })

  it("seeds a toggle's confirm as enabled when the var is absent", async () => {
    // Absent line = the server's built-in default (true for every curated
    // toggle) — the confirm must start on Yes, not fall to false.
    const scripted = createScriptedPrompts([["MEMORY_ENABLED"], true])

    await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message: "Enable the memory layer (About Me/ folder + memory tools)?",
        initialValue: true,
      },
    ])
  })

  it("seeds the SYNC_MODE select with its default when the var is absent", async () => {
    const scripted = createScriptedPrompts([["SYNC_MODE"], "pull-only"])

    await askOptionalSettings(
      { mode: "remote", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.selectCalls).toEqual([
      {
        message: "How should Obsidian Sync move changes?",
        initialValue: "bidirectional",
      },
    ])
  })

  it("uses the default port on an empty submission", async () => {
    const scripted = createScriptedPrompts([["PORT"], ""])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(overrides).toEqual({ PORT: "8000" })
  })

  it("seeds the SYNC_MODE select with the current .env value", async () => {
    const scripted = createScriptedPrompts([["SYNC_MODE"], "bidirectional"])

    const overrides = await askOptionalSettings(
      { mode: "remote", envContent: "SYNC_MODE=pull-only\n" },
      scripted.prompts,
    )

    expect(scripted.selectCalls).toEqual([
      {
        message: "How should Obsidian Sync move changes?",
        initialValue: "pull-only",
      },
    ])
    expect(overrides).toEqual({ SYNC_MODE: "bidirectional" })
  })

  it("re-prompts on an unknown timezone until a recognized one is given", async () => {
    const scripted = createScriptedPrompts([
      ["TZ"],
      "Not/AZone", // rejected
      "Europe/London", // accepted
    ])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      '"Not/AZone" is not a recognized IANA timezone (e.g. America/New_York, Europe/London).',
    ])
    expect(overrides).toEqual({ TZ: "Europe/London" })
  })
})

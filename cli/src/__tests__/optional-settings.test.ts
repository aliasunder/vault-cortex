import { describe, expect, it } from "vitest"

import {
  applyOptionalSettings,
  askOptionalSettings,
  derivePublicUrlOverride,
  readOptionalValue,
} from "../optional-settings.js"
import { createScriptedPrompts } from "./command-stubs.js"

describe("readOptionalValue", () => {
  it("reads the value of an active line", () => {
    expect(readOptionalValue("PORT=9000\nTZ=UTC\n", "PORT")).toBe("9000")
  })

  it("returns the last duplicate, matching docker --env-file precedence", () => {
    expect(readOptionalValue("PORT=8000\nTZ=UTC\nPORT=9000\n", "PORT")).toBe(
      "9000",
    )
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

  it("replaces every duplicate active line, not just the first", () => {
    // docker --env-file gives the LAST duplicate precedence — a first-line
    // replace would leave a stale duplicate silently winning.
    const patched = applyOptionalSettings(
      "MEMORY_ENABLED=true\nPORT=8000\nMEMORY_ENABLED=true\n",
      { MEMORY_ENABLED: "false" },
    )
    expect(patched).toBe(
      "MEMORY_ENABLED=false\nPORT=8000\nMEMORY_ENABLED=false\n",
    )
  })

  it("writes values containing replacement patterns literally", () => {
    // String.prototype.replace interprets $-patterns in string replacements;
    // the function replacement must keep the value byte-for-byte.
    const patched = applyOptionalSettings("TZ=UTC\n", { TZ: "A$&B" })
    expect(patched).toBe("TZ=A$&B\n")
  })
})

describe("derivePublicUrlOverride", () => {
  it("follows a PORT change when PUBLIC_URL is the derived localhost form", () => {
    const derived = derivePublicUrlOverride(
      "PUBLIC_URL=http://localhost:8000\nPORT=8000\n",
      { PORT: "9000" },
    )
    expect(derived).toEqual({
      PORT: "9000",
      PUBLIC_URL: "http://localhost:9000",
    })
  })

  it("derives from the current PORT, not the default", () => {
    const derived = derivePublicUrlOverride(
      "PUBLIC_URL=http://localhost:9100\nPORT=9100\n",
      { PORT: "9200" },
    )
    expect(derived).toEqual({
      PORT: "9200",
      PUBLIC_URL: "http://localhost:9200",
    })
  })

  it("never touches a custom PUBLIC_URL", () => {
    const derived = derivePublicUrlOverride(
      "PUBLIC_URL=https://vault.example.com\nPORT=8000\n",
      { PORT: "9000" },
    )
    expect(derived).toEqual({ PORT: "9000" })
  })

  it("returns the overrides unchanged without a PORT override", () => {
    const derived = derivePublicUrlOverride(
      "PUBLIC_URL=http://localhost:8000\nPORT=8000\n",
      { MEMORY_ENABLED: "false" },
    )
    expect(derived).toEqual({ MEMORY_ENABLED: "false" })
  })

  it("returns the overrides unchanged when PUBLIC_URL is absent", () => {
    const derived = derivePublicUrlOverride("PORT=8000\n", { PORT: "9000" })
    expect(derived).toEqual({ PORT: "9000" })
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
      "MEMORY_DIR",
      "DAILY_NOTES_FOLDER",
      "DAILY_NOTES_FORMAT",
      "FILE_TOOLS_ENABLED",
      "READONLY_MODE",
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
      "MEMORY_DIR",
      "DAILY_NOTES_FOLDER",
      "DAILY_NOTES_FORMAT",
      "FILE_TOOLS_ENABLED",
      "READONLY_MODE",
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
      "MEMORY_DIR · currently not set · not used while Memory layer is off",
      "DAILY_NOTES_FOLDER · currently not set",
      "DAILY_NOTES_FORMAT · currently not set",
      "FILE_TOOLS_ENABLED · currently not set",
      "READONLY_MODE · currently not set",
      "EMBEDDING_ENABLED · currently not set",
      "PORT · currently 9000",
      "TZ · currently not set",
    ])
  })

  it("omits the memory-folder dependency note while the memory layer is on", async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      {
        mode: "local",
        envContent: "MEMORY_ENABLED=true\nMEMORY_DIR=About Me\n",
      },
      scripted.prompts,
    )

    const memoryFolderOption = scripted.multiselectCalls[0].options.find(
      (option) => option.value === "MEMORY_DIR",
    )
    expect(memoryFolderOption?.hint).toBe("MEMORY_DIR · currently About Me")
  })

  it('adds the dependency note for the server-valid disabled spelling "0"', async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      { mode: "local", envContent: "MEMORY_ENABLED=0\n" },
      scripted.prompts,
    )

    const memoryFolderOption = scripted.multiselectCalls[0].options.find(
      (option) => option.value === "MEMORY_DIR",
    )
    expect(memoryFolderOption?.hint).toBe(
      "MEMORY_DIR · currently not set · not used while Memory layer is off",
    )
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
    // Absent line = the server's built-in default (true for a default-on
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

  it("seeds a default-off toggle's confirm as disabled when the var is absent", async () => {
    // READONLY_MODE defaults to false on the server — an unset var must seed
    // the confirm at No, not inherit the enabled-unless-"false" heuristic.
    const scripted = createScriptedPrompts([["READONLY_MODE"], false])

    await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message:
          "Run the server in read-only mode (hide all tools that change the vault)?",
        initialValue: false,
      },
    ])
  })

  it("seeds a default-off toggle's confirm from the .env value when set", async () => {
    const scripted = createScriptedPrompts([["READONLY_MODE"], true])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "READONLY_MODE=true\n" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message:
          "Run the server in read-only mode (hide all tools that change the vault)?",
        initialValue: true,
      },
    ])
    expect(overrides).toEqual({ READONLY_MODE: "true" })
  })

  it("seeds the SYNC_MODE select with its default when the var is absent", async () => {
    const scripted = createScriptedPrompts([["SYNC_MODE"], "pull-only"])

    await askOptionalSettings(
      { mode: "remote", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.selectCalls).toEqual([
      {
        message: "Obsidian Sync direction:",
        initialValue: "bidirectional",
      },
    ])
  })

  it('seeds a toggle\'s confirm as disabled for the server-valid "0"', async () => {
    // The server reads toggles via env-var's asBool, which accepts 0/1 —
    // the confirm must not misrepresent MEMORY_ENABLED=0 as enabled.
    const scripted = createScriptedPrompts([["MEMORY_ENABLED"], false])

    await askOptionalSettings(
      { mode: "local", envContent: "MEMORY_ENABLED=0\n" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message: "Enable the memory layer (About Me/ folder + memory tools)?",
        initialValue: false,
      },
    ])
  })

  it("rejects numeric port forms readEnvPort cannot read back", async () => {
    // "1e4" passes Number() but not /^\d+$/ — written verbatim it would
    // silently fall back to the default port on every later read.
    const scripted = createScriptedPrompts([["PORT"], "1e4", "9000"])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      "PORT must be a whole number between 1 and 65535.",
    ])
    expect(overrides).toEqual({ PORT: "9000" })
  })

  it("collects a custom memory folder, seeded with the current value", async () => {
    const scripted = createScriptedPrompts([["MEMORY_DIR"], "Memory Bank"])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "MEMORY_DIR=About Me\n" },
      scripted.prompts,
    )

    expect(scripted.textCalls).toEqual([
      {
        message: "Vault folder for the memory files:",
        defaultValue: "About Me",
        placeholder: "About Me",
      },
    ])
    expect(overrides).toEqual({ MEMORY_DIR: "Memory Bank" })
  })

  it("re-prompts on an empty memory folder until a name is given", async () => {
    // No current value and no typed answer: the stub returns the prompt's
    // defaultValue ("About Me"), so a genuinely empty submission needs the
    // default suppressed — send whitespace, which trims to empty.
    const scripted = createScriptedPrompts([["MEMORY_DIR"], "   ", "Notes"])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual(["The folder name can't be empty."])
    expect(overrides).toEqual({ MEMORY_DIR: "Notes" })
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
        message: "Obsidian Sync direction:",
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

  it("skips an unset daily notes folder left blank, writing nothing", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], ""])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    // No pre-filled default when unset — the real default is the vault's
    // own config, so the prompt must not offer a concrete value to accept.
    expect(scripted.textCalls).toEqual([
      {
        message: "Vault folder for daily notes:",
        defaultValue: undefined,
        placeholder: "blank = use your vault's daily notes settings",
      },
    ])
    expect(overrides).toEqual({})
    expect(scripted.logs).toEqual([
      "Left unset — the server reads this setting from your vault's own config.",
    ])
  })

  it("keeps a set daily notes folder on a blank submit without recording a no-op", async () => {
    // The prompt resolves an empty submit to its defaultValue (the current
    // value), so blank never destroys an existing setting — and the unchanged
    // value is not recorded, so the caller won't rewrite the file or offer a
    // restart for a no-op. The placeholder states what blank actually does.
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], ""])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
      scripted.prompts,
    )

    expect(scripted.textCalls).toEqual([
      {
        message: "Vault folder for daily notes:",
        defaultValue: "Journal",
        placeholder: "blank = keep the current value",
      },
    ])
    expect(overrides).toEqual({})
    expect(scripted.logs).toEqual(["Kept the current value (Journal)."])
  })

  it("collects a typed daily notes format, trimmed", async () => {
    const scripted = createScriptedPrompts([
      ["DAILY_NOTES_FORMAT"],
      "  DD-MM-YYYY  ",
    ])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.textCalls).toEqual([
      {
        message: "Filename date format for daily notes (e.g. YYYY-MM-DD):",
        defaultValue: undefined,
        placeholder: "blank = use your vault's daily notes settings",
      },
    ])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "DD-MM-YYYY" })
  })

  it("does not clobber a set daily notes folder on whitespace input", async () => {
    // Whitespace defeats the empty-submit-resolves-to-default behavior and
    // trims to empty — the keep path must leave the existing value alone
    // rather than write an empty one, and must say "kept", not "left unset":
    // the override stays active in .env.
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "   "])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
      scripted.prompts,
    )

    expect(overrides).toEqual({})
    expect(scripted.logs).toEqual(["Kept the current value (Journal)."])
  })

  it("updates a set daily notes folder to a new value", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "Planner"])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
      scripted.prompts,
    )

    expect(scripted.textCalls).toEqual([
      {
        message: "Vault folder for daily notes:",
        defaultValue: "Journal",
        placeholder: "blank = keep the current value",
      },
    ])
    expect(overrides).toEqual({ DAILY_NOTES_FOLDER: "Planner" })
  })

  it("does not record retyping the value a daily notes folder already has", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "Journal"])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
      scripted.prompts,
    )

    expect(overrides).toEqual({})
    expect(scripted.logs).toEqual(["Kept the current value (Journal)."])
  })

  it("records only the typed setting when one of a pair is left blank", async () => {
    const scripted = createScriptedPrompts([
      ["DAILY_NOTES_FOLDER", "DAILY_NOTES_FORMAT"],
      "", // folder left blank — skipped
      "YYYY/MM/DD", // format typed
    ])

    const overrides = await askOptionalSettings(
      { mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY/MM/DD" })
  })

  it("shows a set daily notes folder in its chooser hint", async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      { mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
      scripted.prompts,
    )

    const dailyNotesFolderOption = scripted.multiselectCalls[0].options.find(
      (option) => option.value === "DAILY_NOTES_FOLDER",
    )
    expect(dailyNotesFolderOption?.hint).toBe(
      "DAILY_NOTES_FOLDER · currently Journal",
    )
  })
})

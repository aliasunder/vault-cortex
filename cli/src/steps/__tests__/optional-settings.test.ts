import { describe, expect, it } from "vitest"

import { askOptionalSettings } from "../optional-settings.js"
import { createScriptedPrompts } from "../../__tests__/command-stubs.js"

describe("askOptionalSettings chooser", () => {
  it("offers the local settings without SYNC_MODE in local mode", async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.multiselectCalls[0].options.map((option) => option.value)).toEqual([
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
      { portsInUse: new Map(), mode: "remote", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.multiselectCalls[0].options.map((option) => option.value)).toEqual([
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
      { portsInUse: new Map(), mode: "local", envContent: "MEMORY_ENABLED=false\nPORT=9000\n" },
      scripted.prompts,
    )

    expect(scripted.multiselectCalls[0].options.map((option) => option.hint)).toEqual([
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
        portsInUse: new Map(),
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
      { portsInUse: new Map(), mode: "local", envContent: "MEMORY_ENABLED=0\n" },
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
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(overrides).toEqual({})
    expect(scripted.asked).toEqual(["Any optional settings to change? (press enter to skip)"])
  })
})

describe("askOptionalSettings per-setting prompts", () => {
  it("seeds a toggle's confirm with the current .env value", async () => {
    const scripted = createScriptedPrompts([["MEMORY_ENABLED"], true])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "MEMORY_ENABLED=false\n" },
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
      { portsInUse: new Map(), mode: "local", envContent: "" },
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
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message: "Run the server in read-only mode (hide all tools that change the vault)?",
        initialValue: false,
      },
    ])
  })

  it("seeds a default-off toggle's confirm as disabled when the var is empty", async () => {
    // READONLY_MODE= (empty string) is treated as unset by Compose's
    // ${VAR:-default} and env-var's .default() — the CLI must match.
    const scripted = createScriptedPrompts([["READONLY_MODE"], false])

    await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "READONLY_MODE=\n" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message: "Run the server in read-only mode (hide all tools that change the vault)?",
        initialValue: false,
      },
    ])
  })

  it("seeds a default-off toggle's confirm from the .env value when set", async () => {
    const scripted = createScriptedPrompts([["READONLY_MODE"], true])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "READONLY_MODE=true\n" },
      scripted.prompts,
    )

    expect(scripted.confirmCalls).toEqual([
      {
        message: "Run the server in read-only mode (hide all tools that change the vault)?",
        initialValue: true,
      },
    ])
    expect(overrides).toEqual({ READONLY_MODE: "true" })
  })

  it("offers the three Sync modes the client accepts, seeded with the default when the var is absent", async () => {
    const scripted = createScriptedPrompts([["SYNC_MODE"], "pull-only"])

    await askOptionalSettings(
      { portsInUse: new Map(), mode: "remote", envContent: "" },
      scripted.prompts,
    )

    // The values are what `ob sync-config --mode` accepts; a chooser entry the
    // client rejects would only surface at the image's first boot.
    expect(scripted.selectCalls).toEqual([
      {
        message: "Obsidian Sync direction:",
        options: [
          {
            value: "bidirectional",
            label: "Bidirectional",
            hint: "pull remote changes and push server-side edits",
          },
          {
            value: "pull-only",
            label: "Pull-only",
            hint: "receive changes but never push",
          },
          {
            value: "mirror-remote",
            label: "Mirror remote",
            hint: "receive changes and revert any server-side edit",
          },
        ],
        initialValue: "bidirectional",
      },
    ])
  })

  it('seeds a toggle\'s confirm as disabled for the server-valid "0"', async () => {
    // The server reads toggles via env-var's asBool, which accepts 0/1 —
    // the confirm must not misrepresent MEMORY_ENABLED=0 as enabled.
    const scripted = createScriptedPrompts([["MEMORY_ENABLED"], false])

    await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "MEMORY_ENABLED=0\n" },
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
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      "PORT must be a whole number between 1 and 65535, with no leading zero.",
    ])
    expect(overrides).toEqual({ PORT: "9000" })
  })

  it("collects a custom memory folder, seeded with the current value", async () => {
    const scripted = createScriptedPrompts([["MEMORY_DIR"], "Memory Bank"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "MEMORY_DIR=About Me\n" },
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

  it.each([
    { label: "an empty line", envContent: "MEMORY_DIR=\n" },
    { label: "empty quotes", envContent: 'MEMORY_DIR=""\n' },
  ])(
    "offers the default memory folder when MEMORY_DIR is $label, as the server reads it",
    async ({ envContent }) => {
      const scripted = createScriptedPrompts([["MEMORY_DIR"], ""])

      const overrides = await askOptionalSettings(
        { portsInUse: new Map(), mode: "local", envContent },
        scripted.prompts,
      )

      expect(scripted.errors).toEqual([])
      expect(overrides).toEqual({ MEMORY_DIR: "About Me" })
    },
  )

  it("re-prompts on an empty memory folder until a name is given", async () => {
    // No current value and no typed answer: the stub returns the prompt's
    // defaultValue ("About Me"), so a genuinely empty submission needs the
    // default suppressed — send whitespace, which trims to empty.
    const scripted = createScriptedPrompts([["MEMORY_DIR"], "   ", "Notes"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual(["The folder name can't be empty."])
    expect(overrides).toEqual({ MEMORY_DIR: "Notes" })
  })

  it("uses the default port on an empty submission", async () => {
    const scripted = createScriptedPrompts([["PORT"], ""])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(overrides).toEqual({ PORT: "8000" })
  })

  it("offers the default port when the PORT line is empty", async () => {
    const scripted = createScriptedPrompts([["PORT"], ""])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "PORT=\n" },
      scripted.prompts,
    )

    expect(scripted.textCalls).toEqual([
      { message: "Host port for the server:", defaultValue: "8000", placeholder: "8000" },
    ])
    expect(overrides).toEqual({ PORT: "8000" })
  })

  it("offers the default port when the PORT line is not a port", async () => {
    const scripted = createScriptedPrompts([["PORT"], ""])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "PORT=80a0\n" },
      scripted.prompts,
    )

    expect(scripted.textCalls).toEqual([
      { message: "Host port for the server:", defaultValue: "8000", placeholder: "8000" },
    ])
    expect(scripted.errors).toEqual([])
    expect(overrides).toEqual({ PORT: "8000" })
  })

  it("offers the first free port when the PORT line is not a port and the default is taken", async () => {
    const scripted = createScriptedPrompts([["PORT"], ""])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map([[8000, "other-app"]]), mode: "local", envContent: "PORT=80a0\n" },
      scripted.prompts,
    )

    expect(scripted.textCalls).toEqual([
      { message: "Host port for the server:", defaultValue: "8001", placeholder: "8001" },
    ])
    expect(scripted.errors).toEqual([])
    expect(overrides).toEqual({ PORT: "8001" })
  })

  it("seeds the SYNC_MODE select with the current .env value", async () => {
    const scripted = createScriptedPrompts([["SYNC_MODE"], "bidirectional"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "remote", envContent: "SYNC_MODE=pull-only\n" },
      scripted.prompts,
    )

    expect(scripted.selectCalls.map(({ initialValue }) => initialValue)).toEqual(["pull-only"])
    expect(overrides).toEqual({ SYNC_MODE: "bidirectional" })
  })

  it("re-prompts on an unknown timezone until a recognized one is given", async () => {
    const scripted = createScriptedPrompts([
      ["TZ"],
      "Not/AZone", // rejected
      "Europe/London", // accepted
    ])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
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
      { portsInUse: new Map(), mode: "local", envContent: "" },
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

  it.each([
    { label: "an empty line", envContent: "DAILY_NOTES_FOLDER=\n" },
    { label: "empty quotes", envContent: 'DAILY_NOTES_FOLDER=""\n' },
  ])(
    "treats a daily notes folder set to $label as unset, as the server reads it",
    async ({ envContent }) => {
      const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], ""])

      const overrides = await askOptionalSettings(
        { portsInUse: new Map(), mode: "local", envContent },
        scripted.prompts,
      )

      expect(scripted.textCalls).toEqual([
        {
          message: "Vault folder for daily notes:",
          defaultValue: "",
          placeholder: "blank = use your vault's daily notes settings",
        },
      ])
      expect(overrides).toEqual({})
      expect(scripted.logs).toEqual([
        "Left unset — the server reads this setting from your vault's own config.",
      ])
    },
  )

  it("keeps a set daily notes folder on a blank submit without recording a no-op", async () => {
    // The prompt resolves an empty submit to its defaultValue (the current
    // value), so blank never destroys an existing setting — and the unchanged
    // value is not recorded, so the caller won't rewrite the file or offer a
    // restart for a no-op. The placeholder states what blank actually does.
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], ""])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
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
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "  DD-MM-YYYY  "])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
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
      { portsInUse: new Map(), mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
      scripted.prompts,
    )

    expect(overrides).toEqual({})
    expect(scripted.logs).toEqual(["Kept the current value (Journal)."])
  })

  it("updates a set daily notes folder to a new value", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "Planner"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
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
      { portsInUse: new Map(), mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
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
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY/MM/DD" })
  })

  it("shows a set daily notes folder in its chooser hint", async () => {
    const scripted = createScriptedPrompts([[]])

    await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "DAILY_NOTES_FOLDER=Journal\n" },
      scripted.prompts,
    )

    const dailyNotesFolderOption = scripted.multiselectCalls[0].options.find(
      (option) => option.value === "DAILY_NOTES_FOLDER",
    )
    expect(dailyNotesFolderOption?.hint).toBe("DAILY_NOTES_FOLDER · currently Journal")
  })
})

describe("askFolder validation", () => {
  it("rejects path traversal", async () => {
    const scripted = createScriptedPrompts([
      // chooser: pick MEMORY_DIR
      ["MEMORY_DIR"],
      // first answer: traversal → rejected, re-prompted
      "../secret",
      // second answer: valid
      "My Notes",
    ])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "MEMORY_DIR=About Me\n" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual(["Path traversal (..) is not allowed in folder names."])
    expect(overrides).toEqual({ MEMORY_DIR: "My Notes" })
  })

  it("rejects absolute paths", async () => {
    const scripted = createScriptedPrompts([["MEMORY_DIR"], "/var/data", "My Notes"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "MEMORY_DIR=About Me\n" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      "Absolute paths are not allowed — use a vault-relative folder name.",
    ])
    expect(overrides).toEqual({ MEMORY_DIR: "My Notes" })
  })
})

describe("DAILY_NOTES_FOLDER validate callback", () => {
  it("rejects path traversal", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "../etc", "Journal"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual(["Path traversal (..) is not allowed in folder names."])
    expect(overrides).toEqual({ DAILY_NOTES_FOLDER: "Journal" })
  })

  it("rejects absolute paths", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "/var/notes", "Journal"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      "Absolute paths are not allowed — use a vault-relative folder name.",
    ])
    expect(overrides).toEqual({ DAILY_NOTES_FOLDER: "Journal" })
  })

  it("accepts / as the vault root", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FOLDER"], "/"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([])
    expect(overrides).toEqual({ DAILY_NOTES_FOLDER: "/" })
  })
})

describe("DAILY_NOTES_FORMAT validate callback", () => {
  it("rejects path traversal", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "../YYYY-MM-DD", "YYYY-MM-DD"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual(["Date format must not contain path traversal (..)."])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY-MM-DD" })
  })

  it("rejects a leading path separator", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "/YYYY-MM-DD", "YYYY-MM-DD"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual(["Date format must not start with a path separator."])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY-MM-DD" })
  })

  it("rejects a trailing path separator", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "YYYY-MM-DD/", "YYYY-MM-DD"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual(["Date format must not end with a path separator."])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY-MM-DD" })
  })

  it("rejects digits outside bracket escapes", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "2024-MM-DD", "YYYY-MM-DD"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      "Date format should use Moment tokens (YYYY, MM, DD), not digits — wrap literal text in [...] brackets.",
    ])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY-MM-DD" })
  })

  it("rejects digits outside brackets even when brackets contain digits too", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "2024 [Day 2]", "YYYY-MM-DD"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      "Date format should use Moment tokens (YYYY, MM, DD), not digits — wrap literal text in [...] brackets.",
    ])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY-MM-DD" })
  })

  it("rejects trailing digits in a format string", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "YYYY-2024", "YYYY-MM-DD"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([
      "Date format should use Moment tokens (YYYY, MM, DD), not digits — wrap literal text in [...] brackets.",
    ])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY-MM-DD" })
  })

  it("accepts digits inside bracket escapes", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "YYYY-MM-DD [Day 1]"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY-MM-DD [Day 1]" })
  })

  it("accepts a valid format without digits", async () => {
    const scripted = createScriptedPrompts([["DAILY_NOTES_FORMAT"], "YYYY/MM/DD"])

    const overrides = await askOptionalSettings(
      { portsInUse: new Map(), mode: "local", envContent: "" },
      scripted.prompts,
    )

    expect(scripted.errors).toEqual([])
    expect(overrides).toEqual({ DAILY_NOTES_FORMAT: "YYYY/MM/DD" })
  })
})

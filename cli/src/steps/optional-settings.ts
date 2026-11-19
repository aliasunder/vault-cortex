import type { Mode } from "../adapters/docker.js"
import type { Prompts, SelectOption } from "../adapters/prompts.js"
import { parseEnvValues, readEnvValue } from "../rules/env-values.js"
import { DEFAULT_PORT, type PortsInUse } from "../rules/ports.js"
import { askFreePort } from "./port-prompt.js"

type OptionalSettingBase = {
  /** The .env variable name — doubles as the chooser's option value. */
  name: string
  /** Human label shown in the settings chooser. */
  label: string
  /**
   * A toggle var this setting has no effect without. When that toggle is
   * currently off, the chooser hint says so — the user learns the dependency
   * before spending a prompt on an inert value.
   */
  requiresToggle?: string
  /** Only offered in remote-mode flows (absent = offered in both modes). */
  remoteOnly?: true
}

/**
 * One optional .env setting the guided flow can change. `kind` selects the
 * prompt shape a picked setting gets: toggles use a yes/no confirm, port and
 * timezone use validated text inputs, folder requires a non-empty name,
 * optionalText writes nothing when left blank, and choice uses a single select.
 */
type OptionalSetting =
  | (OptionalSettingBase & {
      kind: "toggle"
      question: string
      /** The server's default when the var is unset — seeds the confirm for
       *  an unset toggle. Omitted means enabled (the common case). */
      defaultEnabled?: boolean
    })
  | (OptionalSettingBase & { kind: "port" })
  | (OptionalSettingBase & { kind: "timezone" })
  | (OptionalSettingBase & {
      kind: "folder"
      question: string
      defaultValue: string
    })
  | (OptionalSettingBase & {
      kind: "optionalText"
      question: string
      /** Ghost text while unset — no defaultValue because pre-filling would silently shadow the vault's own config. */
      placeholder: string
      /** Rejects a user-entered value — returns an error message, or undefined to accept. */
      validate?: (value: string) => string | undefined
    })
  | (OptionalSettingBase & {
      kind: "choice"
      question: string
      choices: SelectOption[]
      defaultValue: string
    })

/** Matches Moment.js [...] literal escape groups, splitting format spans from literal content. */
const MOMENT_BRACKET_ESCAPE = /\[([^\]]*)\]/g

/** Matches a value made only of forward or back slashes, which the server
 *  reads as the vault root. */
const VAULT_ROOT_FOLDER_RE = /^[\\/]+$/

/** Why a vault folder name is refused, or undefined when it is a vault-relative name. */
const describeInvalidVaultFolder = (folderName: string): string | undefined => {
  if (folderName.includes("..")) return "Path traversal (..) is not allowed in folder names."
  if (folderName.startsWith("/")) {
    return "Absolute paths are not allowed — use a vault-relative folder name."
  }
  return undefined
}

// The curated prompt set — settings users most often want without reading
// .env comments. Everything else stays documented-only in the generated
// optional block, deliberately: every extra prompt costs init flow length.
const OPTIONAL_SETTINGS: OptionalSetting[] = [
  {
    kind: "toggle",
    name: "MEMORY_ENABLED",
    label: "Memory layer",
    question: "Enable the memory layer (About Me/ folder + memory tools)?",
  },
  {
    kind: "folder",
    name: "MEMORY_DIR",
    label: "Memory folder",
    question: "Vault folder for the memory files:",
    defaultValue: "About Me",
    requiresToggle: "MEMORY_ENABLED",
  },
  {
    kind: "optionalText",
    name: "DAILY_NOTES_FOLDER",
    label: "Daily notes folder",
    question: "Vault folder for daily notes:",
    placeholder: "blank = use your vault's daily notes settings",
    validate: (value) => {
      // "/" names the vault root, so the absolute-path check must not catch it.
      if (VAULT_ROOT_FOLDER_RE.test(value)) return undefined
      return describeInvalidVaultFolder(value)
    },
  },
  {
    kind: "optionalText",
    name: "DAILY_NOTES_FORMAT",
    label: "Daily notes format",
    question: "Filename date format for daily notes (e.g. YYYY-MM-DD):",
    placeholder: "blank = use your vault's daily notes settings",
    validate: (value) => {
      if (value.includes("..")) return "Date format must not contain path traversal (..)."
      if (value.startsWith("/")) return "Date format must not start with a path separator."
      if (value.endsWith("/")) return "Date format must not end with a path separator."
      // Moment format tokens are all letters — digits outside of [...]
      // bracket escapes are almost always a mistake.
      // A split on a capturing regex puts each bracket's content at an odd
      // index, so the even indexes hold the format text outside brackets.
      const formatSegments = value.split(MOMENT_BRACKET_ESCAPE)
      const hasDigitsInFormat = formatSegments.some(
        (segment, index) => index % 2 === 0 && /\d/.test(segment),
      )

      if (hasDigitsInFormat)
        return "Date format should use Moment tokens (YYYY, MM, DD), not digits — wrap literal text in [...] brackets."
      return undefined
    },
  },
  {
    kind: "toggle",
    name: "FILE_TOOLS_ENABLED",
    label: "File tools",
    question: "Enable file tools (read images, PDFs, and other non-Markdown files)?",
  },
  {
    kind: "toggle",
    name: "READONLY_MODE",
    label: "Read-only mode",
    question: "Run the server in read-only mode (hide all tools that change the vault)?",
    defaultEnabled: false,
  },
  {
    kind: "toggle",
    name: "EMBEDDING_ENABLED",
    label: "Semantic search",
    question: "Enable semantic search embeddings (richer search, slower first startup)?",
  },
  { kind: "port", name: "PORT", label: "Host port" },
  { kind: "timezone", name: "TZ", label: "Timezone" },
  {
    kind: "choice",
    name: "SYNC_MODE",
    label: "Sync direction",
    question: "Obsidian Sync direction:",
    choices: [
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
    defaultValue: "bidirectional",
    remoteOnly: true,
  },
]

/** The toggle spellings the server's env-var asBool accepts, in any case, and the state each means. */
const TOGGLE_STATES: ReadonlyMap<string, string> = new Map([
  ["true", "true"],
  ["1", "true"],
  ["false", "false"],
  ["0", "false"],
])

/** The setting kinds the server gives a default, so an unset line still has a value. */
type DefaultedSetting = Extract<OptionalSetting, { kind: "toggle" | "port" | "folder" | "choice" }>

/**
 * The value the server runs with for a defaulted setting, given its .env text,
 * in the spelling the setting's prompt returns. Prompts start from it, and an
 * answer equal to it is not a change.
 * - An unset or empty line means the setting's default, since Compose's
 *   `${VAR:-default}` and env-var's `.default()` both read an empty value as unset.
 * - A toggle reads as "true" or "false" from any spelling the server accepts.
 *   Any other spelling stops the server at boot, so it is returned as written:
 *   it then matches no answer, so confirming the toggle rewrites the line, and
 *   the confirm starts at "yes".
 */
const defaultedSettingValue = (setting: DefaultedSetting, envText: string | undefined): string => {
  switch (setting.kind) {
    case "toggle":
      if (!envText) return String(setting.defaultEnabled ?? true)
      return TOGGLE_STATES.get(envText.toLowerCase()) ?? envText
    case "port":
      return envText || String(DEFAULT_PORT)
    case "folder":
    case "choice":
      return envText || setting.defaultValue
  }
}

/** The value the server runs with for any setting; one with no default is its .env text. */
const effectiveSettingValue = (
  setting: OptionalSetting,
  envText: string | undefined,
): string | undefined => {
  switch (setting.kind) {
    case "toggle":
    case "port":
    case "folder":
    case "choice":
      return defaultedSettingValue(setting, envText)
    case "timezone":
    case "optionalText":
      return envText
  }
}

/**
 * The engine's own IANA zone validation: Intl.DateTimeFormat throws a
 * RangeError for an unknown timeZone, so no hand-rolled zone list to drift.
 */
const isValidTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Re-prompts until the answer is a zone the runtime recognizes. An empty
 * answer, which a set timezone never gives because the prompt defaults to it,
 * leaves TZ unset.
 */
const askTimezone = async (
  currentValue: string | undefined,
  prompts: Prompts,
): Promise<string | undefined> => {
  const answer = (
    await prompts.text("Your IANA timezone:", {
      defaultValue: currentValue,
      placeholder: "America/New_York",
    })
  ).trim()

  if (answer === "") {
    prompts.log("Left unset — the server uses UTC.")
    return undefined
  }
  if (isValidTimezone(answer)) return answer
  prompts.error(
    `"${answer}" is not a recognized IANA timezone (e.g. America/New_York, Europe/London).`,
  )
  return askTimezone(currentValue, prompts)
}

/** Re-prompts until the answer is a non-empty folder name. */
const askFolder = async (
  params: {
    question: string
    /** The folder the server uses now, which an empty answer keeps. */
    effectiveFolder: string
    defaultFolder: string
  },
  prompts: Prompts,
): Promise<string> => {
  const { question, effectiveFolder, defaultFolder } = params
  const answer = (
    await prompts.text(question, {
      defaultValue: effectiveFolder,
      placeholder: defaultFolder,
    })
  ).trim()

  const folderError =
    answer === "" ? "The folder name can't be empty." : describeInvalidVaultFolder(answer)

  if (!folderError) return answer
  prompts.error(folderError)
  return askFolder(params, prompts)
}

/**
 * Text prompt for a setting whose absence is meaningful — the server falls
 * back to the vault's own config when the var is unset. Blank-when-unset
 * writes nothing; blank-when-set keeps the current value. Returns undefined
 * on skip or no-op so the caller never rewrites for nothing. No removal
 * path — clearing is a manual .env edit.
 */
const askOptionalText = async (
  params: {
    question: string
    placeholder: string
    currentValue: string | undefined
  },
  prompts: Prompts,
): Promise<string | undefined> => {
  const { question, placeholder, currentValue } = params
  const answer = (
    await prompts.text(question, {
      defaultValue: currentValue,
      // The server reads an empty .env value as unset.
      placeholder: currentValue ? "blank = keep the current value" : placeholder,
    })
  ).trim()

  if (answer !== "" && answer !== currentValue) return answer
  if (!currentValue) {
    prompts.log("Left unset — the server reads this setting from your vault's own config.")
    return undefined
  }
  prompts.log(`Kept the current value (${currentValue}).`)
  return undefined
}

/**
 * Routes a picked setting to its kind's prompt and returns the .env value —
 * or undefined when an optionalText or timezone prompt was left blank
 * (nothing to write).
 */
const askSettingValue = async (
  params: { setting: OptionalSetting; currentValue: string | undefined; portsInUse: PortsInUse },
  prompts: Prompts,
): Promise<string | undefined> => {
  const { setting, currentValue, portsInUse } = params
  switch (setting.kind) {
    case "toggle": {
      const currentlyEnabled = defaultedSettingValue(setting, currentValue) !== "false"
      const enabled = await prompts.confirm(setting.question, currentlyEnabled)
      return String(enabled)
    }
    case "port":
      return askFreePort(
        { suggestedPort: defaultedSettingValue(setting, currentValue), portsInUse },
        prompts,
      )
    case "timezone":
      return askTimezone(currentValue, prompts)
    case "folder":
      return askFolder(
        {
          question: setting.question,
          effectiveFolder: defaultedSettingValue(setting, currentValue),
          defaultFolder: setting.defaultValue,
        },
        prompts,
      )
    case "optionalText": {
      const value = await askOptionalText(
        {
          question: setting.question,
          placeholder: setting.placeholder,
          currentValue,
        },
        prompts,
      )

      if (value && setting.validate) {
        const error = setting.validate(value)

        if (error) {
          prompts.error(error)
          return askSettingValue(params, prompts)
        }
      }
      return value
    }
    case "choice":
      return prompts.select(
        setting.question,
        setting.choices,
        defaultedSettingValue(setting, currentValue),
      )
  }
}

/**
 * The guided optional-settings flow shared by init and configure:
 * - one multiselect chooser (enter with nothing picked = change nothing), then
 *   one prompt per picked setting;
 * - returns the chosen values keyed by var name, which the caller applies with
 *   applyOptionalSettings.
 */
export const askOptionalSettings = async (
  params: {
    mode: Mode
    envContent: string
    /** Ports other containers publish, which the port prompt refuses; empty when Docker can't be asked. */
    portsInUse: PortsInUse
  },
  prompts: Prompts,
): Promise<Record<string, string>> => {
  const { mode, envContent, portsInUse } = params
  // Hints, prompt seeding and the PUBLIC_URL derivation reason from the value
  // that takes effect, so each one reads the parsed value, quotes removed.
  const envValues = parseEnvValues(envContent)
  const offeredSettings = OPTIONAL_SETTINGS.filter(
    (setting) => !setting.remoteOnly || mode === "remote",
  )
  const chooserOptions = offeredSettings.map((setting) => {
    const currentValue = readEnvValue(envValues, setting.name)
    const requiredToggle = OPTIONAL_SETTINGS.find(
      (candidate) => candidate.name === setting.requiresToggle,
    )
    const requiredToggleOff =
      requiredToggle &&
      effectiveSettingValue(requiredToggle, readEnvValue(envValues, requiredToggle.name)) ===
        "false"
    const dependencyNote = requiredToggleOff
      ? ` · not used while ${requiredToggle.label} is off`
      : ""
    return {
      value: setting.name,
      label: setting.label,
      hint: `${setting.name} · currently ${currentValue || "not set"}${dependencyNote}`,
    }
  })

  const pickedNames = await prompts.multiselect(
    "Any optional settings to change? (press enter to skip)",
    chooserOptions,
  )

  // Answers are gathered one at a time in the curated order, so the record
  // builds up inside a plain loop. A blank optionalText answer writes nothing,
  // and an answer the server reads the same as the current line is not a
  // change, because recording it would make the caller rewrite the file and
  // offer a restart for a setting that did not change.
  const overrides: Record<string, string> = {}
  for (const setting of offeredSettings) {
    if (!pickedNames.includes(setting.name)) continue
    const currentValue = readEnvValue(envValues, setting.name)
    const value = await askSettingValue({ setting, currentValue, portsInUse }, prompts)

    if (!value) continue
    if (value === effectiveSettingValue(setting, currentValue)) {
      prompts.log(`Kept the current value (${currentValue || value}).`)
      continue
    }
    overrides[setting.name] = value
  }
  return overrides
}

import { DEFAULT_PORT, type Mode } from "./scaffold.js"
import type { Prompts, SelectOption } from "./prompts.js"

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
 * timezone use validated text inputs, and choice uses a single select.
 */
type OptionalSetting =
  | (OptionalSettingBase & { kind: "toggle"; question: string })
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
    })
  | (OptionalSettingBase & {
      kind: "choice"
      question: string
      choices: SelectOption[]
      defaultValue: string
    })

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
  },
  {
    kind: "optionalText",
    name: "DAILY_NOTES_FORMAT",
    label: "Daily notes format",
    question: "Filename date format for daily notes (e.g. YYYY-MM-DD):",
    placeholder: "blank = use your vault's daily notes settings",
  },
  {
    kind: "toggle",
    name: "FILE_TOOLS_ENABLED",
    label: "File tools",
    question:
      "Enable file tools (read images, PDFs, and other non-Markdown files)?",
  },
  {
    kind: "toggle",
    name: "EMBEDDING_ENABLED",
    label: "Semantic search",
    question:
      "Enable semantic search embeddings (richer search, slower first startup)?",
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
        value: "push-only",
        label: "Push-only",
        hint: "push changes but never pull",
      },
    ],
    defaultValue: "bidirectional",
    remoteOnly: true,
  },
]

/** Matches the full active (uncommented) assignment line for a var. */
const activeLinePattern = (name: string): RegExp =>
  new RegExp(`^${name}=.*$`, "m")

/** Matches the full commented-out assignment line (`# VAR=...`) for a var. */
const commentedLinePattern = (name: string): RegExp =>
  new RegExp(`^# ${name}=.*$`, "m")

/**
 * Reads a var's current value from .env content. A commented-out or missing
 * line returns undefined — both mean "the server uses its built-in default",
 * which is exactly what the prompts need to distinguish. Duplicate lines
 * report the LAST value, matching docker --env-file precedence — hints,
 * prompt seeding, and the PUBLIC_URL derivation must reason from the value
 * that actually takes effect.
 */
export const readOptionalValue = (
  envContent: string,
  name: string,
): string | undefined => {
  const matches = [...envContent.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))]
  return matches.at(-1)?.[1].trim()
}

/**
 * Applies chosen values to .env content as a pure text transform: every
 * active line for the var is replaced (docker --env-file gives the last
 * duplicate precedence, so a single-line replace could leave a stale
 * duplicate winning), a commented-out line is uncommented and replaced, and
 * a var with no line at all (a .env predating the setting) is appended —
 * the chosen value must land in the file, never be silently dropped.
 */
export const applyOptionalSettings = (
  envContent: string,
  overrides: Record<string, string>,
): string =>
  Object.entries(overrides).reduce((content, [name, value]) => {
    // Fresh RegExp per use (the /g flag makes instances stateful via
    // lastIndex); function replacements avoid $-pattern interpretation in
    // values, same as patchEnvObsidianToken.
    const everyActiveLine = new RegExp(`^${name}=.*$`, "gm")
    if (activeLinePattern(name).test(content)) {
      return content.replace(everyActiveLine, () => `${name}=${value}`)
    }
    if (commentedLinePattern(name).test(content)) {
      return content.replace(
        commentedLinePattern(name),
        () => `${name}=${value}`,
      )
    }
    return `${content.trimEnd()}\n\n${name}=${value}\n`
  }, envContent)

/**
 * A PORT override moves the server, and the local quickstart derives
 * PUBLIC_URL (the OAuth issuer) from that port. When the current PUBLIC_URL
 * is exactly the derived http://localhost:<current port> form, it follows
 * the new port — otherwise the advertised OAuth discovery endpoints would
 * point at a port nothing listens on. A custom PUBLIC_URL (reverse proxy,
 * remote domain) is the user's own and is never touched.
 */
export const derivePublicUrlOverride = (
  envContent: string,
  overrides: Record<string, string>,
): Record<string, string> => {
  const newPort = overrides.PORT
  if (!newPort) return overrides
  const currentPort =
    readOptionalValue(envContent, "PORT") ?? String(DEFAULT_PORT)
  const currentPublicUrl = readOptionalValue(envContent, "PUBLIC_URL")
  if (currentPublicUrl !== `http://localhost:${currentPort}`) return overrides
  return { ...overrides, PUBLIC_URL: `http://localhost:${newPort}` }
}

/**
 * The .env spellings the server reads as "off" — env-var's asBool accepts
 * 0/1 alongside true/false. An absent or unrecognized value falls to the
 * server default, which is enabled for every curated toggle.
 */
const isDisabledToggleValue = (value: string | undefined): boolean =>
  ["false", "0"].includes((value ?? "").toLowerCase())

/**
 * Plain digits in the TCP port range. Number() coercion is not enough:
 * it accepts "1e4"/"0x1F40"/"+9000", which readEnvPort's /^PORT=(\d+)/
 * would later fail to read back — silently falling to the default port.
 */
const isValidPort = (value: string): boolean => {
  if (!/^\d+$/.test(value)) return false
  const port = Number(value)
  return port >= 1 && port <= 65535
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

/** Re-prompts until the answer is a valid port number. */
const askPort = async (
  currentValue: string | undefined,
  prompts: Prompts,
): Promise<string> => {
  const answer = (
    await prompts.text("Host port for the server:", {
      defaultValue: currentValue ?? String(DEFAULT_PORT),
      placeholder: String(DEFAULT_PORT),
    })
  ).trim()
  if (isValidPort(answer)) return answer
  prompts.error("PORT must be a whole number between 1 and 65535.")
  return askPort(currentValue, prompts)
}

/** Re-prompts until the answer is a zone the runtime recognizes. */
const askTimezone = async (
  currentValue: string | undefined,
  prompts: Prompts,
): Promise<string> => {
  const answer = (
    await prompts.text("Your IANA timezone:", {
      defaultValue: currentValue,
      placeholder: "America/New_York",
    })
  ).trim()
  if (answer !== "" && isValidTimezone(answer)) return answer
  prompts.error(
    `"${answer}" is not a recognized IANA timezone (e.g. America/New_York, Europe/London).`,
  )
  return askTimezone(currentValue, prompts)
}

/** Re-prompts until the answer is a non-empty folder name. */
const askFolder = async (
  params: {
    question: string
    currentValue: string | undefined
    defaultValue: string
  },
  prompts: Prompts,
): Promise<string> => {
  const { question, currentValue, defaultValue } = params
  const answer = (
    await prompts.text(question, {
      defaultValue: currentValue ?? defaultValue,
      placeholder: defaultValue,
    })
  ).trim()
  if (answer !== "") return answer
  prompts.error("The folder name can't be empty.")
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
      placeholder:
        currentValue === undefined
          ? placeholder
          : "blank = keep the current value",
    })
  ).trim()
  if (answer !== "" && answer !== currentValue) return answer
  if (currentValue === undefined) {
    prompts.log(
      "Left unset — the server reads this setting from your vault's own config.",
    )
    return undefined
  }
  prompts.log(`Kept the current value (${currentValue}).`)
  return undefined
}

/**
 * Routes a picked setting to its kind's prompt and returns the .env value —
 * or undefined when an optionalText prompt was left blank (nothing to write).
 */
const askSettingValue = async (
  params: { setting: OptionalSetting; currentValue: string | undefined },
  prompts: Prompts,
): Promise<string | undefined> => {
  const { setting, currentValue } = params
  switch (setting.kind) {
    case "toggle": {
      const enabled = await prompts.confirm(
        setting.question,
        !isDisabledToggleValue(currentValue),
      )
      return String(enabled)
    }
    case "port":
      return askPort(currentValue, prompts)
    case "timezone":
      return askTimezone(currentValue, prompts)
    case "folder":
      return askFolder(
        {
          question: setting.question,
          currentValue,
          defaultValue: setting.defaultValue,
        },
        prompts,
      )
    case "optionalText":
      return askOptionalText(
        {
          question: setting.question,
          placeholder: setting.placeholder,
          currentValue,
        },
        prompts,
      )
    case "choice":
      return prompts.select(
        setting.question,
        setting.choices,
        currentValue ?? setting.defaultValue,
      )
  }
}

/**
 * The guided optional-settings flow shared by init and configure: one
 * multiselect chooser (enter with nothing picked = change nothing), then one
 * prompt per picked setting. Returns the chosen values keyed by var name —
 * the caller owns applying them via applyOptionalSettings.
 */
export const askOptionalSettings = async (
  params: { mode: Mode; envContent: string },
  prompts: Prompts,
): Promise<Record<string, string>> => {
  const { mode, envContent } = params
  const offeredSettings = OPTIONAL_SETTINGS.filter(
    (setting) => !setting.remoteOnly || mode === "remote",
  )
  const chooserOptions = offeredSettings.map((setting) => {
    const currentValue = readOptionalValue(envContent, setting.name)
    const requiredToggle = OPTIONAL_SETTINGS.find(
      (candidate) => candidate.name === setting.requiresToggle,
    )
    const dependencyNote =
      requiredToggle &&
      isDisabledToggleValue(readOptionalValue(envContent, requiredToggle.name))
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

  // Sequential prompting: answers are gathered one at a time in the curated
  // order, so the record builds up inside an honest loop. An undefined answer
  // (an optionalText prompt left blank) writes nothing.
  const overrides: Record<string, string> = {}
  for (const setting of offeredSettings) {
    if (!pickedNames.includes(setting.name)) continue
    const value = await askSettingValue(
      { setting, currentValue: readOptionalValue(envContent, setting.name) },
      prompts,
    )
    if (value !== undefined) overrides[setting.name] = value
  }
  return overrides
}

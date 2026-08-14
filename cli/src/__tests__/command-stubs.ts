import type { DockerRunner } from "../docker.js"
import type { Prompts, SelectOption } from "../prompts.js"

/**
 * One canned reply for one interactive prompt, in ask order: string for
 * select/text/password, boolean for confirm, string[] for multiselect.
 */
export type ScriptedAnswer = string | boolean | string[]

export type MultiselectCall = { message: string; options: SelectOption[] }
export type ConfirmCall = { message: string; initialValue: boolean }
export type SelectCall = { message: string; initialValue: string }
export type TextCall = {
  message: string
  defaultValue: string | undefined
  placeholder: string | undefined
}

export type ScriptedPrompts = {
  prompts: Prompts
  asked: string[]
  errors: string[]
  warnings: string[]
  logs: string[]
  notes: string[]
  prints: string[]
  outros: string[]
  spinnerMessages: string[]
  multiselectCalls: MultiselectCall[]
  confirmCalls: ConfirmCall[]
  selectCalls: SelectCall[]
  textCalls: TextCall[]
}

/**
 * A Prompts stub that replays canned answers in order and records everything:
 * the asked-prompt sequence, every output channel, and per-kind prompt calls
 * (message + initial/default value) for chooser and seeding asserts.
 * An interactive prompt with no scripted answer throws, so a flow that asks
 * an unexpected question fails loudly instead of receiving a silent default —
 * commands with no interactive prompts call this with no arguments.
 */
export const createScriptedPrompts = (
  answers: ScriptedAnswer[] = [],
): ScriptedPrompts => {
  const remaining = [...answers]
  const asked: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const logs: string[] = []
  const notes: string[] = []
  const prints: string[] = []
  const outros: string[] = []
  const spinnerMessages: string[] = []
  const multiselectCalls: MultiselectCall[] = []
  const confirmCalls: ConfirmCall[] = []
  const selectCalls: SelectCall[] = []
  const textCalls: TextCall[] = []

  const nextAnswer = (message: string): ScriptedAnswer => {
    asked.push(message)
    const answer = remaining.shift()
    if (answer === undefined)
      throw new Error(`No scripted answer for prompt: ${message}`)
    return answer
  }

  // Typed variants reject a wrong-type answer instead of coercing it — a
  // script misaligned with the flow's actual prompts must fail, not feed
  // "false" into a text prompt or truthy-cast an array into a confirm.
  const nextStringAnswer = (message: string): string => {
    const answer = nextAnswer(message)
    if (typeof answer === "string") return answer
    throw new Error(
      `prompt "${message}" needs a string scripted answer, got: ${String(answer)}`,
    )
  }

  const nextBooleanAnswer = (message: string): boolean => {
    const answer = nextAnswer(message)
    if (typeof answer === "boolean") return answer
    throw new Error(
      `prompt "${message}" needs a boolean scripted answer, got: ${String(answer)}`,
    )
  }

  const prompts: Prompts = {
    intro: () => {},
    outro: (message) => {
      outros.push(message)
    },
    note: (message) => {
      notes.push(message)
    },
    print: (message) => {
      prints.push(message)
    },
    log: (message) => {
      logs.push(message)
    },
    warn: (message) => {
      warnings.push(message)
    },
    error: (message) => {
      errors.push(message)
    },
    select: async (message, _options, initialValue) => {
      selectCalls.push({ message, initialValue })
      return nextStringAnswer(message)
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
      textCalls.push({
        message,
        defaultValue: options?.defaultValue,
        placeholder: options?.placeholder,
      })
      const answer = nextStringAnswer(message)
      // Mirrors @clack/prompts: an empty submission resolves to defaultValue.
      if (answer === "" && options?.defaultValue !== undefined)
        return options.defaultValue
      return answer
    },
    password: async (message) => nextStringAnswer(message),
    confirm: async (message, initialValue) => {
      confirmCalls.push({ message, initialValue })
      return nextBooleanAnswer(message)
    },
    spinner: () => ({
      start: (message) => {
        spinnerMessages.push(`start: ${message}`)
      },
      stop: (message) => {
        spinnerMessages.push(`stop: ${message}`)
      },
    }),
  }

  return {
    prompts,
    asked,
    errors,
    warnings,
    logs,
    notes,
    prints,
    outros,
    spinnerMessages,
    multiselectCalls,
    confirmCalls,
    selectCalls,
    textCalls,
  }
}

/** Daemon up and every operation succeeds — the container exists. */
export const dockerReady: DockerRunner = {
  daemonStatus: () => "running",
  dockerRun: () => true,
  pullImage: () => true,
  stopAndRemoveContainer: () => true,
  containerExists: () => true,
  streamLogs: async () => 0,
  runObsidianLogin: () => false,
}

/** Daemon installed but not running — every operation fails. */
export const dockerDown: DockerRunner = {
  daemonStatus: () => "not-running",
  dockerRun: () => false,
  pullImage: () => false,
  stopAndRemoveContainer: () => false,
  containerExists: () => false,
  streamLogs: async () => 1,
  runObsidianLogin: () => false,
}

/** Docker binary absent entirely — every operation fails. */
export const dockerNotInstalled: DockerRunner = {
  ...dockerDown,
  daemonStatus: () => "not-installed",
}

/**
 * Daemon up but every operation fails — the spread base for per-test
 * variants that succeed at exactly one operation.
 */
export const dockerDaemonOnly: DockerRunner = {
  ...dockerDown,
  daemonStatus: () => "running",
}

/** Health check passes immediately. */
export const fetchOk: typeof fetch = async () =>
  new Response(null, { status: 200 })

/** Fails the test if the flow under test reaches the network at all. */
export const fetchNever: typeof fetch = async () => {
  throw new Error("fetch must not be called")
}

import * as clack from "@clack/prompts"

export type SelectOption = {
  value: string
  label: string
  hint?: string
}

export type Spinner = {
  start: (message: string) => void
  stop: (message: string) => void
}

/**
 * The prompt surface init.ts depends on. The real implementation wraps
 * @clack/prompts; tests inject a scripted stub, so this is the only module
 * that touches stdin.
 */
export type Prompts = {
  intro: (message: string) => void
  outro: (message: string) => void
  note: (message: string, title?: string) => void
  log: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  select: (
    message: string,
    options: SelectOption[],
    initialValue: string,
  ) => Promise<string>
  text: (
    message: string,
    options?: { placeholder?: string; defaultValue?: string },
  ) => Promise<string>
  confirm: (message: string, initialValue: boolean) => Promise<boolean>
  spinner: () => Spinner
}

// User pressed ctrl-C mid-prompt: 130 = 128 + SIGINT, the shell convention.
const exitOnCancel = <T>(value: T | symbol): T => {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.")
    process.exit(130)
  }
  return value as T
}

export const createPrompts = (): Prompts => ({
  intro: (message) => clack.intro(message),
  outro: (message) => clack.outro(message),
  note: (message, title) => clack.note(message, title),
  log: (message) => clack.log.info(message),
  warn: (message) => clack.log.warn(message),
  error: (message) => clack.log.error(message),
  select: async (message, options, initialValue) =>
    exitOnCancel(await clack.select({ message, options, initialValue })),
  text: async (message, options = {}) =>
    exitOnCancel(
      await clack.text({
        message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
      }),
    ),
  confirm: async (message, initialValue) =>
    exitOnCancel(await clack.confirm({ message, initialValue })),
  spinner: () => {
    const clackSpinner = clack.spinner()
    return {
      start: (message) => clackSpinner.start(message),
      stop: (message) => clackSpinner.stop(message),
    }
  },
})

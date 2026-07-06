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
  /**
   * Print plain text with no clack framing. Used for the Connect
   * instructions: a clack note box hard-wraps long lines behind a "│ "
   * border, which corrupts a copied command — plain output lets the terminal
   * soft-wrap instead, keeping commands and tokens copyable.
   */
  print: (message: string) => void
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
  /** Like text, but input is masked — the value never echoes to the terminal or scrollback. */
  password: (message: string) => Promise<string>
  confirm: (message: string, initialValue: boolean) => Promise<boolean>
  spinner: () => Spinner
}

// User pressed ctrl-C mid-prompt: 130 = 128 + SIGINT, the shell convention.
// clack.isCancel is a type guard (value is symbol), so after the early exit
// TypeScript narrows `value` to `T` — no assertion needed.
const exitOnCancel = <T>(value: T | symbol): T => {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.")
    process.exit(130)
  }
  return value
}

/**
 * The production Prompts implementation: a thin pass-through to
 * @clack/prompts, plus two behaviors the Prompts type promises its callers —
 * every interactive prompt exits the process on ctrl-C (via exitOnCancel),
 * so flow code never sees a cancel symbol and answers are always plain
 * values; and select/text/confirm adapt clack's options-object signatures to
 * the flatter Prompts signatures that init.ts and the test stub share.
 */
export const createPrompts = (): Prompts => ({
  intro: (message) => clack.intro(message),
  outro: (message) => clack.outro(message),
  note: (message, title) => clack.note(message, title),
  // Leading + trailing newline sets the block off from the surrounding clack
  // output without a box around it.
  print: (message) => process.stdout.write(`\n${message}\n`),
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
  password: async (message) => exitOnCancel(await clack.password({ message })),
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

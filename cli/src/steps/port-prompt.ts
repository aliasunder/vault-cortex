import type { Prompts } from "../adapters/prompts.js"
import {
  DEFAULT_PORT,
  decidePort,
  isValidPort,
  portInUseMessage,
  suggestFreePort,
  type PortRequest,
  type PortsInUse,
} from "../rules/ports.js"

/** "ok" carries the .env settings to write for the port; an empty record keeps the default port. */
type PortSettingResult = { kind: "ok"; settings: Record<string, string> } | { kind: "exit" }

/**
 * Re-prompts until the answer is a valid port no other container on the
 * machine publishes. Without a suggested port, it offers the first free one.
 */
export const askFreePort = async (
  params: { suggestedPort?: string; portsInUse: PortsInUse },
  prompts: Prompts,
): Promise<string> => {
  const { portsInUse } = params
  const suggestedPort = params.suggestedPort ?? suggestFreePort(portsInUse)
  // A value that isn't a port is never offered, since it would be rejected.
  const offeredPort = isValidPort(suggestedPort) ? suggestedPort : String(DEFAULT_PORT)
  const answer = (
    await prompts.text("Host port for the server:", {
      defaultValue: offeredPort,
      placeholder: offeredPort,
    })
  ).trim()

  if (!isValidPort(answer)) {
    prompts.error("PORT must be a whole number between 1 and 65535.")
    return askFreePort(params, prompts)
  }
  const portUser = portsInUse.get(Number(answer))

  if (!portUser) return answer
  prompts.error(`${portInUseMessage({ port: answer, containerName: portUser })} Pick another port.`)
  // Suggest a free port, so pressing Enter can't pick the taken one again.
  return askFreePort({ portsInUse }, prompts)
}

/**
 * Acts on decidePort's decision for init: a free port is used, a taken one
 * stops a non-interactive run and is asked again otherwise, and an unknown
 * one is asked for.
 */
export const choosePort = async (
  params: { request: PortRequest; portsInUse: PortsInUse; interactive: boolean },
  prompts: Prompts,
): Promise<PortSettingResult> => {
  const { request, portsInUse, interactive } = params
  const decision = decidePort({ request, portsInUse })

  switch (decision.kind) {
    case "use":
      return { kind: "ok", settings: decision.settings }
    case "taken": {
      const message = portInUseMessage(decision)

      if (!interactive) {
        prompts.error(
          `${message} Re-run with a free port, such as --port ${suggestFreePort(portsInUse)}.`,
        )
        return { kind: "exit" }
      }
      prompts.warn(message)
      return { kind: "ok", settings: { PORT: await askFreePort({ portsInUse }, prompts) } }
    }
    case "ask":
      return { kind: "ok", settings: { PORT: await askFreePort({ portsInUse }, prompts) } }
  }
}

import type { PublishedPort } from "../adapters/docker.js"

/** Default host port — matches the container's internal port. */
export const DEFAULT_PORT = 8000

/** Host ports that containers on this machine publish, mapped to each container's name. */
export type PortsInUse = ReadonlyMap<number, string>

/** The port an install asks for: one given by --port, the default, or none known yet. */
export type PortRequest = { kind: "flag"; port: string } | { kind: "default" } | { kind: "unknown" }

/**
 * What to do with a port request:
 * - use: write these settings (an empty record keeps the default port);
 * - taken: another container publishes the requested port;
 * - ask: no port is known, so the user picks one.
 */
export type PortDecision =
  | { kind: "use"; settings: Record<string, string> }
  | { kind: "taken"; port: string; containerName: string }
  | { kind: "ask" }

/**
 * Plain digits in the TCP port range. Number() coercion is not enough: it
 * accepts "1e4", "0x1F40" and "+9000".
 */
export const isValidPort = (value: string): boolean => {
  if (!/^\d+$/.test(value)) return false
  const port = Number(value)
  return port >= 1 && port <= 65535
}

/** The error for a .env PORT value that isn't a port; callers add where to fix it. */
export const describeInvalidEnvPort = (portValue: string): string => {
  return `PORT "${portValue}" is not a valid port — use a whole number between 1 and 65535.`
}

export const portInUseMessage = (params: { port: string; containerName: string }): string => {
  return `Port ${params.port} is already used by the "${params.containerName}" container on this machine.`
}

/** The first port, counting up from the default, that no container publishes. */
export const suggestFreePort = (portsInUse: PortsInUse): string => {
  const findFreePort = (candidatePort: number): number => {
    return portsInUse.has(candidatePort) ? findFreePort(candidatePort + 1) : candidatePort
  }
  return String(findFreePort(DEFAULT_PORT))
}

export const buildPortsInUse = (publishedPorts: ReadonlyArray<PublishedPort>): PortsInUse => {
  return new Map(publishedPorts.map(({ hostPort, containerName }) => [hostPort, containerName]))
}

/**
 * Start and restart replace the install's own container, so only other
 * containers' ports are taken. A port another container also publishes stays taken.
 */
export const portsOfOtherContainers = (
  publishedPorts: ReadonlyArray<PublishedPort>,
  containerName: string,
): PortsInUse => {
  const otherContainersPorts = publishedPorts.filter((publishedPort) => {
    return publishedPort.containerName !== containerName
  })
  return buildPortsInUse(otherContainersPorts)
}

/**
 * Returns the decision as data, without prompting, so the caller chooses how
 * to act on it: --yes refuses a taken port, while an interactive run asks.
 */
export const decidePort = (params: {
  request: PortRequest
  portsInUse: PortsInUse
}): PortDecision => {
  const { request, portsInUse } = params

  switch (request.kind) {
    case "unknown":
      return { kind: "ask" }
    case "default": {
      const containerName = portsInUse.get(DEFAULT_PORT)

      if (!containerName) return { kind: "use", settings: {} }
      return { kind: "taken", port: String(DEFAULT_PORT), containerName }
    }
    case "flag": {
      const containerName = portsInUse.get(Number(request.port))

      if (!containerName) return { kind: "use", settings: { PORT: request.port } }
      return { kind: "taken", port: request.port, containerName }
    }
  }
}

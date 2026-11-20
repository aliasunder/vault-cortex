import { isIPv4, isIPv6 } from "node:net"

import type { Mode } from "../adapters/docker.js"

/**
 * The host address Docker publishes the port on when .env sets no
 * BIND_ADDRESS:
 * - a local install answers this machine only;
 * - a remote install gets no address, so Docker publishes on every address,
 *   IPv4 and IPv6, and other devices can reach the server over either.
 */
export const DEFAULT_BIND_ADDRESSES: Readonly<Record<Mode, string>> = {
  local: "127.0.0.1",
  remote: "",
}

/**
 * An IPv4 address, or an IPv6 address in brackets (`[::1]`): the host-address
 * forms both `docker run -p` and Compose's ports list read. A bare IPv6
 * address is refused, because its colons run into the port separators, and
 * so is a zone-scoped one (`[fe80::1%eth0]`), which Node accepts but Docker
 * does not.
 */
export const isValidBindAddress = (value: string): boolean => {
  if (isIPv4(value)) return true
  if (value.includes("%")) return false
  return value.startsWith("[") && value.endsWith("]") && isIPv6(value.slice(1, -1))
}

/** The error for a .env BIND_ADDRESS value that isn't an address; callers add where to fix it. */
export const describeInvalidEnvBindAddress = (bindAddress: string): string => {
  return `BIND_ADDRESS "${bindAddress}" is not an address Docker can publish on — use an IPv4 address such as 127.0.0.1 or 0.0.0.0, or an IPv6 address in brackets such as [::1].`
}

/**
 * The loopback address that reaches a port published on a wildcard address,
 * or on no address, which publishes on every IPv4 and IPv6 address. A port
 * published on any other address answers only on that address.
 */
const LOOPBACK_FOR_WILDCARD: ReadonlyMap<string, string> = new Map([
  ["", "127.0.0.1"],
  ["0.0.0.0", "127.0.0.1"],
  ["[::]", "[::1]"],
])

/** The URL this machine polls for the server's health, given where Docker published the port. */
export const hostHealthUrl = (params: { bindAddress: string; port: number }): string => {
  const { bindAddress, port } = params
  const healthHost = LOOPBACK_FOR_WILDCARD.get(bindAddress) ?? bindAddress

  return `http://${healthHost}:${port}/healthz`
}

/**
 * Bind addresses whose port still answers on this machine's loopback address:
 * no address and the wildcard addresses, which publish on loopback as well,
 * plus the loopback addresses the health poll reaches them on.
 */
const BIND_ADDRESSES_ANSWERING_ON_LOOPBACK: ReadonlySet<string> = new Set([
  ...LOOPBACK_FOR_WILDCARD.keys(),
  ...LOOPBACK_FOR_WILDCARD.values(),
])

/** PUBLIC_URL hosts that name this machine's loopback address. */
const LOOPBACK_PUBLIC_URL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Warns when BIND_ADDRESS publishes the port on one network address while
 * PUBLIC_URL still names loopback, where the port no longer answers. Returns
 * undefined when there is nothing to warn about. Pass a PUBLIC_URL that
 * validatePublicUrl accepted.
 */
export const describeStrandedLoopbackPublicUrl = (params: {
  targetDir: string
  port: number
  bindAddress: string
  publicUrl: string
}): string | undefined => {
  const { targetDir, port, bindAddress, publicUrl } = params
  // A URL that does not parse names no host, so it gets no warning.
  const publicUrlHost = URL.parse(publicUrl)?.hostname
  const publicUrlNamesLoopback = Boolean(
    publicUrlHost && LOOPBACK_PUBLIC_URL_HOSTS.has(publicUrlHost),
  )

  if (BIND_ADDRESSES_ANSWERING_ON_LOOPBACK.has(bindAddress) || !publicUrlNamesLoopback) {
    return undefined
  }
  return (
    `BIND_ADDRESS publishes the port on ${bindAddress} only, so PUBLIC_URL (${publicUrl}) no longer reaches the server — ` +
    `set PUBLIC_URL to the address clients use, such as http://${bindAddress}:${port}, in ${targetDir}/.env.`
  )
}

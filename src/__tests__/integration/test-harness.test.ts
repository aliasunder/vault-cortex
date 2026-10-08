import { createConnection } from "node:net"

import { describe, expect, it, onTestFinished } from "vitest"

import { freePort, startServer } from "./test-harness.js"

/** Resolves true when a TCP connection to the port succeeds and false when
 *  the port refuses it; any other socket error rejects. */
const acceptsConnections = (port: number): Promise<boolean> =>
  new Promise((resolveAccepted, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    socket.once("connect", () => {
      socket.destroy()
      resolveAccepted(true)
    })
    socket.once("error", (connectError) => {
      const refused = "code" in connectError && connectError.code === "ECONNREFUSED"

      if (refused) {
        resolveAccepted(false)
        return
      }
      reject(connectError)
    })
  })

/** Polls until the port refuses connections, giving up at the deadline.
 *  Resolves whether the port was refusing them by then. */
const waitForPortToRefuse = async (port: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await acceptsConnections(port))) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  return false
}

describe("startServer", () => {
  it("stops the server on cleanup, so its port refuses connections", async () => {
    const server = await startServer(await freePort())
    // Registered first so a failed assertion still stops the server; a
    // second cleanup after the one under test finds nothing left to do.
    onTestFinished(() => server.cleanup())

    const acceptedBeforeCleanup = await acceptsConnections(server.port)
    await server.cleanup()
    const refusedAfterCleanup = await waitForPortToRefuse(server.port, 5_000)

    expect({ acceptedBeforeCleanup, refusedAfterCleanup }).toEqual({
      acceptedBeforeCleanup: true,
      refusedAfterCleanup: true,
    })
  }, 45_000)
})

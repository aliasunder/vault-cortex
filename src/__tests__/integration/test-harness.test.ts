import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createConnection } from "node:net"

import { describe, expect, it, onTestFinished } from "vitest"

import { freePort, killChild, startServer, stopChild } from "./test-harness.js"

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

/** Resolves with the first line the child writes to stdout. The listener
 *  keeps the stream flowing, so the child can still close. */
const firstLineFrom = (child: ChildProcess): Promise<string> =>
  new Promise((resolveLine) => {
    // let: chunks append until the first line is complete.
    let output = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const lineEnd = output.indexOf("\n")

      if (lineEnd >= 0) resolveLine(output.slice(0, lineEnd))
    })
  })

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

describe("stopChild", () => {
  it("SIGKILLs a child that ignores SIGTERM and resolves once the child has closed", async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1_000)'],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    onTestFinished(() => {
      child.kill("SIGKILL")
    })
    // let: the close listener sets it.
    let closed = false
    child.once("close", () => {
      closed = true
    })
    // "ready" comes after the SIGTERM handler is installed.
    await firstLineFrom(child)

    await stopChild(child)

    expect({ closed, signalCode: child.signalCode }).toEqual({
      closed: true,
      signalCode: "SIGKILL",
    })
  }, 10_000)
})

describe("killChild", () => {
  it("stops waiting for a close that never comes 2 s after SIGKILL", async () => {
    // The background sleep inherits the stdout pipe and outlives the shell, so
    // the shell's process never closes.
    const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    onTestFinished(() => {
      child.kill("SIGKILL")
    })
    const sleepPid = Number(await firstLineFrom(child))
    onTestFinished(() => {
      process.kill(sleepPid, "SIGKILL")
    })
    // let: the close listener sets it.
    let closed = false
    child.once("close", () => {
      closed = true
    })

    await killChild(child)

    expect({ closed, signalCode: child.signalCode }).toEqual({
      closed: false,
      signalCode: "SIGKILL",
    })
  }, 10_000)
})

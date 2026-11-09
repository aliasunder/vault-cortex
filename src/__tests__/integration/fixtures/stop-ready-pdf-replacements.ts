import childProcess, { type ChildProcess } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"

const spawn = childProcess.spawn
// The first child warms the server; replacements must remain stopped until their deadline.
let pdfChildrenStarted = 0
childProcess.spawn = new Proxy(spawn, {
  apply: (target, _receiver: unknown, args: Parameters<typeof spawn>): ChildProcess => {
    const child = target(...args)
    const commandArgs = args[1]

    if (!Array.isArray(commandArgs)) return child
    if (!commandArgs.some((argument) => argument.includes("pdf-extraction-child"))) return child
    pdfChildrenStarted += 1
    if (pdfChildrenStarted === 1 || pdfChildrenStarted > 4) return child

    // This listener precedes the extractor's listener, so no extraction can run before SIGSTOP.
    child.once("message", (message: unknown) => {
      if (typeof message !== "object" || !message || !("kind" in message)) return
      if (message.kind === "ready") child.kill("SIGSTOP")
    })
    return child
  },
})
syncBuiltinESMExports()

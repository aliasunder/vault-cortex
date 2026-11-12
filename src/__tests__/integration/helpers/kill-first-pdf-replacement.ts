import childProcess, { type ChildProcess } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"

const spawn = childProcess.spawn
// The first child warms the server; its first replacement dies before it can report ready, so
// the extractor reports a start failure. Later replacements run normally for recovery.
let pdfChildrenStarted = 0
childProcess.spawn = new Proxy(spawn, {
  apply: (target, _receiver: unknown, args: Parameters<typeof spawn>): ChildProcess => {
    const child = target(...args)
    const commandArgs = args[1]

    if (!Array.isArray(commandArgs)) return child
    if (!commandArgs.some((argument) => argument.includes("pdf-extraction-child"))) return child
    pdfChildrenStarted += 1
    if (pdfChildrenStarted === 2) child.kill("SIGKILL")
    return child
  },
})
// The server imports spawn as an ESM named binding, which only this call re-points at the
// replacement; without it the second child starts normally and the test's read succeeds.
syncBuiltinESMExports()

#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  minimumNodeVersion,
  nodeVersionRefusalMessage,
  satisfiesMinimum,
} from "./node-version.js"

const pkg: { version: string; engines: { node: string } } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
)
const { version, engines } = pkg

// npm only warns (EBADENGINE) on an engines mismatch but runs the CLI anyway,
// which would surface as a cryptic crash inside a dependency. Fail with a
// clear message instead — and only import dependency-laden code after the
// check passes.
const requiredNodeVersion = minimumNodeVersion(engines.node)
if (!satisfiesMinimum(process.versions.node, requiredNodeVersion)) {
  console.error(
    nodeVersionRefusalMessage({
      minimum: requiredNodeVersion,
      current: process.versions.node,
    }),
  )
  process.exit(1)
}

const { run } = await import("./main.js")
await run(version)

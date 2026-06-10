#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { minimumNodeVersion, satisfiesMinimum } from "./node-version.js"

const { version, engines } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string; engines: { node: string } }

// npm only warns (EBADENGINE) on an engines mismatch but runs the CLI anyway,
// which would surface as a cryptic crash inside a dependency. Fail with a
// clear message instead — and only import dependency-laden code after the
// check passes.
const requiredNodeVersion = minimumNodeVersion(engines.node)
if (!satisfiesMinimum(process.versions.node, requiredNodeVersion)) {
  console.error(
    `vault-cortex requires Node.js >= ${requiredNodeVersion} (you have ${process.versions.node}).\n` +
      `Upgrade at https://nodejs.org — or use the no-Node manual setup:\n` +
      `https://github.com/aliasunder/vault-cortex/blob/main/deploy/local/README.md`,
  )
  process.exit(1)
}

const { run } = await import("./main.js")
await run(version)

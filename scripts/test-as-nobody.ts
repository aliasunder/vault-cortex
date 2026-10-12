/**
 * Runs vitest as `nobody` from a root shell, so the tests that skip as root
 * (they deny file access, which root ignores) run too. Extra arguments go to
 * `vitest run`: `npm run test:as-nobody -- src/utils`.
 */

import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const readNobodyId = (flag: "-u" | "-g"): string =>
  execFileSync("id", [flag, "nobody"], { encoding: "utf8" }).trim()
const uid = readNobodyId("-u")
const gid = readNobodyId("-g")
const nodeModules = join(process.cwd(), "node_modules")
const testHome = join(nodeModules, ".test-home")

// nobody writes only vite's config bundle, vitest's results cache, and its HOME.
const writableFolders = [".vite-temp", ".vite/vitest", ".test-home"].map((folder) =>
  join(nodeModules, folder),
)
for (const folder of writableFolders) mkdirSync(folder, { recursive: true })
execFileSync("chown", ["-R", `${uid}:${gid}`, ...writableFolders])

// Root's Node usually sits under a folder nobody can't enter, such as /root/.nvm.
const nodeFolder = join(nodeModules, ".nobody-node", `node-${process.version}`)
const nodePath = join(nodeFolder, "node")

if (!existsSync(nodePath)) {
  mkdirSync(nodeFolder, { recursive: true })
  copyFileSync(process.execPath, nodePath)
  chmodSync(nodePath, 0o755)
}

const switchToNobody = [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "/usr/bin/env"]
// nobody may be unable to read root's CA bundle, and Node then warns on every start.
const environment = ["-u", "NODE_EXTRA_CA_CERTS", `HOME=${testHome}`]
const path = `PATH=${nodeFolder}:${process.env.PATH ?? ""}`
const vitest = [
  nodePath,
  join(nodeModules, "vitest", "vitest.mjs"),
  "run",
  ...process.argv.slice(2),
]
const run = spawnSync("setpriv", [...switchToNobody, ...environment, path, ...vitest], {
  stdio: "inherit",
})

if (run.error) throw run.error
process.exit(run.status ?? 1)

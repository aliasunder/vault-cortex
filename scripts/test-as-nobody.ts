/**
 * Runs vitest as `nobody` from a root shell, so the tests that skip as root
 * (they deny file access, which root ignores) run too. Extra arguments go to
 * `vitest run`: `npm run test:as-nobody -- src/utils`.
 */

import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { join } from "node:path"

const readNobodyId = (flag: "-u" | "-g"): string =>
  execFileSync("id", [flag, "nobody"], { encoding: "utf8" }).trim()
const [uid, gid] = (["-u", "-g"] as const).map(readNobodyId)
const nodeModules = join(process.cwd(), "node_modules")
const testHome = join(nodeModules, ".test-home")

// nobody writes only vite's config bundle, vitest's results cache, and its HOME.
const writableFolders = [".vite-temp", ".vite/vitest", ".test-home"].map((folder) =>
  join(nodeModules, folder),
)
for (const folder of writableFolders) mkdirSync(folder, { recursive: true })
execFileSync("chown", ["-R", `${uid}:${gid}`, ...writableFolders])

// Root's Node usually sits where nobody can't enter, such as /root/.nvm.
const nodeFolder = join(nodeModules, ".nobody-node", `node-${process.version}`)
const nodePath = join(nodeFolder, "node")

if (!existsSync(nodePath)) {
  mkdirSync(nodeFolder, { recursive: true })
  // A temporary name keeps a copy cut short (a full disk) from being reused.
  copyFileSync(process.execPath, `${nodePath}.partial`)
  chmodSync(`${nodePath}.partial`, 0o755)
  renameSync(`${nodePath}.partial`, nodePath)
}

const asNobody = [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "/usr/bin/env"]
// nobody may be unable to read root's CA bundle, and Node then warns on every start.
const nobodyEnv = ["-u", "NODE_EXTRA_CA_CERTS", `HOME=${testHome}`]
const path = `PATH=${nodeFolder}:${process.env.PATH ?? ""}`
const vitestEntry = join(nodeModules, "vitest", "vitest.mjs")
const vitest = [nodePath, vitestEntry, "run", ...process.argv.slice(2)]
const run = spawnSync("setpriv", [...asNobody, ...nobodyEnv, path, ...vitest], {
  stdio: "inherit",
})

if (run.error) throw run.error
process.exit(run.status ?? 1)

import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it, onTestFinished } from "vitest"

const SYNC_SCRIPT = resolve("scripts/sync-cli-env-blocks.ts")
const TSX_CLI = resolve("node_modules/tsx/dist/cli.mjs")

/** The header the script puts above each block, written out here so a change to it shows. */
const EXPECTED_HEADER = `# Optional ──────────────────────────────────────────────────
# To change a setting: run "npx vault-cortex@latest configure --dir
# <this folder>", or edit its value here (uncommenting it first if
# needed) and apply with "npx vault-cortex@latest restart --dir
# <this folder>" (plain docker restart does not re-read this file).

`

/**
 * Builds a throwaway repository with the script, both .env.example files
 * and a templates file holding the sync markers, so a run touches no real file.
 */
const makeRepoCopy = (sections: { local: string; remote: string }): string => {
  const repoDir = mkdtempSync(join(tmpdir(), "vault-cortex-sync-env-blocks-"))
  onTestFinished(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })
  mkdirSync(join(repoDir, "scripts"))
  copyFileSync(SYNC_SCRIPT, join(repoDir, "scripts", "sync-cli-env-blocks.ts"))

  for (const mode of ["local", "remote"] as const) {
    mkdirSync(join(repoDir, "deploy", mode), { recursive: true })
    writeFileSync(
      join(repoDir, "deploy", mode, ".env.example"),
      `MCP_AUTH_TOKEN=\n\n# Optional ─────\n${sections[mode]}`,
    )
  }
  mkdirSync(join(repoDir, "cli", "src", "rules"), { recursive: true })
  writeFileSync(
    join(repoDir, "cli", "src", "rules", "env-templates.ts"),
    [
      "// sync:local-optional:begin",
      "// sync:local-optional:end",
      "// sync:remote-optional:begin",
      "// sync:remote-optional:end",
      "export { LOCAL_OPTIONAL_BLOCK, REMOTE_OPTIONAL_BLOCK }",
      "",
    ].join("\n"),
  )
  return repoDir
}

describe("sync-cli-env-blocks script", () => {
  it("embeds backslashes, backticks and ${ from .env.example exactly as written", async () => {
    const localSection = "# A Windows path: C:\\Users\\me\\Vault\n# Run `npx` with ${HOME} set.\n"
    const remoteSection = "# REMOTE_SETTING=1\n"
    const repoDir = makeRepoCopy({ local: localSection, remote: remoteSection })

    const run = spawnSync(
      process.execPath,
      [TSX_CLI, join(repoDir, "scripts", "sync-cli-env-blocks.ts")],
      { encoding: "utf8" },
    )

    expect(run.status).toBe(0)
    const templates: Record<string, unknown> = await import(
      pathToFileURL(join(repoDir, "cli", "src", "rules", "env-templates.ts")).href
    )
    // The spread drops the module object's own tag, leaving only its exports.
    expect({ ...templates }).toEqual({
      LOCAL_OPTIONAL_BLOCK: `${EXPECTED_HEADER}${localSection}`,
      REMOTE_OPTIONAL_BLOCK: `${EXPECTED_HEADER}${remoteSection}`,
    })
  })
})

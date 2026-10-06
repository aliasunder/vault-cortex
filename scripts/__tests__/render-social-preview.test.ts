import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Builds a temp layout where a copy of the script runs against inputs the test controls:
 * - The script reads assets/ from the folder above scripts/, so the copy sits in `<layout>/scripts/`.
 * - The linked node_modules lets the copy import puppeteer.
 * - The layout path is resolved with realpath because the script prints paths
 *   from Node's resolved entry path, and macOS's temp folder is a symlink.
 */
const createScriptLayout = (): string => {
  const layoutDirectory = realpathSync(
    mkdtempSync(join(tmpdir(), "vault-cortex-render-social-preview-")),
  )
  onTestFinished(() => rmSync(layoutDirectory, { recursive: true, force: true }))

  mkdirSync(join(layoutDirectory, "scripts"))
  mkdirSync(join(layoutDirectory, "assets", "fonts"), { recursive: true })
  copyFileSync(
    resolve("scripts/render-social-preview.ts"),
    join(layoutDirectory, "scripts", "render-social-preview.ts"),
  )
  symlinkSync(resolve("node_modules"), join(layoutDirectory, "node_modules"))
  return layoutDirectory
}

const runRenderScript = (layoutDirectory: string): SpawnSyncReturns<string> => {
  return spawnSync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      join(layoutDirectory, "scripts", "render-social-preview.ts"),
    ],
    { encoding: "utf8" },
  )
}

describe("render-social-preview script", () => {
  // Both cases expect empty stdout: the script prints "launching Chrome for
  // Testing..." after its input checks, so empty stdout shows it stopped before
  // launching a browser.
  it("exits 1 naming the SVG path when the SVG is missing", () => {
    const layoutDirectory = createScriptLayout()

    const { status, stdout, stderr } = runRenderScript(layoutDirectory)

    expect({ status, stdout, stderr }).toEqual({
      status: 1,
      stdout: "",
      stderr: `✕  ${join(layoutDirectory, "assets", "social-preview.svg")} not found\n`,
    })
  })

  it("exits 1 naming the font path and its download source when the font is missing", () => {
    const layoutDirectory = createScriptLayout()
    writeFileSync(join(layoutDirectory, "assets", "social-preview.svg"), "<svg/>")

    const { status, stdout, stderr } = runRenderScript(layoutDirectory)

    expect({ status, stdout, stderr }).toEqual({
      status: 1,
      stdout: "",
      stderr:
        `✕  ${join(layoutDirectory, "assets", "fonts", "DejaVuSans.ttf")} not found\n` +
        "   download it from https://dejavu-fonts.github.io and save it at that path\n",
    })
  })
})

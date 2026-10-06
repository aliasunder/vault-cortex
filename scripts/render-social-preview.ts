// Renders assets/social-preview.svg to assets/social-preview.png.
//
// - Run it with `npm run render:social-preview`, which first runs
//   `puppeteer browsers install chrome`. Running this file directly fails
//   until that install has cached the browser.
// - The browser is Puppeteer's pinned Chrome for Testing build, about 350MB on
//   the first install. `npm ci` skips that download (the
//   `puppeteer.skipDownload` key in package.json) because Puppeteer's install
//   step unpacks a zip archive, which fails where no zip archiver exists, such
//   as slim Docker images and MCP registries that build from source.
// - DejaVu Sans is embedded via @font-face, so text renders the same whatever
//   fonts the host has.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import puppeteer from "puppeteer"

const repoRoot = new URL("..", import.meta.url)

const resolvePath = (repoRelative: string): string => fileURLToPath(new URL(repoRelative, repoRoot))

// GitHub's recommended social preview size is 1280×640, and
// assets/social-preview.svg declares the same width and height. An SVG of any
// other size would be cropped or leave blank space.
const WIDTH = 1280
const HEIGHT = 640

const commandAvailable = (command: string): boolean => {
  try {
    execFileSync("which", [command], { stdio: "pipe" })
    return true
  } catch {
    // `which` exits non-zero when the command is not on PATH; the caller warns.
    return false
  }
}

const optimizePng = (pngPath: string): void => {
  if (!commandAvailable("optipng")) {
    console.warn(
      "⚠  optipng not found — PNG saved without optimization\n" +
        "   install via: brew bundle (macOS, reads the repo's Brewfile) or apt-get install optipng (Linux)",
    )
    return
  }

  console.log("optimizing with optipng...")

  try {
    // -o7 is optipng's most thorough lossless level; -strip all drops metadata chunks.
    execFileSync("optipng", ["-o7", "-strip", "all", pngPath], {
      stdio: "inherit",
    })
  } catch {
    console.warn("⚠  optipng failed — PNG saved without optimization")
  }
}

const renderSocialPreview = async (): Promise<void> => {
  // A globally set PUPPETEER_EXECUTABLE_PATH would launch that browser instead
  // of the pinned build, so the render could differ from machine to machine.
  delete process.env.PUPPETEER_EXECUTABLE_PATH

  const svgPath = resolvePath("assets/social-preview.svg")
  const fontPath = resolvePath("assets/fonts/DejaVuSans.ttf")
  const outputPath = resolvePath("assets/social-preview.png")

  if (!existsSync(svgPath)) {
    throw new Error(`${svgPath} not found`)
  }

  if (!existsSync(fontPath)) {
    throw new Error(
      `${fontPath} not found\n` +
        "   download it from https://dejavu-fonts.github.io and save it at that path",
    )
  }

  const svgContent = readFileSync(svgPath, "utf-8")
  const fontBase64 = readFileSync(fontPath).toString("base64")

  // The SVG markup is inlined into the page, because Chrome garbles non-ASCII
  // text (· renders as Â·) when the SVG is loaded as an image from a blob URL
  // and drawn onto a canvas.
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
<style>
  @font-face {
    font-family: "DejaVu Sans";
    src: url("data:font/ttf;base64,${fontBase64}") format("truetype");
    font-weight: normal;
    font-style: normal;
  }
  * { margin: 0; padding: 0; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    overflow: hidden;
  }
</style>
</head>
<body>${svgContent}</body>
</html>`

  console.log("launching Chrome for Testing...")
  const browser = await puppeteer.launch({ headless: true })

  try {
    const page = await browser.newPage()
    await page.setViewport({
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
    })
    await page.setContent(htmlContent, { waitUntil: "load" })

    // Wait for the embedded @font-face to finish loading before screenshotting
    await page.waitForFunction("document.fonts.status === 'loaded'")

    const screenshotBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    })

    writeFileSync(outputPath, screenshotBuffer)
    console.log("✓  rendered social-preview.png")
  } finally {
    await browser.close()
  }

  optimizePng(outputPath)

  const outputBytes = statSync(outputPath).size
  console.log(`✓  social-preview.png (${outputBytes.toLocaleString()} bytes)`)
}

renderSocialPreview().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`✕  ${message}`)
  process.exit(1)
})

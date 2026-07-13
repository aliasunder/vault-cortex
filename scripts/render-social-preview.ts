// Renders assets/social-preview.svg to assets/social-preview.png using Puppeteer's
// bundled Chromium. Embeds DejaVu Sans via @font-face for deterministic text
// rendering regardless of host system fonts.
//
// Usage: npm run render:social-preview

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import puppeteer from "puppeteer"

const repoRoot = new URL("..", import.meta.url)

const resolvePath = (repoRelative: string): string =>
  fileURLToPath(new URL(repoRelative, repoRoot))

const WIDTH = 1280
const HEIGHT = 640

const commandAvailable = (command: string): boolean => {
  try {
    execFileSync("which", [command], { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

const optimizePng = (pngPath: string): void => {
  if (commandAvailable("optipng")) {
    console.log("optimizing with optipng...")
    execFileSync("optipng", ["-o7", "-strip", "all", pngPath], {
      stdio: "inherit",
    })
    return
  }

  console.warn(
    "⚠  optipng not found — PNG saved without optimization\n" +
      "   install via: brew bundle (macOS) or apt-get install optipng (Linux)",
  )
}

const renderSocialPreview = async (): Promise<void> => {
  // Clear env vars that override Puppeteer's bundled browser resolution
  // (some systems set PUPPETEER_EXECUTABLE_PATH or PUPPETEER_SKIP_DOWNLOAD globally)
  delete process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD
  delete process.env.PUPPETEER_SKIP_DOWNLOAD
  delete process.env.PUPPETEER_EXECUTABLE_PATH

  const svgPath = resolvePath("assets/social-preview.svg")
  const fontPath = resolvePath("assets/fonts/DejaVuSans.ttf")
  const outputPath = resolvePath("assets/social-preview.png")

  if (!existsSync(svgPath)) {
    console.error("✕  assets/social-preview.svg not found")
    process.exit(1)
  }

  if (!existsSync(fontPath)) {
    console.error(
      "✕  assets/fonts/DejaVuSans.ttf not found\n" +
        "   download from https://dejavu-fonts.github.io and place in assets/fonts/",
    )
    process.exit(1)
  }

  const svgContent = readFileSync(svgPath, "utf-8")
  const fontBase64 = readFileSync(fontPath).toString("base64")

  // HTML with embedded @font-face ensures DejaVu Sans is available regardless
  // of host system fonts. The SVG is inlined directly (no blob URL) to avoid
  // Chrome's canvas UTF-8 encoding bug with non-ASCII characters like · (U+00B7).
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

  console.log("launching Chromium...")
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
    await page.evaluate("document.fonts.ready")

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

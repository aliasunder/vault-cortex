/**
 * Puppeteer install-time configuration, read by its postinstall script and CLI.
 * Must be CommonJS — the postinstall runs in plain Node with no TS/ESM loader.
 *
 * Skips the Chrome download during `npm ci` so installs succeed in minimal
 * environments without a zip archiver (slim Docker images, registry build
 * sandboxes). Puppeteer is only used by `npm run render:social-preview`,
 * which installs the pinned Chrome for Testing build on demand via
 * `puppeteer browsers install chrome` before rendering.
 *
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  skipDownload: true,
}

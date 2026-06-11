// Copies the canonical deploy/ compose files into cli/templates/ so the
// published npm package ships them. cli/src/templates.test.ts fails CI when
// the copies drift; this script is the one-command fix.
//
// Usage: npm run sync:cli-templates

import { copyFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const repoRoot = new URL("..", import.meta.url)

const templateSources = [
  {
    from: "deploy/local/docker-compose.yml",
    to: "cli/templates/local/docker-compose.yml",
  },
  {
    from: "deploy/remote/docker-compose.yml",
    to: "cli/templates/remote/docker-compose.yml",
  },
]

for (const { from, to } of templateSources) {
  copyFileSync(
    fileURLToPath(new URL(from, repoRoot)),
    fileURLToPath(new URL(to, repoRoot)),
  )
  console.log(`synced ${from} -> ${to}`)
}

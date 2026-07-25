// Regenerates lhm.plugin.json — the manifest `lhm plugin publish` reads when
// updating the LobeHub Marketplace listing
// (lobehub.com/mcp/aliasunder-vault-cortex).
//
// scripts/__tests__/lobehub-manifest.test.ts fails CI when the committed
// manifest drifts from the server; this script is the one-command fix.
//
// Usage: npm run sync:lobehub-manifest
//        npm run publish:lobehub   (sync, then publish — needs `lhm login`)
//
// publish:lobehub pins @lobehub/market-cli to an exact version: the publisher
// runs with a logged-in marketplace credential, and the CLI is pre-1.0, so an
// unpinned `npx` would hand that credential to whatever `latest` resolves to
// on the day. Bump the pin deliberately, the way the workflows pin actions.

import { writeFileSync } from "node:fs"
import {
  buildLobehubManifest,
  serializeLobehubManifest,
  LOBEHUB_MANIFEST_PATH,
  LOBEHUB_IDENTIFIER,
} from "./lobehub-manifest.js"

const manifest = await buildLobehubManifest()
writeFileSync(LOBEHUB_MANIFEST_PATH, serializeLobehubManifest(manifest))

console.log(
  `Wrote lhm.plugin.json — ${LOBEHUB_IDENTIFIER} v${manifest.version} (${manifest.tools.length} tools, ${manifest.prompts.length} prompts)`,
)

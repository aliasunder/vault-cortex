import { extname } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The URL of the module `name` in the same folder as `besideModule`, with
 * `besideModule`'s extension:
 * - Compiled `dist` runs `.js` files, while `tsx` (the dev server, the
 *   integration harness, scripts) and vitest run the `.ts` sources, so a worker
 *   or child entry takes the extension of the module that starts it.
 * - A `.ts` entry needs a TypeScript loader. A worker thread inherits the
 *   parent's `--import tsx`, which vitest's config also passes; a child process
 *   gets it only when its starter passes `process.execArgv` on.
 */
export const siblingModuleUrl = (params: { name: string; besideModule: string }): URL => {
  const { name, besideModule } = params

  return new URL(`./${name}${extname(fileURLToPath(besideModule))}`, besideModule)
}

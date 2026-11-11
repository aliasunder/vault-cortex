import type { SearchIndex } from "../../../search/search-index.js"

/** Runs the work at once, as an idle search index does */
const runForegroundWorkNow: SearchIndex["trackForegroundWork"] = (work) => work()

/** A search index for handler tests that stub only the methods they call.
 *  Every tool and prompt handler runs inside trackForegroundWork, so the stub
 *  always carries it. */
export const stubSearchIndex = (methods: Partial<SearchIndex> = {}): SearchIndex => {
  return { trackForegroundWork: runForegroundWorkNow, ...methods } as SearchIndex
}

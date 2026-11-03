import { hasTagCandidate, parseBodyTags } from "../../obsidian-markdown/body-tags.js"
import { splitPropertiesBlock } from "../../obsidian-markdown/frontmatter.js"
import type { BodyTagParser } from "../body-tag-parser.js"

/** A note's body tags, parsed on the calling thread. Index tests use this in
 *  place of the worker, which only the parser factory's tests exercise. */
const parseBodyTagsInProcess = (rawContent: string): string[] => {
  return parseBodyTags(splitPropertiesBlock(rawContent).body)
}

/** upsertNote params with the body tags production would pass for the same content. */
export const withBodyTags = <Params extends { rawContent: string }>(
  params: Params,
): Params & { bodyTags: string[] } => {
  return { ...params, bodyTags: parseBodyTagsInProcess(params.rawContent) }
}

/** A BodyTagParser that parses on the calling thread, for rebuild and watcher
 *  tests that do not exercise the worker. Like the real one, it answers a body
 *  with no tag candidate without parsing. */
export const inProcessBodyTagParser: BodyTagParser = {
  parse: async ({ body }) => {
    if (!hasTagCandidate(body)) return { outcome: "no-candidate" }
    return { outcome: "parsed", tags: parseBodyTags(body) }
  },
  close: async () => undefined,
}

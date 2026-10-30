// ── Body tags, read the way Obsidian's Tags view reads them ────────────────

import { parseObsidianMarkdown } from "./obsidian-remark-parser.js"
import type { ParsedNode } from "./remark-parse-types.js"
import { isObsidianTagName, TAG_NAME_CHARACTER_CLASS } from "./tags.js"

/** Matches what every body tag starts with: `#` and one tag-name character. */
const TAG_CANDIDATE_RE = new RegExp(`#${TAG_NAME_CHARACTER_CLASS}`)

/** True when the body holds a `#` followed by a tag-name character. Every
 *  body tag starts that way, so a body without one has no tags and need not
 *  be parsed. */
export const hasTagCandidate = (body: string): boolean => TAG_CANDIDATE_RE.test(body)

/** The raw tag names in the tree, in the order Obsidian's metadata lists
 *  them: document order, except that an inline footnote's tags come after
 *  every tag outside one. A footnote nested in a footnote keeps its place. */
const collectRawTagNames = (root: ParsedNode): string[] => {
  const rawNames: string[] = []
  const deferredFootnotes: ParsedNode[] = []

  // Both walks fill the arrays above in visiting order, so they mutate them
  const walk = (node: ParsedNode, deferFootnotes: boolean): void => {
    if (node.type === "tag" && node.value) {
      rawNames.push(node.value)
      return
    }

    if (node.type === "inlineFootnote" && deferFootnotes) {
      deferredFootnotes.push(node)
      return
    }

    for (const child of node.children ?? []) walk(child, deferFootnotes)
  }

  walk(root, true)

  for (const footnote of deferredFootnotes) {
    for (const child of footnote.children ?? []) walk(child, false)
  }

  return rawNames
}

/** The name the Tags view lists for a raw tag name: one trailing `/` removed. */
const stripOneTrailingSlash = (rawName: string): string =>
  rawName.endsWith("/") ? rawName.slice(0, -1) : rawName

/**
 * The tags Obsidian's Tags view lists for a note's body, as bare names, one
 * per occurrence, in the order Obsidian's metadata lists them. Reproduces
 * Obsidian 1.14.4's body-tag parsing followed by `getTags`'s name test:
 * - a `#tag` counts at the start of a block's inline content, after
 *   whitespace or right after another inline token (`**b**#tag`), never
 *   after plain text (`foo#bar`);
 * - code, HTML, math, wikilinks, link destinations and URLs are skipped,
 *   while `%% %%` comments, link text and footnotes are read;
 * - one trailing `/` is removed, and a name left empty or made of digits
 *   only is dropped.
 * The frontmatter must already be split off; pass the body alone.
 */
export const parseBodyTags = (body: string): string[] => {
  if (!hasTagCandidate(body)) return []

  const rawNames = collectRawTagNames(parseObsidianMarkdown(body))

  return rawNames.map(stripOneTrailingSlash).filter(isObsidianTagName)
}

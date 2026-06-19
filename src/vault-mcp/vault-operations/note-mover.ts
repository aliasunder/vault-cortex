/** Moving and renaming notes — relocates a .md file and rewrites every link
 *  across the vault that resolves to it, mirroring Obsidian's built-in rename.
 *
 *  Link resolution and link syntax are reused from search-index.ts (resolveLink
 *  plus the WIKILINK/MD/FENCE/INLINE-code regexes) so the rewriter can never
 *  disagree with the indexer about what a link is or where it points. The
 *  rewrite is form-preserving and minimal-churn: a link's text changes only
 *  when leaving it as-is would no longer resolve to the right note — exactly
 *  what Obsidian does (a bare [[Foo]] survives a folder move when its short
 *  name is still unambiguous). */

import { readFile, mkdir, unlink, stat } from "node:fs/promises"
import { posix } from "node:path"
import { parseNote, stringifyNote } from "./frontmatter.js"
import { resolveSafePath, atomicWriteFile } from "./vault-filesystem.js"
import {
  resolveLink,
  WIKILINK_RE,
  MD_LINK_RE,
  FENCE_OPEN,
  INLINE_CODE_RE,
} from "../search/search-index.js"
import type { Logger } from "../../logger.js"

// ── Types ───────────────────────────────────────────────────────

/** Structured summary of a completed move. */
export type MoveResult = {
  /** Vault-relative destination path the note now lives at. */
  moved_to: string
  /** Total number of individual link occurrences rewritten across all notes
   *  (backlink sources plus the moved note's own relative links). */
  links_updated: number
  /** Vault-relative paths of the other notes whose link text was rewritten,
   *  sorted. Excludes the moved note itself (conveyed by moved_to). */
  updated_notes: string[]
}

/** Everything a single link occurrence needs to decide whether — and how — to
 *  rewrite its target. Captured once per note being processed. */
type RewriteContext = {
  /** Path the note is resolved-from before the move (its current location). */
  oldSourcePath: string
  /** Path the note is resolved-from after the move (its destination). Equal to
   *  oldSourcePath for every note except the moved note itself. */
  newSourcePath: string
  /** The moved note's path before the move (with .md). */
  oldTargetPath: string
  /** The moved note's path after the move (with .md). */
  newTargetPath: string
  /** All note paths before the move (includes oldTargetPath). */
  allPaths: string[]
  /** All note paths after the move (oldTargetPath replaced by newTargetPath). */
  allPathsAfter: string[]
}

/** Which of Obsidian's link forms a raw target used to resolve, so the
 *  replacement can be written back in the same style. */
type LinkForm = "basename" | "absolute" | "relative"

// ── Link-text parsers (reconstruction) ──────────────────────────
// The matching regexes are imported from search-index.ts; these split a single
// already-matched link into its parts so the target can be swapped while the
// embed marker, heading anchor, and alias/text are preserved verbatim.

/** Splits one matched wikilink into [, embed `!`, target, `#heading`, `|alias`]. */
const WIKILINK_PARTS = /^(!?)\[\[([^\]#|]+)(#[^\]|]*)?(\|[^\]]+)?\]\]$/

/** Splits one matched markdown link into [, `[text](`, path-without-ext, `#heading`, `)`]. */
const MD_LINK_PARTS = /^(\[[^\]]*\]\()([^)#\s]+?)\.md(#[^)\s]*)?(\))$/

// ── Target classification + construction ────────────────────────

/** Strips a trailing .md so a vault path can be used as a wikilink target. */
const withoutExtension = (path: string): string =>
  path.endsWith(".md") ? path.slice(0, -".md".length) : path

/** Re-derives which resolution branch a raw target took to reach resolvedTarget,
 *  mirroring resolveLink's precedence (exact path, then source-relative, then
 *  basename) so the replacement keeps the author's chosen link style. */
const classifyLinkForm = (params: {
  rawTarget: string
  sourcePath: string
  resolvedTarget: string
}): LinkForm => {
  const { rawTarget, sourcePath, resolvedTarget } = params
  const targetWithExtension = rawTarget.endsWith(".md")
    ? rawTarget
    : `${rawTarget}.md`
  if (targetWithExtension === resolvedTarget) return "absolute"
  if (
    posix.join(posix.dirname(sourcePath), targetWithExtension) ===
    resolvedTarget
  ) {
    return "relative"
  }
  return "basename"
}

/** Builds a new extensionless target string that resolves to desiredTarget from
 *  newSourcePath in the post-move vault, keeping the original link form. Every
 *  candidate is verified with resolveLink and falls back to the always-correct
 *  vault-absolute path if the preferred shorter form would resolve elsewhere
 *  (e.g. a basename that is no longer unique after the move). */
const buildReplacementTarget = (params: {
  form: LinkForm
  desiredTarget: string
  newSourcePath: string
  allPathsAfter: string[]
}): string => {
  const { form, desiredTarget, newSourcePath, allPathsAfter } = params
  const absoluteForm = withoutExtension(desiredTarget)

  const resolvesToDesired = (candidate: string): boolean =>
    resolveLink(candidate, allPathsAfter, newSourcePath) === desiredTarget

  if (form === "basename") {
    const basename = posix.basename(absoluteForm)
    return resolvesToDesired(basename) ? basename : absoluteForm
  }

  if (form === "relative") {
    const relative = posix.relative(posix.dirname(newSourcePath), absoluteForm)
    return resolvesToDesired(relative) ? relative : absoluteForm
  }

  return absoluteForm
}

/** Decides the replacement for one raw link target, or null to leave it as-is.
 *  Returns null when the link is unresolved, points elsewhere and still will, or
 *  already resolves to the right note from the new location (minimal churn). */
const rewriteTarget = (
  rawTarget: string,
  context: RewriteContext,
): string | null => {
  const resolvedBefore = resolveLink(
    rawTarget,
    context.allPaths,
    context.oldSourcePath,
  )
  if (resolvedBefore === null) return null

  // The note this link should still point at once the move settles: the new
  // location if it pointed at the moved note, otherwise its unchanged target.
  const desiredTarget =
    resolvedBefore === context.oldTargetPath
      ? context.newTargetPath
      : resolvedBefore

  // Minimal churn: if the existing text already resolves to the desired note
  // from the new location, leave it untouched (Obsidian-faithful).
  const resolvedAfter = resolveLink(
    rawTarget,
    context.allPathsAfter,
    context.newSourcePath,
  )
  if (resolvedAfter === desiredTarget) return null

  return buildReplacementTarget({
    form: classifyLinkForm({
      rawTarget,
      sourcePath: context.oldSourcePath,
      resolvedTarget: resolvedBefore,
    }),
    desiredTarget,
    newSourcePath: context.newSourcePath,
    allPathsAfter: context.allPathsAfter,
  })
}

// ── Body rewriting ──────────────────────────────────────────────

/** Percent-encodes spaces in a markdown link path (Obsidian's convention);
 *  other characters are left as authored. */
const encodeMarkdownLinkPath = (path: string): string =>
  path.replaceAll(" ", "%20")

type LinkEdit = { start: number; end: number; replacement: string }

/** Rewrites the link targets in a single body line, skipping any link that sits
 *  inside an inline-code span. Returns the new line and how many links changed. */
const rewriteBodyLine = (
  line: string,
  context: RewriteContext,
): { line: string; count: number } => {
  // Inline-code spans are passed through verbatim — a link inside backticks is
  // documentation, not a real edge (matches the indexer's extraction).
  const codeSpans = [...line.matchAll(INLINE_CODE_RE)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  )
  const isInsideCode = (start: number): boolean =>
    codeSpans.some(
      ([spanStart, spanEnd]) => start >= spanStart && start < spanEnd,
    )

  const edits = collectLineEdits(line, context, isInsideCode)
  if (edits.length === 0) return { line, count: 0 }

  // Apply edits left-to-right; wikilink and markdown matches never overlap.
  const orderedEdits = [...edits].sort(
    (left, right) => left.start - right.start,
  )
  const rebuilt = orderedEdits.reduce(
    (acc, edit) => ({
      text: acc.text + line.slice(acc.cursor, edit.start) + edit.replacement,
      cursor: edit.end,
    }),
    { text: "", cursor: 0 },
  )
  return {
    line: rebuilt.text + line.slice(rebuilt.cursor),
    count: edits.length,
  }
}

/** Gathers the (non-code) wikilink and markdown-link edits for one line. */
const collectLineEdits = (
  line: string,
  context: RewriteContext,
  isInsideCode: (start: number) => boolean,
): LinkEdit[] => {
  const editsFor = (
    pattern: RegExp,
    rewrite: (linkText: string) => string | null,
  ): LinkEdit[] =>
    [...line.matchAll(pattern)].reduce<LinkEdit[]>((acc, match) => {
      if (isInsideCode(match.index)) return acc
      const replacement = rewrite(match[0])
      if (replacement === null) return acc
      acc.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement,
      })
      return acc
    }, [])

  return [
    ...editsFor(WIKILINK_RE, (text) => rewriteWikilinkText(text, context)),
    ...editsFor(MD_LINK_RE, (text) => rewriteMarkdownLinkText(text, context)),
  ]
}

/** Rewrites one matched wikilink, preserving the embed marker, heading, and
 *  alias; null when the target needs no change. */
const rewriteWikilinkText = (
  linkText: string,
  context: RewriteContext,
): string | null => {
  const parts = WIKILINK_PARTS.exec(linkText)
  if (!parts) return null
  const [, embedMarker, target, heading = "", alias = ""] = parts
  const newTarget = rewriteTarget(target!.trim(), context)
  if (newTarget === null) return null
  return `${embedMarker}[[${newTarget}${heading}${alias}]]`
}

/** Rewrites one matched markdown link, preserving the link text and heading;
 *  null when the target needs no change. */
const rewriteMarkdownLinkText = (
  linkText: string,
  context: RewriteContext,
): string | null => {
  const parts = MD_LINK_PARTS.exec(linkText)
  if (!parts) return null
  const [, prefix, encodedPath, heading = "", closeParen] = parts
  const decodedTarget = decodeMarkdownLinkPath(encodedPath!)
  const newTarget = rewriteTarget(decodedTarget, context)
  if (newTarget === null) return null
  return `${prefix}${encodeMarkdownLinkPath(newTarget)}.md${heading}${closeParen}`
}

/** Decodes a markdown link path, tolerating malformed percent-encoding. */
const decodeMarkdownLinkPath = (encoded: string): string => {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/** Rewrites every link in a note body, skipping fenced code blocks. Tracks the
 *  open fence with the same state machine the indexer uses. */
const rewriteBody = (
  body: string,
  context: RewriteContext,
): { body: string; count: number } => {
  const lines = body.split("\n")

  // Mutable parser state: the active fence opener (null outside any fence). A
  // line-by-line state machine has no clean immutable form without pairing each
  // line with its running state — the indexer's extractLinks uses the same shape.
  let currentFenceOpener: string | null = null

  const rewritten = lines.reduce<{ outputLines: string[]; count: number }>(
    (acc, line) => {
      const fenceMatch = FENCE_OPEN.exec(line)
      if (fenceMatch) {
        const fenceChars = fenceMatch[1]!
        if (currentFenceOpener === null) {
          currentFenceOpener = fenceChars[0]!.repeat(fenceChars.length)
        } else if (
          fenceChars[0] === currentFenceOpener[0] &&
          fenceChars.length >= currentFenceOpener.length &&
          line.trim() === fenceChars[0]!.repeat(line.trim().length)
        ) {
          currentFenceOpener = null
        }
        acc.outputLines.push(line)
        return acc
      }
      if (currentFenceOpener !== null) {
        acc.outputLines.push(line)
        return acc
      }
      const result = rewriteBodyLine(line, context)
      acc.outputLines.push(result.line)
      acc.count += result.count
      return acc
    },
    { outputLines: [], count: 0 },
  )

  return { body: rewritten.outputLines.join("\n"), count: rewritten.count }
}

// ── Frontmatter rewriting ───────────────────────────────────────

/** Rewrites the wikilinks inside one frontmatter value (string, array, or
 *  nested object), recursing into containers. Markdown links are a body
 *  convention and are intentionally left untouched, matching the indexer. */
const rewriteFrontmatterValue = (
  value: unknown,
  context: RewriteContext,
): { value: unknown; count: number } => {
  if (typeof value === "string") {
    // Mutable counter: replaceAll's callback is the only place a per-match tally
    // can be kept without scanning the string a second time.
    let count = 0
    const rewritten = value.replaceAll(WIKILINK_RE, (linkText) => {
      const replacement = rewriteWikilinkText(linkText, context)
      if (replacement === null) return linkText
      count += 1
      return replacement
    })
    return { value: rewritten, count }
  }

  if (Array.isArray(value)) {
    return value.reduce<{ value: unknown[]; count: number }>(
      (acc, item) => {
        const result = rewriteFrontmatterValue(item, context)
        acc.value.push(result.value)
        acc.count += result.count
        return acc
      },
      { value: [], count: 0 },
    )
  }

  if (value !== null && typeof value === "object") {
    return Object.entries(value).reduce<{
      value: Record<string, unknown>
      count: number
    }>(
      (acc, [key, nestedValue]) => {
        const result = rewriteFrontmatterValue(nestedValue, context)
        acc.value[key] = result.value
        acc.count += result.count
        return acc
      },
      { value: {}, count: 0 },
    )
  }

  return { value, count: 0 }
}

// ── Whole-note rewriting ────────────────────────────────────────

/** Rewrites all links (body + frontmatter) in a note's raw content. Returns the
 *  serialized note only when something changed, so callers can skip no-op writes. */
const rewriteNoteContent = (
  rawContent: string,
  context: RewriteContext,
): { content: string; count: number } | null => {
  const parsed = parseNote(rawContent)
  const frontmatter = parsed.data as Record<string, unknown>

  const bodyResult = rewriteBody(parsed.content, context)
  const frontmatterResult = rewriteFrontmatterValue(frontmatter, context)
  const count = bodyResult.count + frontmatterResult.count
  if (count === 0) return null

  const content = stringifyNote(
    bodyResult.body,
    frontmatterResult.value as Record<string, unknown>,
  )
  return { content, count }
}

// ── Orchestration ───────────────────────────────────────────────

/** True when path sits under one of the protected folders (memory, daily notes). */
const isProtected = (
  path: string,
  protectedPaths: readonly string[],
): boolean =>
  protectedPaths
    .map((folder) => (folder.endsWith("/") ? folder : `${folder}/`))
    .some((prefix) => path.startsWith(prefix))

/** Resolves true if a file exists at the resolved vault path. */
const fileExists = async (fullPath: string): Promise<boolean> => {
  try {
    await stat(fullPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}

/** Moves a note and rewrites every link across the vault that resolves to it.
 *
 *  backlinkSources is the set of notes that currently link to oldPath (supplied
 *  by the caller from the search index); allPaths is every note path before the
 *  move. The move is performed as: write the rewritten note to newPath, rewrite
 *  each backlink source, then delete oldPath last — so a mid-operation failure
 *  never strands a broken link (the original note stays in place until the end). */
const moveNote = async (
  params: {
    vaultPath: string
    oldPath: string
    newPath: string
    protectedPaths: readonly string[]
    backlinkSources: readonly string[]
    allPaths: readonly string[]
  },
  logger: Logger,
): Promise<MoveResult> => {
  const { vaultPath, oldPath, newPath, protectedPaths, allPaths } = params

  if (oldPath === newPath) {
    throw new Error("source and destination are the same path")
  }
  if (!oldPath.endsWith(".md") || !newPath.endsWith(".md")) {
    throw new Error(
      "vault_move_note only moves .md notes (paths must end in .md)",
    )
  }
  if (isProtected(oldPath, protectedPaths)) {
    throw new Error(`cannot move protected path "${oldPath}"`)
  }
  if (isProtected(newPath, protectedPaths)) {
    throw new Error(`cannot move into protected path "${newPath}"`)
  }

  const oldFullPath = resolveSafePath(vaultPath, oldPath)
  const newFullPath = resolveSafePath(vaultPath, newPath)

  if (!(await fileExists(oldFullPath))) {
    throw new Error(`note not found: "${oldPath}"`)
  }
  if (await fileExists(newFullPath)) {
    throw new Error(`destination exists: "${newPath}"`)
  }

  // Copy to a mutable array — resolveLink takes string[], and allPathsAfter is
  // a fresh array anyway (oldPath swapped for newPath).
  const allPathsBefore = [...allPaths]
  const allPathsAfter = allPaths.map((path) =>
    path === oldPath ? newPath : path,
  )

  // 1. Write the moved note to its destination, rewriting its own self-links
  //    and any source-relative links so they still resolve from the new folder.
  const movedRawContent = await readFile(oldFullPath, "utf8")
  const movedRewrite = rewriteNoteContent(movedRawContent, {
    oldSourcePath: oldPath,
    newSourcePath: newPath,
    oldTargetPath: oldPath,
    newTargetPath: newPath,
    allPaths: allPathsBefore,
    allPathsAfter,
  })
  const movedContent = movedRewrite?.content ?? movedRawContent
  await mkdir(posix.dirname(newFullPath), { recursive: true })
  await atomicWriteFile(newFullPath, movedContent)

  // 2. Rewrite each note that linked to the old path (skip the moved note
  //    itself — its self-links were handled in step 1). Sources are distinct
  //    files with no shared state, so they rewrite in parallel.
  const rewriteContextFor = (source: string): RewriteContext => ({
    oldSourcePath: source,
    newSourcePath: source,
    oldTargetPath: oldPath,
    newTargetPath: newPath,
    allPaths: allPathsBefore,
    allPathsAfter,
  })

  const sourceRewrites = await Promise.all(
    params.backlinkSources
      .filter((source) => source !== oldPath)
      .map(async (source) => {
        const sourceFullPath = resolveSafePath(vaultPath, source)
        const rawContent = await readFile(sourceFullPath, "utf8")
        const rewrite = rewriteNoteContent(
          rawContent,
          rewriteContextFor(source),
        )
        if (rewrite === null) return null
        await atomicWriteFile(sourceFullPath, rewrite.content)
        return { source, count: rewrite.count }
      }),
  )
  const appliedRewrites = sourceRewrites.filter((rewrite) => rewrite !== null)

  // 3. Remove the original only after the destination and all sources are safe.
  await unlink(oldFullPath)

  const linksUpdated =
    (movedRewrite?.count ?? 0) +
    appliedRewrites.reduce((sum, rewrite) => sum + rewrite.count, 0)
  logger.info("moved note", {
    from: oldPath,
    to: newPath,
    linksUpdated,
    notesUpdated: appliedRewrites.length,
  })

  return {
    moved_to: newPath,
    links_updated: linksUpdated,
    updated_notes: appliedRewrites.map((rewrite) => rewrite.source).sort(),
  }
}

export const noteMover = {
  moveNote,
}

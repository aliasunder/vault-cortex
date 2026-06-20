/** Moves/renames a note and rewrites every vault-wide link that resolves to it,
 *  mirroring Obsidian's built-in rename. Reuses resolveLink and the link regexes
 *  from search-index.ts so the rewriter and indexer always agree.
 *
 *  How it comes together — building blocks first, orchestrator last:
 *    1. Target classification — decides IF a link needs rewriting and what form
 *       (basename, absolute, relative) the replacement should take.
 *    2. Body rewriting — walks each line, skipping code blocks and inline code,
 *       rewrites wikilinks and markdown links via the target classifier.
 *    3. Frontmatter rewriting — rewrites wikilinks inside frontmatter values
 *       (strings, arrays, nested objects). Markdown links are body-only.
 *    4. Whole-note rewriting — combines body + frontmatter into one call; returns
 *       null when nothing changed so the caller can skip the write.
 *    5. Orchestration (moveNote) — two-phase: preflight reads every affected
 *       note and computes its rewrite (aborting on any failure before touching
 *       the vault), then commit writes the destination, updates backlink sources,
 *       and deletes the original last. */

import { readFile, mkdir, unlink, stat } from "node:fs/promises"
import { dirname, posix } from "node:path"
import { parseNote, stringifyNote } from "./frontmatter.js"
import {
  resolveSafePath,
  atomicWriteFile,
  atomicWriteFileExclusive,
} from "./vault-filesystem.js"
import {
  resolveLink,
  WIKILINK_RE,
  MD_LINK_RE,
  FENCE_OPEN,
  INLINE_CODE_RE,
} from "../search/search-index.js"
import { mapWithConcurrency } from "../../utils/map-with-concurrency.js"
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

/** Context for rewriting links in one note. Two notes are in play, named by
 *  link-graph direction: the "source" holds the link (its location is where
 *  relative links resolve from), the "target" is the note being moved. The
 *  source has an old/new path pair because when rewriting the moved note's own
 *  links, the source IS the moved note — its location changes, which shifts
 *  how its relative links resolve. For every other note, old === new. */
type RewriteContext = {
  oldSourcePath: string
  newSourcePath: string
  oldTargetPath: string
  newTargetPath: string
  allNotePaths: string[]
  allNotePathsAfter: string[]
}

/** Which of Obsidian's link forms a raw target used to resolve, so the
 *  replacement can be written back in the same style. */
type LinkForm = "basename" | "absolute" | "relative"

// ── Link-text parsers (reconstruction) ──────────────────────────

/** Splits a matched wikilink into [, embed `!`, target, `#heading`, `|alias`]. */
const WIKILINK_PARTS = /^(!?)\[\[([^\]#|]+)(#[^\]|]*)?(\|[^\]]+)?\]\]$/

/** Splits a matched markdown link into [, `[text](`, path-without-ext, `#heading`, `)`]. */
const MD_LINK_PARTS = /^(\[[^\]]*\]\()([^)#\s]+?)\.md(#[^)\s]*)?(\))$/

// ── Target classification + construction ────────────────────────

/** Strips a trailing .md so a vault path can be used as a wikilink target. */
const withoutExtension = (path: string): string =>
  path.endsWith(".md") ? path.slice(0, -".md".length) : path

/** Determines which link form (basename, absolute, relative) was used, so the
 *  replacement can be written back in the same style. */
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

/** Builds a replacement target that resolves to desiredTarget from the new source
 *  location, keeping the original link form. Falls back to vault-absolute if the
 *  shorter form would resolve elsewhere after the move. */
const buildReplacementTarget = (params: {
  form: LinkForm
  desiredTarget: string
  newSourcePath: string
  allNotePathsAfter: string[]
}): string => {
  const { form, desiredTarget, newSourcePath, allNotePathsAfter } = params
  const absoluteForm = withoutExtension(desiredTarget)

  const resolvesToDesired = (candidate: string): boolean =>
    resolveLink(candidate, allNotePathsAfter, newSourcePath) === desiredTarget

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

/** Returns the replacement target for one link, or null to leave it unchanged.
 *  Null when unresolved, still pointing at the right note, or not affected. */
const rewriteTarget = (
  rawTarget: string,
  context: RewriteContext,
): string | null => {
  const resolvedBefore = resolveLink(
    rawTarget,
    context.allNotePaths,
    context.oldSourcePath,
  )
  if (resolvedBefore === null) return null

  // Follow the moved note to its new location; leave other targets as-is.
  const desiredTarget =
    resolvedBefore === context.oldTargetPath
      ? context.newTargetPath
      : resolvedBefore

  // Already resolves correctly from the new location — leave it alone.
  const resolvedAfter = resolveLink(
    rawTarget,
    context.allNotePathsAfter,
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
    allNotePathsAfter: context.allNotePathsAfter,
  })
}

// ── Body rewriting ──────────────────────────────────────────────

/** Percent-encodes a markdown link path segment-by-segment. Parentheses are
 *  encoded explicitly because encodeURIComponent skips them and an unencoded ")"
 *  would close the link early. */
const encodeMarkdownLinkPath = (path: string): string =>
  path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29"),
    )
    .join("/")

type LinkEdit = { start: number; end: number; replacement: string }

/** Rewrites link targets in a single body line, skipping links inside
 *  inline-code spans. */
const rewriteBodyLine = (
  line: string,
  context: RewriteContext,
): { line: string; linksRewritten: number } => {
  const codeSpans = [...line.matchAll(INLINE_CODE_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  const isInsideCode = (position: number): boolean =>
    codeSpans.some((span) => position >= span.start && position < span.end)

  const edits = collectLineEdits(line, context, isInsideCode)
  if (edits.length === 0) return { line, linksRewritten: 0 }

  const orderedEdits = [...edits].sort(
    (left, right) => left.start - right.start,
  )

  // Splice replacements left-to-right; sequential cursor state.
  let result = ""
  let cursor = 0
  for (const edit of orderedEdits) {
    result += line.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
  }
  return { line: result + line.slice(cursor), linksRewritten: edits.length }
}

/** Gathers wikilink and markdown-link edits for one line, excluding code spans. */
const collectLineEdits = (
  line: string,
  context: RewriteContext,
  isInsideCode: (position: number) => boolean,
): LinkEdit[] => {
  const editsForPattern = (
    linkPattern: RegExp,
    rewriteLinkText: (linkText: string) => string | null,
  ): LinkEdit[] =>
    [...line.matchAll(linkPattern)].flatMap((linkMatch) => {
      const linkText = linkMatch[0]
      const start = linkMatch.index
      if (isInsideCode(start)) return []
      const replacement = rewriteLinkText(linkText)
      if (replacement === null) return []
      return [{ start, end: start + linkText.length, replacement }]
    })

  return [
    ...editsForPattern(WIKILINK_RE, (text) =>
      rewriteWikilinkText(text, context),
    ),
    ...editsForPattern(MD_LINK_RE, (text) =>
      rewriteMarkdownLinkText(text, context),
    ),
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

/** Returns the fence delimiter when inside a code block, null otherwise.
 *  Mirrors the indexer's fence handling. */
const advanceFence = (
  line: string,
  openFence: string | null,
): string | null => {
  const fenceMatch = FENCE_OPEN.exec(line)
  if (!fenceMatch) return openFence

  const fenceChars = fenceMatch[1]!
  if (openFence === null) return fenceChars[0]!.repeat(fenceChars.length)

  // Close only on the same fence character, at least as long, with no info string.
  const trimmedLine = line.trim()
  if (
    fenceChars[0] === openFence[0] &&
    fenceChars.length >= openFence.length &&
    trimmedLine === fenceChars[0]!.repeat(trimmedLine.length)
  ) {
    return null
  }
  return openFence
}

/** Rewrites every link in a note body, skipping fenced code blocks. */
const rewriteBody = (
  body: string,
  context: RewriteContext,
): { body: string; linksRewritten: number } => {
  // Fence state tracked line-by-line; mutable by necessity.
  let openFence: string | null = null
  let linksRewritten = 0
  const outputLines: string[] = []

  for (const line of body.split("\n")) {
    const fenceBefore = openFence
    openFence = advanceFence(line, openFence)

    if (fenceBefore !== null || openFence !== null) {
      outputLines.push(line)
      continue
    }

    const rewrite = rewriteBodyLine(line, context)
    outputLines.push(rewrite.line)
    linksRewritten += rewrite.linksRewritten
  }

  return { body: outputLines.join("\n"), linksRewritten }
}

// ── Frontmatter rewriting ───────────────────────────────────────

type FrontmatterRewrite = { value: unknown; linksRewritten: number }

/** Total links rewritten across a set of child results. */
const totalLinksRewritten = (
  rewrites: ReadonlyArray<FrontmatterRewrite>,
): number =>
  rewrites.reduce(
    (runningTotal, child) => runningTotal + child.linksRewritten,
    0,
  )

/** Rewrites wikilinks inside a frontmatter value, recursing into arrays and
 *  objects. Markdown links are body-only and left untouched. */
const rewriteFrontmatterValue = (
  value: unknown,
  context: RewriteContext,
): FrontmatterRewrite => {
  if (typeof value === "string") {
    // Mutable: replaceAll's callback is the only way to tally per-match.
    let linksRewritten = 0
    const rewritten = value.replaceAll(WIKILINK_RE, (linkText) => {
      const replacement = rewriteWikilinkText(linkText, context)
      if (replacement === null) return linkText
      linksRewritten += 1
      return replacement
    })
    return { value: rewritten, linksRewritten }
  }

  if (Array.isArray(value)) {
    const rewrittenItems = value.map((item) =>
      rewriteFrontmatterValue(item, context),
    )
    return {
      value: rewrittenItems.map((item) => item.value),
      linksRewritten: totalLinksRewritten(rewrittenItems),
    }
  }

  if (value !== null && typeof value === "object") {
    const rewrittenEntries = Object.entries(value).map(
      ([key, nestedValue]) => ({
        key,
        result: rewriteFrontmatterValue(nestedValue, context),
      }),
    )
    return {
      value: Object.fromEntries(
        rewrittenEntries.map(({ key, result }) => [key, result.value]),
      ),
      linksRewritten: totalLinksRewritten(
        rewrittenEntries.map(({ result }) => result),
      ),
    }
  }

  return { value, linksRewritten: 0 }
}

// ── Whole-note rewriting ────────────────────────────────────────

/** Rewrites all links (body + frontmatter) in a note's raw content. Returns the
 *  serialized note only when something changed, so callers can skip no-op writes. */
const rewriteNoteContent = (
  rawContent: string,
  context: RewriteContext,
): { content: string; linksRewritten: number } | null => {
  const parsed = parseNote(rawContent)
  const frontmatter = parsed.data as Record<string, unknown>

  const bodyResult = rewriteBody(parsed.content, context)
  const frontmatterResult = rewriteFrontmatterValue(frontmatter, context)
  const linksRewritten =
    bodyResult.linksRewritten + frontmatterResult.linksRewritten
  if (linksRewritten === 0) return null

  const content = stringifyNote(
    bodyResult.body,
    frontmatterResult.value as Record<string, unknown>,
  )
  return { content, linksRewritten }
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

/** Collapses "./" and "../" so traversal paths can't evade the protected-path
 *  prefix check. Absolute or vault-escaping paths are left for resolveSafePath. */
export const toVaultRelativePath = (input: string): string =>
  posix.normalize(input)

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

/** Caps concurrent file handles during rewriting. */
const REWRITE_CONCURRENCY = 10

/** Human-readable message from an unknown thrown value, for structured logs. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Moves a note and rewrites every link across the vault that resolves to it.
 *  Two phases: preflight reads all files and computes rewrites (aborting on any
 *  read failure before touching the vault), then commit writes everything and
 *  deletes the original last — so a failure never loses data. */
const moveNote = async (
  params: {
    vaultPath: string
    oldPath: string
    newPath: string
    protectedPaths: readonly string[]
    backlinkSources: readonly string[]
    /** Every .md path in the vault — resolveLink checks against this to determine where links point. */
    allNotePaths: readonly string[]
  },
  logger: Logger,
): Promise<MoveResult> => {
  const { vaultPath, protectedPaths, allNotePaths } = params
  // Normalize before any guard or comparison — see toVaultRelativePath.
  const oldPath = toVaultRelativePath(params.oldPath)
  const newPath = toVaultRelativePath(params.newPath)

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

  const allNotePathsBefore = [...allNotePaths]
  const allNotePathsAfter = allNotePaths.map((path) =>
    path === oldPath ? newPath : path,
  )

  // Backlink sources stay put (before === after); the moved note shifts old → new.
  const rewriteContextForSource = (sourceLocation: {
    before: string
    after: string
  }): RewriteContext => ({
    oldSourcePath: sourceLocation.before,
    newSourcePath: sourceLocation.after,
    oldTargetPath: oldPath,
    newTargetPath: newPath,
    allNotePaths: allNotePathsBefore,
    allNotePathsAfter,
  })

  // ── Preflight: read every file and compute its rewrite, mutating nothing. ──

  // Rewrite the moved note's self-links and source-relative links so they still
  // resolve from the new folder. A read failure aborts before any write.
  const planMovedNote = async (): Promise<{
    content: string
    linksRewritten: number
  }> => {
    try {
      const rawContent = await readFile(oldFullPath, "utf8")
      const rewrite = rewriteNoteContent(
        rawContent,
        rewriteContextForSource({ before: oldPath, after: newPath }),
      )
      return {
        content: rewrite?.content ?? rawContent,
        linksRewritten: rewrite?.linksRewritten ?? 0,
      }
    } catch (error) {
      logger.error("note move aborted: could not read the note being moved", {
        from: oldPath,
        to: newPath,
        error: describeError(error),
      })
      throw new Error(
        `move aborted: could not read "${oldPath}". Nothing was written.`,
        { cause: error },
      )
    }
  }
  const { content: movedContent, linksRewritten: movedLinksRewritten } =
    await planMovedNote()

  const plannedRewrites = (
    await mapWithConcurrency({
      items: params.backlinkSources.filter((source) => source !== oldPath),
      concurrency: REWRITE_CONCURRENCY,
      mapper: async (source) => {
        try {
          const sourceFullPath = resolveSafePath(vaultPath, source)
          const rawContent = await readFile(sourceFullPath, "utf8")
          const rewrite = rewriteNoteContent(
            rawContent,
            rewriteContextForSource({ before: source, after: source }),
          )
          return rewrite === null
            ? null
            : {
                source,
                fullPath: sourceFullPath,
                content: rewrite.content,
                linksRewritten: rewrite.linksRewritten,
              }
        } catch (error) {
          logger.error(
            "note move aborted: could not read/plan a backlink source",
            { source, from: oldPath, to: newPath, error: describeError(error) },
          )
          throw new Error(
            `move aborted: could not read backlink source "${source}". Nothing was written.`,
            { cause: error },
          )
        }
      },
    })
  ).filter((planned) => planned !== null)

  // ── Commit: all reads succeeded — write destination, update sources, delete original last. ──

  await mkdir(dirname(newFullPath), { recursive: true })
  try {
    await atomicWriteFileExclusive(newFullPath, movedContent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`destination exists: "${newPath}"`, { cause: error })
    }
    logger.error(
      "note move aborted: could not write the note to its new path",
      { from: oldPath, to: newPath, error: describeError(error) },
    )
    throw new Error(
      `move aborted: could not write to "${newPath}". Nothing was written.`,
      { cause: error },
    )
  }

  // Mutable: tracks progress so a mid-commit failure can report how far it got.
  let sourcesWritten = 0
  await mapWithConcurrency({
    items: plannedRewrites,
    concurrency: REWRITE_CONCURRENCY,
    mapper: async (planned) => {
      try {
        await atomicWriteFile(planned.fullPath, planned.content)
        sourcesWritten += 1
      } catch (error) {
        logger.error("note move failed while writing a backlink source", {
          source: planned.source,
          from: oldPath,
          to: newPath,
          sources_written: sourcesWritten,
          sources_planned: plannedRewrites.length,
          error: describeError(error),
        })
        throw new Error(
          `move incomplete: failed updating "${planned.source}" (${sourcesWritten}/${plannedRewrites.length} sources written). Original not deleted — re-run to finish.`,
          { cause: error },
        )
      }
    },
  })
  const linksUpdated =
    movedLinksRewritten +
    plannedRewrites.reduce((sum, planned) => sum + planned.linksRewritten, 0)

  // Delete the original last — if this fails, both copies exist but no data is lost.
  try {
    await unlink(oldFullPath)
  } catch (error) {
    logger.error("note move failed while deleting the original note", {
      from: oldPath,
      to: newPath,
      sources_updated: plannedRewrites.length,
      links_updated: linksUpdated,
      error: describeError(error),
    })
    throw new Error(
      `move incomplete: "${newPath}" written but could not delete "${oldPath}". Delete "${oldPath}" manually to finish.`,
      { cause: error },
    )
  }

  logger.info("note move complete", {
    from: oldPath,
    to: newPath,
    links_updated: linksUpdated,
    sources_updated: plannedRewrites.length,
    sources_failed: 0,
  })

  return {
    moved_to: newPath,
    links_updated: linksUpdated,
    updated_notes: plannedRewrites.map((planned) => planned.source).sort(),
  }
}

export const noteMover = {
  moveNote,
}

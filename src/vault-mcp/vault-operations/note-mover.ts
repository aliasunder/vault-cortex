/** Moves/renames a note and rewrites every vault-wide link that resolves to it,
 *  mirroring Obsidian's built-in rename. Reuses the link grammar, parsing, and
 *  resolution from ../links.ts so the rewriter and indexer always agree.
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
 *       and deletes the original last. The whole span runs under a multi-file
 *       write lock covering the moved note, its destination, and every backlink
 *       source, so concurrent single-file writes fail fast instead of racing. */

import { readFile, mkdir, unlink } from "node:fs/promises"
import { dirname, posix } from "node:path"
import { parseNote, stringifyNote } from "../obsidian-markdown/frontmatter.js"
import {
  resolveSafePath,
  atomicWriteFile,
  atomicWriteFileExclusive,
  pruneEmptyParents,
  toVaultRelativePath,
} from "./vault-filesystem.js"
import { links } from "../obsidian-markdown/links.js"
import { classifyLines } from "../obsidian-markdown/lines.js"
import { withExclusiveMultiFileLock } from "../../utils/file-write-lock.js"
import { mapWithConcurrency } from "../../utils/map-with-concurrency.js"
import { describeError } from "../../utils/describe-error.js"
import { fileExists } from "../../utils/fs.js"
import { assertPathHasExtension } from "../../utils/assert-path-has-extension.js"
import type { Logger } from "../../logger.js"

// ── Types ───────────────────────────────────────────────────────

/** Structured summary of a completed move. */
type MoveResult = {
  /** Vault-relative destination path the note now lives at. */
  moved_to: string
  /** Total number of individual link occurrences rewritten across all notes
   *  (backlink sources plus the moved note's own relative links). */
  links_updated: number
  /** Vault-relative paths of the other notes whose link text was rewritten,
   *  sorted. Excludes the moved note itself (conveyed by moved_to). */
  updated_notes: string[]
  /** Number of now-empty source folders removed after the move. Always 0 unless
   *  pruneEmptyFolders was set. */
  pruned_empty_folders: number
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
    links.resolve(candidate, allNotePathsAfter, newSourcePath) === desiredTarget

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
  const resolvedBefore = links.resolve(
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
  const resolvedAfter = links.resolve(
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

/** Takes a raw link target string and returns its replacement, or null to
 *  leave the link unchanged. Created by binding rewriteTarget to a context. */
type RewriteLink = (rawTarget: string) => string | null

/** Splices link replacements into text in start order. Shared by body-line and
 *  frontmatter-string rewriting. */
const applyLinkEdits = (text: string, edits: LinkEdit[]): string => {
  if (edits.length === 0) return text
  const orderedEdits = [...edits].sort(
    (left, right) => left.start - right.start,
  )

  // Splice replacements left-to-right; sequential cursor state, so a plain loop.
  let result = ""
  let cursor = 0
  for (const edit of orderedEdits) {
    result += text.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
  }
  return result + text.slice(cursor)
}

/** Rewrites link targets in a single body line, skipping links inside
 *  inline-code spans. */
const rewriteBodyLine = (
  line: string,
  rewriteLink: RewriteLink,
): { line: string; linksRewritten: number } => {
  const codeSpans = links.inlineCodeSpans(line)
  const isInsideCode = (position: number): boolean =>
    codeSpans.some((span) => position >= span.start && position < span.end)

  const edits = collectLineEdits(line, rewriteLink, isInsideCode)
  return { line: applyLinkEdits(line, edits), linksRewritten: edits.length }
}

/** Gathers wikilink and markdown-link edits for one line, excluding code spans. */
const collectLineEdits = (
  line: string,
  rewriteLink: RewriteLink,
  isInsideCode: (position: number) => boolean,
): LinkEdit[] =>
  links.matchLinksInLine(line).flatMap((linkMatch) => {
    if (isInsideCode(linkMatch.start)) return []
    const replacement =
      linkMatch.kind === "wikilink"
        ? rewriteWikilinkText(linkMatch.text, rewriteLink)
        : rewriteMarkdownLinkText(linkMatch.text, rewriteLink)
    if (replacement === null) return []
    return [{ start: linkMatch.start, end: linkMatch.end, replacement }]
  })

/** Rewrites one matched wikilink, preserving the embed marker, heading, and
 *  alias; null when the target needs no change. */
const rewriteWikilinkText = (
  linkText: string,
  rewriteLink: RewriteLink,
): string | null => {
  const parts = links.splitWikilink(linkText)
  if (!parts) return null
  const newTarget = rewriteLink(parts.target.trim())
  if (newTarget === null) return null
  return `${parts.embed}[[${newTarget}${parts.heading}${parts.alias}]]`
}

/** Rewrites one matched markdown link, preserving the link text and heading;
 *  null when the target needs no change. */
const rewriteMarkdownLinkText = (
  linkText: string,
  rewriteLink: RewriteLink,
): string | null => {
  const parts = links.splitMarkdownLink(linkText)
  if (!parts) return null
  const newTarget = rewriteLink(parts.path)
  if (newTarget === null) return null
  return `${parts.prefix}${encodeMarkdownLinkPath(newTarget)}.md${parts.heading}${parts.closeParen}`
}

/** Rewrites every link in a note body, skipping fenced code blocks. */
const rewriteBody = (
  body: string,
  rewriteLink: RewriteLink,
): { body: string; linksRewritten: number } => {
  // Code lines (fence delimiters and fenced content) pass through verbatim;
  // links.classifyLines owns the fence state machine. A running tally over a
  // sequential line walk, so a plain loop with mutable counters.
  let linksRewritten = 0
  const outputLines: string[] = []

  for (const { text, inCode } of classifyLines(body)) {
    if (inCode) {
      outputLines.push(text)
      continue
    }
    const rewrite = rewriteBodyLine(text, rewriteLink)
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
  rewriteLink: RewriteLink,
): FrontmatterRewrite => {
  if (typeof value === "string") {
    // Frontmatter has no code fences/spans, so every wikilink match is live.
    // Markdown links are body-only, so non-wikilink matches are skipped.
    const edits = links.matchLinksInLine(value).flatMap((linkMatch) => {
      if (linkMatch.kind !== "wikilink") return []
      const replacement = rewriteWikilinkText(linkMatch.text, rewriteLink)
      if (replacement === null) return []
      return [{ start: linkMatch.start, end: linkMatch.end, replacement }]
    })
    return { value: applyLinkEdits(value, edits), linksRewritten: edits.length }
  }

  if (Array.isArray(value)) {
    const rewrittenItems = value.map((item) =>
      rewriteFrontmatterValue(item, rewriteLink),
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
        result: rewriteFrontmatterValue(nestedValue, rewriteLink),
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
  rewriteLink: RewriteLink,
): { content: string; linksRewritten: number } | null => {
  const parsed = parseNote(rawContent)
  const frontmatter = parsed.data as Record<string, unknown>

  const bodyResult = rewriteBody(parsed.content, rewriteLink)
  const frontmatterResult = rewriteFrontmatterValue(frontmatter, rewriteLink)
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

/** Caps concurrent file handles during rewriting. */
const REWRITE_CONCURRENCY = 10

/** Moves a note and rewrites every link across the vault that resolves to it.
 *  Two phases: preflight reads all files and computes rewrites (aborting on any
 *  read failure before touching the vault), then commit writes everything and
 *  deletes the original last — so a failure never loses data. Both phases hold
 *  an exclusive multi-file lock on every affected file (moved note, destination,
 *  backlink sources); the move rejects fail-fast when any of them already has a
 *  write in flight, and vice versa. */
const moveNote = async (
  params: {
    vaultPath: string
    oldPath: string
    newPath: string
    protectedPaths: readonly string[]
    backlinkSources: readonly string[]
    /** Every .md path in the vault — links.resolve checks against this to determine where links point. */
    allNotePaths: readonly string[]
    /** When set, remove any source folders the move leaves empty. */
    pruneEmptyFolders: boolean
    /** Windows-drive bind mount — write the destination via rename, not a hard
     *  link (unsupported across the Docker Desktop ↔ WSL2 bridge). */
    windowsBindMount: boolean
  },
  logger: Logger,
): Promise<MoveResult> => {
  const { vaultPath, protectedPaths, allNotePaths, pruneEmptyFolders } = params
  // Normalize before any guard or comparison — see toVaultRelativePath.
  const oldPath = toVaultRelativePath(params.oldPath)
  const newPath = toVaultRelativePath(params.newPath)

  if (oldPath === newPath) {
    throw new Error("source and destination are the same path")
  }
  assertPathHasExtension(oldPath, ".md")
  assertPathHasExtension(newPath, ".md")
  if (isProtected(oldPath, protectedPaths)) {
    throw new Error(`cannot move protected path "${oldPath}"`)
  }
  if (isProtected(newPath, protectedPaths)) {
    throw new Error(`cannot move into protected path "${newPath}"`)
  }

  const oldFullPath = resolveSafePath(vaultPath, oldPath)
  const newFullPath = resolveSafePath(vaultPath, newPath)

  // Resolve every backlink source upfront so the lock set below covers each
  // file the move reads or writes. A resolution failure aborts before anything
  // is locked or written.
  const backlinkSources = params.backlinkSources
    .filter((source) => source !== oldPath)
    .map((source) => {
      try {
        return { source, fullPath: resolveSafePath(vaultPath, source) }
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
    })

  // Lock the moved note, its destination, and every backlink source as one
  // unit for the whole read-plan-write span — a concurrent single-file write
  // to any of them fails fast instead of racing the move (and losing), and the
  // move fails fast when any of them already has a write in flight. Acquired
  // before the existence checks so those also run against a stable vault.
  const lockPaths = [
    oldFullPath,
    newFullPath,
    ...backlinkSources.map((backlinkSource) => backlinkSource.fullPath),
  ]
  return withExclusiveMultiFileLock(lockPaths, async () => {
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

    // Bind rewriteTarget to a context for one source note, producing a simple
    // callback. Backlink sources stay put (before === after); the moved note
    // shifts old → new.
    const rewriteLinkForSource = (sourceLocation: {
      before: string
      after: string
    }): RewriteLink => {
      const context: RewriteContext = {
        oldSourcePath: sourceLocation.before,
        newSourcePath: sourceLocation.after,
        oldTargetPath: oldPath,
        newTargetPath: newPath,
        allNotePaths: allNotePathsBefore,
        allNotePathsAfter,
      }
      return (rawTarget) => rewriteTarget(rawTarget, context)
    }

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
          rewriteLinkForSource({ before: oldPath, after: newPath }),
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
        items: backlinkSources,
        concurrency: REWRITE_CONCURRENCY,
        mapper: async ({ source, fullPath }) => {
          try {
            const rawContent = await readFile(fullPath, "utf8")
            const rewrite = rewriteNoteContent(
              rawContent,
              rewriteLinkForSource({ before: source, after: source }),
            )
            return rewrite === null
              ? null
              : {
                  source,
                  fullPath,
                  content: rewrite.content,
                  linksRewritten: rewrite.linksRewritten,
                }
          } catch (error) {
            logger.error(
              "note move aborted: could not read/plan a backlink source",
              {
                source,
                from: oldPath,
                to: newPath,
                error: describeError(error),
              },
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
      await atomicWriteFileExclusive(newFullPath, movedContent, {
        hardLinksSupported: !params.windowsBindMount,
      })
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

    // Prune from the OLD note's folder — a same-folder rename or a move into a
    // subfolder leaves the source non-empty, so nothing is pruned in those cases.
    const prunedEmptyFolders = pruneEmptyFolders
      ? await pruneEmptyParents({ vaultPath, path: oldPath }, logger)
      : 0

    logger.info("note move complete", {
      from: oldPath,
      to: newPath,
      links_updated: linksUpdated,
      sources_updated: plannedRewrites.length,
      sources_failed: 0,
      pruned_empty_folders: prunedEmptyFolders,
    })

    return {
      moved_to: newPath,
      links_updated: linksUpdated,
      updated_notes: plannedRewrites.map((planned) => planned.source).sort(),
      pruned_empty_folders: prunedEmptyFolders,
    }
  })
}

export const noteMover = {
  moveNote,
}

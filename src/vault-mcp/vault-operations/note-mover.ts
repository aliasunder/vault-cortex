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

/** Percent-encodes each segment of a markdown link path so reserved characters
 *  (spaces, #, parentheses, %, …) can't break markdown link parsing or change the
 *  link's meaning. encodeURIComponent leaves "()" alone, so they're encoded
 *  explicitly — an unencoded ")" would close the link early. "/" separators are
 *  preserved by encoding per segment. */
const encodeMarkdownLinkPath = (path: string): string =>
  path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29"),
    )
    .join("/")

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

/** Canonical vault-relative form used for guard checks and index comparisons.
 *  Collapses "./" and "../" segments so a path like "X/../Daily Notes/Foo.md"
 *  can't evade the protected-path prefix check and then resolve into a protected
 *  folder. Absolute or vault-escaping paths are left for resolveSafePath to reject. */
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

/** Max notes processed concurrently. Caps open file handles so moving a note with
 *  a very large backlink set (e.g. a hub note) can't exhaust the process
 *  file-descriptor limit. */
const REWRITE_CONCURRENCY = 10

/** Human-readable message from an unknown thrown value, for structured logs. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Moves a note and rewrites every link across the vault that resolves to it.
 *
 *  backlinkSources is the set of notes that currently link to oldPath (supplied
 *  by the caller from the search index); allPaths is every note path before the
 *  move. Done in two phases for failure-safety: a preflight reads every file and
 *  computes its rewrite (so a read failure aborts with the vault untouched), then
 *  the commit writes the destination + sources and deletes the original last — so
 *  even a write failure never loses data or strands a broken link. */
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
  const { vaultPath, protectedPaths, allPaths } = params
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

  // Copy to a mutable array — resolveLink takes string[], and allPathsAfter is
  // a fresh array anyway (oldPath swapped for newPath).
  const allPathsBefore = [...allPaths]
  const allPathsAfter = allPaths.map((path) =>
    path === oldPath ? newPath : path,
  )

  const rewriteContextFor = (source: string): RewriteContext => ({
    oldSourcePath: source,
    newSourcePath: source,
    oldTargetPath: oldPath,
    newTargetPath: newPath,
    allPaths: allPathsBefore,
    allPathsAfter,
  })

  // ── Preflight: read every file and compute its rewrite, mutating nothing. ──

  // The moved note itself: rewrite its self-links and any source-relative links
  // so they still resolve from the new folder. A read failure aborts the move
  // before any write, named so the abort is debuggable.
  const planMovedNote = async (): Promise<{
    content: string
    count: number
  }> => {
    try {
      const rawContent = await readFile(oldFullPath, "utf8")
      const rewrite = rewriteNoteContent(rawContent, {
        oldSourcePath: oldPath,
        newSourcePath: newPath,
        oldTargetPath: oldPath,
        newTargetPath: newPath,
        allPaths: allPathsBefore,
        allPathsAfter,
      })
      return {
        content: rewrite?.content ?? rawContent,
        count: rewrite?.count ?? 0,
      }
    } catch (error) {
      logger.error("note move aborted: could not read the note being moved", {
        from: oldPath,
        to: newPath,
        error: describeError(error),
      })
      throw new Error(
        `move aborted: could not read the note being moved "${oldPath}"; nothing was written: ${describeError(error)}`,
        { cause: error },
      )
    }
  }
  const { content: movedContent, count: movedLinkCount } = await planMovedNote()

  // Each backlink source (excluding the moved note, handled above): keep only the
  // ones whose content actually changes. A read/plan failure here aborts the whole
  // move (nothing has been written yet) — logged with the offending source and the
  // intended destination so the abort is debuggable.
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
            rewriteContextFor(source),
          )
          return rewrite === null
            ? null
            : {
                source,
                fullPath: sourceFullPath,
                content: rewrite.content,
                count: rewrite.count,
              }
        } catch (error) {
          logger.error(
            "note move aborted: could not read/plan a backlink source",
            { source, from: oldPath, to: newPath, error: describeError(error) },
          )
          throw new Error(
            `move aborted: could not read backlink source "${source}" (moving "${oldPath}" -> "${newPath}"); nothing was written: ${describeError(error)}`,
            { cause: error },
          )
        }
      },
    })
  ).filter((planned) => planned !== null)

  // ── Commit: all reads succeeded, so perform the writes. The original is
  //    deleted last, so a write failure here never loses data. ──
  // dirname must be the native variant — newFullPath is an absolute filesystem
  // path from resolveSafePath, not a vault-relative ("/"-separated) path.
  await mkdir(dirname(newFullPath), { recursive: true })
  try {
    // Atomic no-clobber create: never overwrites an existing note even if one
    // appears after the earlier destination-exists check (a concurrent writer).
    await atomicWriteFileExclusive(newFullPath, movedContent)
  } catch (error) {
    // EEXIST means we lost that race — surface the same error as the pre-check.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`destination exists: "${newPath}"`, { cause: error })
    }
    logger.error(
      "note move aborted: could not write the note to its new path",
      {
        from: oldPath,
        to: newPath,
        error: describeError(error),
      },
    )
    throw new Error(
      `move aborted: could not write the moved note to "${newPath}"; nothing was written: ${describeError(error)}`,
      { cause: error },
    )
  }

  // Mutable counter so a mid-commit write failure can report how many sources
  // were already updated — in that rare case the vault is left partially
  // rewritten (the original is still in place), which the operator needs to see.
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
          note: "original left in place; some sources may already be updated",
          error: describeError(error),
        })
        throw new Error(
          `move incomplete: failed updating backlink source "${planned.source}" while moving "${oldPath}" -> "${newPath}" (${sourcesWritten}/${plannedRewrites.length} sources updated). "${newPath}" exists and the original was NOT deleted — re-run the move to finish: ${describeError(error)}`,
          { cause: error },
        )
      }
    },
  })
  const linksUpdated =
    movedLinkCount +
    plannedRewrites.reduce((sum, planned) => sum + planned.count, 0)

  // Delete the original last. If this fails after the destination + sources are
  // written, the vault is left with both copies — log enough context to recover.
  try {
    await unlink(oldFullPath)
  } catch (error) {
    logger.error("note move failed while deleting the original note", {
      from: oldPath,
      to: newPath,
      sources_updated: plannedRewrites.length,
      links_updated: linksUpdated,
      note: "destination and backlink sources were already written; the original may still exist — delete it to finish the move",
      error: describeError(error),
    })
    throw new Error(
      `move incomplete: the moved note and updated backlinks were written, but deleting the original "${oldPath}" failed — both "${oldPath}" and "${newPath}" now exist; delete "${oldPath}" to finish: ${describeError(error)}`,
      { cause: error },
    )
  }

  // Completion summary: counts of what was rewritten. Atomic move, so failures is
  // always 0 here — a failure would have thrown above (logged with its source).
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

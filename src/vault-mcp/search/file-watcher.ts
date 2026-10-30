/** File watcher — builds the search index at startup and keeps it and the
 *  vector embeddings current via chokidar events, plus a rescan safety net for
 *  the files chokidar's new-directory handling loses (see rescanNewDirectory).
 *  Startup order is watchVaultAndBuildIndex's job. */

import { watch } from "chokidar"
import { DateTime } from "luxon"
import { readFile, readdir, stat } from "node:fs/promises"
import type { Stats } from "node:fs"
import { extname, join, relative, resolve as resolvePath, sep } from "node:path"
import {
  INDEXABLE_TEXT_EXTENSIONS,
  INDEXING_FILE_READ_CONCURRENCY,
  PDF_EXTRACTION_CONCURRENCY,
} from "./search-index.js"
import type { SearchIndex } from "./search-index.js"
import { bodyTagsFromParseResult, type BodyTagParser } from "./body-tag-parser.js"
import { splitPropertiesBlock } from "../obsidian-markdown/frontmatter.js"
import { extractPdfText } from "../obsidian-markdown/pdf.js"
import type { Logger } from "../../logger.js"
import { describeError, describeErrorForLog } from "../../utils/describe-error.js"
import { isErrnoException } from "../../utils/is-errno-exception.js"
import { isMissingPathError, readdirOrNull, realpathOrNull, statOrNull } from "../../utils/fs.js"
import { hasHiddenPathSegment } from "../../utils/has-hidden-path-segment.js"
import { mapWithConcurrency } from "../../utils/map-with-concurrency.js"

/** ms between filesystem polls when usePolling is on. chokidar's raw default is
 *  100ms, which stat()s the whole tree 10×/sec; 300ms meaningfully cuts CPU, and
 *  re-index latency is already governed by the 2000ms awaitWriteFinish window, so
 *  the perceived cost is negligible. */
const POLLING_INTERVAL_MS = 300

/** Default for FileWatcherOptions.stabilityThreshold (see its doc). */
const DEFAULT_STABILITY_THRESHOLD_MS = 2000

/** Default for FileWatcherOptions.pollInterval. */
const DEFAULT_POLL_INTERVAL_MS = 100

/**
 * Default for FileWatcherOptions.heldChangesDeadline. The server starts
 * listening only after watchVaultAndBuildIndex resolves, so the deadline caps
 * how long a Sync backlog arriving during startup delays listening.
 * - The local compose health check's 20 s start period sets the value: 10 s
 *   leaves the server time to listen inside it.
 * - Without a deadline, the backlog could keep the server from listening past
 *   the CLI's 120 s health wait.
 */
const DEFAULT_HELD_CHANGES_DEADLINE_MS = 10_000

type FileWatcherOptions = Readonly<{
  /** ms a file's size must stay unchanged before we index it (default 2000).
   *  Prevents reading partial writes from Obsidian Sync. */
  stabilityThreshold?: number
  /** ms between file-size checks during the stability window (default 100). */
  pollInterval?: number
  /** Poll the filesystem instead of using native fs events (inotify). Needed
   *  when the vault is bind-mounted across the Docker Desktop ↔ WSL2 bridge,
   *  where inotify events don't propagate. CPU-heavier; default off. */
  usePolling?: boolean
  /** ms to wait after a new directory appears before reconciling its contents
   *  against chokidar's tracking (default 2 × stabilityThreshold). The margin
   *  past the awaitWriteFinish window lets in-flight writes settle before the
   *  rescan reads them. */
  newDirectoryRescanDelay?: number
  /** ms startup waits after the rebuild for the changes chokidar reported
   *  meanwhile to be indexed, before returning anyway (default 10000); the
   *  rest are applied in the background. */
  heldChangesDeadline?: number
}>

type WatchVaultParams = Readonly<{
  vaultPath: string
  search: SearchIndex
  /** Finds each note's body tags off the main thread, for the rebuild and for
   *  every changed note. */
  bodyTagParser: BodyTagParser
  watcherOptions?: FileWatcherOptions
}>

/** The kind of the latest event chokidar reported for a held path. `add` and
 *  `change` both record "change", since either means "read this path again".
 *  The startup batch checks every held path against the disk; going live uses
 *  the kind only to remove a deleted path early. */
type HeldEventKind = "change" | "unlink"

/** While holding, the paths chokidar reports are recorded instead of applied;
 *  once live, each event is applied as it arrives; once closed, they are
 *  ignored. */
type WatcherState =
  { mode: "holding"; heldPaths: Map<string, HeldEventKind> } | { mode: "live" } | { mode: "closed" }

/** A held path and the event token reserved for it when the watcher went live.
 *  An event token is a symbol stored per path in currentEvents, which each
 *  newer event for the path replaces. The startup batch removes the path, or
 *  indexes what it read, only while the reservation is still the path's token. */
type ReservedPath = Readonly<{ filePath: string; reservation: symbol }>

/** What indexing one changed file did. A note's embedding is still running when
 *  this returns, so whoever receives `note-indexed` reports its failure. */
type ChangeIndexResult =
  | { status: "note-indexed"; embedding: Promise<void> }
  | { status: "file-indexed" }
  // The file was gone when read.
  | { status: "vanished" }
  // A newer event or a removal for the same path replaced this read's token
  // before the read finished, so its content was dropped.
  | { status: "superseded" }
  // A note's read, stat or index write failed, or a non-md file's stat or
  // asset-table write did; already logged. A non-md file whose content alone
  // could not be read, extracted or indexed is still "file-indexed".
  | { status: "failed" }

/** Whether a held path names a file on disk. "unknown" leaves the path to its
 *  read, which reports why it cannot be checked. */
type HeldPathPresence = "present" | "missing" | "unknown"

type FolderListing =
  { status: "listed"; names: ReadonlySet<string> } | { status: "missing" } | { status: "failed" }

type HoldingWatcher = Readonly<{
  /** Resolves once chokidar's initial scan is done and every folder is watched. */
  ready: Promise<void>
  /** Goes live and starts applying what chokidar reported while holding, and
   *  returns how many distinct paths that is. `applied` resolves once the
   *  batch's index writes commit, and never rejects. */
  applyHeldChanges: () => { heldPathCount: number; applied: Promise<void> }
  /** Stops watching; a rescan or retry still scheduled fires later and does
   *  nothing. Used only when startup fails before the held changes apply.
   *  Never rejects, so the startup failure stays the error reported. */
  close: () => Promise<void>
}>

/**
 * Starts a vault watcher in holding mode: from the moment chokidar starts, it
 * records each changed path instead of indexing it. applyHeldChanges switches
 * it live, and from then on it mirrors every file add/change/delete into the
 * search index for the process lifetime.
 */
const startHoldingWatcher = (params: WatchVaultParams, logger: Logger): HoldingWatcher => {
  const { vaultPath, search, bodyTagParser, watcherOptions } = params

  // Each path's latest embedding job. A new job for the path waits for this one,
  // so a note edited many times runs one model job at a time. A job that still
  // finishes after a newer edit writes nothing: the index checks the source
  // version the job carries (the token upsertNote or upsertFileContent returned
  // for the content it embeds) against the path's current one.
  const pendingEmbeds = new Map<string, Promise<void>>()

  /**
   * Each path's event token, which guards the path's read; source versions
   * guard the embedding that runs after it.
   * - indexChangedFile stores a fresh token before it reads the file, and drops
   *   what it read if a newer event or a removal replaced the token meanwhile.
   * - applyHeldChanges reserves one for each held path as the watcher goes
   *   live. The startup batch reads the path under it, so after a later
   *   deletion or a newer event for the path, the batch skips its removal or
   *   drops what it read.
   */
  const currentEvents = new Map<string, symbol>()

  /** Each path's body-tag parse still waiting in the parser's queue. A newer
   *  event or a removal for the path aborts it, because its result would be
   *  dropped as superseded anyway, so a slow note saved repeatedly is parsed
   *  once instead of once per save. */
  const pendingBodyTagParses = new Map<string, AbortController>()

  /** Aborts a path's pending body-tag parse, when there is one. */
  const abortPendingBodyTagParse = (relativePath: string): void => {
    pendingBodyTagParses.get(relativePath)?.abort()
    pendingBodyTagParses.delete(relativePath)
  }

  // Reassigned, so `let`: going live ends holding, and a failed startup closes
  // the watcher.
  let watcherState: WatcherState = { mode: "holding", heldPaths: new Map() }

  /** Indexes an added or modified non-md file: its asset-table row, plus its
   *  content when it is a canvas or an indexable text or PDF file. */
  const indexChangedNonMdFile = async (params: {
    filePath: string
    relativePath: string
    eventToken: symbol
  }): Promise<ChangeIndexResult> => {
    const { filePath, relativePath, eventToken } = params

    const readNonMdFileStat = async (): Promise<
      { status: "found"; fileStat: Stats } | { status: "missing" } | { status: "failed" }
    > => {
      try {
        const fileStat = await statOrNull(filePath)
        return fileStat ? { status: "found", fileStat } : { status: "missing" }
      } catch (error) {
        logger.error("failed to stat non-md file", {
          path: relativePath,
          error: describeError(error),
        })
        return { status: "failed" }
      }
    }
    const nonMdStat = await readNonMdFileStat()

    if (currentEvents.get(relativePath) !== eventToken) return { status: "superseded" }
    // Vanished between the event and the stat: the unlink event that follows
    // removes any existing row.
    if (nonMdStat.status === "missing") return { status: "vanished" }
    if (nonMdStat.status === "failed") return { status: "failed" }

    const { fileStat } = nonMdStat

    // Nothing is awaited between the token check above and this write, so it
    // cannot be superseded; only the content read below needs a second check.
    try {
      search.upsertNonMdFile(relativePath, fileStat.size)
    } catch (error) {
      logger.error("failed to index non-md file metadata", {
        path: relativePath,
        error: describeError(error),
      })
      return { status: "failed" }
    }

    // Canvas files are always read — link extraction is unconditional.
    // PDF and text files (INDEXABLE_TEXT_EXTENSIONS, which includes .pdf) are
    // only read when file content FTS is enabled.
    const extension = extname(filePath)
    const isCanvas = extension === ".canvas"
    const isIndexableNonCanvas =
      search.fileContentIndexingEnabled && INDEXABLE_TEXT_EXTENSIONS.has(extension)

    if (isCanvas || isIndexableNonCanvas) {
      try {
        const readContentToIndex = async (): Promise<string> => {
          if (extension !== ".pdf") return await readFile(filePath, "utf8")

          const buffer = await readFile(filePath)
          // pdfjs throws on a Node Buffer, so it gets a plain Uint8Array view
          // over the same bytes.
          const pdfData = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          const pdfResult = await extractPdfText(pdfData)
          return pdfResult.text
        }
        const contentToIndex = await readContentToIndex()

        if (currentEvents.get(relativePath) !== eventToken) return { status: "superseded" }

        const sourceVersion = search.upsertFileContent(
          {
            filePath: relativePath,
            rawContent: contentToIndex,
            fileStat: { mtimeMs: fileStat.mtimeMs, size: fileStat.size },
          },
          logger,
        )

        // Embed file content vectors — serialized per path via the same
        // pendingEmbeds map. A note path ends in .md and a file path never
        // does, so their keys never collide. Reads the processed content from
        // the file_content table.
        const previousEmbed = pendingEmbeds.get(relativePath) ?? Promise.resolve()
        const currentEmbed = previousEmbed
          .catch((previousError) => {
            logger.debug("previous file embed failed, proceeding with current", {
              path: relativePath,
              error: describeError(previousError),
            })
          })
          .then(() => {
            return search.embedFileContent({ filePath: relativePath, sourceVersion }, logger)
          })
        pendingEmbeds.set(relativePath, currentEmbed)

        // Unlike a note's, this embedding is not returned: neither the live
        // handler nor the startup batch waits on file-content model work. So
        // the job reports its own failure and removes its own queue entry,
        // leaving a newer queued job registered.
        currentEmbed
          .catch((embedError) => {
            logger.error("file content embedding failed", {
              path: relativePath,
              error: describeError(embedError),
            })
          })
          .finally(() => {
            if (pendingEmbeds.get(relativePath) === currentEmbed) {
              pendingEmbeds.delete(relativePath)
            }
          })
      } catch (error) {
        // Warn, as the rebuild does for an unreadable file: the asset-table row
        // above is indexed, and content search keeps what it had for the file.
        // describeErrorForLog keeps the cause, because a PDF reader that
        // failed to start arrives wrapped.
        logger.warn("file content indexing failed", {
          path: relativePath,
          ...describeErrorForLog(error),
        })
      }
    }

    logger.debug("indexed non-md file", { path: relativePath })
    return { status: "file-indexed" }
  }

  /** Indexes an added or modified note and queues its re-embedding. The
   *  embedding is returned unawaited, so the caller decides whether to wait. */
  const indexChangedNote = async (params: {
    filePath: string
    relativePath: string
    eventToken: symbol
  }): Promise<ChangeIndexResult> => {
    const { filePath, relativePath, eventToken } = params

    try {
      const readNoteSource = async (): Promise<{ content: string; fileStat: Stats } | null> => {
        try {
          const [content, fileStat] = await Promise.all([
            readFile(filePath, "utf8"),
            stat(filePath),
          ])
          return { content, fileStat }
        } catch (error) {
          if (!isErrnoException(error, "ENOENT")) throw error

          logger.debug("change event skipped, file vanished", { path: relativePath })
          return null
        }
      }
      const readNoteBodyTags = async (content: string): Promise<string[]> => {
        const parseController = new AbortController()
        pendingBodyTagParses.set(relativePath, parseController)

        try {
          const parseResult = await bodyTagParser.parse(
            {
              notePath: relativePath,
              body: splitPropertiesBlock(content).body,
              signal: parseController.signal,
            },
            logger,
          )
          return bodyTagsFromParseResult(parseResult)
        } finally {
          if (pendingBodyTagParses.get(relativePath) === parseController) {
            pendingBodyTagParses.delete(relativePath)
          }
        }
      }

      const noteSource = await readNoteSource()
      // Parsed before the token check, with no await between that check and the
      // write, so a delete or newer event that lands during a slow parse wins
      const bodyTags = noteSource ? await readNoteBodyTags(noteSource.content) : []

      if (currentEvents.get(relativePath) !== eventToken) return { status: "superseded" }
      if (!noteSource) return { status: "vanished" }

      const { content, fileStat } = noteSource

      const sourceVersion = search.upsertNote(
        {
          filePath: relativePath,
          rawContent: content,
          fileStat: { mtimeMs: fileStat.mtimeMs, size: fileStat.size },
          bodyTags,
        },
        logger,
      )

      // Each path queues model work; recovering a rejected predecessor
      // allows later jobs to run after a transient failure.
      const previousEmbed = pendingEmbeds.get(relativePath) ?? Promise.resolve()
      const currentEmbed = previousEmbed
        .catch((previousError) => {
          logger.debug("previous embed failed, proceeding with current", {
            path: relativePath,
            error: describeError(previousError),
          })
        })
        .then(() => {
          return search.embedNote(
            { notePath: relativePath, rawContent: content, sourceVersion },
            logger,
          )
        })
      pendingEmbeds.set(relativePath, currentEmbed)

      // The caller gets the cleanup promise, not currentEmbed, because a
      // promise nobody holds rejects unhandled: `.finally` passes currentEmbed's
      // rejection through to it. The cleanup leaves a newer queued job registered.
      const embedding = currentEmbed.finally(() => {
        if (pendingEmbeds.get(relativePath) === currentEmbed) {
          pendingEmbeds.delete(relativePath)
        }
      })
      return { status: "note-indexed", embedding }
    } catch (err) {
      logger.error("failed to process file change", {
        path: relativePath,
        error: describeError(err),
      })
      return { status: "failed" }
    }
  }

  /** Indexes an added or modified file under the token its caller stored for
   *  the path, and reports what it did. */
  const indexFileUnderToken = (params: {
    filePath: string
    relativePath: string
    eventToken: symbol
  }): Promise<ChangeIndexResult> => {
    if (params.filePath.endsWith(".md")) return indexChangedNote(params)
    return indexChangedNonMdFile(params)
  }

  /** Releases a path's event token unless a newer event replaced it: deleting
   *  a newer event's token would make that event's read look superseded. An
   *  older read that finds no token still fails its check. */
  const releaseEventToken = (relativePath: string, eventToken: symbol): void => {
    if (currentEvents.get(relativePath) === eventToken) currentEvents.delete(relativePath)
  }

  /** Indexes an added or modified file and reports what it did. */
  const indexChangedFile = async (filePath: string): Promise<ChangeIndexResult> => {
    const relativePath = relative(vaultPath, filePath)

    // Taken before the first await, so events take their tokens in the order
    // their handlers start, and the read that starts last is the one indexed.
    const eventToken = Symbol()
    abortPendingBodyTagParse(relativePath)
    currentEvents.set(relativePath, eventToken)

    // Awaited inside the try, so the token is released only once indexing ends.
    try {
      return await indexFileUnderToken({ filePath, relativePath, eventToken })
    } finally {
      releaseEventToken(relativePath, eventToken)
    }
  }

  /** Logs a note embedding's failure under the same message as a failed read,
   *  so each change reports one error whichever step failed. */
  const reportEmbeddingFailure = (filePath: string, error: unknown): void => {
    logger.error("failed to process file change", {
      path: relative(vaultPath, filePath),
      error: describeError(error),
    })
  }

  /** chokidar's add and change listener. While the watcher holds, it records
   *  the path for applyHeldChanges instead of indexing it. chokidar ignores
   *  the returned promise, so each step logs its own failure and the listener
   *  never rejects. */
  const handleChange = async (filePath: string): Promise<void> => {
    if (watcherState.mode === "closed") return
    if (watcherState.mode === "holding") {
      watcherState.heldPaths.set(filePath, "change")
      logger.debug("held a change until startup indexing ends", {
        path: relative(vaultPath, filePath),
      })
      return
    }

    const indexResult = await indexChangedFile(filePath)

    if (indexResult.status !== "note-indexed") return

    try {
      await indexResult.embedding
    } catch (error) {
      reportEmbeddingFailure(filePath, error)
    }
  }

  /** Removes a deleted file from the index — the asset table for non-md
   *  files, the note tables (FTS, links, tasks, vectors) for notes. */
  const removeFromIndex = (filePath: string): void => {
    const relativePath = relative(vaultPath, filePath)

    // Dropping the path's token makes a read still in flight for it return
    // "superseded", so that read cannot re-add the file removed here.
    currentEvents.delete(relativePath)
    abortPendingBodyTagParse(relativePath)

    if (!filePath.endsWith(".md")) {
      const removeAssetRow = (): boolean => {
        try {
          search.removeNonMdFile(relativePath)
          return true
        } catch (error) {
          logger.error("failed to remove non-md file metadata", {
            path: relativePath,
            error: describeError(error),
          })
          return false
        }
      }
      const assetRowRemoved = removeAssetRow()

      // The content rows live in their own tables, so they are removed even
      // when the asset-table removal above failed.
      const deletedExtension = extname(filePath)
      const isDeletedCanvas = deletedExtension === ".canvas"
      const isDeletedIndexable =
        search.fileContentIndexingEnabled && INDEXABLE_TEXT_EXTENSIONS.has(deletedExtension)

      if (isDeletedCanvas || isDeletedIndexable) {
        try {
          search.removeFileContent({ filePath: relativePath }, logger)
        } catch (error) {
          logger.error("failed to remove file content", {
            path: relativePath,
            error: describeError(error),
          })
          return
        }
      }
      // Reported only when every removal succeeded; a failure logged its own error.
      if (assetRowRemoved) logger.debug("processed non-md file removal", { path: relativePath })
      return
    }

    try {
      search.removeNote(relativePath)
    } catch (error) {
      logger.error("failed to remove note from index", {
        path: relativePath,
        error: describeError(error),
      })
      return
    }
    logger.debug("removed from index", { path: relativePath })
  }

  /** chokidar's unlink listener. While the watcher holds, it records the path
   *  for applyHeldChanges instead of removing it. */
  const handleDelete = (filePath: string): void => {
    if (watcherState.mode === "closed") return
    if (watcherState.mode === "holding") {
      watcherState.heldPaths.set(filePath, "unlink")
      logger.debug("held a deletion until startup indexing ends", {
        path: relative(vaultPath, filePath),
      })
      return
    }
    removeFromIndex(filePath)
  }

  const stabilityThreshold = watcherOptions?.stabilityThreshold ?? DEFAULT_STABILITY_THRESHOLD_MS
  const newDirectoryRescanDelay = watcherOptions?.newDirectoryRescanDelay ?? 2 * stabilityThreshold

  /** True when the file's last write falls inside the stability window —
   *  plausibly still being written. A negative age (mtime in the future —
   *  clock skew across a Docker bind mount) counts as settled: skipping
   *  forever would lose the note, while a too-early read is corrected by the
   *  file's next change event. */
  const isWithinStabilityWindow = (mtimeMs: number): boolean => {
    const fileAgeMs = DateTime.now().toMillis() - mtimeMs
    return fileAgeMs >= 0 && fileAgeMs < stabilityThreshold
  }

  const watcher = watch(vaultPath, {
    // Skip dotfiles/directories (.obsidian/, .trash/) but allow the vault root itself
    ignored: (path: string) => {
      const relativePath = relative(vaultPath, path)

      if (!relativePath) return false
      return hasHiddenPathSegment(relativePath)
    },
    persistent: true,
    ignoreInitial: true,
    // Poll across the Docker Desktop ↔ WSL2 bridge, where inotify is dropped.
    usePolling: watcherOptions?.usePolling ?? false,
    // interval only drives chokidar's polling backend. Pass it only when
    // polling, so we never depend on how chokidar treats an interval set
    // without usePolling (today it's ignored — a future release needn't be).
    ...(watcherOptions?.usePolling ? { interval: POLLING_INTERVAL_MS } : {}),
    // Obsidian Sync writes files in chunks — wait for write stability before
    // indexing to avoid reading partial content
    awaitWriteFinish: {
      stabilityThreshold,
      pollInterval: watcherOptions?.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
    },
  })

  /** Adds a path to chokidar unless the watcher is closed. A rescan or retry
   *  timer can fire after close, and chokidar's add reopens a closed watcher. */
  const watchPathUnlessClosed = (path: string): void => {
    if (watcherState.mode === "closed") return
    watcher.add(path)
  }

  /**
   * Polls a mid-write file until its writes settle, then indexes it. Serves
   * the new-directory rescan (rescanNewDirectory, below) for one case: a file
   * inside a directory chokidar wasn't watching when the write began. There,
   * waiting on chokidar would strand the note unindexed forever — registering
   * a directory (watcher.add) emits no events for content that already
   * exists — whereas a file in an already-watched directory needs no retry:
   * its own write event is in flight behind awaitWriteFinish. A vanished file
   * ends the retry.
   */
  const scheduleUnstableFileRetry = (filePath: string): void => {
    const retryTimer = setTimeout(() => {
      const indexIfSettled = async (): Promise<void> => {
        // Ends the retries, which would otherwise keep polling a closed
        // watcher's file until it settles.
        if (watcherState.mode === "closed") return

        const fileStat = await stat(filePath)

        // A file still being written is checked again after another window.
        // The retries have no limit, since a file that keeps changing is still
        // arriving; a deleted file ends them when the stat above rejects.
        if (isWithinStabilityWindow(fileStat.mtimeMs)) {
          scheduleUnstableFileRetry(filePath)
          return
        }
        watchPathUnlessClosed(filePath)
        logger.debug("rescan indexing settled file after retry", {
          path: relative(vaultPath, filePath),
        })
        await handleChange(filePath)
      }
      // A timer callback cannot await, so the retry runs detached and logs its own failure.
      indexIfSettled().catch((err) => {
        logger.debug("rescan retry skipped unreadable file", {
          path: relative(vaultPath, filePath),
          error: describeError(err),
        })
      })
    }, stabilityThreshold)
    // Never hold the process open for a pending retry.
    retryTimer.unref()
  }

  /**
   * The new-directory safety net. chokidar processes a newly-appeared
   * directory by scanning it FIRST and registering its fs.watch only after
   * the scan completes (_handleDir in chokidar's handler), so a file that
   * lands between the scan read and the watch registration is silently lost —
   * the scan didn't see it and no watcher existed to observe the event
   * (chokidar#1471). Our atomic writes (temp file + rename into a freshly
   * created folder) hit that window under load, leaving the note invisible to
   * search until an unrelated later event touches it. This rescan reconciles
   * the directory's actual contents against what chokidar tracks
   * (getWatched) and indexes anything chokidar missed.
   */
  const rescanNewDirectory = async (
    dirPath: string,
    visitedRealPaths: Set<string>,
  ): Promise<void> => {
    // A rescan scheduled before close still fires, but a closed watcher has
    // nothing to reconcile, and close empties getWatched, so every entry would
    // look missed.
    if (watcherState.mode === "closed") {
      logger.debug("rescan skipped, watcher closed", { path: relative(vaultPath, dirPath) })
      return
    }

    // readdirOrNull lists every descendant recursively, or returns null when the
    // directory is gone. It does not enter symlinked directories; the loop
    // below rescans those.
    const entries = await readdirOrNull(dirPath)

    if (!entries) {
      logger.debug("rescan skipped, directory vanished", {
        path: relative(vaultPath, dirPath),
      })
      return
    }

    // Symlinked directories recurse below; realpath identity breaks cycles
    // (a symlink pointing back at an ancestor would otherwise recurse until
    // the filesystem throws ELOOP, indexing ghost duplicates along the way).
    // A null realpath means the directory was deleted after the readdir above
    // — the same benign race as the vanished-listing branch, not an error.
    const realDirPath = await realpathOrNull(dirPath)

    if (!realDirPath) {
      logger.debug("rescan skipped, directory vanished", {
        path: relative(vaultPath, dirPath),
      })
      return
    }
    if (visitedRealPaths.has(realDirPath)) return
    visitedRealPaths.add(realDirPath)

    // Map of watched directory (absolute) → tracked child basenames. Anything
    // on disk but absent here is an entry chokidar's new-directory scan missed.
    const watchedChildren = watcher.getWatched()

    for (const entry of entries) {
      const fullPath = join(entry.parentPath, entry.name)
      const relativePath = relative(vaultPath, fullPath)

      if (hasHiddenPathSegment(relativePath)) continue

      // getWatched() keys are resolved paths (chokidar resolves internally).
      const trackedSiblings = watchedChildren[resolvePath(entry.parentPath)]

      if (trackedSiblings?.includes(entry.name)) continue

      if (entry.isDirectory()) {
        // A subdirectory chokidar never saw would stay unwatched forever —
        // watcher.add() registers its watches. Its contents are already covered
        // by this recursive listing, so the add's suppressed events don't matter.
        watchPathUnlessClosed(fullPath)
        logger.debug("rescan registered missed directory", {
          path: relativePath,
        })
        continue
      }

      try {
        // stat follows symlinks, so a symlinked note is indexed like the add
        // path would; a broken symlink or vanished file throws and is skipped.
        const fileStat = await stat(fullPath)

        if (fileStat.isDirectory()) {
          // Symlink to a directory — its contents aren't in this recursive
          // listing (readdir doesn't traverse symlinks), so reconcile it
          // before registering: watcher.add() tracks its children without
          // emitting events, which would make a later pass skip them as
          // already tracked.
          await rescanNewDirectory(fullPath, visitedRealPaths)
          watchPathUnlessClosed(fullPath)
          logger.debug("rescan registered missed symlinked directory", {
            path: relativePath,
          })
          continue
        }
        // A freshly-modified file is plausibly still being written — don't
        // read it yet. When its directory was already watched before this
        // rescan (present in the getWatched snapshot), the write's own event
        // is in flight behind awaitWriteFinish, so skipping is safe. Inside a
        // directory chokidar never watched (a missed subdirectory or symlinked
        // directory), registration emits no replay for the write — retry once
        // it settles instead.
        if (isWithinStabilityWindow(fileStat.mtimeMs)) {
          const parentWatchedBeforeRescan = Boolean(trackedSiblings)

          if (parentWatchedBeforeRescan) continue
          scheduleUnstableFileRetry(fullPath)
          continue
        }

        // Register the file with chokidar too — indexed but untracked, its
        // later deletion would emit no unlink, leaving a ghost index entry.
        watchPathUnlessClosed(fullPath)
        logger.debug("rescan indexing missed file", { path: relativePath })
        await handleChange(fullPath)
      } catch (err) {
        logger.debug("rescan skipped unreadable entry", {
          path: relativePath,
          error: describeError(err),
        })
      }
    }
  }

  /** Runs rescanNewDirectory once per new directory, delayed by
   *  newDirectoryRescanDelay so in-flight writes settle before the rescan
   *  reads them. Wired to chokidar's addDir event below. */
  const scheduleNewDirectoryRescan = (dirPath: string): void => {
    const rescanTimer = setTimeout(() => {
      // A timer callback cannot await, so the rescan runs detached and logs its own failure.
      rescanNewDirectory(dirPath, new Set()).catch((err) => {
        logger.error("failed to rescan new directory", {
          path: relative(vaultPath, dirPath),
          error: describeError(err),
        })
      })
    }, newDirectoryRescanDelay)
    // Never hold the process open for a pending rescan.
    rescanTimer.unref()
  }

  /** Lists a folder's entry names for the startup batch's presence checks. */
  const listFolderNames = async (folderPath: string): Promise<FolderListing> => {
    try {
      // A plain readdir, not readdirOrNull: the check needs only this folder's
      // own names, and readdirOrNull lists every descendant.
      const names = await readdir(folderPath)
      return { status: "listed", names: new Set(names) }
    } catch (error) {
      if (isMissingPathError(error)) return { status: "missing" }

      logger.warn("could not list a folder of held changes, so stat checks its files", {
        path: relative(vaultPath, folderPath),
        error: describeError(error),
      })
      return { status: "failed" }
    }
  }

  /**
   * Decides whether a held path still names a file.
   * - Each folder from the vault root down must list the next name in the path
   *   exactly. On a case-insensitive filesystem, `stat` still succeeds for the
   *   old path after a case-only rename of the file (`note.md` to `Note.md`) or
   *   of a folder above it (`notes/` to `Notes/`), and reading it would index
   *   the old path again.
   * - `listFolderOnce` returns the batch's shared listing of a folder, so each
   *   folder is read once per batch.
   */
  const checkHeldPathOnDisk = async (
    filePath: string,
    listFolderOnce: (folderPath: string) => Promise<FolderListing>,
  ): Promise<HeldPathPresence> => {
    const pathSegments = relative(vaultPath, filePath).split(sep)

    // Walks down from the vault root: the vault root must list the first
    // segment, that folder the second, and so on to the file's own name.
    // Sequential, so the first folder that lacks the next name ends the check.
    for (const [segmentIndex, segmentName] of pathSegments.entries()) {
      const folderPath = join(vaultPath, ...pathSegments.slice(0, segmentIndex))
      const folderListing = await listFolderOnce(folderPath)
      const missingFromListing =
        folderListing.status === "listed" && !folderListing.names.has(segmentName)

      // A folder that could not be listed proves nothing either way, so the
      // walk goes on and the stat below decides.
      if (folderListing.status === "missing" || missingFromListing) return "missing"
    }

    try {
      const fileStat = await statOrNull(filePath)

      // A folder now at the path also counts as missing. Removing it is
      // harmless: it clears only rows for a file that is no longer there.
      return fileStat?.isFile() ? "present" : "missing"
    } catch (error) {
      // The path's read runs next and reports the failure at error level.
      logger.debug("could not stat a held path, so its read reports why", {
        path: relative(vaultPath, filePath),
        error: describeError(error),
      })
      return "unknown"
    }
  }

  /** Removes a held path the startup batch found missing on disk. A held
   *  deletion that applyHeldChanges already removed comes here again while its
   *  path is still gone; the second removal finds no rows and changes nothing. */
  const removeHeldPath = (filePath: string): void => {
    logger.debug("removing a held path that is gone from disk", {
      path: relative(vaultPath, filePath),
    })
    removeFromIndex(filePath)
  }

  /**
   * Reads one held path again for the startup batch, under its reservation,
   * without waiting for its embedding.
   * - If a live event for the path replaced the reservation after going live,
   *   the read drops what it read, as an older live read does.
   * - A path that vanished by its read is left to the `unlink` chokidar sends
   *   for every file it tracks, as a live read leaves it.
   */
  const indexHeldPath = async ({ filePath, reservation }: ReservedPath): Promise<void> => {
    const relativePath = relative(vaultPath, filePath)

    // Awaited inside the try, so the reservation is released only once indexing ends.
    try {
      const indexResult = await indexFileUnderToken({
        filePath,
        relativePath,
        eventToken: reservation,
      })

      if (indexResult.status !== "note-indexed") return

      // The batch does not wait for embeddings, so the failure handler is
      // attached now. Attached after the batch, an embedding that rejected
      // first would be reported as an unhandled rejection.
      indexResult.embedding.catch((error) => {
        reportEmbeddingFailure(filePath, error)
      })
    } finally {
      releaseEventToken(relativePath, reservation)
    }
  }

  /**
   * Reads held paths again within the concurrency limits the rebuild also uses.
   * - Other files go first, INDEXING_FILE_READ_CONCURRENCY at a time, so slow
   *   PDF extraction does not hold them back.
   * - PDFs whose text is extracted go after, PDF_EXTRACTION_CONCURRENCY at a
   *   time. The groups run one after the other, so the two limits never add up.
   */
  const indexHeldPathsWithinBounds = async (
    reservedPaths: ReadonlyArray<ReservedPath>,
  ): Promise<void> => {
    // indexChangedNonMdFile extracts a PDF's text only when file content
    // indexing is on; otherwise a PDF is only statted and keeps the general bound.
    const needsPdfExtraction = ({ filePath }: ReservedPath): boolean => {
      return search.fileContentIndexingEnabled && extname(filePath) === ".pdf"
    }
    const pdfReads = reservedPaths.filter(needsPdfExtraction)
    const otherReads = reservedPaths.filter((reservedPath) => !needsPdfExtraction(reservedPath))

    await mapWithConcurrency({
      items: otherReads,
      concurrency: INDEXING_FILE_READ_CONCURRENCY,
      mapper: indexHeldPath,
    })
    await mapWithConcurrency({
      items: pdfReads,
      concurrency: PDF_EXTRACTION_CONCURRENCY,
      mapper: indexHeldPath,
    })
  }

  /** Checks each held path against the disk, removes the missing ones, then
   *  reads the rest again. The watcher is live meanwhile, so for a path whose
   *  reservation a live event replaced, the removal is skipped and the read's
   *  result is dropped: that event is newer. */
  const reconcileHeldPaths = async (reservedPaths: ReadonlyArray<ReservedPath>): Promise<void> => {
    const folderListings = new Map<string, Promise<FolderListing>>()

    /** Lists each folder once per batch, however many held paths sit in it. */
    const listFolderOnce = (folderPath: string): Promise<FolderListing> => {
      const knownListing = folderListings.get(folderPath)

      if (knownListing) return knownListing
      const folderListing = listFolderNames(folderPath)
      folderListings.set(folderPath, folderListing)
      return folderListing
    }

    const presenceChecks = await mapWithConcurrency({
      items: reservedPaths,
      concurrency: INDEXING_FILE_READ_CONCURRENCY,
      mapper: async (reservedPath) => {
        const presence = await checkHeldPathOnDisk(reservedPath.filePath, listFolderOnce)
        return { reservedPath, presence }
      },
    })
    const missingPaths = presenceChecks
      .filter((check) => check.presence === "missing")
      .map((check) => check.reservedPath)
    const pathsToRead = presenceChecks
      .filter((check) => check.presence !== "missing")
      .map((check) => check.reservedPath)

    // Removals run before reads. upsertNote re-resolves only links whose target
    // is not indexed, so removing a renamed note's old path first lets the new
    // path's read claim the links that pointed at the old path. Going live
    // already removed an old path whose latest held event is a deletion; this
    // loop removes one whose latest held event is a change.
    for (const { filePath, reservation } of missingPaths) {
      // Skips a path a live event has taken since going live, so a live `add`
      // that indexed it is not removed. No await sits between this check and
      // the removal, so no live event can take the path in between.
      const reservationIsCurrent = currentEvents.get(relative(vaultPath, filePath)) === reservation

      if (!reservationIsCurrent) continue
      removeHeldPath(filePath)
    }

    await indexHeldPathsWithinBounds(pathsToRead)
  }

  /**
   * Goes live and starts the startup batch over the distinct held paths. The
   * first three steps run with no await between them, before any live event
   * can start:
   *
   * 1. The watcher goes live.
   * 2. Each path whose latest held event is a deletion is removed, so a renamed
   *    note's new path, held or arriving as a live event, claims the links that
   *    pointed at the old one. reconcileHeldPaths removes an old path whose
   *    latest held event is a change, before the batch reads any path. A file
   *    that came back is read again by the batch.
   * 3. Each held path gets a reserved event token. It comes after step 2,
   *    because removeFromIndex deletes the path's token.
   *
   * `applied` never rejects: one catch logs a failure of the batch.
   */
  const applyHeldChanges = (): { heldPathCount: number; applied: Promise<void> } => {
    // Unreachable today, because applyHeldChanges runs once per startup and the
    // watcher closes only when the rebuild fails, before that call.
    if (watcherState.mode !== "holding") return { heldPathCount: 0, applied: Promise.resolve() }

    const { heldPaths } = watcherState
    watcherState = { mode: "live" }

    for (const [filePath, latestEventKind] of heldPaths) {
      if (latestEventKind === "unlink") removeFromIndex(filePath)
    }

    const reservedPaths: ReservedPath[] = []
    for (const filePath of heldPaths.keys()) {
      const reservation = Symbol()
      currentEvents.set(relative(vaultPath, filePath), reservation)
      reservedPaths.push({ filePath, reservation })
    }

    const applyBatch = async (): Promise<void> => {
      try {
        await reconcileHeldPaths(reservedPaths)
        logger.info("applied the changes held during startup indexing", {
          heldPaths: reservedPaths.length,
        })
      } catch (error) {
        logger.error("failed to apply the changes held during startup", {
          error: describeError(error),
        })
      }
    }
    return { heldPathCount: reservedPaths.length, applied: applyBatch() }
  }

  watcher
    .on("add", handleChange)
    .on("change", handleChange)
    .on("unlink", handleDelete)
    .on("addDir", scheduleNewDirectoryRescan)
    .on("error", (err) => {
      logger.error("watcher error", {
        error: describeError(err),
      })
    })

  const ready = new Promise<void>((resolve) => {
    watcher.on("ready", () => {
      logger.info("file watcher started", { vaultPath })
      resolve()
    })
  })

  const close = async (): Promise<void> => {
    watcherState = { mode: "closed" }
    try {
      await watcher.close()
    } catch (error) {
      logger.error("failed to close the file watcher", { error: describeError(error) })
    }
  }

  return { ready, applyHeldChanges, close }
}

/**
 * Starts the watcher, builds the search index from disk, then applies the
 * changes the watcher saw meanwhile. The watcher is ready before the rebuild
 * reads anything and holds every change until the rebuild returns, so a change
 * landing mid-rebuild is applied after it instead of being missed or replaced
 * by the rebuild's older read. Resolves with the rebuild's result (the note
 * count and its background embedding promise) once the batch over the held
 * changes commits its index writes, or at heldChangesDeadline if it takes
 * longer; the rest then apply in the background.
 */
export const watchVaultAndBuildIndex = async (
  params: WatchVaultParams,
  logger: Logger,
): Promise<{ count: number; embedding: Promise<void> }> => {
  const { vaultPath, search, bodyTagParser, watcherOptions } = params
  const holdingWatcher = startHoldingWatcher(params, logger)
  await holdingWatcher.ready

  // A failed rebuild closes the watcher rather than leave it holding every
  // later change; the caller sees the rebuild's error.
  const rebuildIndexOrCloseWatcher = async (): Promise<{
    count: number
    embedding: Promise<void>
  }> => {
    try {
      return await search.rebuildFromVault({ vaultPath, bodyTagParser }, logger)
    } catch (error) {
      await holdingWatcher.close()
      throw error
    }
  }
  const rebuildResult = await rebuildIndexOrCloseWatcher()

  // `applied` never rejects, so past the deadline it can finish unawaited.
  const { heldPathCount, applied } = holdingWatcher.applyHeldChanges()
  const heldChangesDeadline =
    watcherOptions?.heldChangesDeadline ?? DEFAULT_HELD_CHANGES_DEADLINE_MS
  const { promise: deadlinePassed, resolve: passDeadline } = Promise.withResolvers<"deadline">()
  const deadlineTimer = setTimeout(() => passDeadline("deadline"), heldChangesDeadline)

  // `applied` resolves with nothing, so only the deadline makes this "deadline".
  const firstSettled = await Promise.race([applied, deadlinePassed])
  clearTimeout(deadlineTimer)

  if (firstSettled === "deadline") {
    logger.info("startup continues while the changes held during it are still applied", {
      heldPaths: heldPathCount,
      heldChangesDeadline,
    })
  }
  return rebuildResult
}

/** File watcher — builds the search index at startup and keeps it and the
 *  vector embeddings current via chokidar events, plus a rescan safety net for
 *  the files chokidar's new-directory handling loses (see rescanNewDirectory).
 *  Startup order is watchVaultAndBuildIndex's job. */

import { watch } from "chokidar"
import { DateTime } from "luxon"
import { readFile, readdir, stat } from "node:fs/promises"
import type { Stats } from "node:fs"
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path"
import { INDEXABLE_TEXT_EXTENSIONS } from "./search-index.js"
import type { SearchIndex } from "./search-index.js"
import { extractPdfText } from "../obsidian-markdown/pdf.js"
import { logger } from "../../logger.js"
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

/** Default for FileWatcherOptions.heldChangesDeadline. It sits inside the local
 *  compose health check's 20 s start period. A batch that runs longer means
 *  Sync is delivering a backlog during startup, which search lags anyway, and
 *  the CLI stops waiting for health after 120 s. */
const DEFAULT_HELD_CHANGES_DEADLINE_MS = 10_000

/** Paths the startup batch checks and reads at once: the rebuild's own file
 *  concurrency, so a large batch cannot open every file at once. */
const HELD_CHANGES_CONCURRENCY = 16

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
  /** ms startup waits for the changes held during the rebuild before returning
   *  anyway (default 10000); the rest are applied in the background. */
  heldChangesDeadline?: number
}>

/** A change chokidar reported while the watcher held it. `add` and `change`
 *  both record "change", since either means "read this path again". */
type HeldEvent = Readonly<{ kind: "change" | "unlink"; filePath: string }>

/** What indexing one changed file did. A note's embedding is still running when
 *  this returns, so whoever receives `note-indexed` reports its failure. */
type ChangeIndexResult =
  | { status: "note-indexed"; embedding: Promise<void> }
  | { status: "file-indexed" }
  | { status: "vanished" }
  | { status: "superseded" }
  | { status: "failed" }

/** Whether a held path names a file on disk. "unknown" leaves the path to its
 *  read, which reports why it cannot be checked. */
type HeldPathPresence = "present" | "missing" | "unknown"

type FolderListing =
  { status: "listed"; names: ReadonlySet<string> } | { status: "missing" } | { status: "failed" }

type HoldingWatcher = Readonly<{
  /** Resolves once chokidar's initial scan is done and every folder is watched. */
  ready: Promise<void>
  /** Starts applying what chokidar reported while holding, and returns how many
   *  distinct paths that is. `applied` resolves once their index writes commit
   *  and the watcher is live. */
  applyHeldChanges: () => { heldPathCount: number; applied: Promise<void> }
}>

/**
 * Watches the vault and mirrors every file add/change/delete into the search
 * index, holding every change from the moment chokidar starts until
 * applyHeldChanges runs. The watcher then runs for the process lifetime —
 * there is no shutdown path.
 */
const startHoldingWatcher = (
  vaultPath: string,
  search: SearchIndex,
  options?: FileWatcherOptions,
): HoldingWatcher => {
  // Serializing per path limits model concurrency; source versions reject
  // obsolete results independently of the order jobs finish.
  const pendingEmbeds = new Map<string, Promise<void>>()

  /** Event tokens reject superseded filesystem reads until their handler finishes.
   *  Source versions belong to the index and protect model work after the handler returns. */
  const currentEvents = new Map<string, symbol>()

  /** Each held event's path and kind in arrival order, or undefined once the
   *  watcher is live. Reassigned twice: the startup batch takes the list and
   *  starts a new one, and going live ends holding. */
  let heldEvents: HeldEvent[] | undefined = []

  /** Indexes an added or modified file: non-md files land in the asset table;
   *  notes are read from disk and upserted into the FTS index, and their
   *  re-embedding is queued (serialized per path via pendingEmbeds). */
  const indexChangedFile = async (filePath: string): Promise<ChangeIndexResult> => {
    const relativePath = relative(vaultPath, filePath)
    const eventToken = Symbol()
    currentEvents.set(relativePath, eventToken)

    try {
      if (!filePath.endsWith(".md")) {
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
        // Vanished between the watcher event and the stat — the unlink event
        // that follows will remove any existing row.
        if (nonMdStat.status === "missing") return { status: "vanished" }
        if (nonMdStat.status === "failed") return { status: "failed" }

        const { fileStat } = nonMdStat

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
        // PDF and text files are only read when file content FTS is enabled.
        const extension = extname(filePath)
        const isCanvas = extension === ".canvas"
        const isIndexableNonCanvas =
          search.fileContentIndexingEnabled && INDEXABLE_TEXT_EXTENSIONS.has(extension)

        if (isCanvas || isIndexableNonCanvas) {
          try {
            const readContentToIndex = async (): Promise<string> => {
              if (extension !== ".pdf") return await readFile(filePath, "utf8")

              const buffer = await readFile(filePath)
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
            // pendingEmbeds map (note paths end in .md, file paths don't).
            // Reads the processed content from the file_content table.
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

            /** This detached job owns its error reporting and queue cleanup after the
             *  file handler returns; an older job must leave a newer queued job registered. */
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
            // A PDF reader that failed to start arrives wrapped; the cause holds why
            logger.warn("file content indexing failed", {
              path: relativePath,
              ...describeErrorForLog(error),
            })
          }
        }

        logger.debug("indexed non-md file", { path: relativePath })
        return { status: "file-indexed" }
      }

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
        const noteSource = await readNoteSource()

        if (currentEvents.get(relativePath) !== eventToken) return { status: "superseded" }
        if (!noteSource) return { status: "vanished" }

        const { content, fileStat } = noteSource

        const sourceVersion = search.upsertNote(
          {
            filePath: relativePath,
            rawContent: content,
            fileStat: { mtimeMs: fileStat.mtimeMs, size: fileStat.size },
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

        /** The receiver of this result reports the job's failures. Hand over the
         *  cleanup promise, so its rejection is the one handled and newer queued jobs remain registered. */
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
    } finally {
      // A newer handler may already have finished and removed its entry.
      // Only the current event owns cleanup; absence still invalidates old reads.
      if (currentEvents.get(relativePath) === eventToken) {
        currentEvents.delete(relativePath)
      }
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
   *  the path for applyHeldChanges instead of indexing it. */
  const handleChange = async (filePath: string): Promise<void> => {
    if (heldEvents) {
      heldEvents.push({ kind: "change", filePath })
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
    currentEvents.delete(relativePath)

    if (!filePath.endsWith(".md")) {
      try {
        search.removeNonMdFile(relativePath)
      } catch (error) {
        logger.error("failed to remove non-md file metadata", {
          path: relativePath,
          error: describeError(error),
        })
      }
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
      logger.debug("processed non-md file removal", { path: relativePath })
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
    if (heldEvents) {
      heldEvents.push({ kind: "unlink", filePath })
      logger.debug("held a deletion until startup indexing ends", {
        path: relative(vaultPath, filePath),
      })
      return
    }
    removeFromIndex(filePath)
  }

  const stabilityThreshold = options?.stabilityThreshold ?? DEFAULT_STABILITY_THRESHOLD_MS
  const newDirectoryRescanDelay = options?.newDirectoryRescanDelay ?? 2 * stabilityThreshold

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
    usePolling: options?.usePolling ?? false,
    // interval only drives chokidar's polling backend. Pass it only when
    // polling, so we never depend on how chokidar treats an interval set
    // without usePolling (today it's ignored — a future release needn't be).
    ...(options?.usePolling ? { interval: POLLING_INTERVAL_MS } : {}),
    // Obsidian Sync writes files in chunks — wait for write stability before
    // indexing to avoid reading partial content
    awaitWriteFinish: {
      stabilityThreshold,
      pollInterval: options?.pollInterval ?? 100,
    },
  })

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
        const fileStat = await stat(filePath)

        if (isWithinStabilityWindow(fileStat.mtimeMs)) {
          scheduleUnstableFileRetry(filePath)
          return
        }
        watcher.add(filePath)
        logger.debug("rescan indexing settled file after retry", {
          path: relative(vaultPath, filePath),
        })
        await handleChange(filePath)
      }
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
    /** The wrapper lists descendants recursively; symlinked directories are followed below. */
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
        watcher.add(fullPath)
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
          watcher.add(fullPath)
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
        watcher.add(fullPath)
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
      const names = await readdir(folderPath)
      return { status: "listed", names: new Set(names) }
    } catch (error) {
      if (isMissingPathError(error)) return { status: "missing" }

      logger.warn("could not list a folder of held changes, so its files are read instead", {
        path: relative(vaultPath, folderPath),
        error: describeError(error),
      })
      return { status: "failed" }
    }
  }

  /**
   * Decides whether a held path still names a file. The parent folder's listing
   * must hold the exact name: on a case-insensitive filesystem, `stat` of
   * `note.md` still succeeds after a rename to `Note.md`, and reading it would
   * index the old name again.
   */
  const checkHeldPathOnDisk = async (
    filePath: string,
    listFolderOnce: (folderPath: string) => Promise<FolderListing>,
  ): Promise<HeldPathPresence> => {
    const folderListing = await listFolderOnce(dirname(filePath))
    const missingFromListing =
      folderListing.status === "listed" && !folderListing.names.has(basename(filePath))

    if (folderListing.status === "missing" || missingFromListing) return "missing"
    try {
      const fileStat = await statOrNull(filePath)
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

  /** Removes a held path the startup batch found missing on disk. */
  const removeHeldPath = (filePath: string): void => {
    logger.debug("removing a held path that is gone from disk", {
      path: relative(vaultPath, filePath),
    })
    removeFromIndex(filePath)
  }

  /** Re-reads one held path for the startup batch, without waiting for its embedding. */
  const indexHeldPath = async (filePath: string): Promise<void> => {
    const indexResult = await indexChangedFile(filePath)

    if (indexResult.status === "vanished") {
      removeHeldPath(filePath)
      return
    }
    if (indexResult.status !== "note-indexed") return
    // Caught here, inside the batch step, so a fast rejection is never unhandled.
    indexResult.embedding.catch((error) => {
      reportEmbeddingFailure(filePath, error)
    })
  }

  /** Ends holding and replays the events held while the batch ran, in arrival order. */
  const goLiveAndReplay = (batchPathCount: number): void => {
    const eventsDuringBatch = heldEvents ?? []
    heldEvents = undefined
    // Every replayed event starts in this one tick, before any newer live
    // event for the same path, so that newer event takes the path's token and
    // wins. chokidar delivers a burst the same way.
    for (const heldEvent of eventsDuringBatch) {
      if (heldEvent.kind === "unlink") {
        handleDelete(heldEvent.filePath)
        continue
      }
      // As with chokidar's own emit, nothing awaits it; it logs its own failures.
      void handleChange(heldEvent.filePath)
    }
    logger.info("applied the changes held during startup indexing", {
      batchPaths: batchPathCount,
      replayedEvents: eventsDuringBatch.length,
    })
  }

  /** Steps 1 and 2 of applyHeldBatch. Removing a path because its check found
   *  it missing is safe only while holding: once live, the removal could clear
   *  the event token of an `add` that started during the check, and the added
   *  note would stay unindexed. */
  const reconcileHeldPaths = async (batchPaths: ReadonlyArray<string>): Promise<void> => {
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
      items: batchPaths,
      concurrency: HELD_CHANGES_CONCURRENCY,
      mapper: async (filePath) => {
        return { filePath, presence: await checkHeldPathOnDisk(filePath, listFolderOnce) }
      },
    })
    const missingPaths = presenceChecks
      .filter((check) => check.presence === "missing")
      .map((check) => check.filePath)
    const pathsToRead = presenceChecks
      .filter((check) => check.presence !== "missing")
      .map((check) => check.filePath)

    for (const filePath of missingPaths) {
      removeHeldPath(filePath)
    }
    await mapWithConcurrency({
      items: pathsToRead,
      concurrency: HELD_CHANGES_CONCURRENCY,
      mapper: indexHeldPath,
    })
  }

  /**
   * Brings the index up to date with the held paths, in one batch, then goes live:
   *
   * 1. Each path is checked against the disk; missing ones are removed first,
   *    so a rename seen whole in the batch resolves incoming links to the new path.
   * 2. The rest are read and indexed, 16 at a time; one that vanished by its read is removed.
   * 3. Events held while steps 1 and 2 ran are replayed live.
   *
   * Never rejects, and step 3 runs even if an earlier step threw: a watcher
   * left holding would drop every later change.
   */
  const applyHeldBatch = async (batchPaths: ReadonlyArray<string>): Promise<void> => {
    try {
      await reconcileHeldPaths(batchPaths)
    } catch (error) {
      logger.error("failed to apply the changes held during startup", {
        error: describeError(error),
      })
    }
    goLiveAndReplay(batchPaths.length)
  }

  const applyHeldChanges = (): { heldPathCount: number; applied: Promise<void> } => {
    if (!heldEvents) return { heldPathCount: 0, applied: Promise.resolve() }

    const batchEvents = heldEvents
    // Events arriving while the batch runs collect here and are replayed after it.
    heldEvents = []
    const batchPaths = [...new Set(batchEvents.map((heldEvent) => heldEvent.filePath))]

    return { heldPathCount: batchPaths.length, applied: applyHeldBatch(batchPaths) }
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

  return { ready, applyHeldChanges }
}

/**
 * Starts the watcher, builds the search index from disk, then applies the
 * changes the watcher saw meanwhile. The watcher is ready before the rebuild
 * reads anything and holds every change until the rebuild returns, so a change
 * landing mid-rebuild is applied after it instead of being missed or replaced
 * by the rebuild's older read. Resolves with the rebuild's result once the
 * held changes are indexed, or at heldChangesDeadline if they take longer;
 * the rest then apply in the background.
 */
export const watchVaultAndBuildIndex = async (
  vaultPath: string,
  search: SearchIndex,
  options?: FileWatcherOptions,
): ReturnType<SearchIndex["rebuildFromVault"]> => {
  const holdingWatcher = startHoldingWatcher(vaultPath, search, options)
  await holdingWatcher.ready

  const rebuildResult = await search.rebuildFromVault({ vaultPath }, logger)
  const { heldPathCount, applied } = holdingWatcher.applyHeldChanges()
  const heldChangesDeadline = options?.heldChangesDeadline ?? DEFAULT_HELD_CHANGES_DEADLINE_MS
  const { promise: deadlinePassed, resolve: passDeadline } = Promise.withResolvers<"deadline">()
  const deadlineTimer = setTimeout(() => passDeadline("deadline"), heldChangesDeadline)
  const waitForHeldChanges = async (): Promise<"applied"> => {
    await applied
    return "applied"
  }
  const outcome = await Promise.race([waitForHeldChanges(), deadlinePassed])
  clearTimeout(deadlineTimer)

  if (outcome === "deadline") {
    logger.info("startup continues while the changes held during it are still applied", {
      heldPaths: heldPathCount,
      heldChangesDeadline,
    })
  }
  return rebuildResult
}

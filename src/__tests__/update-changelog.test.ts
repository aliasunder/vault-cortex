import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Behavioral spec for the changelog updater
 * (.github/scripts/update-changelog.sh): where a release entry goes in
 * CHANGELOG.md, and the blank lines around it. The real script runs under
 * `bash` with real python3, in a fresh directory per test, with a stub `date`
 * first on PATH so every entry carries RELEASE_DATE.
 */

const SCRIPT_PATH = resolve(import.meta.dirname, "../../.github/scripts/update-changelog.sh")

const RELEASE_DATE = "2026-07-04"

/** Stub `date`: prints RELEASE_DATE for the format the script asks for, and
 *  fails on any other call. */
const DATE_STUB = `#!/bin/sh
if [ "$*" = "+%Y-%m-%d" ]; then
  echo ${RELEASE_DATE}
  exit 0
fi
echo "date stub: unexpected arguments: $*" >&2
exit 1
`

const NOTES = "### Bug Fixes\n\n- Handle a missing note (#2)\n"

const NEWER_NOTES = "### Features\n\n- Add search (#3)\n"

/** Two released entries in the shape the script writes them. */
const EARLIER_ENTRIES =
  "## [0.1.1] — 2026-01-02\n\n### Bug Fixes\n\n- Fix a thing (#1)\n\n" +
  "## [0.1.0] — 2026-01-01\n\n- First release\n"

const runnerPath = (): string => {
  const path = process.env.PATH

  if (!path) throw new Error("the changelog tests need a PATH")
  return path
}

type ScriptRun = { status: number | null; stdout: string; stderr: string }

type ReleaseDir = {
  /** Runs the script for the version with the notes file at notesPath. With
   *  stdinPath, standard input comes from that file, like a shell's `<`. */
  runScript: (params: {
    version: string
    notesPath: string
    extraEnv?: Record<string, string>
    stdinPath?: string
  }) => ScriptRun
  /** Writes the notes to a file outside the changelog's directory and runs
   *  the script with it; throws unless the run succeeds without output. */
  release: (params: { version: string; notes: string; extraEnv?: Record<string, string> }) => void
  readChangelog: () => string
  notesPathFor: (version: string) => string
}

/** A directory holding the given CHANGELOG.md, or none when changelog is null. */
const createReleaseDir = (changelog: string | null): ReleaseDir => {
  // realpath: macOS's tmpdir is a symlink.
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "update-changelog-")))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const stubDir = join(tempDir, "bin")
  const changelogDir = join(tempDir, "repo")
  const changelogPath = join(changelogDir, "CHANGELOG.md")

  mkdirSync(stubDir)
  writeFileSync(join(stubDir, "date"), DATE_STUB)
  chmodSync(join(stubDir, "date"), 0o755)
  mkdirSync(changelogDir)

  if (changelog !== null) {
    writeFileSync(changelogPath, changelog)
  }

  const notesPathFor = (version: string): string => join(tempDir, `notes-${version}.md`)

  const runScript: ReleaseDir["runScript"] = ({ version, notesPath, extraEnv, stdinPath }) => {
    // A file descriptor, not spawnSync's `input`: on Linux that input arrives
    // on a socket, which cannot be opened as /dev/stdin.
    const stdinFd = stdinPath ? openSync(stdinPath, "r") : undefined

    // 0 is a valid file descriptor, so compare with undefined.
    if (stdinFd !== undefined) onTestFinished(() => closeSync(stdinFd))

    const result = spawnSync("bash", [SCRIPT_PATH, version, notesPath], {
      cwd: changelogDir,
      env: { PATH: `${stubDir}:${runnerPath()}`, HOME: tempDir, ...extraEnv },
      encoding: "utf8",
      stdio: [stdinFd ?? "ignore", "pipe", "pipe"],
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  const release: ReleaseDir["release"] = ({ version, notes, extraEnv = {} }) => {
    const notesPath = notesPathFor(version)
    writeFileSync(notesPath, notes)
    const scriptRun = runScript({ version, notesPath, extraEnv })

    if (scriptRun.status !== 0 || scriptRun.stdout || scriptRun.stderr) {
      throw new Error(`update-changelog.sh failed: ${JSON.stringify(scriptRun)}`)
    }
  }

  const readChangelog = (): string => readFileSync(changelogPath, "utf8")

  return { runScript, release, readChangelog, notesPathFor }
}

describe("update-changelog.sh", () => {
  describe("placing the entry", () => {
    it("puts the entry under the title with one blank line on each side", () => {
      const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}`)

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })

    it("leaves earlier entries byte-identical and adds no blank lines over repeated releases", () => {
      const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}`)

      releaseDir.release({ version: "0.2.0", notes: NOTES })
      releaseDir.release({ version: "0.3.0", notes: NEWER_NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.3.0] — ${RELEASE_DATE}\n\n${NEWER_NOTES}\n` +
          `## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })

    it("keeps the text between the title and the first entry, then one blank line", () => {
      const releaseDir = createReleaseDir(
        `# Changelog\n\nAll notable changes.\n\n\n\n${EARLIER_ENTRIES}`,
      )

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\nAll notable changes.\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n` +
          EARLIER_ENTRIES,
      )
    })

    it("keeps one blank line below the entry when the notes end in blank lines", () => {
      const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}`)

      releaseDir.release({ version: "0.2.0", notes: `${NOTES}\n\n\n` })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })

    it("keeps one blank line below the entry when the notes have no final newline", () => {
      const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}`)

      releaseDir.release({ version: "0.2.0", notes: NOTES.trimEnd() })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })

    it("ends the file with a single newline when the changelog ends in blank lines", () => {
      const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}\n\n\n`)

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })
  })

  describe("the title", () => {
    it.each([
      { label: "missing", changelog: null },
      { label: "empty", changelog: "" },
      { label: "whitespace only", changelog: "\n\n  \n" },
    ])("writes a # Changelog title when the file is $label", ({ changelog }) => {
      const releaseDir = createReleaseDir(changelog)

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}`,
      )
    })

    it("adds a # Changelog title above entries that have none", () => {
      const releaseDir = createReleaseDir(EARLIER_ENTRIES)

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })

    it("keeps the file's own title when no entries follow it", () => {
      const releaseDir = createReleaseDir("# Release history\n")

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Release history\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}`,
      )
    })
  })

  describe("an [Unreleased] section", () => {
    it("is replaced when it sits above the newest entry", () => {
      const releaseDir = createReleaseDir(
        `# Changelog\n\n## [Unreleased]\n\n- pending item\n\n\n${EARLIER_ENTRIES}`,
      )

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })

    it("is replaced when it is the last section, leaving a single final newline", () => {
      const releaseDir = createReleaseDir("# Changelog\n\n## [Unreleased]\n\n- pending item\n\n")

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}`,
      )
    })

    it("is replaced, and a # Changelog title added, when it opens the file", () => {
      const releaseDir = createReleaseDir(`## [Unreleased]\n\n- pending item\n\n${EARLIER_ENTRIES}`)

      releaseDir.release({ version: "0.2.0", notes: NOTES })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
      )
    })

    it("is replaced by notes whose backslash sequences are written as-is", () => {
      const releaseDir = createReleaseDir(
        `# Changelog\n\n## [Unreleased]\n\n- pending item\n\n${EARLIER_ENTRIES}`,
      )
      const backslashNotes = "### Bug Fixes\n\n- Match \\d and \\n in C:\\temp, then \\1 (#2)\n"

      releaseDir.release({ version: "0.2.0", notes: backslashNotes })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${backslashNotes}\n${EARLIER_ENTRIES}`,
      )
    })
  })

  describe("empty notes", () => {
    it("writes the heading alone, with one blank line on each side", () => {
      const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}`)

      releaseDir.release({ version: "0.2.0", notes: "" })

      expect(releaseDir.readChangelog()).toBe(
        `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${EARLIER_ENTRIES}`,
      )
    })

    it("ends the file with a single newline after the heading when no entries follow", () => {
      const releaseDir = createReleaseDir("# Changelog\n")

      releaseDir.release({ version: "0.2.0", notes: "" })

      expect(releaseDir.readChangelog()).toBe(`# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n`)
    })
  })

  it("reads and writes UTF-8 under a locale whose encoding is ASCII", () => {
    const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}`)
    const nonAsciiNotes = "### ⚠ BREAKING CHANGES\n\n- Rename the café tool (#4)\n"

    releaseDir.release({
      version: "0.2.0",
      notes: nonAsciiNotes,
      // Python otherwise switches a C locale to UTF-8 (PEP 538, PEP 540).
      extraEnv: { LC_ALL: "C", PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0" },
    })

    expect(releaseDir.readChangelog()).toBe(
      `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${nonAsciiNotes}\n${EARLIER_ENTRIES}`,
    )
  })

  it("reads notes passed as /dev/stdin", () => {
    const releaseDir = createReleaseDir(`# Changelog\n\n${EARLIER_ENTRIES}`)
    const notesPath = releaseDir.notesPathFor("0.2.0")
    writeFileSync(notesPath, NOTES)

    const scriptRun = releaseDir.runScript({
      version: "0.2.0",
      notesPath: "/dev/stdin",
      stdinPath: notesPath,
    })

    expect({ scriptRun, changelog: releaseDir.readChangelog() }).toEqual({
      scriptRun: { status: 0, stdout: "", stderr: "" },
      changelog: `# Changelog\n\n## [0.2.0] — ${RELEASE_DATE}\n\n${NOTES}\n${EARLIER_ENTRIES}`,
    })
  })

  it("fails without changing CHANGELOG.md when the notes file is missing", () => {
    const changelog = `# Changelog\n\n${EARLIER_ENTRIES}`
    const releaseDir = createReleaseDir(changelog)
    const notesPath = releaseDir.notesPathFor("0.2.0")

    const { status, stdout, stderr } = releaseDir.runScript({ version: "0.2.0", notesPath })
    // Python's traceback ends with the error line, then a newline.
    const stderrErrorLine = stderr.split("\n").at(-2)

    expect({ status, stdout, stderrErrorLine, changelog: releaseDir.readChangelog() }).toEqual({
      status: 1,
      stdout: "",
      stderrErrorLine: `FileNotFoundError: [Errno 2] No such file or directory: '${notesPath}'`,
      changelog,
    })
  })
})

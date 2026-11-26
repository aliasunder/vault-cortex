import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { ghAnsweringPullRequests, WITH_GH_TOKEN } from "./helpers/gh-pull-request-stub.js"

/**
 * Behavioral spec for the server release-notes generator
 * (.github/scripts/generate-notes.sh): which commits between two tags the
 * notes list, and how they are grouped. The real script runs under `bash` with
 * real git and python3, in a fresh repository per test. GH_TOKEN is set only
 * for the pull-request tests, which put a stub `gh` on PATH.
 */

const SCRIPT_PATH = resolve(import.meta.dirname, "../../.github/scripts/generate-notes.sh")

const runnerPath = (): string => {
  const path = process.env.PATH

  if (!path) throw new Error("the release-notes tests need a PATH")
  return path
}

type PackageManifest = Record<string, unknown>

type Lockfile = {
  name: string
  lockfileVersion: number
  packages: Record<string, Record<string, unknown>>
}

/** The project the first release ships: one dependency the app installs
 *  (zod) and one dev dependency (vitest). */
const BASE_MANIFEST: PackageManifest = {
  name: "fixture",
  version: "1.0.0",
  dependencies: { zod: "^1.0.0" },
  devDependencies: { vitest: "^1.0.0" },
}

const BASE_LOCKFILE: Lockfile = {
  name: "fixture",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "fixture",
      version: "1.0.0",
      dependencies: { zod: "^1.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    },
    "node_modules/zod": { version: "1.0.0" },
    "node_modules/vitest": { version: "1.0.0", dev: true },
  },
}

const toJsonFile = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** File contents by repository path; null deletes the file. */
type FileChanges = Record<string, string | null>

type NotesRun = { status: number | null; stdout: string; stderr: string }

type NotesRunOptions = {
  /** Shell scripts by command name, placed ahead of the runner's PATH for the
   *  script run only. */
  stubCommands?: Record<string, string>
  /** Added to the script run's environment only. */
  extraEnv?: Record<string, string>
}

type ReleaseRepo = {
  /** Commits the changes with the message; no changes makes an empty commit.
   *  Returns the commit's hash. */
  commit: (message: string, changes: FileChanges) => string
  /** Deletes the commit's root tree object, so git still lists the commit but
   *  cannot diff it. */
  deleteRootTree: (commitHash: string) => void
  /** The folder the stub commands are written to. */
  stubDir: string
  /** Tags HEAD as the release under test and runs the script for it. */
  generateNotes: (options?: NotesRunOptions) => NotesRun
}

/** A stub command must be executable for the script to find it on PATH. */
const EXECUTABLE_MODE = 0o755

/** A repository whose first commit, tagged v0.1.0, holds the base manifests
 *  and a source file. */
const createReleaseRepo = (): ReleaseRepo => {
  // realpath: macOS's tmpdir is a symlink.
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "generate-notes-")))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const repoDir = join(tempDir, "repo")

  // Built from scratch, so the runner's git config (signing, hooks) and
  // GH_TOKEN never reach git or the script.
  const env = {
    PATH: runnerPath(),
    HOME: tempDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  }
  const git = (...args: string[]): string => {
    return execFileSync("git", ["-C", repoDir, ...args], { env, encoding: "utf8", stdio: "pipe" })
  }

  const commit = (message: string, changes: FileChanges): string => {
    for (const [path, content] of Object.entries(changes)) {
      const filePath = join(repoDir, path)

      if (content === null) {
        rmSync(filePath)
        continue
      }
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content)
    }
    git("add", "--all")
    git("commit", "--quiet", "--allow-empty", "--message", message)
    return git("rev-parse", "HEAD").trimEnd()
  }

  const deleteRootTree = (commitHash: string): void => {
    const treeHash = git("rev-parse", `${commitHash}^{tree}`).trimEnd()
    // A fresh repository stores each object loose, at objects/<2 hex>/<rest>.
    rmSync(join(repoDir, ".git", "objects", treeHash.slice(0, 2), treeHash.slice(2)))
  }

  mkdirSync(repoDir)
  git("init", "--quiet")
  commit("feat: first release", {
    "package.json": toJsonFile(BASE_MANIFEST),
    "package-lock.json": toJsonFile(BASE_LOCKFILE),
    "src/index.ts": "export {}\n",
  })
  git("tag", "v0.1.0")

  const stubDir = join(tempDir, "stub-bin")

  const pathWithStubs = (stubCommands: Record<string, string>): string => {
    mkdirSync(stubDir, { recursive: true })
    for (const [commandName, script] of Object.entries(stubCommands)) {
      writeFileSync(join(stubDir, commandName), script, { mode: EXECUTABLE_MODE })
    }
    return `${stubDir}:${runnerPath()}`
  }

  const generateNotes = ({ stubCommands = {}, extraEnv = {} }: NotesRunOptions = {}): NotesRun => {
    git("tag", "v0.2.0")
    const result = spawnSync("bash", [SCRIPT_PATH, "v0.2.0"], {
      cwd: repoDir,
      env: { ...env, ...extraEnv, PATH: pathWithStubs(stubCommands) },
      encoding: "utf8",
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  return { commit, deleteRootTree, stubDir, generateNotes }
}

/** A commit the notes always list, so a run that leaves out every commit
 *  ("No notable changes.") cannot pass a test that expects another commit
 *  to be left out. */
const commitListedFeature = (repo: ReleaseRepo): void => {
  repo.commit("feat: add search", { "src/search.ts": "export const search = 1\n" })
}

const LISTED_FEATURE_ONLY = "### Features\n\n- Add search\n"

/** The base lockfile with each install path's entry replaced; null removes
 *  the entry. */
const lockfileWith = (entries: Record<string, Record<string, unknown> | null>): Lockfile => {
  const replacedPackages = { ...BASE_LOCKFILE.packages, ...entries }
  const keptPackages = Object.entries(replacedPackages).flatMap(([installPath, entry]) => {
    return entry === null ? [] : [[installPath, entry] as const]
  })
  return { ...BASE_LOCKFILE, packages: Object.fromEntries(keptPackages) }
}

describe("generate-notes.sh", () => {
  describe("listing and grouping", () => {
    it("groups commits under headings in type order, newest first within a heading", () => {
      const repo = createReleaseRepo()
      repo.commit("fix(server): handle a missing note", { "src/a.ts": "a\n" })
      repo.commit("feat: add search", { "src/b.ts": "b\n" })
      repo.commit("feat(cli): add a flag", { "src/c.ts": "c\n" })
      repo.commit("Update the readme", { "README.md": "readme\n" })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### Features\n\n- **cli:** Add a flag\n- Add search\n\n" +
          "### Bug Fixes\n\n- **server:** Handle a missing note\n\n" +
          "### Other Changes\n\n- Update the readme\n",
        stderr: "",
      })
    })

    it("leads with breaking changes, described by the BREAKING CHANGE footer", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("feat!: rename the search tool\n\nBREAKING CHANGE: search is now find", {
        "src/search.ts": "export const find = 1\n",
      })

      expect(repo.generateNotes().stdout).toBe(
        "### ⚠ BREAKING CHANGES\n\n- search is now find\n\n" +
          "### Features\n\n- Rename the search tool\n- Add search\n",
      )
    })

    it("joins a wrapped BREAKING CHANGE footer into one line, ending at the blank line after it", () => {
      const repo = createReleaseRepo()
      repo.commit(
        "feat!: rename the search tool\n\n" +
          "BREAKING CHANGE: search is now\nfind.\n\nGenerated by a fixture.",
        { "src/search.ts": "export const find = 1\n" },
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool\n",
        stderr: "",
      })
    })

    it("joins a wrapped BREAKING CHANGE footer into one line, ending at the next trailer", () => {
      const repo = createReleaseRepo()
      repo.commit(
        "feat!: rename the search tool\n\n" +
          "BREAKING CHANGE: search is now\nfind.\n" +
          "Co-Authored-By: Fixture <fixture@example.com>",
        { "src/search.ts": "export const find = 1\n" },
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool\n",
        stderr: "",
      })
    })

    it("ends a wrapped BREAKING CHANGE footer at a Token #value trailer", () => {
      const repo = createReleaseRepo()
      repo.commit(
        "feat!: rename the search tool\n\nBREAKING CHANGE: search is now\nfind.\nRefs #42",
        {
          "src/search.ts": "export const find = 1\n",
        },
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool\n",
        stderr: "",
      })
    })

    it("reads a BREAKING CHANGE footer that follows another footer", () => {
      const repo = createReleaseRepo()
      repo.commit(
        "feat: rename the search tool\n\nRefs #42\nBREAKING CHANGE: search is now find.",
        {
          "src/search.ts": "export const find = 1\n",
        },
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool\n",
        stderr: "",
      })
    })

    it("lists a commit as not breaking when prose wraps onto a line starting BREAKING CHANGE:", () => {
      const repo = createReleaseRepo()
      repo.commit(
        "docs: document the footer\n\nThe guide explains the\nBREAKING CHANGE: footer and when to write it.",
        { "README.md": "footer\n" },
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "### Documentation\n\n- Document the footer\n",
        stderr: "",
      })
    })

    it("keeps a wrapped line that starts with a hyphen and # in the BREAKING CHANGE footer", () => {
      const repo = createReleaseRepo()
      repo.commit(
        "feat!: rename the search tool\n\nBREAKING CHANGE: search is now find, and\n- #12 is gone.",
        { "src/search.ts": "export const find = 1\n" },
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find, and - #12 is gone.\n\n" +
          "### Features\n\n- Rename the search tool\n",
        stderr: "",
      })
    })

    it("reads a BREAKING-CHANGE footer spelled with a hyphen", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool\n\nBREAKING-CHANGE: search is now find", {
        "src/search.ts": "export const find = 1\n",
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find\n\n" +
          "### Features\n\n- Rename the search tool\n",
        stderr: "",
      })
    })

    it("leaves out release bump commits", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("release: v0.2.0", { "src/version.ts": "0.2.0\n" })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("says there are no notable changes when every commit is left out", () => {
      const repo = createReleaseRepo()
      repo.commit("chore(deps-dev): bump a dev tool", { "src/tooling.ts": "tool\n" })
      repo.commit("docs: update the conventions", { "AGENTS.md": "conventions\n" })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "No notable changes.\n",
        stderr: "",
      })
    })
  })

  describe("breaking changes from the pull request", () => {
    it("takes a wrapped footer from the PR body when the commit has no mark", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)", {
        "src/search.ts": "export const find = 1\n",
      })
      const gh = ghAnsweringPullRequests({
        12: {
          body: "Renames the tool.\n\nBREAKING CHANGE: search is now\nfind.\n\nGenerated by a fixture.",
        },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n",
        stderr: "",
      })
    })

    it("prefers the PR body's footer to the commit body's", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)\n\nBREAKING CHANGE: search is renamed.", {
        "src/search.ts": "export const find = 1\n",
      })
      const gh = ghAnsweringPullRequests({ 12: { body: "BREAKING CHANGE: search is now find." } })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n",
        stderr: "",
      })
    })

    it("takes the description for a PR labeled breaking-change with no footer", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)", {
        "src/search.ts": "export const find = 1\n",
      })
      const gh = ghAnsweringPullRequests({
        12: { labels: ["enhancement", "breaking-change"], body: "Renames the tool." },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- Rename the search tool (#12)\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n",
        stderr: "",
      })
    })

    it("lists a commit as not breaking when its PR body quotes a footer in a code block", () => {
      const repo = createReleaseRepo()
      repo.commit("docs: show the footer format (#12)", { "README.md": "footer\n" })
      const gh = ghAnsweringPullRequests({
        12: { body: "Shows the footer format:\n\n```\nBREAKING CHANGE: describe the change\n```" },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout: "### Documentation\n\n- Show the footer format (#12)\n",
        stderr: "",
      })
    })

    it("lists a commit as not breaking when its PR has no footer and no breaking-change label", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)", {
        "src/search.ts": "export const find = 1\n",
      })
      const gh = ghAnsweringPullRequests({
        12: { labels: ["enhancement"], body: "Renames the tool." },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout: "### Features\n\n- Rename the search tool (#12)\n",
        stderr: "",
      })
    })

    it("warns about a failed PR lookup and lists a commit with no mark of its own as not breaking", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)", {
        "src/search.ts": "export const find = 1\n",
      })
      const failingGh = "#!/bin/sh\necho 'HTTP 502: Bad Gateway' >&2\nexit 1\n"

      expect(
        repo.generateNotes({ stubCommands: { gh: failingGh }, extraEnv: WITH_GH_TOKEN }),
      ).toEqual({
        status: 0,
        stdout: "### Features\n\n- Rename the search tool (#12)\n",
        stderr:
          "generate-notes: gh pr view #12 failed (exit 1): HTTP 502: Bad Gateway" +
          " — falling back to commit-only signals\n",
      })
    })

    it("warns about a failed PR lookup and keeps the commit's own marks", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)\n\nBREAKING CHANGE: search is now find.", {
        "src/search.ts": "export const find = 1\n",
      })
      const failingGh = "#!/bin/sh\necho 'HTTP 502: Bad Gateway' >&2\nexit 1\n"

      expect(
        repo.generateNotes({ stubCommands: { gh: failingGh }, extraEnv: WITH_GH_TOKEN }),
      ).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n",
        stderr:
          "generate-notes: gh pr view #12 failed (exit 1): HTTP 502: Bad Gateway" +
          " — falling back to commit-only signals\n",
      })
    })

    it("never calls gh without GH_TOKEN, and uses the commit's own marks", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)\n\nBREAKING CHANGE: search is now find.", {
        "src/search.ts": "export const find = 1\n",
      })
      const markerPath = join(repo.stubDir, "gh-was-called")
      const trapGh = `#!/bin/sh\ntouch '${markerPath}'\nexit 1\n`

      expect(repo.generateNotes({ stubCommands: { gh: trapGh } })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n",
        stderr: "",
      })
      expect(existsSync(markerPath)).toBe(false)
    })

    it("looks the PR up in the GITHUB_REPOSITORY repository", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)", {
        "src/search.ts": "export const find = 1\n",
      })
      const gh = ghAnsweringPullRequests(
        { 12: { labels: ["breaking-change"], body: "Renames the tool." } },
        { repo: "fixture-owner/fixture-repo" },
      )

      expect(
        repo.generateNotes({
          stubCommands: { gh },
          extraEnv: { ...WITH_GH_TOKEN, GITHUB_REPOSITORY: "fixture-owner/fixture-repo" },
        }),
      ).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- Rename the search tool (#12)\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n",
        stderr: "",
      })
    })

    it("warns about a PR lookup that prints no JSON and keeps the commit's own marks", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)\n\nBREAKING CHANGE: search is now find.", {
        "src/search.ts": "export const find = 1\n",
      })
      const garbledGh = "#!/bin/sh\necho 'Bad Gateway'\n"

      expect(
        repo.generateNotes({ stubCommands: { gh: garbledGh }, extraEnv: WITH_GH_TOKEN }),
      ).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n",
        stderr:
          "generate-notes: gh pr view #12 errored: Expecting value: line 1 column 1 (char 0)" +
          " — falling back to commit-only signals\n",
      })
    })

    it("lists a breaking line once when two PRs carry the same footer", () => {
      const repo = createReleaseRepo()
      repo.commit("feat: rename the search tool (#12)", {
        "src/search.ts": "export const find = 1\n",
      })
      repo.commit("docs: describe the find tool (#13)", { "README.md": "find\n" })
      const sharedFooter = "BREAKING CHANGE: search is now find."
      const gh = ghAnsweringPullRequests({
        12: { body: sharedFooter },
        13: { body: `Documents the rename.\n\n${sharedFooter}` },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n- search is now find.\n\n" +
          "### Features\n\n- Rename the search tool (#12)\n\n" +
          "### Documentation\n\n- Describe the find tool (#13)\n",
        stderr: "",
      })
    })
  })

  describe("contributor-only scopes", () => {
    it("leaves out a deps-dev commit", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("chore(deps-dev): bump a dev tool", { "src/tooling.ts": "tool\n" })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("leaves out a hooks commit even when it also changes files under src/", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("chore(hooks): install dependencies on worktree entry", {
        ".claude/hooks/install-deps.sh": "#!/bin/bash\n",
        "src/__tests__/install-deps.test.ts": "test\n",
      })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("leaves out a deps-dev commit git cannot diff, without a warning", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      const commitHash = repo.commit("chore(deps-dev): bump a dev tool", {
        "src/tooling.ts": "tool\n",
      })
      repo.deleteRootTree(commitHash)

      expect(repo.generateNotes()).toEqual({ status: 0, stdout: LISTED_FEATURE_ONLY, stderr: "" })
    })
  })

  describe("contributor-only paths", () => {
    it.each([
      { label: "AGENTS.md", path: "AGENTS.md" },
      { label: "CHANGELOG.md", path: "CHANGELOG.md" },
      { label: "a dotfile at the repository root", path: ".gitignore" },
      { label: "a file under .claude/", path: ".claude/settings.json" },
      { label: "a file under .devin/", path: ".devin/wiki.json" },
      { label: "a file under .husky/", path: ".husky/pre-commit" },
    ])("leaves out a commit that changes only $label", ({ path }) => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("docs: update contributor notes", { [path]: "contributor\n" })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("keeps a commit that changes only files under a dot-folder such as .github/", () => {
      const repo = createReleaseRepo()
      repo.commit("ci: run tests on push", { ".github/workflows/ci.yml": "on: push\n" })

      expect(repo.generateNotes().stdout).toBe("### CI / Infrastructure\n\n- Run tests on push\n")
    })

    it.each([
      { label: ".dockerignore, which decides what the image build copies", path: ".dockerignore" },
      { label: ".env.example, which DEPLOY.md has deployers copy", path: ".env.example" },
    ])("keeps a commit that changes only $label", ({ path }) => {
      const repo = createReleaseRepo()
      repo.commit("docs: update the deploy settings", { [path]: "setting\n" })

      expect(repo.generateNotes().stdout).toBe(
        "### Documentation\n\n- Update the deploy settings\n",
      )
    })

    it("keeps a commit that changes a contributor-only file and a shipped file", () => {
      const repo = createReleaseRepo()
      repo.commit("fix: handle empty notes", {
        "AGENTS.md": "conventions\n",
        "src/notes.ts": "notes\n",
      })

      expect(repo.generateNotes().stdout).toBe("### Bug Fixes\n\n- Handle empty notes\n")
    })

    it("keeps an empty commit", () => {
      const repo = createReleaseRepo()
      repo.commit("chore: trigger a release", {})

      expect(repo.generateNotes().stdout).toBe("### Maintenance\n\n- Trigger a release\n")
    })

    it("keeps a commit git cannot diff, and warns", () => {
      const repo = createReleaseRepo()
      // Changes only AGENTS.md, so a successful diff would leave it out.
      const commitHash = repo.commit("docs: update the conventions", {
        "AGENTS.md": "conventions\n",
      })
      repo.deleteRootTree(commitHash)

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "### Documentation\n\n- Update the conventions\n",
        stderr: expect.stringMatching(
          new RegExp(
            `^generate-notes: git diff-tree ${commitHash} failed \\(exit 128\\): ` +
              "fatal: .+ — listing the commit\\n$",
          ),
        ),
      })
    })
  })

  describe("dev-dependency-only commits", () => {
    it("leaves out a dev dependency bump that adds a dev-only package to the lockfile", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("chore(deps): bump vitest", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, devDependencies: { vitest: "^2.0.0" } }),
        "package-lock.json": toJsonFile(
          lockfileWith({
            "": { ...BASE_LOCKFILE.packages[""], devDependencies: { vitest: "^2.0.0" } },
            "node_modules/vitest": { version: "2.0.0", dev: true },
            "node_modules/tinypool": { version: "1.0.0", dev: true },
          }),
        ),
      })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("leaves out a commit that changes only devDependencies in package.json", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("chore(deps): widen the vitest range", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, devDependencies: { vitest: ">=1.0.0" } }),
      })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("leaves out a lockfile-only change that moves only dev-only packages", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("chore(deps): refresh the lockfile", {
        "package-lock.json": toJsonFile(
          lockfileWith({ "node_modules/vitest": { version: "1.0.1", dev: true } }),
        ),
      })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("leaves out an override that moves only dev-only packages", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("fix(deps): override esbuild for a security fix", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, overrides: { esbuild: "0.25.0" } }),
        "package-lock.json": toJsonFile(
          lockfileWith({ "node_modules/esbuild": { version: "0.25.0", dev: true } }),
        ),
      })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("leaves out an override the lockfile also records in the project's own entry", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("fix(deps): override esbuild for a security fix", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, overrides: { esbuild: "0.25.0" } }),
        "package-lock.json": toJsonFile(
          lockfileWith({
            "": { ...BASE_LOCKFILE.packages[""], overrides: { esbuild: "0.25.0" } },
            "node_modules/esbuild": { version: "0.25.0", dev: true },
          }),
        ),
      })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
    })

    it("keeps a commit that changes the dependencies the app installs", () => {
      const repo = createReleaseRepo()
      repo.commit("chore(deps): bump zod", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, dependencies: { zod: "^2.0.0" } }),
        "package-lock.json": toJsonFile(
          lockfileWith({
            "": { ...BASE_LOCKFILE.packages[""], dependencies: { zod: "^2.0.0" } },
            "node_modules/zod": { version: "2.0.0" },
          }),
        ),
      })

      expect(repo.generateNotes().stdout).toBe("### Maintenance\n\n- **deps:** Bump zod\n")
    })

    it("keeps a commit that changes a package.json field other than devDependencies or overrides", () => {
      const repo = createReleaseRepo()
      repo.commit("chore: add a start script", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, scripts: { start: "node ." } }),
      })

      expect(repo.generateNotes().stdout).toBe("### Maintenance\n\n- Add a start script\n")
    })

    it("keeps a dev dependency bump that also moves a package the app installs", () => {
      const repo = createReleaseRepo()
      repo.commit("chore(deps): bump vitest", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, devDependencies: { vitest: "^2.0.0" } }),
        "package-lock.json": toJsonFile(
          lockfileWith({
            "": { ...BASE_LOCKFILE.packages[""], devDependencies: { vitest: "^2.0.0" } },
            "node_modules/vitest": { version: "2.0.0", dev: true },
            "node_modules/zod": { version: "1.0.1" },
          }),
        ),
      })

      expect(repo.generateNotes().stdout).toBe("### Maintenance\n\n- **deps:** Bump vitest\n")
    })

    it("keeps a lockfile change that removes a package the app installs", () => {
      const repo = createReleaseRepo()
      repo.commit("chore(deps): prune the lockfile", {
        "package-lock.json": toJsonFile(lockfileWith({ "node_modules/zod": null })),
      })

      expect(repo.generateNotes().stdout).toBe(
        "### Maintenance\n\n- **deps:** Prune the lockfile\n",
      )
    })

    it("keeps a lockfile change to the project's own dependencies", () => {
      const repo = createReleaseRepo()
      repo.commit("chore(deps): sync the lockfile", {
        "package-lock.json": toJsonFile(
          lockfileWith({
            "": { ...BASE_LOCKFILE.packages[""], dependencies: { zod: "^1.1.0" } },
          }),
        ),
      })

      expect(repo.generateNotes().stdout).toBe("### Maintenance\n\n- **deps:** Sync the lockfile\n")
    })

    it("keeps a commit that deletes package-lock.json", () => {
      const repo = createReleaseRepo()
      repo.commit("chore: drop the lockfile", { "package-lock.json": null })

      expect(repo.generateNotes().stdout).toBe("### Maintenance\n\n- Drop the lockfile\n")
    })

    it("keeps a commit whose package-lock.json is not valid JSON, and warns", () => {
      const repo = createReleaseRepo()
      const commitHash = repo.commit("chore(deps): bump vitest", {
        "package.json": toJsonFile({ ...BASE_MANIFEST, devDependencies: { vitest: "^2.0.0" } }),
        "package-lock.json": "not json\n",
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "### Maintenance\n\n- **deps:** Bump vitest\n",
        stderr:
          `generate-notes: package-lock.json at ${commitHash} is not valid JSON ` +
          "(Expecting value: line 1 column 1 (char 0)) — listing the commit\n",
      })
    })

    it("keeps a commit whose package.json is not a JSON object, and warns", () => {
      const repo = createReleaseRepo()
      const commitHash = repo.commit("chore: empty the manifest", { "package.json": "[]\n" })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "### Maintenance\n\n- Empty the manifest\n",
        stderr:
          `generate-notes: package.json at ${commitHash} is not a JSON object ` +
          "— listing the commit\n",
      })
    })

    it("keeps a lockfile change when the lockfile has no packages map", () => {
      const repo = createReleaseRepo()
      // npm 6's lockfile format lists packages under `dependencies` instead.
      const npm6LockfileWithZod = (zodVersion: string): string => {
        return toJsonFile({
          name: "fixture",
          lockfileVersion: 1,
          dependencies: {
            zod: { version: zodVersion },
            vitest: { version: "1.0.0", dev: true },
          },
        })
      }
      repo.commit("chore: switch to the npm 6 lockfile", {
        "package-lock.json": npm6LockfileWithZod("1.0.0"),
      })
      repo.commit("fix(deps): bump zod", { "package-lock.json": npm6LockfileWithZod("1.0.1") })

      expect(repo.generateNotes().stdout).toBe(
        "### Bug Fixes\n\n- **deps:** Bump zod\n\n" +
          "### Maintenance\n\n- Switch to the npm 6 lockfile\n",
      )
    })

    it.each([
      { label: "an installed package's entry", installPath: "node_modules/vitest", entry: "1.0.1" },
      { label: "the project's own entry", installPath: "", entry: "fixture" },
      {
        label: "a new install path's entry, set to null",
        installPath: "node_modules/left-pad",
        entry: null,
      },
    ])("keeps a lockfile change where $label is not an object", ({ installPath, entry }) => {
      const repo = createReleaseRepo()
      repo.commit("chore(deps): bump vitest", {
        "package-lock.json": toJsonFile({
          ...BASE_LOCKFILE,
          packages: { ...BASE_LOCKFILE.packages, [installPath]: entry },
        }),
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "### Maintenance\n\n- **deps:** Bump vitest\n",
        stderr: "",
      })
    })
  })
})

import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Behavioral spec for the server release-notes generator
 * (.github/scripts/generate-notes.sh): which commits between two tags the
 * notes list, and how they are grouped. The real script runs under `bash` with
 * real git and python3, in a fresh repository per test. GH_TOKEN is never set,
 * so the script makes no pull-request lookups.
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

type ReleaseRepo = {
  /** Commits the changes with the message; no changes makes an empty commit.
   *  Returns the commit's hash. */
  commit: (message: string, changes: FileChanges) => string
  /** Tags HEAD as the release under test and runs the script for it. */
  generateNotes: () => NotesRun
}

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

  mkdirSync(repoDir)
  git("init", "--quiet")
  commit("feat: first release", {
    "package.json": toJsonFile(BASE_MANIFEST),
    "package-lock.json": toJsonFile(BASE_LOCKFILE),
    "src/index.ts": "export {}\n",
  })
  git("tag", "v0.1.0")

  const generateNotes = (): NotesRun => {
    git("tag", "v0.2.0")
    const result = spawnSync("bash", [SCRIPT_PATH, "v0.2.0"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  return { commit, generateNotes }
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

    it("leaves out release bump commits", () => {
      const repo = createReleaseRepo()
      commitListedFeature(repo)
      repo.commit("release: v0.2.0", { "src/version.ts": "0.2.0\n" })

      expect(repo.generateNotes().stdout).toBe(LISTED_FEATURE_ONLY)
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
  })
})

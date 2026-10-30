import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

/**
 * Behavioral spec for the CLI release-notes generator
 * (.github/scripts/generate-cli-notes.sh): which commits between two CLI tags
 * the notes list. The real script runs under `bash` with real git, in a fresh
 * repository per test.
 */

const SCRIPT_PATH = resolve(import.meta.dirname, "../../.github/scripts/generate-cli-notes.sh")

const runnerPath = (): string => {
  const path = process.env.PATH

  if (!path) throw new Error("the release-notes tests need a PATH")
  return path
}

const cliManifest = ({ version, zod }: { version: string; zod: string }): string => {
  const manifest = { name: "vault-cortex", version, dependencies: { zod } }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Shaped like cli/src/env.ts: .env template text inside a template literal,
 *  where a line starting with # is a comment. */
const envTemplateModule = ({ comment, setting }: { comment: string; setting: string }): string => {
  return `export const TEMPLATE = \`\n${comment}\n${setting}\n\`\n`
}

/** File contents by repository path; null deletes the file. */
type FileChanges = Record<string, string | null>

type NotesRun = { status: number | null; stdout: string; stderr: string }

type CliReleaseRepo = {
  commit: (message: string, changes: FileChanges) => void
  /** Tags HEAD as cli-v0.2.0 and runs the script for it. */
  generateNotes: () => NotesRun
}

/** A repository whose first commit holds a small cli/ package and a server
 *  file, tagged firstCommitTag. */
const createCliReleaseRepo = ({
  firstCommitTag = "cli-v0.1.0",
}: { firstCommitTag?: string } = {}): CliReleaseRepo => {
  // realpath: macOS's tmpdir is a symlink.
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "generate-cli-notes-")))
  onTestFinished(() => rmSync(tempDir, { recursive: true, force: true }))
  const repoDir = join(tempDir, "repo")

  // Built from scratch, so the runner's git config (signing, hooks, diff
  // prefixes) never reaches git or the script.
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

  const commit = (message: string, changes: FileChanges): void => {
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
  }

  mkdirSync(repoDir)
  git("init", "--quiet")
  commit("feat: first release", {
    "cli/package.json": cliManifest({ version: "0.1.0", zod: "^1.0.0" }),
    "cli/README.md": "# vault-cortex\n",
    "cli/src/env.ts": envTemplateModule({
      comment: "# Path to the vault",
      setting: "VAULT_PATH=/vault",
    }),
    "cli/src/program.ts": "export const flag = 1\n",
    "cli/src/__tests__/program.test.ts": "export const checks = 1\n",
    "src/server.ts": "export const server = 1\n",
  })
  git("tag", firstCommitTag)

  const generateNotes = (): NotesRun => {
    git("tag", "cli-v0.2.0")
    const result = spawnSync("bash", [SCRIPT_PATH, "cli-v0.2.0"], {
      cwd: repoDir,
      env,
      encoding: "utf8",
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  return { commit, generateNotes }
}

/** A commit the notes always list, so a run that lists nothing cannot pass a
 *  test that expects another commit to be left out. */
const commitListedCodeChange = (repo: CliReleaseRepo): void => {
  repo.commit("feat: add a flag", { "cli/src/program.ts": "export const flag = 2\n" })
}

const LISTED_CODE_CHANGE_ONLY = { status: 0, stdout: "- feat: add a flag\n", stderr: "" }

describe("generate-cli-notes.sh", () => {
  describe("listed commits", () => {
    it("lists a commit that changes code", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("lists a README change, headings included", () => {
      const repo = createCliReleaseRepo()
      repo.commit("docs(cli): add a usage heading", {
        "cli/README.md": "# vault-cortex\n\n## Usage\n",
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "- docs(cli): add a usage heading\n",
        stderr: "",
      })
    })

    it("lists a dependency change in cli/package.json", () => {
      const repo = createCliReleaseRepo()
      repo.commit("chore(deps): bump zod", {
        "cli/package.json": cliManifest({ version: "0.1.0", zod: "^1.1.0" }),
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "- chore(deps): bump zod\n",
        stderr: "",
      })
    })

    it("lists a commit that changes comment lines and a code line", () => {
      const repo = createCliReleaseRepo()
      repo.commit("fix(cli): rename the vault setting", {
        "cli/src/env.ts":
          "// The local template\n" +
          envTemplateModule({ comment: "# Vault folder", setting: "VAULT_DIR=/vault" }),
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "- fix(cli): rename the vault setting\n",
        stderr: "",
      })
    })

    it("lists a commented-out setting added to a .ts template", () => {
      const repo = createCliReleaseRepo()
      repo.commit("feat(cli): offer the log level setting", {
        "cli/src/env.ts": envTemplateModule({
          comment: "# Path to the vault",
          setting: "VAULT_PATH=/vault\n\n# How much the server logs\n# LOG_LEVEL=info",
        }),
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "- feat(cli): offer the log level setting\n",
        stderr: "",
      })
    })

    it("lists a heading added to an .md file git quotes, after .ts comments in the same commit", () => {
      const repo = createCliReleaseRepo()
      repo.commit("docs(cli): add a guide", {
        "cli/src/guide.ts": "// Points to the guide\n",
        "cli/ünïcode.md": "# Guide\n",
      })

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "- docs(cli): add a guide\n",
        stderr: "",
      })
    })

    it("lists every commit from the first when no earlier CLI tag exists, ignoring server tags", () => {
      const repo = createCliReleaseRepo({ firstCommitTag: "v0.1.0" })
      commitListedCodeChange(repo)

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "- feat: add a flag\n- feat: first release\n",
        stderr: "",
      })
    })
  })

  describe("left-out commits", () => {
    it("leaves out a .ts change made only of comment and blank lines", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("docs(cli): reword the template comments", {
        "cli/src/env.ts":
          "// Written to a new .env file\n" +
          "/**\n * The local template.\n */\n" +
          envTemplateModule({
            comment: "# Folder that holds your vault (default: VAULT_PATH=/vault)",
            setting: "VAULT_PATH=/vault\n",
          }),
      })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("leaves out a commit that adds comment lines to two .ts files", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("docs(cli): explain the template and the flag", {
        "cli/src/env.ts":
          "// Written to a new .env file\n" +
          envTemplateModule({ comment: "# Path to the vault", setting: "VAULT_PATH=/vault" }),
        "cli/src/program.ts": "// Read by the start command\nexport const flag = 2\n",
      })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it.each([
      { label: "a space", path: "cli/src/env notes.ts" },
      { label: "non-ASCII characters", path: "cli/src/ünïcode.ts" },
    ])("leaves out a comment-only change to a .ts file whose name has $label", ({ path }) => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("docs(cli): add a comment file", { [path]: "// A note\n" })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("leaves out a commit that deletes a .ts file holding only comments", () => {
      const repo = createCliReleaseRepo()
      repo.commit("docs(cli): add a note file", { "cli/src/notes.ts": "// A note\n" })
      commitListedCodeChange(repo)
      repo.commit("docs(cli): drop the note file", { "cli/src/notes.ts": null })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("leaves out a commit that changes only the version in cli/package.json", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("release(cli): v0.2.0", {
        "cli/package.json": cliManifest({ version: "0.2.0", zod: "^1.0.0" }),
      })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("leaves out a commit that changes only CLI tests", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("test(cli): cover the flag", {
        "cli/src/__tests__/program.test.ts": "export const checks = 2\n",
      })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("leaves out a commit that changes nothing under cli/", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("feat: add a server tool", { "src/server.ts": "export const server = 2\n" })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })
  })
})

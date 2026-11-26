import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { ghAnsweringPullRequests, WITH_GH_TOKEN } from "./helpers/gh-pull-request-stub.js"

/**
 * Behavioral spec for the CLI release-notes generator
 * (.github/scripts/generate-cli-notes.sh): which commits since the previous CLI
 * tag the notes list, and which of them lead the notes as breaking changes. The
 * real script runs under `bash` with real git, in a fresh repository per test.
 * Stub commands on PATH stand in for `gh`, and for `awk` or `git` in the
 * failure tests.
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

/** Shaped like cli/src/rules/env-templates.ts: .env template text inside a template literal,
 *  where a line starting with # is a comment. */
const envTemplateModule = ({ comment, setting }: { comment: string; setting: string }): string => {
  return `export const TEMPLATE = \`\n${comment}\n${setting}\n\`\n`
}

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

type CliReleaseRepo = {
  commit: (message: string, changes: FileChanges) => void
  headHash: () => string
  /** The folder the stub commands are written to. */
  stubDir: string
  tagHead: (tagName: string) => void
  /** Runs the script for a ref, such as HEAD, without tagging anything. */
  generateNotesFor: (ref: string, options?: NotesRunOptions) => NotesRun
  /** Tags HEAD as cli-v0.2.0 and runs the script for it. */
  generateNotes: (options?: NotesRunOptions) => NotesRun
}

/** A stub command must be executable for the script to find it on PATH. */
const EXECUTABLE_MODE = 0o755

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

  const headHash = (): string => git("rev-parse", "HEAD").trim()

  const stubDir = join(tempDir, "stub-bin")

  const pathWithStubs = (stubCommands: Record<string, string>): string => {
    mkdirSync(stubDir, { recursive: true })
    for (const [commandName, script] of Object.entries(stubCommands)) {
      writeFileSync(join(stubDir, commandName), script, { mode: EXECUTABLE_MODE })
    }
    return `${stubDir}:${runnerPath()}`
  }

  const tagHead = (tagName: string): void => {
    git("tag", tagName)
  }

  const generateNotesFor = (
    ref: string,
    { stubCommands = {}, extraEnv = {} }: NotesRunOptions = {},
  ): NotesRun => {
    const result = spawnSync("bash", [SCRIPT_PATH, ref], {
      cwd: repoDir,
      env: { ...env, ...extraEnv, PATH: pathWithStubs(stubCommands) },
      encoding: "utf8",
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  const generateNotes = (options: NotesRunOptions = {}): NotesRun => {
    tagHead("cli-v0.2.0")
    return generateNotesFor("cli-v0.2.0", options)
  }

  return { commit, headHash, stubDir, tagHead, generateNotesFor, generateNotes }
}

/** A commit the notes always list, so a run that lists nothing cannot pass a
 *  test that expects another commit to be left out. */
const commitListedCodeChange = (repo: CliReleaseRepo): void => {
  repo.commit("feat: add a flag", { "cli/src/program.ts": "export const flag = 2\n" })
}

const LISTED_CODE_CHANGE_ONLY = { status: 0, stdout: "- feat: add a flag\n", stderr: "" }

/** A commit the notes list, changing cli/src/start.ts to hold startValue. */
const commitStartChange = (repo: CliReleaseRepo, message: string, startValue = 1): void => {
  repo.commit(message, { "cli/src/start.ts": `export const start = ${startValue}\n` })
}

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

    it("leaves out a commit that changes only tests inside a CLI layer folder", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("test(cli): cover a command", {
        "cli/src/commands/__tests__/init.test.ts": "export const checks = 1\n",
      })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("leaves out a commit that changes nothing under cli/", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("feat: add a server tool", { "src/server.ts": "export const server = 2\n" })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("prints nothing when every commit under cli/ is left out", () => {
      const repo = createCliReleaseRepo()
      repo.commit("docs(cli): explain the flag", {
        "cli/src/program.ts": "// Read by the start command\nexport const flag = 1\n",
      })

      expect(repo.generateNotes()).toEqual({ status: 0, stdout: "", stderr: "" })
    })
  })

  describe("the previous CLI tag", () => {
    it("lists nothing for HEAD when HEAD carries the latest CLI tag", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.tagHead("cli-v0.2.0")

      expect(repo.generateNotesFor("HEAD")).toEqual({ status: 0, stdout: "", stderr: "" })
    })

    it("lists for HEAD only the commits after the latest CLI tag", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.tagHead("cli-v0.2.0")
      commitStartChange(repo, "feat(cli): add a start command")

      expect(repo.generateNotesFor("HEAD")).toEqual({
        status: 0,
        stdout: "- feat(cli): add a start command\n",
        stderr: "",
      })
    })

    it("lists for a release tag the commits since the CLI tag before it", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.tagHead("cli-v0.2.0")
      commitStartChange(repo, "feat(cli): add a start command")

      expect(repo.generateNotesFor("cli-v0.2.0")).toEqual(LISTED_CODE_CHANGE_ONLY)
    })

    it("lists for HEAD every commit from the first when no CLI tag exists, ignoring server tags", () => {
      const repo = createCliReleaseRepo({ firstCommitTag: "v0.1.0" })
      commitListedCodeChange(repo)

      expect(repo.generateNotesFor("HEAD")).toEqual({
        status: 0,
        stdout: "- feat: add a flag\n- feat: first release\n",
        stderr: "",
      })
    })

    // The release workflow checks the notes for HEAD before it commits the
    // version bump, and publishes the notes for the tag it puts on that commit.
    it("lists for HEAD the same commits as for the tag later put on its version bump", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      const headNotes = repo.generateNotesFor("HEAD")
      repo.commit("release(cli): v0.2.0", {
        "cli/package.json": cliManifest({ version: "0.2.0", zod: "^1.0.0" }),
      })

      expect({ headNotes, tagNotes: repo.generateNotes() }).toEqual({
        headNotes: LISTED_CODE_CHANGE_ONLY,
        tagNotes: LISTED_CODE_CHANGE_ONLY,
      })
    })
  })

  describe("breaking changes", () => {
    it("leads with a breaking section for a listed commit whose subject has !", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      commitStartChange(repo, "feat(cli)!: rename the start command")

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- feat(cli)!: rename the start command\n\n" +
          "### Changes\n\n" +
          "- feat(cli)!: rename the start command\n" +
          "- feat: add a flag\n",
        stderr: "",
      })
    })

    it.each([
      { label: "BREAKING CHANGE:", footer: "BREAKING CHANGE: run `up` instead of `start`." },
      { label: "BREAKING-CHANGE:", footer: "BREAKING-CHANGE: run `up` instead of `start`." },
    ])("takes the line from a $label footer in the commit body", ({ footer }) => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, `feat(cli): rename the start command\n\n${footer}`)

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command\n",
        stderr: "",
      })
    })

    it("takes the line from a footer in the PR body when the commit has no mark", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "feat(cli): rename the start command (#12)")
      const gh = ghAnsweringPullRequests({
        12: { body: "Renames the command.\n\nBREAKING CHANGE: run `up` instead of `start`." },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
    })

    it("prefers the PR body's footer to the commit body's", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command (#12)\n\nBREAKING CHANGE: start is renamed.",
      )
      const gh = ghAnsweringPullRequests({
        12: { body: "BREAKING CHANGE: run `up` instead of `start`." },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
    })

    it("joins a PR footer's wrapped lines into one line, ending at the blank line after it", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "feat(cli): rename the start command (#12)")
      const gh = ghAnsweringPullRequests({
        12: { body: "BREAKING CHANGE: run `up` instead of\n`start`.\n\nGenerated by a fixture." },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
    })

    it("joins a commit footer's wrapped lines into one line, ending at the next trailer", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command\n\n" +
          "BREAKING CHANGE: run `up` instead of\n`start`.\n" +
          "Co-Authored-By: Fixture <fixture@example.com>",
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command\n",
        stderr: "",
      })
    })

    it("ends a commit footer at a Token #value trailer", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command\n\nBREAKING CHANGE: run `up` instead of `start`.\nRefs #42",
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command\n",
        stderr: "",
      })
    })

    it("keeps a wrapped line that starts with a hyphen and # in a commit footer", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command\n\nBREAKING CHANGE: run `up` instead of\n- #12 `start`.",
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of - #12 `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command\n",
        stderr: "",
      })
    })

    it("takes the subject for a PR labeled breaking-change with no footer", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "feat(cli): rename the start command (#12)")
      const gh = ghAnsweringPullRequests({
        12: { labels: ["enhancement", "breaking-change"], body: "Renames the command." },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- feat(cli): rename the start command (#12)\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
    })

    it("reads a commit footer that follows another footer", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command\n\nRefs #42\nBREAKING CHANGE: run `up` instead of `start`.",
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command\n",
        stderr: "",
      })
    })

    it("reads a commit footer that follows a wrapped footer", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command\n\nRefs: #10,\n- #12\nBREAKING CHANGE: run `up` instead of `start`.",
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command\n",
        stderr: "",
      })
    })

    it("reads a footer that follows a bare BREAKING CHANGE: label in wrapped prose", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command\n\nThe guide explains the\nBREAKING CHANGE:\n\n" +
          "BREAKING CHANGE: run `up` instead of `start`.",
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command\n",
        stderr: "",
      })
    })

    it("lists a commit as not breaking when prose wraps onto a line starting BREAKING CHANGE:", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): document the footer\n\nThe guide explains the\nBREAKING CHANGE: footer and when to write it.",
      )

      expect(repo.generateNotes()).toEqual({
        status: 0,
        stdout: "- feat(cli): document the footer\n",
        stderr: "",
      })
    })

    it("lists a commit as not breaking when its PR body quotes a footer in a code block", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "docs(cli): show the footer format (#12)")
      const gh = ghAnsweringPullRequests({
        12: { body: "Shows the footer format:\n\n```\nBREAKING CHANGE: describe the change\n```" },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout: "- docs(cli): show the footer format (#12)\n",
        stderr: "",
      })
    })

    it("lists a commit as not breaking when its PR has no footer and no breaking-change label", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "feat(cli): rename the start command (#12)")
      const gh = ghAnsweringPullRequests({
        12: { labels: ["enhancement"], body: "Renames the command." },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout: "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
    })

    it("warns about a failed PR lookup and lists a commit with no mark of its own as not breaking", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "feat(cli): rename the start command (#12)")
      const failingGh = "#!/bin/sh\necho 'HTTP 502: Bad Gateway' >&2\nexit 1\n"

      expect(
        repo.generateNotes({ stubCommands: { gh: failingGh }, extraEnv: WITH_GH_TOKEN }),
      ).toEqual({
        status: 0,
        stdout: "- feat(cli): rename the start command (#12)\n",
        stderr:
          "generate-cli-notes: gh pr view #12 failed (exit 1): HTTP 502: Bad Gateway" +
          " — falling back to commit-only signals\n",
      })
    })

    it("warns about a failed PR lookup and keeps the commit's own marks", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command (#12)\n\nBREAKING CHANGE: start is renamed.",
      )
      const failingGh = "#!/bin/sh\necho 'HTTP 502: Bad Gateway' >&2\nexit 1\n"

      expect(
        repo.generateNotes({ stubCommands: { gh: failingGh }, extraEnv: WITH_GH_TOKEN }),
      ).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- start is renamed.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr:
          "generate-cli-notes: gh pr view #12 failed (exit 1): HTTP 502: Bad Gateway" +
          " — falling back to commit-only signals\n",
      })
    })

    it("never calls gh without GH_TOKEN, and uses the commit's own marks", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command (#12)\n\nBREAKING CHANGE: start is renamed.",
      )
      const markerPath = join(repo.stubDir, "gh-was-called")
      const trapGh = `#!/bin/sh\ntouch '${markerPath}'\nexit 1\n`

      expect(repo.generateNotes({ stubCommands: { gh: trapGh } })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- start is renamed.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
      expect(existsSync(markerPath)).toBe(false)
    })

    it("looks the PR up in the GITHUB_REPOSITORY repository", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "feat(cli): rename the start command (#12)")
      const gh = ghAnsweringPullRequests(
        { 12: { labels: ["breaking-change"], body: "Renames the command." } },
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
          "### ⚠ BREAKING CHANGES\n\n" +
          "- feat(cli): rename the start command (#12)\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
    })

    it("warns about a PR lookup that prints no JSON and keeps the commit's own marks", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(
        repo,
        "feat(cli): rename the start command (#12)\n\nBREAKING CHANGE: start is renamed.",
      )
      const garbledGh = "#!/bin/sh\necho 'Bad Gateway'\n"

      expect(
        repo.generateNotes({ stubCommands: { gh: garbledGh }, extraEnv: WITH_GH_TOKEN }),
      ).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- start is renamed.\n\n" +
          "### Changes\n\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr:
          "generate-cli-notes: gh pr view #12 errored: Expecting value: line 1 column 1 (char 0)" +
          " — falling back to commit-only signals\n",
      })
    })

    it("lists a breaking line once when two PRs carry the same footer", () => {
      const repo = createCliReleaseRepo()
      commitStartChange(repo, "feat(cli): rename the start command (#12)")
      commitStartChange(repo, "docs(cli): describe the up command (#13)", 2)
      const sharedFooter = "BREAKING CHANGE: run `up` instead of `start`."
      const gh = ghAnsweringPullRequests({
        12: { body: sharedFooter },
        13: { body: `Documents the rename.\n\n${sharedFooter}` },
      })

      expect(repo.generateNotes({ stubCommands: { gh }, extraEnv: WITH_GH_TOKEN })).toEqual({
        status: 0,
        stdout:
          "### ⚠ BREAKING CHANGES\n\n" +
          "- run `up` instead of `start`.\n\n" +
          "### Changes\n\n" +
          "- docs(cli): describe the up command (#13)\n" +
          "- feat(cli): rename the start command (#12)\n",
        stderr: "",
      })
    })

    it("leaves out a breaking commit that changes only CLI tests", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      repo.commit("test(cli)!: replace the init fixtures", {
        "cli/src/commands/__tests__/init.test.ts": "export const checks = 1\n",
      })

      expect(repo.generateNotes()).toEqual(LISTED_CODE_CHANGE_ONLY)
    })
  })

  describe("failures", () => {
    // The release workflow reads an exit status of 0 with empty output as a
    // release with nothing to list.
    it("stops with git's error for a ref that names no commit", () => {
      const repo = createCliReleaseRepo()

      expect(repo.generateNotesFor("cli-v9.9.9")).toEqual({
        status: 128,
        stdout: "",
        stderr: "fatal: bad revision 'cli-v9.9.9'\n",
      })
    })

    it("stops with git's exit status when reading the listed commits fails", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)
      const realGitPath = execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim()
      // Fails only the git log call that reads each listed commit's message.
      const gitFailingOnLog = [
        "#!/bin/sh",
        'case "$*" in',
        '  *--no-walk=unsorted*) echo "fatal: bad object" >&2; exit 128 ;;',
        "esac",
        `exec '${realGitPath}' "$@"`,
        "",
      ].join("\n")

      expect(repo.generateNotes({ stubCommands: { git: gitFailingOnLog } })).toEqual({
        status: 128,
        stdout: "",
        stderr: "fatal: bad object\n",
      })
    })

    it("stops with the commit's hash when the line classifier fails", () => {
      const repo = createCliReleaseRepo()
      commitListedCodeChange(repo)

      // awk exits 2 on its own errors, such as a program it cannot parse.
      const failingAwk = "#!/bin/sh\nexit 2\n"

      expect(repo.generateNotes({ stubCommands: { awk: failingAwk } })).toEqual({
        status: 1,
        stdout: "",
        stderr: `generate-cli-notes: could not classify ${repo.headHash()}\n`,
      })
    })
  })
})

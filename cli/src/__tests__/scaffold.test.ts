import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { buildFilesToWrite, readEnvPort, writeFiles } from "../scaffold.js"

const neverOverwrite = async (): Promise<boolean> => false
const alwaysOverwrite = async (): Promise<boolean> => true

describe("buildFilesToWrite", () => {
  it("plans a docker-compose.yml from the mode's template plus the generated .env", () => {
    const files = buildFilesToWrite("local", "MCP_AUTH_TOKEN=abc\n")

    expect(files.map((file) => file.name)).toEqual([
      "docker-compose.yml",
      ".env",
    ])
    const composeFile = files.find((file) => file.name === "docker-compose.yml")
    const envFile = files.find((file) => file.name === ".env")
    expect(composeFile?.content).toContain(
      "ghcr.io/aliasunder/vault-mcp:latest",
    )
    expect(envFile?.content).toBe("MCP_AUTH_TOKEN=abc\n")
  })

  it("plans the two-service remote compose with the forked sync image and no init-config-perms", () => {
    const files = buildFilesToWrite("remote", "MCP_AUTH_TOKEN=abc\n")
    const composeContent = files.find(
      (file) => file.name === "docker-compose.yml",
    )?.content

    expect(composeContent).toContain("obsidian-sync")
    expect(composeContent).toContain(
      "ghcr.io/aliasunder/obsidian-headless-sync-docker:latest",
    )
    expect(composeContent).not.toContain("init-config-perms")
  })
})

describe("writeFiles", () => {
  it("creates the target directory and writes all files", async () => {
    const targetDir = join(
      mkdtempSync(join(tmpdir(), "vault-cli-")),
      "nested",
      "vault-cortex",
    )

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [
          { name: "docker-compose.yml", content: "services: {}\n" },
          { name: ".env", content: "MCP_AUTH_TOKEN=abc\n" },
        ],
      },
      neverOverwrite,
    )

    expect(results).toEqual([
      { name: "docker-compose.yml", status: "created" },
      { name: ".env", status: "created" },
    ])
    expect(readFileSync(join(targetDir, "docker-compose.yml"), "utf8")).toBe(
      "services: {}\n",
    )
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=abc\n",
    )
  })

  it("skips an existing identical file without consulting the conflict resolver", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=abc\n")
    const failingResolver = async (): Promise<boolean> => {
      throw new Error("resolver must not be called for identical content")
    }

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n" }],
      },
      failingResolver,
    )

    expect(results).toEqual([{ name: ".env", status: "unchanged" }])
  })

  it("keeps a differing existing file untouched when the resolver declines", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n" }],
      },
      neverOverwrite,
    )

    expect(results).toEqual([{ name: ".env", status: "kept" }])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=old\n",
    )
  })

  it("overwrites a differing existing file when the resolver approves", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n" }],
      },
      alwaysOverwrite,
    )

    expect(results).toEqual([{ name: ".env", status: "overwritten" }])
    expect(readFileSync(join(targetDir, ".env"), "utf8")).toBe(
      "MCP_AUTH_TOKEN=new\n",
    )
  })

  it("resolves conflicts per file — keeps one and creates another in the same run", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const results = await writeFiles(
      {
        targetDir: targetDir,
        files: [
          { name: "docker-compose.yml", content: "services: {}\n" },
          { name: ".env", content: "MCP_AUTH_TOKEN=new\n" },
        ],
      },
      neverOverwrite,
    )

    expect(results).toEqual([
      { name: "docker-compose.yml", status: "created" },
      { name: ".env", status: "kept" },
    ])
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true)
  })
})

describe("readEnvPort", () => {
  it("returns the default 8000 when no .env exists", () => {
    const missingPath = join(tmpdir(), "vault-cli-no-such-env", ".env")

    expect(readEnvPort(missingPath)).toBe(8000)
  })

  it("returns the default 8000 when PORT is only present as a comment", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\n# PORT=9000\n")

    expect(readEnvPort(envPath)).toBe(8000)
  })

  it("returns an uncommented PORT override", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=abc\nPORT=9000\n")

    expect(readEnvPort(envPath)).toBe(9000)
  })
})

describe("writeFiles permissions", () => {
  it("creates .env owner-only (0600) via the file mode", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))

    await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n", mode: 0o600 }],
      },
      neverOverwrite,
    )

    const fileMode = statSync(join(targetDir, ".env")).mode & 0o777
    expect(fileMode).toBe(0o600)
  })

  it("tightens permissions when overwriting an existing wider-mode file", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    const envPath = join(targetDir, ".env")
    writeFileSync(envPath, "MCP_AUTH_TOKEN=old\n", { mode: 0o644 })

    await writeFiles(
      {
        targetDir: targetDir,
        files: [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n", mode: 0o600 }],
      },
      alwaysOverwrite,
    )

    const fileMode = statSync(envPath).mode & 0o777
    expect(fileMode).toBe(0o600)
  })
})

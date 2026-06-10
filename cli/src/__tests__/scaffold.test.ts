import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { planFiles, writeFiles } from "../scaffold.js"

const neverOverwrite = async (): Promise<boolean> => false
const alwaysOverwrite = async (): Promise<boolean> => true

describe("planFiles", () => {
  it("plans a docker-compose.yml from the mode's template plus the generated .env", () => {
    const files = planFiles("local", "MCP_AUTH_TOKEN=abc\n")

    expect(files.map((file) => file.name)).toEqual([
      "docker-compose.yml",
      ".env",
    ])
    expect(files[0].content).toContain("ghcr.io/aliasunder/vault-mcp:latest")
    expect(files[1].content).toBe("MCP_AUTH_TOKEN=abc\n")
  })

  it("plans the three-service compose file for remote mode", () => {
    const files = planFiles("remote", "MCP_AUTH_TOKEN=abc\n")

    expect(files[0].content).toContain("obsidian-sync")
    expect(files[0].content).toContain("init-config-perms")
  })
})

describe("writeFiles", () => {
  it("creates the target directory and writes all planned files", async () => {
    const targetDir = join(
      mkdtempSync(join(tmpdir(), "vault-cli-")),
      "nested",
      "vault-cortex",
    )

    const results = await writeFiles(
      targetDir,
      [
        { name: "docker-compose.yml", content: "services: {}\n" },
        { name: ".env", content: "MCP_AUTH_TOKEN=abc\n" },
      ],
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
      targetDir,
      [{ name: ".env", content: "MCP_AUTH_TOKEN=abc\n" }],
      failingResolver,
    )

    expect(results).toEqual([{ name: ".env", status: "unchanged" }])
  })

  it("keeps a differing existing file untouched when the resolver declines", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "vault-cli-"))
    writeFileSync(join(targetDir, ".env"), "MCP_AUTH_TOKEN=old\n")

    const results = await writeFiles(
      targetDir,
      [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n" }],
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
      targetDir,
      [{ name: ".env", content: "MCP_AUTH_TOKEN=new\n" }],
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
      targetDir,
      [
        { name: "docker-compose.yml", content: "services: {}\n" },
        { name: ".env", content: "MCP_AUTH_TOKEN=new\n" },
      ],
      neverOverwrite,
    )

    expect(results).toEqual([
      { name: "docker-compose.yml", status: "created" },
      { name: ".env", status: "kept" },
    ])
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true)
  })
})

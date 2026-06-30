import { describe, it, expect } from "vitest"
import { loadConfig } from "../config.js"

const EMPTY_ENV: Record<string, string | undefined> = {}

describe("loadConfig", () => {
  describe("defaults", () => {
    it("memoryDir defaults to About Me", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.memoryDir).toBe("About Me")
    })

    it("protectedPaths defaults to About Me and Daily Notes", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.protectedPaths).toEqual(["About Me", "Daily Notes"])
    })

    it("orphanExcludeFolders defaults to Daily Notes, Templates, About Me", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.orphanExcludeFolders).toEqual([
        "Daily Notes",
        "Templates",
        "About Me",
      ])
    })

    it("serviceDocumentationUrl defaults to the GitHub repo", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.serviceDocumentationUrl).toBe(
        "https://github.com/aliasunder/vault-cortex",
      )
    })

    it("windowsBindMount defaults to false", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.windowsBindMount).toBe(false)
    })

    it("memoryEnabled defaults to true", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.memoryEnabled).toBe(true)
    })

    it("returns a frozen (immutable) config object", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(Object.isFrozen(config)).toBe(true)
    })
  })

  describe("MEMORY_DIR", () => {
    it("uses the provided value", () => {
      const config = loadConfig({ MEMORY_DIR: "Profile" })
      expect(config.memoryDir).toBe("Profile")
    })

    it("cascades into protectedPaths when PROTECTED_PATHS is not set", () => {
      const config = loadConfig({ MEMORY_DIR: "Profile" })
      expect(config.protectedPaths).toEqual(["Profile", "Daily Notes"])
    })

    it("cascades into orphanExcludeFolders when ORPHAN_EXCLUDE_FOLDERS is not set", () => {
      const config = loadConfig({ MEMORY_DIR: "Profile" })
      expect(config.orphanExcludeFolders).toEqual([
        "Daily Notes",
        "Templates",
        "Profile",
      ])
    })

    it.each([
      { name: "trims whitespace", input: "  Profile  ", expected: "Profile" },
      {
        name: "strips trailing slashes",
        input: "Profile/",
        expected: "Profile",
      },
      {
        name: "strips multiple trailing slashes",
        input: "Profile///",
        expected: "Profile",
      },
      {
        name: "treats empty string as unset and uses default",
        input: "",
        expected: "About Me",
      },
      {
        name: "treats blank whitespace as unset and uses default",
        input: "   ",
        expected: "About Me",
      },
    ])("$name", ({ input, expected }) => {
      const config = loadConfig({ MEMORY_DIR: input })
      expect(config.memoryDir).toBe(expected)
    })

    it.each([
      {
        name: "rejects path traversal",
        input: "../secrets",
        message: "path traversal",
      },
      {
        name: "rejects absolute paths",
        input: "/etc/passwd",
        message: "absolute paths",
      },
    ])("$name", ({ input, message }) => {
      expect(() => loadConfig({ MEMORY_DIR: input })).toThrow(message)
    })

    it("accepts folder names with spaces", () => {
      const config = loadConfig({ MEMORY_DIR: "My Profile" })
      expect(config.memoryDir).toBe("My Profile")
    })

    it("accepts nested folder paths", () => {
      const config = loadConfig({ MEMORY_DIR: "My Vault/Memory" })
      expect(config.memoryDir).toBe("My Vault/Memory")
    })
  })

  describe("PROTECTED_PATHS (comma-separated)", () => {
    it("overrides the default entirely", () => {
      const config = loadConfig({ PROTECTED_PATHS: "Secrets,Archive" })
      expect(config.protectedPaths).toEqual(["Secrets", "Archive"])
    })

    it("does not include MEMORY_DIR when explicitly set", () => {
      const config = loadConfig({
        MEMORY_DIR: "Profile",
        PROTECTED_PATHS: "Secrets,Archive",
      })
      expect(config.protectedPaths).toEqual(["Secrets", "Archive"])
      expect(config.protectedPaths).not.toContain("Profile")
    })

    it("trims whitespace around entries", () => {
      const config = loadConfig({
        PROTECTED_PATHS: " Secrets , Archive ",
      })
      expect(config.protectedPaths).toEqual(["Secrets", "Archive"])
    })

    it("filters out empty entries from trailing commas", () => {
      const config = loadConfig({
        PROTECTED_PATHS: "Secrets,Archive,",
      })
      expect(config.protectedPaths).toEqual(["Secrets", "Archive"])
    })

    it("validates each entry", () => {
      expect(() =>
        loadConfig({ PROTECTED_PATHS: "Secrets,../escape" }),
      ).toThrow("path traversal")
    })
  })

  describe("ORPHAN_EXCLUDE_FOLDERS (comma-separated)", () => {
    it("overrides the default entirely", () => {
      const config = loadConfig({
        ORPHAN_EXCLUDE_FOLDERS: "Archive,Scratch",
      })
      expect(config.orphanExcludeFolders).toEqual(["Archive", "Scratch"])
    })

    it("does not include MEMORY_DIR when explicitly set", () => {
      const config = loadConfig({
        MEMORY_DIR: "Profile",
        ORPHAN_EXCLUDE_FOLDERS: "Archive,Scratch",
      })
      expect(config.orphanExcludeFolders).toEqual(["Archive", "Scratch"])
      expect(config.orphanExcludeFolders).not.toContain("Profile")
    })

    it("validates each entry", () => {
      expect(() => loadConfig({ ORPHAN_EXCLUDE_FOLDERS: "/absolute" })).toThrow(
        "absolute paths",
      )
    })
  })

  describe("SERVICE_DOCUMENTATION_URL", () => {
    it("uses the provided URL", () => {
      const config = loadConfig({
        SERVICE_DOCUMENTATION_URL: "https://github.com/myuser/my-fork",
      })
      expect(config.serviceDocumentationUrl).toBe(
        "https://github.com/myuser/my-fork",
      )
    })

    it("rejects invalid URLs", () => {
      expect(() =>
        loadConfig({ SERVICE_DOCUMENTATION_URL: "not-a-url" }),
      ).toThrow("Invalid URL")
    })
  })

  describe("WINDOWS_MODE", () => {
    it("defaults to false when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.windowsBindMount).toBe(false)
    })

    it("is true when set to 'true'", () => {
      const config = loadConfig({ WINDOWS_MODE: "true" })
      expect(config.windowsBindMount).toBe(true)
    })

    it("is false when set to 'false'", () => {
      const config = loadConfig({ WINDOWS_MODE: "false" })
      expect(config.windowsBindMount).toBe(false)
    })

    it("rejects a non-boolean value (fails fast at startup)", () => {
      expect(() => loadConfig({ WINDOWS_MODE: "yes" })).toThrow(/WINDOWS_MODE/)
    })
  })

  describe("RERANK_MODE", () => {
    it("defaults to 'blended' when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.rerankMode).toBe("blended")
    })

    it("accepts 'none'", () => {
      const config = loadConfig({ RERANK_MODE: "none" })
      expect(config.rerankMode).toBe("none")
    })

    it("accepts 'blended'", () => {
      const config = loadConfig({ RERANK_MODE: "blended" })
      expect(config.rerankMode).toBe("blended")
    })

    it("rejects an invalid value", () => {
      expect(() => loadConfig({ RERANK_MODE: "aggressive" })).toThrow()
    })
  })

  describe("EMBEDDING_ENABLED", () => {
    it("defaults to true when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.embeddingEnabled).toBe(true)
    })

    it("is true when set to 'true'", () => {
      const config = loadConfig({ EMBEDDING_ENABLED: "true" })
      expect(config.embeddingEnabled).toBe(true)
    })

    it("is false when set to 'false'", () => {
      const config = loadConfig({ EMBEDDING_ENABLED: "false" })
      expect(config.embeddingEnabled).toBe(false)
    })

    it("rejects a non-boolean value", () => {
      expect(() => loadConfig({ EMBEDDING_ENABLED: "yes" })).toThrow(
        /EMBEDDING_ENABLED/,
      )
    })
  })

  describe("MEMORY_ENABLED", () => {
    it("defaults to true when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.memoryEnabled).toBe(true)
    })

    it("is true when set to 'true'", () => {
      const config = loadConfig({ MEMORY_ENABLED: "true" })
      expect(config.memoryEnabled).toBe(true)
    })

    it("is false when set to 'false'", () => {
      const config = loadConfig({ MEMORY_ENABLED: "false" })
      expect(config.memoryEnabled).toBe(false)
    })

    it("rejects a non-boolean value", () => {
      expect(() => loadConfig({ MEMORY_ENABLED: "yes" })).toThrow(
        /MEMORY_ENABLED/,
      )
    })

    it("still parses MEMORY_DIR when disabled", () => {
      const config = loadConfig({
        MEMORY_ENABLED: "false",
        MEMORY_DIR: "Profile",
      })
      expect(config.memoryEnabled).toBe(false)
      expect(config.memoryDir).toBe("Profile")
    })

    it("still includes memoryDir in default protectedPaths when disabled", () => {
      const config = loadConfig({ MEMORY_ENABLED: "false" })
      expect(config.protectedPaths).toEqual(["About Me", "Daily Notes"])
    })
  })
})

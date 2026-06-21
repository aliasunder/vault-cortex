import { describe, it, expect } from "vitest"
import { loadConfig } from "../config.js"

const EMPTY_ENV: Record<string, string | undefined> = {}

describe("loadConfig", () => {
  describe("defaults", () => {
    it("returns correct defaults when no env vars are set", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.memoryDir).toBe("About Me")
      expect(config.protectedPaths).toEqual(["About Me", "Daily Notes"])
      expect(config.orphanExcludeFolders).toEqual([
        "Daily Notes",
        "Templates",
        "About Me",
      ])
      expect(config.serviceDocumentationUrl).toBe(
        "https://github.com/aliasunder/vault-cortex",
      )
      expect(config.windowsBindMount).toBe(false)
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

    it("trims whitespace", () => {
      const config = loadConfig({ MEMORY_DIR: "  Profile  " })
      expect(config.memoryDir).toBe("Profile")
    })

    it("strips trailing slashes", () => {
      const config = loadConfig({ MEMORY_DIR: "Profile/" })
      expect(config.memoryDir).toBe("Profile")
    })

    it("strips multiple trailing slashes", () => {
      const config = loadConfig({ MEMORY_DIR: "Profile///" })
      expect(config.memoryDir).toBe("Profile")
    })

    it("treats empty string as unset and uses default", () => {
      const config = loadConfig({ MEMORY_DIR: "" })
      expect(config.memoryDir).toBe("About Me")
    })

    it("treats blank whitespace as unset and uses default", () => {
      const config = loadConfig({ MEMORY_DIR: "   " })
      expect(config.memoryDir).toBe("About Me")
    })

    it("rejects path traversal", () => {
      expect(() => loadConfig({ MEMORY_DIR: "../secrets" })).toThrow(
        "path traversal",
      )
    })

    it("rejects absolute paths", () => {
      expect(() => loadConfig({ MEMORY_DIR: "/etc/passwd" })).toThrow(
        "absolute paths",
      )
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
      ).toThrow()
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
      expect(() => loadConfig({ WINDOWS_MODE: "yes" })).toThrow()
    })
  })
})

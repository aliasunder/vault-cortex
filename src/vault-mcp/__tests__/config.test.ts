import { describe, it, expect, vi, onTestFinished } from "vitest"
import { loadConfig } from "../config.js"
import { logger } from "../../logger.js"

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

  describe("DAILY_NOTES_FOLDER", () => {
    it("defaults to undefined when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.dailyNotesFolder).toBeUndefined()
    })

    it.each([
      { name: "treats empty string as unset", input: "" },
      { name: "treats blank whitespace as unset", input: "   " },
    ])("$name", ({ input }) => {
      const config = loadConfig({ DAILY_NOTES_FOLDER: input })
      expect(config.dailyNotesFolder).toBeUndefined()
    })

    it("uses the provided value", () => {
      const config = loadConfig({ DAILY_NOTES_FOLDER: "Journal" })
      expect(config.dailyNotesFolder).toBe("Journal")
    })

    it("cascades into protectedPaths when PROTECTED_PATHS is not set", () => {
      const config = loadConfig({ DAILY_NOTES_FOLDER: "Journal" })
      expect(config.protectedPaths).toEqual(["About Me", "Journal"])
    })

    it("cascades into orphanExcludeFolders when ORPHAN_EXCLUDE_FOLDERS is not set", () => {
      const config = loadConfig({ DAILY_NOTES_FOLDER: "Journal" })
      expect(config.orphanExcludeFolders).toEqual([
        "Journal",
        "Templates",
        "About Me",
      ])
    })

    it("does not cascade when PROTECTED_PATHS is explicitly set", () => {
      const config = loadConfig({
        DAILY_NOTES_FOLDER: "Journal",
        PROTECTED_PATHS: "Secrets,Archive",
      })
      expect(config.protectedPaths).toEqual(["Secrets", "Archive"])
    })

    it("accepts nested folder paths", () => {
      const config = loadConfig({ DAILY_NOTES_FOLDER: "Journal/Daily" })
      expect(config.dailyNotesFolder).toBe("Journal/Daily")
    })

    it("trims whitespace and strips trailing slashes", () => {
      const config = loadConfig({ DAILY_NOTES_FOLDER: "  Journal/  " })
      expect(config.dailyNotesFolder).toBe("Journal")
    })

    it("rejects path traversal", () => {
      expect(() => loadConfig({ DAILY_NOTES_FOLDER: "../escape" })).toThrow(
        "path traversal (..) not allowed",
      )
    })

    it("rejects absolute paths", () => {
      expect(() => loadConfig({ DAILY_NOTES_FOLDER: "/etc/notes" })).toThrow(
        "absolute paths not allowed",
      )
    })
  })

  describe("DAILY_NOTES_FORMAT", () => {
    it("defaults to undefined when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.dailyNotesFormat).toBeUndefined()
    })

    it.each([
      { name: "treats empty string as unset", input: "" },
      { name: "treats blank whitespace as unset", input: "   " },
    ])("$name", ({ input }) => {
      const config = loadConfig({ DAILY_NOTES_FORMAT: input })
      expect(config.dailyNotesFormat).toBeUndefined()
    })

    it("preserves the raw moment format string (no Luxon conversion)", () => {
      const config = loadConfig({ DAILY_NOTES_FORMAT: "DD-MM-YYYY" })
      expect(config.dailyNotesFormat).toBe("DD-MM-YYYY")
    })

    it("accepts a nested-folder format (YYYY/MM/DD)", () => {
      const config = loadConfig({ DAILY_NOTES_FORMAT: "YYYY/MM/DD" })
      expect(config.dailyNotesFormat).toBe("YYYY/MM/DD")
    })

    it("accepts a format with a [literal] escape", () => {
      const config = loadConfig({ DAILY_NOTES_FORMAT: "YYYY-MM-DD [Daily]" })
      expect(config.dailyNotesFormat).toBe("YYYY-MM-DD [Daily]")
    })

    it("rejects raw path traversal", () => {
      expect(() => loadConfig({ DAILY_NOTES_FORMAT: "../YYYY" })).toThrow(
        'env-var: "DAILY_NOTES_FORMAT" must not contain path traversal (..)',
      )
    })

    it("rejects a format that renders to path traversal ([.][.])", () => {
      expect(() => loadConfig({ DAILY_NOTES_FORMAT: "[.][.]" })).toThrow(
        'env-var: "DAILY_NOTES_FORMAT" must not contain path traversal (..)',
      )
    })

    it("rejects a leading path separator", () => {
      expect(() => loadConfig({ DAILY_NOTES_FORMAT: "/YYYY-MM-DD" })).toThrow(
        'env-var: "DAILY_NOTES_FORMAT" must not start with a path separator',
      )
    })

    it("rejects a format that renders to a leading path separator ([/]YYYY)", () => {
      expect(() => loadConfig({ DAILY_NOTES_FORMAT: "[/]YYYY" })).toThrow(
        'env-var: "DAILY_NOTES_FORMAT" must not start with a path separator',
      )
    })

    it("rejects a trailing path separator", () => {
      expect(() => loadConfig({ DAILY_NOTES_FORMAT: "YYYY/MM/DD/" })).toThrow(
        'env-var: "DAILY_NOTES_FORMAT" must not end with a path separator',
      )
    })

    it("rejects a format that renders to a trailing path separator (YYYY[/])", () => {
      expect(() => loadConfig({ DAILY_NOTES_FORMAT: "YYYY[/]" })).toThrow(
        'env-var: "DAILY_NOTES_FORMAT" must not end with a path separator',
      )
    })

    it("rejects a format that renders to an empty filename", () => {
      expect(() => loadConfig({ DAILY_NOTES_FORMAT: "[ ]" })).toThrow(
        'env-var: "DAILY_NOTES_FORMAT" renders to an empty filename',
      )
    })

    it("accepts a Do format and warns about unsupported token", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
      onTestFinished(() => warnSpy.mockRestore())
      const config = loadConfig({ DAILY_NOTES_FORMAT: "MMMM Do, YYYY" })
      expect(config.dailyNotesFormat).toBe("MMMM Do, YYYY")
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("unsupported token(s): Do"),
      )
    })

    it("accepts a dd format and warns about unsupported token", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
      onTestFinished(() => warnSpy.mockRestore())
      const config = loadConfig({ DAILY_NOTES_FORMAT: "YYYY-MM-DD dd" })
      expect(config.dailyNotesFormat).toBe("YYYY-MM-DD dd")
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("unsupported token(s): dd"),
      )
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
      expect(() => loadConfig({ RERANK_MODE: "aggressive" })).toThrow(
        /Invalid option/,
      )
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

  describe("FILE_TOOLS_ENABLED", () => {
    it("defaults to true when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.fileToolsEnabled).toBe(true)
    })

    it("is true when set to 'true'", () => {
      const config = loadConfig({ FILE_TOOLS_ENABLED: "true" })
      expect(config.fileToolsEnabled).toBe(true)
    })

    it("is false when set to 'false'", () => {
      const config = loadConfig({ FILE_TOOLS_ENABLED: "false" })
      expect(config.fileToolsEnabled).toBe(false)
    })

    it("rejects a non-boolean value", () => {
      expect(() => loadConfig({ FILE_TOOLS_ENABLED: "yes" })).toThrow(
        /FILE_TOOLS_ENABLED/,
      )
    })

    it("still parses MAX_FILE_BYTES when disabled", () => {
      const config = loadConfig({
        FILE_TOOLS_ENABLED: "false",
        MAX_FILE_BYTES: "10485760",
      })
      expect(config.fileToolsEnabled).toBe(false)
      expect(config.maxFileBytes).toBe(10_485_760)
    })

    it("still parses MAX_IMAGE_OUTPUT_BYTES when disabled", () => {
      const config = loadConfig({
        FILE_TOOLS_ENABLED: "false",
        MAX_IMAGE_OUTPUT_BYTES: "65536",
      })
      expect(config.fileToolsEnabled).toBe(false)
      expect(config.maxImageOutputBytes).toBe(65_536)
    })
  })

  describe("READONLY_MODE", () => {
    it("defaults to false when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.readOnlyMode).toBe(false)
    })

    it("is true when set to 'true'", () => {
      const config = loadConfig({ READONLY_MODE: "true" })
      expect(config.readOnlyMode).toBe(true)
    })

    it("is false when set to 'false'", () => {
      const config = loadConfig({ READONLY_MODE: "false" })
      expect(config.readOnlyMode).toBe(false)
    })

    it("rejects a non-boolean value", () => {
      expect(() => loadConfig({ READONLY_MODE: "yes" })).toThrow(
        /READONLY_MODE/,
      )
    })

    it("composes with MEMORY_ENABLED — both flags parse independently", () => {
      const config = loadConfig({
        READONLY_MODE: "true",
        MEMORY_ENABLED: "false",
      })
      expect(config.readOnlyMode).toBe(true)
      expect(config.memoryEnabled).toBe(false)
    })
  })

  describe("DISABLED_TOOLS (comma-separated)", () => {
    it("defaults to an empty set when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.disabledTools.size).toBe(0)
    })

    it("is an empty set when set to an empty string", () => {
      const config = loadConfig({ DISABLED_TOOLS: "" })
      expect(config.disabledTools.size).toBe(0)
    })

    it("parses a single tool name", () => {
      const config = loadConfig({ DISABLED_TOOLS: "vault_write_note" })
      expect([...config.disabledTools]).toEqual(["vault_write_note"])
    })

    it("parses multiple tool names and trims whitespace around each", () => {
      const config = loadConfig({
        DISABLED_TOOLS: "vault_write_note, vault_delete_note ,vault_move_note",
      })
      expect([...config.disabledTools].toSorted()).toEqual([
        "vault_delete_note",
        "vault_move_note",
        "vault_write_note",
      ])
    })

    it("drops empty entries from trailing or doubled commas", () => {
      const config = loadConfig({ DISABLED_TOOLS: "vault_write_note,," })
      expect([...config.disabledTools]).toEqual(["vault_write_note"])
    })

    it("deduplicates repeated names", () => {
      const config = loadConfig({
        DISABLED_TOOLS: "vault_write_note,vault_write_note",
      })
      expect([...config.disabledTools]).toEqual(["vault_write_note"])
    })

    it("rejects an unknown tool name, naming the offender", () => {
      expect(() => loadConfig({ DISABLED_TOOLS: "vault_wrote_note" })).toThrow(
        'env-var: "DISABLED_TOOLS" contains an unknown tool name: "vault_wrote_note"',
      )
    })

    it("rejects an unknown name even when valid names surround it", () => {
      expect(() =>
        loadConfig({
          DISABLED_TOOLS: "vault_write_note,not_a_tool,vault_delete_note",
        }),
      ).toThrow(
        'env-var: "DISABLED_TOOLS" contains an unknown tool name: "not_a_tool"',
      )
    })
  })

  describe("MAX_FILE_BYTES", () => {
    it("defaults to 50 MiB (52428800) when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.maxFileBytes).toBe(52_428_800)
    })

    it("accepts a custom positive integer", () => {
      const config = loadConfig({ MAX_FILE_BYTES: "10485760" })
      expect(config.maxFileBytes).toBe(10_485_760)
    })

    it("rejects a non-integer value", () => {
      expect(() => loadConfig({ MAX_FILE_BYTES: "abc" })).toThrow(
        /MAX_FILE_BYTES/,
      )
    })

    it.each(["0", "-1", "1.5"])("rejects non-positive-integer %s", (value) => {
      expect(() => loadConfig({ MAX_FILE_BYTES: value })).toThrow(
        /MAX_FILE_BYTES/,
      )
    })
  })

  describe("MAX_IMAGE_OUTPUT_BYTES", () => {
    it("defaults to 48 KiB (49152) when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.maxImageOutputBytes).toBe(49_152)
    })

    it("accepts a custom positive integer", () => {
      const config = loadConfig({ MAX_IMAGE_OUTPUT_BYTES: "65536" })
      expect(config.maxImageOutputBytes).toBe(65_536)
    })

    it("rejects a non-integer value", () => {
      expect(() => loadConfig({ MAX_IMAGE_OUTPUT_BYTES: "nope" })).toThrow(
        /MAX_IMAGE_OUTPUT_BYTES/,
      )
    })

    it.each(["0", "-1", "1.5"])("rejects non-positive-integer %s", (value) => {
      expect(() => loadConfig({ MAX_IMAGE_OUTPUT_BYTES: value })).toThrow(
        /MAX_IMAGE_OUTPUT_BYTES/,
      )
    })
  })

  describe("MAX_OAUTH_CLIENTS", () => {
    it("defaults to 1000 when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.maxOauthClients).toBe(1000)
    })

    it("accepts a custom positive integer", () => {
      const config = loadConfig({ MAX_OAUTH_CLIENTS: "25" })
      expect(config.maxOauthClients).toBe(25)
    })

    it("rejects a non-integer value", () => {
      expect(() => loadConfig({ MAX_OAUTH_CLIENTS: "abc" })).toThrow(
        /MAX_OAUTH_CLIENTS/,
      )
    })

    it.each(["0", "-1", "1.5"])("rejects non-positive-integer %s", (value) => {
      expect(() => loadConfig({ MAX_OAUTH_CLIENTS: value })).toThrow(
        /MAX_OAUTH_CLIENTS/,
      )
    })
  })

  describe("MAX_PDF_RENDER_PAGES", () => {
    it("defaults to 5 when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.maxPdfRenderPages).toBe(5)
    })

    it("accepts a custom positive integer", () => {
      const config = loadConfig({ MAX_PDF_RENDER_PAGES: "10" })
      expect(config.maxPdfRenderPages).toBe(10)
    })

    it("rejects a non-integer value", () => {
      expect(() => loadConfig({ MAX_PDF_RENDER_PAGES: "abc" })).toThrow(
        /MAX_PDF_RENDER_PAGES/,
      )
    })

    it.each(["0", "-1", "1.5"])("rejects non-positive-integer %s", (value) => {
      expect(() => loadConfig({ MAX_PDF_RENDER_PAGES: value })).toThrow(
        /MAX_PDF_RENDER_PAGES/,
      )
    })
  })

  describe("TRUST_PROXY_HOPS", () => {
    it("defaults to 0 when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.trustProxyHops).toBe(0)
    })

    it("accepts a custom non-negative integer", () => {
      const config = loadConfig({ TRUST_PROXY_HOPS: "2" })
      expect(config.trustProxyHops).toBe(2)
    })

    it("rejects a non-integer value", () => {
      expect(() => loadConfig({ TRUST_PROXY_HOPS: "abc" })).toThrow(
        /TRUST_PROXY_HOPS/,
      )
    })

    it.each(["-1", "1.5"])("rejects invalid hop count %s", (value) => {
      expect(() => loadConfig({ TRUST_PROXY_HOPS: value })).toThrow(
        /TRUST_PROXY_HOPS/,
      )
    })
  })

  describe("TRUST_FORWARDED_HEADER", () => {
    it("defaults to false when unset", () => {
      const config = loadConfig(EMPTY_ENV)
      expect(config.trustForwardedHeader).toBe(false)
    })

    it("is true when set to 'true'", () => {
      const config = loadConfig({ TRUST_FORWARDED_HEADER: "true" })
      expect(config.trustForwardedHeader).toBe(true)
    })

    it("is false when set to 'false'", () => {
      const config = loadConfig({ TRUST_FORWARDED_HEADER: "false" })
      expect(config.trustForwardedHeader).toBe(false)
    })

    it("rejects a non-boolean value", () => {
      expect(() => loadConfig({ TRUST_FORWARDED_HEADER: "yes" })).toThrow(
        /TRUST_FORWARDED_HEADER/,
      )
    })
  })
})

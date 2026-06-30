import { describe, it, expect, vi, afterEach } from "vitest"
import {
  captureRegistration,
  findCall,
  PROMPT_NAMES,
  loadConfig,
} from "./prompt-test-harness.js"

const ALL_PROMPT_NAMES = Object.values(PROMPT_NAMES)

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Registration ─────────────────────────────────────────────────

describe("registerPrompts — registration", () => {
  it(`registers exactly ${ALL_PROMPT_NAMES.length} prompts`, () => {
    const calls = captureRegistration()
    expect(calls).toHaveLength(ALL_PROMPT_NAMES.length)
  })

  it.each(ALL_PROMPT_NAMES)("registers %s", (name) => {
    const calls = captureRegistration()
    expect(calls.find((call) => call[0] === name)).toBeDefined()
  })

  it("every prompt has a non-empty title", () => {
    const calls = captureRegistration()
    for (const call of calls) {
      const [, config] = call
      expect(config.title).toEqual(expect.any(String))
      expect(config.title?.length).toBeGreaterThan(0)
    }
  })

  it("every prompt has a non-empty description", () => {
    const calls = captureRegistration()
    for (const call of calls) {
      const [, config] = call
      expect(config.description).toEqual(expect.any(String))
      expect(config.description?.length).toBeGreaterThan(0)
    }
  })

  it("vault-orientation is registered with no argsSchema (zero-arg)", () => {
    const calls = captureRegistration()
    const [, config] = findCall(calls, PROMPT_NAMES.VAULT_ORIENTATION)
    expect(config.argsSchema).toBeUndefined()
  })

  it("memory-review and daily-review expose an argsSchema", () => {
    const calls = captureRegistration()
    const [, memoryConfig] = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)
    const [, dailyConfig] = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)
    expect(memoryConfig.argsSchema).toBeDefined()
    expect(dailyConfig.argsSchema).toBeDefined()
  })

  it("memory-review and daily-review accept an optional max_chars argument", () => {
    const calls = captureRegistration()
    const [, memoryConfig] = findCall(calls, PROMPT_NAMES.MEMORY_REVIEW)
    const [, dailyConfig] = findCall(calls, PROMPT_NAMES.DAILY_REVIEW)
    expect(memoryConfig.argsSchema).toHaveProperty("max_chars")
    expect(dailyConfig.argsSchema).toHaveProperty("max_chars")
  })
})

// ── Genericness (works for any vault via MEMORY_DIR) ─────────────

describe("registerPrompts — genericness", () => {
  it("descriptions interpolate a custom MEMORY_DIR and never hardcode 'About Me/'", () => {
    const calls = captureRegistration(loadConfig({ MEMORY_DIR: "Profile" }))
    for (const promptName of [
      PROMPT_NAMES.VAULT_ORIENTATION,
      PROMPT_NAMES.MEMORY_REVIEW,
      PROMPT_NAMES.DAILY_REVIEW,
    ]) {
      const [, config] = findCall(calls, promptName)
      expect(config.description).toContain("Profile/")
      expect(config.description).not.toContain("About Me/")
    }
  })
})

// ── MEMORY_ENABLED=false ────────────────────────────────────────

describe("MEMORY_ENABLED=false", () => {
  const disabledConfig = loadConfig({ MEMORY_ENABLED: "false" })

  it("registers 2 prompts instead of 3", () => {
    const calls = captureRegistration(disabledConfig)
    expect(calls).toHaveLength(2)
  })
})

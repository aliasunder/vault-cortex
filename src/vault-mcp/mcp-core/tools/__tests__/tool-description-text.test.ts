import { describe, it, expect } from "vitest"
import { loadConfig } from "../../../config.js"
import { describeDailyNotesConfigErrorEntry } from "../tool-description-text.js"

describe("describeDailyNotesConfigErrorEntry", () => {
  it("lists the entry when the server reads daily-notes.json for the protected folder", () => {
    expect(describeDailyNotesConfigErrorEntry(loadConfig({}))).toBe(
      "\n- \"cannot read daily notes config from .obsidian/daily-notes.json\" — the file that names the protected daily notes folder can't be parsed; ask the vault's owner to repair it, or the server's operator to set DAILY_NOTES_FOLDER or PROTECTED_PATHS, then retry",
    )
  })

  it.each([
    { label: "PROTECTED_PATHS", env: { PROTECTED_PATHS: "Private" } },
    { label: "DAILY_NOTES_FOLDER", env: { DAILY_NOTES_FOLDER: "Journal" } },
    { label: "DAILY_NOTES_FOLDER set to the vault root", env: { DAILY_NOTES_FOLDER: "/" } },
  ])("is empty under $label, which bypasses the file", ({ env }) => {
    expect(describeDailyNotesConfigErrorEntry(loadConfig(env))).toBe("")
  })
})

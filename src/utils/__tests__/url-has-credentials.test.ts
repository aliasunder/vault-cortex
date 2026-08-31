import { describe, it, expect } from "vitest"
import { urlHasCredentials } from "../url-has-credentials.js"

describe("urlHasCredentials", () => {
  it("returns true for a username and password", () => {
    expect(
      urlHasCredentials(new URL("https://user:pass@mcp.example.com")),
    ).toBe(true)
  })

  it("returns true for a username alone", () => {
    expect(urlHasCredentials(new URL("https://user@mcp.example.com"))).toBe(
      true,
    )
  })

  it("returns true for a password alone", () => {
    expect(urlHasCredentials(new URL("https://:pass@mcp.example.com"))).toBe(
      true,
    )
  })

  it("returns false for a URL without userinfo", () => {
    expect(urlHasCredentials(new URL("https://mcp.example.com/mcp"))).toBe(
      false,
    )
  })
})

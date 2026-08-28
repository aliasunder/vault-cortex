import { describe, expect, it, onTestFinished } from "vitest"
import {
  ObsidianApiError,
  describeApiFailure,
  isMfaRequiredError,
  obsidianApi,
} from "../obsidian-api.js"
import { startFakeObsidianApi } from "./fake-obsidian-api.js"
import type { FakeApiRequest, FakeApiResponse } from "./fake-obsidian-api.js"

const startApi = async (
  respond: (request: FakeApiRequest) => FakeApiResponse,
) => {
  const api = await startFakeObsidianApi(respond)
  onTestFinished(api.close)
  return api
}

describe("obsidianApi.signIn", () => {
  it("posts the credentials with the Origin header the API requires and returns the token", async () => {
    const api = await startApi(() => ({
      body: { token: "tok-1", name: "Tanisha", email: "t@example.com" },
    }))

    const result = await obsidianApi.signIn({
      apiBaseUrl: api.baseUrl,
      email: "t@example.com",
      password: "pw",
      mfa: "",
    })

    expect(result).toEqual({ token: "tok-1", accountName: "Tanisha" })
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.path).toBe("/user/signin")
    expect(api.requests[0]?.headers.origin).toBe("https://obsidian.md")
    expect(api.requests[0]?.headers["content-type"]).toBe("application/json")
    expect(api.requests[0]?.body).toEqual({
      email: "t@example.com",
      password: "pw",
      mfa: "",
    })
  })

  it("falls back to the email as the account name when the API sends none", async () => {
    const api = await startApi(() => ({ body: { token: "tok-1" } }))

    const result = await obsidianApi.signIn({
      apiBaseUrl: api.baseUrl,
      email: "t@example.com",
      password: "pw",
      mfa: "",
    })

    expect(result.accountName).toBe("t@example.com")
  })

  it("throws ObsidianApiError with the API's own text when the body carries an error", async () => {
    const api = await startApi(() => ({
      body: { error: "Invalid email or password" },
    }))

    await expect(
      obsidianApi.signIn({
        apiBaseUrl: api.baseUrl,
        email: "t@example.com",
        password: "wrong",
        mfa: "",
      }),
    ).rejects.toThrow(new ObsidianApiError("Invalid email or password"))
  })

  it("throws on a non-200 status", async () => {
    const api = await startApi(() => ({ status: 503, body: {} }))

    await expect(
      obsidianApi.signIn({
        apiBaseUrl: api.baseUrl,
        email: "t@example.com",
        password: "pw",
        mfa: "",
      }),
    ).rejects.toThrow("Obsidian API answered HTTP 503")
  })

  it("throws when the response is not a JSON object", async () => {
    const api = await startApi(() => ({ body: ["not", "an", "object"] }))

    await expect(
      obsidianApi.signIn({
        apiBaseUrl: api.baseUrl,
        email: "t@example.com",
        password: "pw",
        mfa: "",
      }),
    ).rejects.toThrow("Obsidian API response is not a JSON object")
  })

  it("throws when a 200 response carries no token", async () => {
    const api = await startApi(() => ({ body: { name: "Tanisha" } }))

    await expect(
      obsidianApi.signIn({
        apiBaseUrl: api.baseUrl,
        email: "t@example.com",
        password: "pw",
        mfa: "",
      }),
    ).rejects.toThrow("Obsidian API sign-in response carries no token")
  })
})

describe("obsidianApi.listVaults", () => {
  it("sends the token with the supported encryption version and merges own and shared vaults", async () => {
    const api = await startApi(() => ({
      body: {
        vaults: [
          { id: "a", name: "Plain", password: "server-known", salt: "s" },
          { id: "b", name: "Locked", salt: "s", encryption_version: 3 },
        ],
        shared: [{ id: "c", name: "Team", password: "x" }],
      },
    }))

    const vaults = await obsidianApi.listVaults({
      apiBaseUrl: api.baseUrl,
      token: "tok-1",
    })

    expect(vaults).toEqual([
      { name: "Plain", encrypted: false },
      { name: "Locked", encrypted: true },
      { name: "Team", encrypted: false },
    ])
    expect(api.requests[0]?.path).toBe("/vault/list")
    expect(api.requests[0]?.body).toEqual({
      token: "tok-1",
      supported_encryption_version: 3,
    })
  })

  it("returns an empty list when the response has no vault arrays", async () => {
    const api = await startApi(() => ({ body: {} }))

    const vaults = await obsidianApi.listVaults({
      apiBaseUrl: api.baseUrl,
      token: "tok-1",
    })

    expect(vaults).toEqual([])
  })
})

describe("isMfaRequiredError", () => {
  it("is true for the API's first-attempt 2FA prompt", () => {
    expect(
      isMfaRequiredError(new ObsidianApiError("2FA code is required")),
    ).toBe(true)
  })

  it("is false for a wrong code", () => {
    expect(
      isMfaRequiredError(new ObsidianApiError("2FA code is incorrect")),
    ).toBe(false)
  })

  it("is false for other API errors and for non-API errors", () => {
    expect(isMfaRequiredError(new ObsidianApiError("Invalid password"))).toBe(
      false,
    )
    expect(isMfaRequiredError(new Error("2FA code is required"))).toBe(false)
  })
})

describe("describeApiFailure", () => {
  it("returns the API's text for an API error", () => {
    expect(describeApiFailure(new ObsidianApiError("Invalid password"))).toBe(
      "Invalid password",
    )
  })

  it("names a timeout without internals", () => {
    const timeout = new Error("aborted")
    timeout.name = "TimeoutError"
    expect(describeApiFailure(timeout)).toBe(
      "Obsidian's servers did not answer in time — try again.",
    )
  })

  it("wraps any other failure as a reachability problem", () => {
    expect(describeApiFailure(new Error("fetch failed"))).toBe(
      "Could not reach Obsidian's servers (fetch failed).",
    )
  })
})

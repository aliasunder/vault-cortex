import { describe, expect, it, onTestFinished } from "vitest"
import {
  ObsidianApiError,
  describeApiFailure,
  isMfaCodeError,
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
      body: { token: "tok-1", name: "Sample User", email: "user@example.com" },
    }))

    const result = await obsidianApi.signIn({
      apiBaseUrl: api.baseUrl,
      email: "user@example.com",
      password: "pw",
      mfa: "",
    })

    expect(result).toEqual({ token: "tok-1", accountEmail: "user@example.com" })
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.path).toBe("/user/signin")
    expect(api.requests[0]?.headers.origin).toBe("https://obsidian.md")
    expect(api.requests[0]?.headers["content-type"]).toBe("application/json")
    expect(api.requests[0]?.body).toEqual({
      email: "user@example.com",
      password: "pw",
      mfa: "",
    })
  })

  it("throws ObsidianApiError with the API's own text when the body carries an error", async () => {
    const api = await startApi(() => ({
      body: { error: "Invalid email or password" },
    }))

    await expect(
      obsidianApi.signIn({
        apiBaseUrl: api.baseUrl,
        email: "user@example.com",
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
        email: "user@example.com",
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
        email: "user@example.com",
        password: "pw",
        mfa: "",
      }),
    ).rejects.toThrow("Obsidian API response is not a JSON object")
  })

  it("throws when a 200 response carries no token", async () => {
    const api = await startApi(() => ({ body: { name: "Sample User" } }))

    await expect(
      obsidianApi.signIn({
        apiBaseUrl: api.baseUrl,
        email: "user@example.com",
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
          {
            id: "b",
            name: "Locked",
            password: "",
            salt: "s",
            host: "sync-1.example.com",
            encryption_version: 3,
          },
          { id: "d", name: "Legacy", salt: "s" },
          {
            id: "e",
            name: "Future",
            password: "",
            salt: "s",
            host: "sync-1.example.com",
            encryption_version: 4,
          },
        ],
        shared: [{ id: "c", name: "Team", password: "x" }],
      },
    }))

    const vaults = await obsidianApi.listVaults({
      apiBaseUrl: api.baseUrl,
      token: "tok-1",
    })

    // "Locked" mirrors the live API: an end-to-end encrypted vault comes back
    // with `password: ""`, not with the field missing. "Legacy" and "Future"
    // are encrypted but cannot be key-checked (missing host, unsupported
    // version).
    expect(vaults).toEqual([
      { name: "Plain", encrypted: false },
      {
        name: "Locked",
        encrypted: true,
        keyMaterial: {
          vaultId: "b",
          salt: "s",
          host: "sync-1.example.com",
          encryptionVersion: 3,
        },
      },
      { name: "Legacy", encrypted: true, keyMaterial: undefined },
      { name: "Future", encrypted: true, keyMaterial: undefined },
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

describe("obsidianApi.validateVaultKey", () => {
  const keyMaterial = {
    vaultId: "vault-1",
    salt: "s",
    host: "sync-1.example.com",
    encryptionVersion: 3,
  } as const

  it("posts the key hash with the vault's id, host, and version", async () => {
    const api = await startApi(() => ({ body: {} }))

    await obsidianApi.validateVaultKey({
      apiBaseUrl: api.baseUrl,
      token: "tok-1",
      keyMaterial,
      keyHash: "ab".repeat(32),
    })

    expect(api.requests.map((request) => request.path)).toEqual([
      "/vault/access",
    ])
    expect(api.requests[0]?.body).toEqual({
      token: "tok-1",
      vault_uid: "vault-1",
      keyhash: "ab".repeat(32),
      host: "sync-1.example.com",
      encryption_version: 3,
    })
  })

  it("throws ObsidianApiError with the API's own text when the vault rejects the key", async () => {
    const api = await startApi(() => ({
      body: { error: "Wrong vault key, please try again." },
    }))

    await expect(
      obsidianApi.validateVaultKey({
        apiBaseUrl: api.baseUrl,
        token: "tok-1",
        keyMaterial,
        keyHash: "ab".repeat(32),
      }),
    ).rejects.toThrow(
      new ObsidianApiError("Wrong vault key, please try again."),
    )
  })
})

describe("isMfaCodeError", () => {
  it("is true for both the code prompt and a wrong code", () => {
    expect(isMfaCodeError(new ObsidianApiError("2FA code is required"))).toBe(
      true,
    )
    expect(isMfaCodeError(new ObsidianApiError("2FA code is incorrect"))).toBe(
      true,
    )
  })

  it("is false for other API errors and for non-API errors", () => {
    expect(isMfaCodeError(new ObsidianApiError("Invalid password"))).toBe(false)
    expect(isMfaCodeError(new Error("2FA code is incorrect"))).toBe(false)
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

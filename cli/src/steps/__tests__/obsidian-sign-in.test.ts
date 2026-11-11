import { describe, expect, it } from "vitest"

import { captureObsidianToken } from "../obsidian-sign-in.js"
import {
  createScriptedPrompts,
  fetchApiError,
  fetchSigninSuccess,
} from "../../__tests__/command-stubs.js"

/** Builds a mock fetch that returns an HTTP error status. */
const fetchHttpError = (status: number): typeof fetch =>
  (async () => new Response(null, { status })) as typeof fetch

/** Builds a mock fetch that throws a network error. */
const fetchNetworkError = (message: string): typeof fetch =>
  (async () => {
    throw new Error(message)
  }) as typeof fetch

/** Builds a mock fetch that throws a timeout error. */
const fetchTimeout = (): typeof fetch =>
  (async () => {
    const error = new DOMException("The operation was aborted", "TimeoutError")
    throw error
  }) as typeof fetch

/** Builds a mock fetch that returns a non-JSON response. */
const fetchNonJson = (): typeof fetch =>
  (async () =>
    new Response("<html>Server Error</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch

/** Builds a mock fetch that returns 200 but no token field. */
const fetchMalformedSuccess = (): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ name: "User", email: "u@e.com" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch

/** Builds a mock fetch that returns valid JSON that is not an object (e.g. array). */
const fetchJsonNonObject = (): typeof fetch =>
  (async () =>
    new Response(JSON.stringify([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch

/**
 * Builds a mock fetch that requires MFA: first call returns the "2FA code"
 * error, second call with a valid MFA code succeeds.
 */
const fetchMfaRequired = (token = "mfa-sync-token"): typeof fetch => {
  let callCount = 0
  return (async () => {
    callCount += 1
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: "Your account requires a 2FA code" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ token }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

/**
 * Builds a mock fetch that requires MFA but the retry fails: first call
 * returns the "2FA code" error, second call returns a wrong-code rejection.
 */
const fetchMfaRetryFail = (retryError: string): typeof fetch => {
  let callCount = 0
  return (async () => {
    callCount += 1
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: "Your account requires a 2FA code" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ error: retryError }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

describe("captureObsidianToken", () => {
  it("returns the token on successful sign-in", async () => {
    const scripted = createScriptedPrompts([
      "user@example.com", // email
      "secret123", // password
    ])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchSigninSuccess("abc123-sync-token"),
    })

    expect(token).toBe("abc123-sync-token")
    expect(scripted.spinnerMessages).toEqual([
      "start: Signing in to Obsidian...",
      "stop: Signed in as user@example.com.",
    ])
  })

  it("prompts for MFA when the API requires it and succeeds on retry", async () => {
    const scripted = createScriptedPrompts([
      "mfa@example.com", // email
      "password", // password
      "123456", // MFA code
    ])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchMfaRequired("mfa-token"),
    })

    expect(token).toBe("mfa-token")
    expect(scripted.asked).toEqual(["Obsidian account email:", "Password:", "2FA code:"])
    expect(scripted.spinnerMessages).toEqual([
      "start: Signing in to Obsidian...",
      "stop: Two-factor authentication required.",
      "start: Verifying...",
      "stop: Signed in as mfa@example.com.",
    ])
  })

  it("returns undefined when the MFA code is incorrect", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchApiError("2FA code is incorrect"),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe("Could not sign in: 2FA code is incorrect")
  })

  it("returns undefined with retry guidance when MFA retry fails", async () => {
    const scripted = createScriptedPrompts([
      "user@example.com", // email
      "password", // password
      "000000", // wrong MFA code
    ])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchMfaRetryFail("2FA code is incorrect"),
    })

    expect(token).toBeUndefined()
    expect(scripted.asked).toEqual(["Obsidian account email:", "Password:", "2FA code:"])
    expect(scripted.warnings[0]).toBe(
      "Could not sign in: 2FA code is incorrect\n" + "  Check your 2FA code and try again.",
    )
    expect(scripted.spinnerMessages).toEqual([
      "start: Signing in to Obsidian...",
      "stop: Two-factor authentication required.",
      "start: Verifying...",
      "stop: Sign-in failed.",
    ])
  })

  it("shows a timeout message when the MFA retry times out", async () => {
    let callCount = 0
    const fetchMfaThenTimeout: typeof fetch = (async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "Your account requires a 2FA code" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new DOMException("The operation was aborted", "TimeoutError")
    }) as typeof fetch

    const scripted = createScriptedPrompts(["user@example.com", "password", "123456"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchMfaThenTimeout,
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe(
      "Request timed out — check your internet connection and try again.",
    )
  })

  it("omits 2FA hint when the MFA retry fails with a network error", async () => {
    let callCount = 0
    const fetchMfaThenNetworkError: typeof fetch = (async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "Your account requires a 2FA code" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error("fetch failed")
    }) as typeof fetch

    const scripted = createScriptedPrompts(["user@example.com", "password", "123456"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchMfaThenNetworkError,
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe("Could not sign in: fetch failed")
  })

  it("returns undefined on wrong password", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "wrong-password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchApiError("Invalid email or password"),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe("Could not sign in: Invalid email or password")
  })

  it("returns undefined on HTTP error", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchHttpError(500),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe("Could not sign in: HTTP Error 500")
  })

  it("returns undefined with a clear message on HTTP 429", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchHttpError(429),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe("Could not sign in: HTTP Error 429")
  })

  it("returns undefined on network error", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchNetworkError("fetch failed"),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe("Could not sign in: fetch failed")
  })

  it("returns undefined with a timeout message when the request times out", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchTimeout(),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe(
      "Request timed out — check your internet connection and try again.",
    )
  })

  it("returns undefined on non-JSON response", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchNonJson(),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toMatch(
      /^Could not sign in: Unexpected response from Obsidian API \(/,
    )
  })

  it("returns undefined when the response is valid JSON but not an object", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchJsonNonObject(),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe(
      "Could not sign in: Unexpected response from Obsidian API (not a JSON object)",
    )
  })

  it("returns undefined when the response is missing the token field", async () => {
    const scripted = createScriptedPrompts(["user@example.com", "password"])

    const token = await captureObsidianToken({
      prompts: scripted.prompts,
      fetchFn: fetchMalformedSuccess(),
    })

    expect(token).toBeUndefined()
    expect(scripted.warnings[0]).toBe(
      "Could not sign in: Unexpected response from Obsidian API (no token field)",
    )
  })
})

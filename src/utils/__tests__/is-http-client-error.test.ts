import { describe, expect, it } from "vitest"
import { isHttpClientError } from "../is-http-client-error.js"

describe("isHttpClientError", () => {
  it.each([
    { label: "bad request", status: 400 },
    { label: "too large", status: 413 },
    { label: "last client-error status", status: 499 },
  ])("recognises a $label http-error", ({ status }) => {
    const error = Object.assign(new Error("invalid body"), { status, expose: true })

    expect(isHttpClientError(error)).toBe(true)
  })

  it.each([
    { label: "plain error", error: new Error("boom") },
    {
      label: "server http-error",
      error: Object.assign(new Error("boom"), { status: 500, expose: true }),
    },
    { label: "private error", error: { status: 400, expose: false } },
    { label: "string status", error: { status: "400", expose: true } },
    { label: "fractional status", error: { status: 400.5, expose: true } },
    { label: "redirect", error: { status: 300, expose: true } },
    { label: "status below the client-error boundary", error: { status: 399, expose: true } },
    { label: "missing exposure flag", error: { status: 400 } },
    { label: "missing status", error: { expose: true } },
    { label: "truthy exposure flag", error: { status: 400, expose: "true" } },
    { label: "string", error: "invalid body" },
    { label: "undefined", error: undefined },
    { label: "null", error: null },
  ])("rejects a $label", ({ error }) => {
    expect(isHttpClientError(error)).toBe(false)
  })
})

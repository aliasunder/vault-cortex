import { describe, expect, it } from "vitest"

import { pollHealth } from "../docker.js"

const okResponse = { ok: true } as Response
const failResponse = { ok: false } as Response

describe("pollHealth", () => {
  it("returns true as soon as the endpoint responds ok", async () => {
    const fetchStub = async (): Promise<Response> => okResponse

    const healthy = await pollHealth(
      { url: "http://127.0.0.1:8000/healthz", timeoutMs: 100, intervalMs: 1 },
      fetchStub,
    )

    expect(healthy).toBe(true)
  })

  it("keeps polling through connection errors until the endpoint comes up", async () => {
    const responses: Array<() => Promise<Response>> = [
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => Promise.resolve(failResponse),
      () => Promise.resolve(okResponse),
    ]
    const fetchStub = (): Promise<Response> => {
      const nextResponse = responses.shift()
      if (nextResponse === undefined)
        throw new Error("fetch called after success")
      return nextResponse()
    }

    const healthy = await pollHealth(
      { url: "http://127.0.0.1:8000/healthz", timeoutMs: 1_000, intervalMs: 1 },
      fetchStub as typeof fetch,
    )

    expect(healthy).toBe(true)
    expect(responses).toHaveLength(0)
  })

  it("returns false when the endpoint never responds within the timeout", async () => {
    const fetchStub = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED")
    }

    const healthy = await pollHealth(
      { url: "http://127.0.0.1:8000/healthz", timeoutMs: 20, intervalMs: 1 },
      fetchStub,
    )

    expect(healthy).toBe(false)
  })
})

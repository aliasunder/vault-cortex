import { describe, it, expect, onTestFinished } from "vitest"
import type { Server } from "node:http"
import express from "express"
import { securityHeaders } from "../security-headers.js"

const startApp = async (): Promise<string> => {
  const app = express()
  app.use(securityHeaders)
  app.get("/page", (_req, res) => {
    res.send("page body")
  })
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const serverAddress = server.address()

  if (!serverAddress || typeof serverAddress === "string") {
    throw new Error("expected a TCP address from a listening server")
  }
  return `http://127.0.0.1:${serverAddress.port}`
}

describe("securityHeaders", () => {
  it("sets the framing, sniffing and referrer headers, then hands the request on", async () => {
    const baseUrl = await startApp()

    const response = await fetch(`${baseUrl}/page`)

    expect({
      frameOptions: response.headers.get("x-frame-options"),
      contentSecurityPolicy: response.headers.get("content-security-policy"),
      contentTypeOptions: response.headers.get("x-content-type-options"),
      referrerPolicy: response.headers.get("referrer-policy"),
    }).toEqual({
      frameOptions: "DENY",
      contentSecurityPolicy: "frame-ancestors 'none'",
      contentTypeOptions: "nosniff",
      referrerPolicy: "same-origin",
    })
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe("page body")
  })
})

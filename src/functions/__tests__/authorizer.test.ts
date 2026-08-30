import { describe, it, expect, vi, onTestFinished } from "vitest"
import { createHmac } from "node:crypto"
import { DateTime } from "luxon"
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda"
import { signJwt } from "../../jwt.js"

const SECRET = "test-lambda-secret"
const PUBLIC_URL = "https://mcp.example.com"

// `Resource` is a Proxy that throws on any read outside a deployed
// function, so the mock must replace the module rather than spy on it.
vi.mock("sst", () => ({
  Resource: {
    McpAuthToken: { value: SECRET },
  },
}))
vi.stubEnv("PUBLIC_URL", PUBLIC_URL)

// Records every log message so a denial can be pinned to the guard that
// produced it — the PUBLIC_URL guards are otherwise indistinguishable
// from the outside (both return { isAuthorized: false }).
type RecordedLog = { level: "info" | "warn" | "error"; message: string }
const recordedLogs: RecordedLog[] = []
vi.mock("../../logger.js", () => {
  const recordingLogger = {
    debug: () => {},
    info: (message: string) => {
      recordedLogs.push({ level: "info", message })
    },
    warn: (message: string) => {
      recordedLogs.push({ level: "warn", message })
    },
    error: (message: string) => {
      recordedLogs.push({ level: "error", message })
    },
    child: () => recordingLogger,
  }
  return { logger: recordingLogger }
})

const { handler } = await import("../authorizer.js")

const protectedRequest = (
  authorization: string,
): APIGatewayRequestAuthorizerEventV2 => {
  return {
    rawPath: "/mcp",
    headers: { authorization },
    requestContext: {
      requestId: "req-1",
      http: { sourceIp: "203.0.113.7" },
    },
  } as unknown as APIGatewayRequestAuthorizerEventV2
}

const accessToken = (claims: { iss: string; aud: string }): string => {
  return signJwt(
    {
      sub: "client-1",
      scope: "vault",
      exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
      ...claims,
    },
    SECRET,
  )
}

/** An access token in the shape minted before tokens were bound to a
 *  server (literal issuer, no `aud`) — signed by hand because `signJwt`
 *  only accepts the bound shape. */
const preBindingToken = (secret: string): string => {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url")
  const body = Buffer.from(
    JSON.stringify({
      sub: "client-1",
      scope: "vault",
      exp: DateTime.now().plus({ hours: 1 }).toUnixInteger(),
      iss: "vault-cortex",
    }),
  ).toString("base64url")
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest()
    .toString("base64url")
  return `${header}.${body}.${sig}`
}

describe("authorizer handler", () => {
  it("authorizes the static token", async () => {
    const result = await handler(protectedRequest(`Bearer ${SECRET}`))
    expect(result).toEqual({ isAuthorized: true })
  })

  it("authorizes a JWT minted for this deployment", async () => {
    const token = accessToken({
      iss: "https://mcp.example.com/",
      aud: "https://mcp.example.com/mcp",
    })
    const result = await handler(protectedRequest(`Bearer ${token}`))
    expect(result).toEqual({ isAuthorized: true })
  })

  it("authorizes a JWT bound to a subpath deployment", async () => {
    vi.stubEnv("PUBLIC_URL", "https://mcp.example.com/vault/")
    onTestFinished(() => {
      vi.stubEnv("PUBLIC_URL", PUBLIC_URL)
    })
    // Pins the derivation the bare-origin test cannot: the path prefix
    // stays in `iss` but is dropped from `aud`. A hand-derived
    // origin-based issuer would pass the bare-origin test and fail here.
    const token = accessToken({
      iss: "https://mcp.example.com/vault/",
      aud: "https://mcp.example.com/mcp",
    })
    const result = await handler(protectedRequest(`Bearer ${token}`))
    expect(result).toEqual({ isAuthorized: true })
  })

  it("denies a same-secret JWT minted for another deployment", async () => {
    const token = accessToken({
      iss: "https://mcp.example.com/",
      aud: "https://other.example/mcp",
    })
    const result = await handler(protectedRequest(`Bearer ${token}`))
    expect(result).toEqual({ isAuthorized: false })
  })

  it("authorizes a pre-binding JWT (no aud) so Express can answer it with a 401", async () => {
    const result = await handler(
      protectedRequest(`Bearer ${preBindingToken(SECRET)}`),
    )
    expect(result).toEqual({ isAuthorized: true })
  })

  it("denies a pre-binding JWT signed with another secret", async () => {
    const result = await handler(
      protectedRequest(`Bearer ${preBindingToken("not-the-lambda-secret")}`),
    )
    expect(result).toEqual({ isAuthorized: false })
  })

  it("denies a same-secret JWT from another issuer", async () => {
    const token = accessToken({
      iss: "https://other.example/",
      aud: "https://mcp.example.com/mcp",
    })
    const result = await handler(protectedRequest(`Bearer ${token}`))
    expect(result).toEqual({ isAuthorized: false })
  })

  it("denies a malformed Authorization header", async () => {
    const result = await handler(protectedRequest("Basic abc"))
    expect(result).toEqual({ isAuthorized: false })
  })

  it("denies when PUBLIC_URL is not a URL", async () => {
    vi.stubEnv("PUBLIC_URL", "mcp.example.com")
    recordedLogs.length = 0
    onTestFinished(() => {
      vi.stubEnv("PUBLIC_URL", PUBLIC_URL)
    })
    const token = accessToken({
      iss: "https://mcp.example.com/",
      aud: "https://mcp.example.com/mcp",
    })
    const result = await handler(protectedRequest(`Bearer ${token}`))
    expect(result).toEqual({ isAuthorized: false })
    // Pins the deny to the URL.parse guard, not the empty-string guard.
    expect(recordedLogs.at(-1)).toEqual({
      level: "error",
      message: "auth_failed: PUBLIC_URL is not a URL",
    })
  })

  it("denies when PUBLIC_URL contains credentials", async () => {
    vi.stubEnv("PUBLIC_URL", "https://user:fake-secret@mcp.example.com")
    recordedLogs.length = 0
    onTestFinished(() => {
      vi.stubEnv("PUBLIC_URL", PUBLIC_URL)
    })
    // A token bound to the credentialed URL would verify without the
    // guard — the deny must come from the credentials check.
    const token = accessToken({
      iss: "https://user:fake-secret@mcp.example.com/",
      aud: "https://mcp.example.com/mcp",
    })
    const result = await handler(protectedRequest(`Bearer ${token}`))
    expect(result).toEqual({ isAuthorized: false })
    expect(recordedLogs.at(-1)).toEqual({
      level: "error",
      message: "auth_failed: PUBLIC_URL contains credentials",
    })
  })

  it("denies when PUBLIC_URL is empty", async () => {
    vi.stubEnv("PUBLIC_URL", "")
    recordedLogs.length = 0
    onTestFinished(() => {
      vi.stubEnv("PUBLIC_URL", PUBLIC_URL)
    })
    // A valid JWT that would pass under normal conditions — the denial
    // must come from the empty-URL guard, not from token verification.
    const token = accessToken({
      iss: "https://mcp.example.com/",
      aud: "https://mcp.example.com/mcp",
    })
    const result = await handler(protectedRequest(`Bearer ${token}`))
    expect(result).toEqual({ isAuthorized: false })
    // Pins the deny to the empty-string guard, not the URL.parse guard
    // (URL.parse("") would also deny, with a different message).
    expect(recordedLogs.at(-1)).toEqual({
      level: "error",
      message: "auth_failed: PUBLIC_URL is empty",
    })
  })
})

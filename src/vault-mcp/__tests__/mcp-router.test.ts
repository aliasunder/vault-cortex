import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import express, { type Express } from "express"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpRouter } from "../mcp-router.js"
import type { SearchIndex } from "../search-index.js"
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { registerTools } from "../tool-definitions.js"
import { logger } from "../../logger.js"

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn(),
}))

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn(),
}))

vi.mock(
  "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js",
  () => ({
    requireBearerAuth: vi.fn(),
  }),
)

vi.mock("@modelcontextprotocol/sdk/types.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    isInitializeRequest: vi.fn(),
  }
})

vi.mock("../tool-definitions.js", () => ({
  registerTools: vi.fn(),
}))

const FORWARDED_IP = "192.0.2.10"

type TransportMock = {
  sessionId: string | undefined
  handleRequest: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  onclose: (() => void) | undefined
}

type ServerMock = {
  connect: ReturnType<typeof vi.fn>
}

type AuthMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void

const allowAuth: AuthMiddleware = (_req, _res, next) => next()

const denyAuth: AuthMiddleware = (_req, res) => {
  res.status(401).json({ error: "unauthorized" })
}

type Harness = {
  app: Express
  server: Server
  port: number
  url: (path?: string) => string
  transportInstances: TransportMock[]
  serverInstances: ServerMock[]
  search: SearchIndex
  provider: OAuthServerProvider
}

const harnesses: Harness[] = []

let sessionCounter = 0

const createTransportMock = (): TransportMock => {
  sessionCounter += 1
  return {
    sessionId: `session-${sessionCounter}`,
    handleRequest: vi.fn(
      async (_req: express.Request, res: express.Response, _body?: unknown) => {
        res.status(202).json({ ok: true, handled: "transport-mock" })
      },
    ),
    close: vi.fn(async () => {}),
    onclose: undefined,
  }
}

const createServerMock = (): ServerMock => ({
  connect: vi.fn(async () => {}),
})

const setupHarness = async (
  opts: { authMiddleware?: AuthMiddleware } = {},
): Promise<Harness> => {
  const transportInstances: TransportMock[] = []
  const serverInstances: ServerMock[] = []

  vi.mocked(StreamableHTTPServerTransport).mockImplementation(
    function MockStreamableHTTPServerTransport() {
      const t = createTransportMock()
      transportInstances.push(t)
      return t
    } as unknown as typeof StreamableHTTPServerTransport,
  )

  vi.mocked(McpServer).mockImplementation(function MockMcpServer() {
    const s = createServerMock()
    serverInstances.push(s)
    return s
  } as unknown as typeof McpServer)

  vi.mocked(requireBearerAuth).mockReturnValue(
    (opts.authMiddleware ?? allowAuth) as unknown as ReturnType<
      typeof requireBearerAuth
    >,
  )

  const search = {} as SearchIndex
  const provider = {} as OAuthServerProvider

  const app = express()
  app.set("trust proxy", true)
  app.use(express.json())
  app.use(createMcpRouter({ vaultPath: "/test-vault", search, provider }))

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const port = (server.address() as AddressInfo).port

  const h: Harness = {
    app,
    server,
    port,
    url: (path = "/mcp") => `http://127.0.0.1:${port}${path}`,
    transportInstances,
    serverInstances,
    search,
    provider,
  }
  harnesses.push(h)
  return h
}

const teardownHarness = (h: Harness): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    h.server.close((err) => (err ? reject(err) : resolve()))
  })

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
}

const baseHeaders = {
  "content-type": "application/json",
  "x-forwarded-for": FORWARDED_IP,
}

const createSession = async (
  h: Harness,
): Promise<{ sessionId: string; transport: TransportMock }> => {
  vi.mocked(isInitializeRequest).mockReturnValue(true)
  const response = await fetch(h.url(), {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initializeBody),
  })
  await response.arrayBuffer()
  const transport = h.transportInstances.at(-1)
  if (!transport || !transport.sessionId) {
    throw new Error("session was not created")
  }
  return { sessionId: transport.sessionId, transport }
}

let infoSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {})
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(teardownHarness))
  vi.clearAllMocks()
  infoSpy.mockRestore()
  warnSpy.mockRestore()
})

describe("createMcpRouter — construction", () => {
  it("wires the OAuth provider into requireBearerAuth as the verifier", async () => {
    const h = await setupHarness()

    expect(requireBearerAuth).toHaveBeenCalledTimes(1)
    expect(vi.mocked(requireBearerAuth).mock.calls[0]![0]).toEqual({
      verifier: h.provider,
    })
  })
})

describe("createMcpRouter — POST /mcp", () => {
  it("creates a new session on initialize request", async () => {
    const h = await setupHarness()
    vi.mocked(isInitializeRequest).mockReturnValue(true)

    const response = await fetch(h.url(), {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(initializeBody),
    })
    const body = (await response.json()) as { handled: string }

    expect(response.status).toBe(202)
    expect(body).toEqual({ ok: true, handled: "transport-mock" })
    expect(h.transportInstances).toHaveLength(1)
    expect(h.serverInstances).toHaveLength(1)
    expect(h.serverInstances[0]!.connect).toHaveBeenCalledWith(
      h.transportInstances[0],
    )
    expect(h.transportInstances[0]!.handleRequest).toHaveBeenCalledTimes(1)
    expect(h.transportInstances[0]!.handleRequest.mock.calls[0]![2]).toEqual(
      initializeBody,
    )
  })

  it("constructs McpServer with the documented name, version, description and instructions", async () => {
    const h = await setupHarness()
    await createSession(h)

    expect(McpServer).toHaveBeenCalledTimes(1)
    const [info, options] = vi.mocked(McpServer).mock.calls[0]!
    expect(info).toEqual({
      name: "vault-cortex",
      version: "1.0.0",
      description:
        "Read, write, and search an Obsidian vault. Provides full-text search, tag queries, and a structured memory layer (About Me/) for personalization across conversations.",
    })
    expect(options).toEqual({
      instructions:
        "Read, write, and search an Obsidian vault. Use vault_search and vault_read_note to find and read notes. Use vault_get_memory to retrieve user preferences and context from About Me/ files. Use vault_write_note and vault_update_memory for writes.",
    })
  })

  it("registers tools with a session-scoped child logger including the sessionId", async () => {
    const h = await setupHarness()
    const childSpy = vi.spyOn(logger, "child")
    await createSession(h)

    expect(registerTools).toHaveBeenCalledTimes(1)
    const registerArg = vi.mocked(registerTools).mock.calls[0]![0]
    expect(registerArg.server).toBe(h.serverInstances[0])
    expect(registerArg.vaultPath).toBe("/test-vault")
    expect(registerArg.search).toBe(h.search)
    expect(registerArg.logger).toBeDefined()
    expect(childSpy).toHaveBeenCalledWith({
      sessionId: h.transportInstances[0]!.sessionId,
      clientIp: FORWARDED_IP,
    })
    childSpy.mockRestore()
  })

  it("logs mcp_response with outcome 'session created' after creating a session", async () => {
    const h = await setupHarness()
    const { sessionId } = await createSession(h)

    expect(infoSpy).toHaveBeenCalledWith("mcp_response", {
      sessionId,
      clientIp: FORWARDED_IP,
      status: 200,
      outcome: "session created",
    })
  })

  it("routes to the existing transport when mcp-session-id matches an active session", async () => {
    const h = await setupHarness()
    const { sessionId, transport } = await createSession(h)
    transport.handleRequest.mockClear()
    infoSpy.mockClear()

    vi.mocked(isInitializeRequest).mockReturnValue(false)
    const followUp = { jsonrpc: "2.0", id: 2, method: "tools/list" }
    const response = await fetch(h.url(), {
      method: "POST",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify(followUp),
    })
    await response.arrayBuffer()

    expect(response.status).toBe(202)
    expect(h.transportInstances).toHaveLength(1)
    expect(transport.handleRequest).toHaveBeenCalledTimes(1)
    expect(transport.handleRequest.mock.calls[0]![2]).toEqual(followUp)
    expect(infoSpy).toHaveBeenCalledWith("mcp_response", {
      sessionId,
      clientIp: FORWARDED_IP,
      status: 200,
      outcome: "routed to existing session",
    })
  })

  it("returns 400 when there is no session and the body is not an initialize request", async () => {
    const h = await setupHarness()
    vi.mocked(isInitializeRequest).mockReturnValue(false)

    const response = await fetch(h.url(), {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: "no session" })
    expect(h.transportInstances).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith("mcp_response", {
      clientIp: FORWARDED_IP,
      status: 400,
      outcome: "no session, non-initialize request",
    })
  })

  it("returns 404 when mcp-session-id is set but the session is unknown", async () => {
    const h = await setupHarness()

    const response = await fetch(h.url(), {
      method: "POST",
      headers: { ...baseHeaders, "mcp-session-id": "ghost-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: "session not found" })
    expect(h.transportInstances).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith("mcp_response", {
      sessionId: "ghost-session",
      clientIp: FORWARDED_IP,
      status: 404,
      outcome: "session not found",
    })
  })

  it("returns 401 when the bearer auth middleware rejects the request", async () => {
    const h = await setupHarness({ authMiddleware: denyAuth })

    const response = await fetch(h.url(), {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(initializeBody),
    })

    expect(response.status).toBe(401)
    expect(h.transportInstances).toHaveLength(0)
    // The route handler never runs, so its mcp_request / mcp_response info
    // logs should never fire.
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it("logs mcp_request for every accepted POST", async () => {
    const h = await setupHarness()
    await createSession(h)

    expect(infoSpy).toHaveBeenCalledWith("mcp_request", {
      sessionId: undefined,
      clientIp: FORWARDED_IP,
      method: "POST",
    })
  })
})

describe("createMcpRouter — GET /mcp", () => {
  it("routes to the existing transport (no body argument)", async () => {
    const h = await setupHarness()
    const { sessionId, transport } = await createSession(h)
    transport.handleRequest.mockClear()

    const response = await fetch(h.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })
    await response.arrayBuffer()

    expect(transport.handleRequest).toHaveBeenCalledTimes(1)
    expect(transport.handleRequest.mock.calls[0]).toHaveLength(2)
  })

  it("returns 404 when mcp-session-id header is missing", async () => {
    const h = await setupHarness()

    const response = await fetch(h.url(), {
      method: "GET",
      headers: baseHeaders,
    })
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: "session not found" })
    expect(warnSpy).toHaveBeenCalledWith("mcp_response", {
      sessionId: undefined,
      clientIp: FORWARDED_IP,
      status: 404,
      outcome: "session not found",
    })
  })

  it("returns 404 when mcp-session-id is set but unknown", async () => {
    const h = await setupHarness()

    const response = await fetch(h.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": "missing" },
    })
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: "session not found" })
    expect(warnSpy).toHaveBeenCalledWith("mcp_response", {
      sessionId: "missing",
      clientIp: FORWARDED_IP,
      status: 404,
      outcome: "session not found",
    })
  })

  it("returns 401 when bearer auth rejects", async () => {
    const h = await setupHarness({ authMiddleware: denyAuth })

    const response = await fetch(h.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": "anything" },
    })

    expect(response.status).toBe(401)
  })
})

describe("createMcpRouter — DELETE /mcp", () => {
  it("closes the transport and removes the session", async () => {
    const h = await setupHarness()
    const { sessionId, transport } = await createSession(h)

    const response = await fetch(h.url(), {
      method: "DELETE",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })
    const body = (await response.json()) as { ok: boolean }

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledWith("mcp_response", {
      sessionId,
      clientIp: FORWARDED_IP,
      status: 200,
      outcome: "session deleted",
    })

    const followUp = await fetch(h.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })
    await followUp.arrayBuffer()
    expect(followUp.status).toBe(404)
  })

  it("returns 404 when mcp-session-id is missing", async () => {
    const h = await setupHarness()

    const response = await fetch(h.url(), {
      method: "DELETE",
      headers: baseHeaders,
    })
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: "session not found" })
  })

  it("returns 404 when mcp-session-id is set but unknown", async () => {
    const h = await setupHarness()

    const response = await fetch(h.url(), {
      method: "DELETE",
      headers: { ...baseHeaders, "mcp-session-id": "ghost" },
    })
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(404)
    expect(body).toEqual({ error: "session not found" })
  })

  it("returns 401 when bearer auth rejects", async () => {
    const h = await setupHarness({ authMiddleware: denyAuth })

    const response = await fetch(h.url(), {
      method: "DELETE",
      headers: { ...baseHeaders, "mcp-session-id": "anything" },
    })

    expect(response.status).toBe(401)
  })
})

describe("createMcpRouter — transport.onclose lifecycle", () => {
  it("removes the session from the map when transport.onclose fires", async () => {
    const h = await setupHarness()
    const { sessionId, transport } = await createSession(h)
    infoSpy.mockClear()

    expect(typeof transport.onclose).toBe("function")
    transport.onclose!()

    expect(infoSpy).toHaveBeenCalledWith("session_closed", { sessionId })

    const followUp = await fetch(h.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })
    await followUp.arrayBuffer()
    expect(followUp.status).toBe(404)
  })

  it("is a no-op when transport.onclose fires without a sessionId", async () => {
    const h = await setupHarness()
    const { transport } = await createSession(h)
    transport.sessionId = undefined
    infoSpy.mockClear()

    expect(() => transport.onclose!()).not.toThrow()
    expect(infoSpy).not.toHaveBeenCalledWith(
      "session_closed",
      expect.anything(),
    )
  })
})

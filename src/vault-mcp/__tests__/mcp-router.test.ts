import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  onTestFinished,
  vi,
} from "vitest"
import express from "express"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpRouter } from "../mcp-router.js"
import type { SearchIndex } from "../search/search-index.js"
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { registerTools } from "../tool-definitions.js"
import { logger } from "../../logger.js"

// `logger` is a real exported object; its methods become spies inside
// beforeEach (vi.spyOn). vi.mocked is a type-only cast that gives us
// typed access to the spy state — at runtime, mockedLogger === logger.
const mockedLogger = vi.mocked(logger)

// We stub the MCP SDK so tests focus on the router's own logic — the
// session map, the route dispatch, and the onclose cleanup — rather than
// the SDK's transport state machine. Each mocked module captures real
// router-side calls; none short-circuits a code path the router would
// otherwise execute, so a test cannot pass because of an impossible
// mock condition.
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn(),
}))
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn(),
}))
vi.mock(
  "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js",
  () => ({ requireBearerAuth: vi.fn() }),
)
vi.mock("@modelcontextprotocol/sdk/types.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isInitializeRequest: vi.fn(),
}))
vi.mock("../tool-definitions.js", () => ({ registerTools: vi.fn() }))

const FORWARDED_IP = "192.0.2.10"
const VAULT_PATH = "/test-vault"

const SERVER_INFO = {
  name: "vault-cortex",
  version: "1.0.0",
  description:
    "Read, write, and search an Obsidian vault. Provides full-text search, tag queries, and a structured memory layer (About Me/) for personalization across conversations.",
}

const SERVER_OPTIONS = {
  instructions: `Read, write, and search an Obsidian vault. Use vault_search and vault_read_note to find and read notes. Use vault_get_memory to retrieve user preferences and context from About Me/ files. Use vault_write_note and vault_update_memory for writes.

Vault content is Obsidian Flavored Markdown. Write tools pass content through without escaping — be intentional about Obsidian syntax (#, [[, %%, etc.) in inputs.`,
}

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

type TransportMock = {
  sessionId: string | undefined
  handleRequest: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  onclose: (() => void) | undefined
}

type ServerMock = { connect: ReturnType<typeof vi.fn> }

type Harness = {
  url: (path?: string) => string
  transportInstances: TransportMock[]
  serverInstances: ServerMock[]
  search: SearchIndex
  provider: OAuthServerProvider
}

const allowAuth: express.RequestHandler = (_req, _res, next) => next()
const denyAuth: express.RequestHandler = (_req, res) => {
  res.status(401).json({ error: "unauthorized" })
}

const setupHarness = async (
  opts: { authMiddleware?: express.RequestHandler } = {},
): Promise<Harness> => {
  const transportInstances: TransportMock[] = []
  const serverInstances: ServerMock[] = []

  vi.mocked(StreamableHTTPServerTransport).mockImplementation(
    function MockStreamableHTTPServerTransport() {
      const transport: TransportMock = {
        sessionId: randomUUID(),
        handleRequest: vi.fn(
          async (_req: express.Request, res: express.Response) => {
            res.status(202).json({ ok: true, handled: "transport-mock" })
          },
        ),
        close: vi.fn(async () => {}),
        onclose: undefined,
      }
      transportInstances.push(transport)
      return transport
    } as unknown as typeof StreamableHTTPServerTransport,
  )

  vi.mocked(McpServer).mockImplementation(function MockMcpServer() {
    const server: ServerMock = { connect: vi.fn(async () => {}) }
    serverInstances.push(server)
    return server
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
  app.use(createMcpRouter({ vaultPath: VAULT_PATH, search, provider }))

  const httpServer = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  const port = (httpServer.address() as AddressInfo).port

  // Close the listening socket when the test ends — vitest's onTestFinished
  // ties cleanup to the same test that called setupHarness, so we don't
  // need a module-level "current harness" reference to find it in afterEach.
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()))
      }),
  )

  return {
    url: (path = "/mcp") => `http://127.0.0.1:${port}${path}`,
    transportInstances,
    serverInstances,
    search,
    provider,
  }
}

const createSession = async (
  harness: Harness,
): Promise<{ sessionId: string; transport: TransportMock }> => {
  const response = await fetch(harness.url(), {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initializeBody),
  })
  await response.arrayBuffer()
  const transport = harness.transportInstances.at(-1)
  if (!transport || !transport.sessionId) {
    throw new Error("session was not created")
  }
  return { sessionId: transport.sessionId, transport }
}

// Sets up a harness and immediately runs the initialize handshake so a
// test can assert on the side-effects of session creation without
// repeating the two-step setup in every it().
const setupInitializedSession = async (): Promise<{
  harness: Harness
  sessionId: string
  transport: TransportMock
}> => {
  const harness = await setupHarness()
  const session = await createSession(harness)
  return { harness, ...session }
}

beforeEach(() => {
  vi.mocked(isInitializeRequest).mockReturnValue(true)
  vi.spyOn(logger, "info").mockImplementation(() => {})
  vi.spyOn(logger, "warn").mockImplementation(() => {})
  vi.spyOn(logger, "child")
})

// restoreAllMocks restores every vi.spyOn-created spy (logger.* go back to
// real methods). clearAllMocks then clears call/instance history on the
// vi.fn() instances created by vi.mock factories (restoreAllMocks doesn't
// touch those). Together they leave every mock fresh for the next test;
// the next beforeEach + setupHarness reinstall implementations.
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("createMcpRouter — construction", () => {
  it("wires the OAuth provider into requireBearerAuth as the verifier", async () => {
    const harness = await setupHarness()

    expect(requireBearerAuth).toHaveBeenCalledTimes(1)
    expect(vi.mocked(requireBearerAuth).mock.calls[0]![0]).toEqual({
      verifier: harness.provider,
    })
  })
})

describe("createMcpRouter — POST /mcp", () => {
  describe("on a fresh initialize request", () => {
    it("constructs exactly one transport", async () => {
      const { harness } = await setupInitializedSession()
      expect(harness.transportInstances).toHaveLength(1)
    })

    it("constructs exactly one McpServer with the documented metadata", async () => {
      await setupInitializedSession()
      expect(McpServer).toHaveBeenCalledTimes(1)
      const [info, options] = vi.mocked(McpServer).mock.calls[0]!
      expect(info).toEqual(SERVER_INFO)
      expect(options).toEqual(SERVER_OPTIONS)
    })

    it("connects the new server to the new transport", async () => {
      const { harness, transport } = await setupInitializedSession()
      expect(harness.serverInstances[0]!.connect).toHaveBeenCalledWith(
        transport,
      )
    })

    it("forwards the request body to transport.handleRequest", async () => {
      const { transport } = await setupInitializedSession()
      expect(transport.handleRequest).toHaveBeenCalledTimes(1)
      expect(transport.handleRequest.mock.calls[0]![2]).toEqual(initializeBody)
    })

    it("registers tools on the new server with vault context", async () => {
      const { harness } = await setupInitializedSession()
      expect(registerTools).toHaveBeenCalledTimes(1)
      const arg = vi.mocked(registerTools).mock.calls[0]![0]
      expect(arg.server).toBe(harness.serverInstances[0])
      expect(arg.vaultPath).toBe(VAULT_PATH)
      expect(arg.search).toBe(harness.search)
      expect(arg.logger).toBeDefined()
    })

    it("scopes the logger for registerTools to the sessionId and clientIp", async () => {
      const { sessionId } = await setupInitializedSession()
      expect(mockedLogger.child).toHaveBeenCalledWith({
        sessionId,
        clientIp: FORWARDED_IP,
      })
    })

    it("logs the 'session created' response", async () => {
      const { sessionId } = await setupInitializedSession()
      expect(mockedLogger.info).toHaveBeenCalledWith("mcp_response", {
        sessionId,
        clientIp: FORWARDED_IP,
        status: 200,
        outcome: "session created",
      })
    })

    it("logs an 'mcp_request' for the incoming POST", async () => {
      await setupInitializedSession()
      expect(mockedLogger.info).toHaveBeenCalledWith("mcp_request", {
        sessionId: undefined,
        clientIp: FORWARDED_IP,
        method: "POST",
      })
    })
  })

  it("routes a follow-up POST to the existing transport when the session id matches", async () => {
    const harness = await setupHarness()
    const { sessionId, transport } = await createSession(harness)
    transport.handleRequest.mockClear()
    mockedLogger.info.mockClear()
    vi.mocked(isInitializeRequest).mockReturnValue(false)

    const followUp = { jsonrpc: "2.0", id: 2, method: "tools/list" }
    const response = await fetch(harness.url(), {
      method: "POST",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify(followUp),
    })
    await response.arrayBuffer()

    expect(harness.transportInstances).toHaveLength(1)
    expect(transport.handleRequest).toHaveBeenCalledTimes(1)
    expect(transport.handleRequest.mock.calls[0]![2]).toEqual(followUp)
    expect(mockedLogger.info).toHaveBeenCalledWith("mcp_response", {
      sessionId,
      clientIp: FORWARDED_IP,
      status: 200,
      outcome: "routed to existing session",
    })
  })

  it("returns 400 with 'no session' when there is no session and the body is not an initialize request", async () => {
    const harness = await setupHarness()
    vi.mocked(isInitializeRequest).mockReturnValue(false)

    const response = await fetch(harness.url(), {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "no session" })
    expect(harness.transportInstances).toHaveLength(0)
    expect(mockedLogger.warn).toHaveBeenCalledWith("mcp_response", {
      clientIp: FORWARDED_IP,
      status: 400,
      outcome: "no session, non-initialize request",
    })
  })

  it("returns 404 when the session id is unknown", async () => {
    const harness = await setupHarness()

    const response = await fetch(harness.url(), {
      method: "POST",
      headers: { ...baseHeaders, "mcp-session-id": "ghost-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "session not found" })
    expect(harness.transportInstances).toHaveLength(0)
    expect(mockedLogger.warn).toHaveBeenCalledWith("mcp_response", {
      sessionId: "ghost-session",
      clientIp: FORWARDED_IP,
      status: 404,
      outcome: "session not found",
    })
  })

  it("returns 401 and never enters the route handler when bearer auth rejects", async () => {
    const harness = await setupHarness({ authMiddleware: denyAuth })

    const response = await fetch(harness.url(), {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(initializeBody),
    })

    expect(response.status).toBe(401)
    expect(harness.transportInstances).toHaveLength(0)
    expect(mockedLogger.info).not.toHaveBeenCalled()
  })
})

describe("createMcpRouter — GET /mcp", () => {
  it("forwards the request to the existing transport without a body argument", async () => {
    const harness = await setupHarness()
    const { sessionId, transport } = await createSession(harness)
    transport.handleRequest.mockClear()

    const response = await fetch(harness.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })
    await response.arrayBuffer()

    expect(transport.handleRequest).toHaveBeenCalledTimes(1)
    expect(transport.handleRequest.mock.calls[0]).toHaveLength(2)
  })

  it("returns 404 when the mcp-session-id header is missing", async () => {
    const harness = await setupHarness()

    const response = await fetch(harness.url(), {
      method: "GET",
      headers: baseHeaders,
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "session not found" })
    expect(mockedLogger.warn).toHaveBeenCalledWith("mcp_response", {
      sessionId: undefined,
      clientIp: FORWARDED_IP,
      status: 404,
      outcome: "session not found",
    })
  })

  it("returns 404 when the session id is unknown", async () => {
    const harness = await setupHarness()

    const response = await fetch(harness.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": "missing" },
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "session not found" })
  })

  it("returns 401 when bearer auth rejects", async () => {
    const harness = await setupHarness({ authMiddleware: denyAuth })

    const response = await fetch(harness.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": "anything" },
    })

    expect(response.status).toBe(401)
  })
})

describe("createMcpRouter — DELETE /mcp", () => {
  it("closes the transport, removes the session, and returns 200", async () => {
    const harness = await setupHarness()
    const { sessionId, transport } = await createSession(harness)

    const response = await fetch(harness.url(), {
      method: "DELETE",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(mockedLogger.info).toHaveBeenCalledWith("mcp_response", {
      sessionId,
      clientIp: FORWARDED_IP,
      status: 200,
      outcome: "session deleted",
    })

    // The session should be gone from the map — verified via a follow-up
    // GET that should now 404.
    const followUp = await fetch(harness.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })
    await followUp.arrayBuffer()
    expect(followUp.status).toBe(404)
  })

  it("returns 404 when the mcp-session-id header is missing", async () => {
    const harness = await setupHarness()

    const response = await fetch(harness.url(), {
      method: "DELETE",
      headers: baseHeaders,
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "session not found" })
  })

  it("returns 404 when the session id is unknown", async () => {
    const harness = await setupHarness()

    const response = await fetch(harness.url(), {
      method: "DELETE",
      headers: { ...baseHeaders, "mcp-session-id": "ghost" },
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "session not found" })
  })

  it("returns 401 when bearer auth rejects", async () => {
    const harness = await setupHarness({ authMiddleware: denyAuth })

    const response = await fetch(harness.url(), {
      method: "DELETE",
      headers: { ...baseHeaders, "mcp-session-id": "anything" },
    })

    expect(response.status).toBe(401)
  })
})

describe("createMcpRouter — transport.onclose", () => {
  it("removes the session from the map and logs 'session_closed'", async () => {
    const harness = await setupHarness()
    const { sessionId, transport } = await createSession(harness)
    mockedLogger.info.mockClear()

    transport.onclose!()

    expect(mockedLogger.info).toHaveBeenCalledWith("session_closed", {
      sessionId,
    })
    // The session should be gone — confirm with a GET that should 404.
    const followUp = await fetch(harness.url(), {
      method: "GET",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
    })
    await followUp.arrayBuffer()
    expect(followUp.status).toBe(404)
  })

  it("is a no-op when the transport has no sessionId", async () => {
    const harness = await setupHarness()
    const { transport } = await createSession(harness)
    transport.sessionId = undefined
    mockedLogger.info.mockClear()

    expect(() => transport.onclose!()).not.toThrow()
    expect(mockedLogger.info).not.toHaveBeenCalled()
  })
})

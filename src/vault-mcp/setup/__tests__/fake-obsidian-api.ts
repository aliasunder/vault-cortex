/** A stand-in for api.obsidian.md on 127.0.0.1: records every request and
 *  answers with whatever the test's `respond` function returns. */

import { createServer } from "node:http"
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

export type FakeApiRequest = {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

export type FakeApiResponse = {
  status?: number
  body: unknown
}

export type FakeObsidianApi = {
  baseUrl: string
  requests: FakeApiRequest[]
  close: () => Promise<void>
}

const readJsonBody = async (
  request: AsyncIterable<Buffer>,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8")
  const parsed: unknown = text ? JSON.parse(text) : {}
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`fake API expected a JSON object body, got: ${text}`)
  }
  return Object.fromEntries(Object.entries(parsed))
}

export const startFakeObsidianApi = async (
  respond: (request: FakeApiRequest) => FakeApiResponse,
): Promise<FakeObsidianApi> => {
  const requests: FakeApiRequest[] = []
  const answer = async (
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> => {
    if (!incoming.url) throw new Error("fake API request has no URL")
    const request = {
      path: incoming.url,
      headers: incoming.headers,
      body: await readJsonBody(incoming),
    }
    requests.push(request)
    const response = respond(request)
    outgoing.writeHead(response.status ?? 200, {
      "content-type": "application/json",
    })
    outgoing.end(JSON.stringify(response.body))
  }
  const server: Server = createServer((incoming, outgoing) => {
    void answer(incoming, outgoing)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("fake API server did not bind a TCP port")
  }
  const { port } = address satisfies AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

import { describe, it, expect } from "vitest"
import { renderUnknownClientPage, UNKNOWN_CLIENT_TITLE } from "../unknown-client-page.js"

/** Each list item's bold client name and the text after it, in page order. */
const CLIENT_STEP_PATTERN = /<li><strong>([^<]*)<\/strong> (.*?)<\/li>/g

const readClientSteps = (html: string): Array<{ client: string; step: string }> => {
  return [...html.matchAll(CLIENT_STEP_PATTERN)].map((match) => ({
    client: match[1] ?? "",
    step: match[2] ?? "",
  }))
}

/** The page's heading text. */
const HEADING_PATTERN = /<h1>([^<]*)<\/h1>/

describe("unknown client page", () => {
  it("names the recovery step for each supported client, in order", () => {
    const html = renderUnknownClientPage()

    expect(HEADING_PATTERN.exec(html)?.[1]).toBe(UNKNOWN_CLIENT_TITLE)
    expect(readClientSteps(html)).toEqual([
      {
        client: "Claude Code:",
        step: "<code>claude mcp remove &lt;name&gt;</code>, then <code>claude mcp add</code> with the same address.",
      },
      {
        client: "claude.ai, Claude Desktop and the mobile apps:",
        step: "remove the connector under Settings → Connectors, then add it again.",
      },
      {
        client: "mcp-remote:",
        step: "delete <code>~/.mcp-auth</code> and restart the client.",
      },
      {
        client: "Other clients:",
        step: "remove the server and add it again.",
      },
    ])
  })

  it("takes no input, so nothing from the request can appear on the page", () => {
    expect(renderUnknownClientPage.length).toBe(0)
    expect(renderUnknownClientPage()).toBe(renderUnknownClientPage())
  })
})

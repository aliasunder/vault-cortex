import { describe, it, expect } from "vitest"
import { renderUnknownClientPage } from "../unknown-client-page.js"

/** Each list item's bold client name and the text after it, in page order. */
const CLIENT_STEP_PATTERN = /<li><strong>([^<]*)<\/strong> (.*?)<\/li>/g

const readClientSteps = (html: string): Array<{ client: string; step: string }> => {
  return [...html.matchAll(CLIENT_STEP_PATTERN)].map((match) => ({
    client: match[1] ?? "",
    step: match[2] ?? "",
  }))
}

/** The browser title's text. */
const TITLE_PATTERN = /<title>([^<]*)<\/title>/
/** The page's heading text. */
const HEADING_PATTERN = /<h1>([^<]*)<\/h1>/
/** Each paragraph's text, in page order. */
const PARAGRAPH_PATTERN = /<p>([^<]*)<\/p>/g

describe("unknown client page", () => {
  it("titles the browser tab with the page's heading", () => {
    const html = renderUnknownClientPage()

    expect({
      title: TITLE_PATTERN.exec(html)?.[1],
      heading: HEADING_PATTERN.exec(html)?.[1],
    }).toEqual({
      title: "This sign-in can't continue — Vault Cortex",
      heading: "This sign-in can't continue",
    })
  })

  it("explains why the registration is gone and that the client must register again", () => {
    const html = renderUnknownClientPage()

    expect([...html.matchAll(PARAGRAPH_PATTERN)].map((match) => match[1])).toEqual([
      "The server no longer has this client's registration. That happens when the server's data was reset, or when a sign-in was started but never finished.",
      "To reconnect, remove the server from your client and add it again, so the client registers afresh:",
    ])
  })

  it("names the recovery step for each supported client, in order", () => {
    expect(readClientSteps(renderUnknownClientPage())).toEqual([
      {
        client: "Claude Code:",
        step: "<code>claude mcp remove &lt;name&gt;</code>, then <code>claude mcp add</code> with the same address.",
      },
      {
        client: "A connector in claude.ai, Claude Desktop or the mobile apps:",
        step: "remove it under Settings → Connectors, then add it again.",
      },
      {
        client: "A client set up through mcp-remote, such as Claude Desktop on a local server:",
        step: "delete <code>~/.mcp-auth</code> and restart the client.",
      },
      {
        client: "Other clients:",
        step: "remove the server and add it again.",
      },
    ])
  })
})

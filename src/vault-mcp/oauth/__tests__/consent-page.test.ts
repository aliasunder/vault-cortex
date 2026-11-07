import { describe, it, expect } from "vitest"
import { renderConsentPage } from "../consent-page.js"

const baseParams = {
  clientName: "Test Client",
  clientId: "client-123",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  requestId: "req-abc",
}

const GRANT_TEXT = "Everything this server's tools can do in your vault"

/** Matches a field's label div followed by its value div, capturing both texts. */
const FIELD_ROW_PATTERN = /<div class="label">([^<]*)<\/div>\s*<div class="value">([^<]*)<\/div>/g

/** Matches the masked token input, capturing its id. */
const TOKEN_INPUT_ID_PATTERN = /<input type="password" id="([^"]+)" name="token"/

/** Matches the reveal button, capturing its onclick handler. */
const REVEAL_ONCLICK_PATTERN = /class="reveal"[^>]*onclick="([^"]+)"/

/** Every label and value row on the page, in page order. */
const readFieldRows = (html: string) => {
  return [...html.matchAll(FIELD_ROW_PATTERN)].map((match) => ({
    label: match[1],
    value: match[2],
  }))
}

const expectedRows = (destination: string): Array<{ label: string; value: string }> => [
  { label: "Application", value: "Test Client" },
  { label: "Client ID", value: "client-123" },
  { label: "Sends access to", value: destination },
  { label: "Access", value: GRANT_TEXT },
]

describe("consent page rows", () => {
  it.each([
    {
      label: "a web address as its origin",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      destination: "https://claude.ai",
    },
    {
      label: "a loopback address with its port",
      redirectUri: "http://127.0.0.1:19876/callback",
      destination: "http://127.0.0.1:19876",
    },
    {
      label: "an IPv6 loopback address with its port",
      redirectUri: "http://[::1]:9000/cb",
      destination: "http://[::1]:9000",
    },
    {
      label: "an app scheme with a host as scheme and host",
      redirectUri: "claude://claude.ai/cb",
      destination: "claude://claude.ai",
    },
    {
      label: "an app link with no host as written",
      redirectUri: "claude.ai:callback",
      destination: "claude.ai:callback",
    },
    {
      label: "a native app callback with no host as written",
      redirectUri: "com.example.app:/oauth/callback",
      destination: "com.example.app:/oauth/callback",
    },
    {
      label: "the host after the userinfo, not the userinfo",
      redirectUri: "https://claude.ai@other.example/cb",
      destination: "https://other.example",
    },
    {
      label: "a host with a lookalike letter as punycode",
      redirectUri: "https://clаude.ai/cb",
      destination: "https://xn--clude-5ve.ai",
    },
    {
      label: "a lookalike subdomain in full",
      redirectUri: "https://claude.ai.other.example/cb",
      destination: "https://claude.ai.other.example",
    },
    {
      label: "a host holding & escaped",
      redirectUri: "https://a&b.example/cb",
      destination: "https://a&amp;b.example",
    },
    {
      label: "an unparseable address as written, escaped",
      redirectUri: "not a url <b>",
      destination: "not a url &lt;b&gt;",
    },
  ])("shows $label", ({ redirectUri, destination }) => {
    const html = renderConsentPage({ ...baseParams, redirectUri })

    expect(readFieldRows(html)).toEqual(expectedRows(destination))
  })

  it("shows a 300-character host whole", () => {
    const longHost = `${"a".repeat(292)}.example`

    const html = renderConsentPage({ ...baseParams, redirectUri: `https://${longHost}/cb` })

    expect(longHost).toHaveLength(300)
    expect(readFieldRows(html)).toEqual(expectedRows(`https://${longHost}`))
  })

  it.each([
    { label: "no name", clientName: undefined },
    { label: "an empty name", clientName: "" },
  ])("shows the client ID as the application when the client has $label", ({ clientName }) => {
    const html = renderConsentPage({ ...baseParams, clientName })

    expect(readFieldRows(html)).toEqual([
      { label: "Application", value: "client-123" },
      ...expectedRows("https://claude.ai").slice(1),
    ])
  })
})

describe("consent page reveal toggle", () => {
  it("renders the token field masked by default", () => {
    const html = renderConsentPage(baseParams)
    // The token is a credential — it must start hidden, not in plaintext.
    expect(html).toContain('<input type="password" id="token" name="token"')
  })

  it("wires the reveal button to the token input's id", () => {
    const html = renderConsentPage(baseParams)
    const tokenId = TOKEN_INPUT_ID_PATTERN.exec(html)?.[1]
    const onclick = REVEAL_ONCLICK_PATTERN.exec(html)?.[1]
    expect(tokenId).toBe("token")
    // The toggle must target the input by its id and flip it to a visible
    // type — otherwise "Show" silently does nothing.
    expect(onclick).toBe(
      "var tokenInput=document.getElementById('token');var hidden=tokenInput.type==='password';tokenInput.type=hidden?'text':'password';this.textContent=hidden?'Hide':'Show'",
    )
  })
})

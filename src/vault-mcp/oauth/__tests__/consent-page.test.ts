import { describe, it, expect } from "vitest"
import { renderConsentPage } from "../consent-page.js"

const baseParams = {
  clientName: "Test Client",
  clientId: "client-123",
  scopes: ["vault"],
  requestId: "req-abc",
}

describe("consent page reveal toggle", () => {
  it("renders the token field masked by default", () => {
    const html = renderConsentPage(baseParams)
    // The token is a credential — it must start hidden, not in plaintext.
    expect(html).toContain('<input type="password" id="token" name="token"')
  })

  it("wires the reveal button to the token input's id", () => {
    const html = renderConsentPage(baseParams)
    const tokenId = /<input type="password" id="([^"]+)" name="token"/.exec(
      html,
    )?.[1]
    const onclick = /class="reveal"[^>]*onclick="([^"]+)"/.exec(html)?.[1]
    expect(tokenId).toBe("token")
    // The toggle must target the input by its id and flip it to a visible
    // type — otherwise "Show" silently does nothing.
    expect(onclick).toContain(`getElementById('${tokenId}')`)
    expect(onclick).toContain("'text'")
  })
})

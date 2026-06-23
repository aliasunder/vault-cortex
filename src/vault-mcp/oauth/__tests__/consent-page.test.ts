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
    const tokenIdMatch =
      /<input type="password" id="([^"]+)" name="token"/.exec(html)
    const onclickMatch = /class="reveal"[^>]*onclick="([^"]+)"/.exec(html)
    expect(tokenIdMatch).not.toBeNull()
    expect(onclickMatch).not.toBeNull()
    const tokenId = tokenIdMatch![1]
    const onclick = onclickMatch![1]
    expect(tokenId).toBe("token")
    // The toggle must target the input by its id and flip it to a visible
    // type — otherwise "Show" silently does nothing.
    expect(onclick).toBe(
      "var t=document.getElementById('token');var s=t.type==='password';t.type=s?'text':'password';this.textContent=s?'Hide':'Show'",
    )
  })
})

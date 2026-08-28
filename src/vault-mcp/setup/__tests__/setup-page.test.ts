import { describe, expect, it } from "vitest"
import { renderSetupPage } from "../setup-page.js"

const SIGN_IN = {
  kind: "sign-in" as const,
  savedLoginRejected: false,
  insecureTransport: false,
}

describe("renderSetupPage — sign-in", () => {
  it("asks for the MCP token (masked) and the Obsidian email and password", () => {
    const html = renderSetupPage(SIGN_IN)

    expect(html).toContain('<form method="POST" action="/setup">')
    expect(html).toContain('<input type="password" id="token" name="token"')
    expect(html).toContain('<input type="email" id="email" name="email"')
    expect(html).toContain(
      '<input type="password" id="password" name="password"',
    )
    expect(html).not.toContain("saved Obsidian login stopped working")
    expect(html).not.toContain("not using HTTPS")
  })

  it("explains a rejected saved login above the form", () => {
    const html = renderSetupPage({ ...SIGN_IN, savedLoginRejected: true })

    expect(html).toContain(
      "Your saved Obsidian login stopped working. Sign in again to replace it.",
    )
  })

  it("warns when the page was served over plain HTTP", () => {
    const html = renderSetupPage({ ...SIGN_IN, insecureTransport: true })

    expect(html).toContain("This page is not using HTTPS")
  })

  it("escapes the error text", () => {
    const html = renderSetupPage({ ...SIGN_IN, error: `<script>"x"</script>` })

    expect(html).toContain(
      '<div class="error">&lt;script&gt;&quot;x&quot;&lt;/script&gt;</div>',
    )
  })
})

describe("renderSetupPage — mfa", () => {
  it("carries the request id as a hidden field and asks for the code only", () => {
    const html = renderSetupPage({ kind: "mfa", requestId: 'id"1' })

    expect(html).toContain(
      '<input type="hidden" name="request_id" value="id&quot;1">',
    )
    expect(html).toContain('name="mfa"')
    expect(html).not.toContain('name="password"')
    expect(html).not.toContain('name="token"')
  })
})

describe("renderSetupPage — blocked", () => {
  it("lists the account's vaults when VAULT_NAME matches none of them", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountName: "Sample User",
      problem: {
        kind: "vault-not-found",
        vaultName: "Notes",
        vaultNames: ["Work <2026>", "Personal"],
      },
    })

    expect(html).toContain("Signed in as <strong>Sample User</strong>.")
    expect(html).toContain("There is no vault named <code>Notes</code>")
    expect(html).toContain(
      "<ul><li><code>Work &lt;2026&gt;</code></li><li><code>Personal</code></li></ul>",
    )
    expect(html).toContain("Fix <code>VAULT_NAME</code>")
  })

  it("says the account has no vaults when the list is empty", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountName: "Sample User",
      problem: { kind: "vault-not-found", vaultName: "Notes", vaultNames: [] },
    })

    expect(html).toContain("Your account has no vaults in Obsidian Sync yet.")
  })

  it("names VAULT_PASSWORD for an encrypted vault", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountName: "Sample User",
      problem: { kind: "password-missing", vaultName: "Notes" },
    })

    expect(html).toContain(
      "The vault <code>Notes</code> is end-to-end encrypted, and <code>VAULT_PASSWORD</code> is not set.",
    )
  })

  it("names VAULT_NAME when it is unset", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountName: "Sample User",
      problem: { kind: "vault-name-unset" },
    })

    expect(html).toContain("<code>VAULT_NAME</code> is not set")
  })

  it("asks for a rename when two vaults share the name", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountName: "Sample User",
      problem: { kind: "vault-name-ambiguous", vaultName: "Notes" },
    })

    expect(html).toContain("more than one vault named <code>Notes</code>")
  })
})

describe("renderSetupPage — complete", () => {
  it("shows the account, polls /healthz, and names the MCP URL", () => {
    const html = renderSetupPage({
      kind: "complete",
      accountName: "Sample User",
      mcpUrl: "https://vault.example.com/mcp",
    })

    expect(html).toContain("Signed in as <strong>Sample User</strong>.")
    expect(html).toContain("fetch('/healthz',{cache:'no-store'})")
    expect(html).toContain("b.mode!=='setup'")
    expect(html).toContain(
      "Connect your MCP client to <code>https://vault.example.com/mcp</code>",
    )
    expect(html).toContain("<code>docker start vault-cortex</code>")
  })

  it("falls back to a relative /mcp hint without a public URL", () => {
    const html = renderSetupPage({
      kind: "complete",
      accountName: "Sample User",
      mcpUrl: undefined,
    })

    expect(html).toContain(
      "Connect your MCP client to this server's <code>/mcp</code> address",
    )
  })
})

describe("renderSetupPage — configured", () => {
  it("says the server is already signed in and how to switch accounts", () => {
    const html = renderSetupPage({ kind: "configured" })

    expect(html).toContain("<h1>Already set up</h1>")
    expect(html).toContain("set <code>OBSIDIAN_AUTH_TOKEN</code>")
    expect(html).not.toContain("<form")
  })
})

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

  it("points the token hint at the Variables tab on Railway", () => {
    const html = renderSetupPage({ ...SIGN_IN, hostingPlatform: "railway" })

    expect(html).toContain(
      `<div class="hint">The <code>MCP_AUTH_TOKEN</code> value from the service's Variables tab on Railway — it proves this is your server.</div>`,
    )
  })

  it("points the token hint at the Environment tab on Render", () => {
    const html = renderSetupPage({ ...SIGN_IN, hostingPlatform: "render" })

    expect(html).toContain(
      `<div class="hint">The <code>MCP_AUTH_TOKEN</code> value from the service's Environment tab on Render — it proves this is your server.</div>`,
    )
  })

  it("keeps the generic token hint when the hosting platform is unknown", () => {
    const html = renderSetupPage(SIGN_IN)

    expect(html).toContain(
      `<div class="hint">The <code>MCP_AUTH_TOKEN</code> value from your deployment's settings — it proves this is your server.</div>`,
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
      accountEmail: "user@example.com",
      problem: {
        kind: "vault-not-found",
        vaultName: "Notes",
        vaultNames: ["Work <2026>", "Personal"],
      },
    })

    expect(html).toContain("Signed in as <strong>user@example.com</strong>.")
    expect(html).toContain("There is no vault named <code>Notes</code>")
    expect(html).toContain(
      "<ul><li><code>Work &lt;2026&gt;</code></li><li><code>Personal</code></li></ul>",
    )
    expect(html).toContain("Fix <code>VAULT_NAME</code>")
  })

  it("says the account has no vaults when the list is empty", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: { kind: "vault-not-found", vaultName: "Notes", vaultNames: [] },
    })

    expect(html).toContain("Your account has no vaults in Obsidian Sync yet.")
  })

  it("names VAULT_PASSWORD for an encrypted vault", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: { kind: "password-missing", vaultName: "Notes" },
    })

    expect(html).toContain(
      "The vault <code>Notes</code> is end-to-end encrypted, and <code>VAULT_PASSWORD</code> is not set.",
    )
  })

  it("names VAULT_NAME when it is unset", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: { kind: "vault-name-unset" },
    })

    expect(html).toContain("<code>VAULT_NAME</code> is not set")
  })

  it("shows Obsidian's text and the VAULT_PASSWORD fix when the vault rejects the key", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: {
        kind: "vault-access-rejected",
        vaultName: "Notes",
        apiMessage: "Wrong vault key, <try> again.",
      },
    })

    expect(html).toContain(
      "<p>Obsidian did not accept <code>VAULT_PASSWORD</code> for the vault <code>Notes</code>: Wrong vault key, &lt;try&gt; again.</p>",
    )
    expect(html).toContain(
      "Fix <code>VAULT_PASSWORD</code> — the vault's encryption password — in your deployment's settings, redeploy, then sign in here again.",
    )
  })

  it("advises a server update for an encryption version above the Sync client's newest", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: {
        kind: "vault-key-underivable",
        vaultName: "Notes",
        encryptionVersion: 4,
      },
    })

    expect(html).toContain(
      "<p>The vault <code>Notes</code> uses encryption version 4, which the Obsidian Sync client this server ships does not support, so syncing it would fail on the next start.</p>\n  <p>Update the server to a newer release, redeploy, then sign in here again.</p>",
    )
  })

  it("does not call an unsupported older encryption version newer or advise an update", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: {
        kind: "vault-key-underivable",
        vaultName: "Notes",
        encryptionVersion: 1,
      },
    })

    expect(html).toContain(
      "<p>The vault <code>Notes</code> uses encryption version 1, which the Obsidian Sync client this server ships does not support, so syncing it would fail on the next start.</p>\n  <p>Report it with the vault's Obsidian Sync settings.</p>",
    )
    expect(html).not.toContain("newer")
    expect(html).not.toContain("Update the server")
  })

  it("asks for a retry when the listing lacks what the key check needs", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: {
        kind: "vault-key-underivable",
        vaultName: "Notes",
        encryptionVersion: undefined,
      },
    })

    expect(html).toContain(
      "<p>Obsidian's vault listing did not include what this server needs to check the password for <code>Notes</code>, so syncing it would fail on the next start.</p>",
    )
    expect(html).toContain("Try again in a few minutes.")
  })

  it("names the Environment tab on Render in the VAULT_PASSWORD remedy", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: { kind: "password-missing", vaultName: "Notes" },
      hostingPlatform: "render",
    })

    expect(html).toContain(
      "Add <code>VAULT_PASSWORD</code> — the vault's encryption password — to the service's Environment tab on Render, redeploy, then sign in here again.",
    )
  })

  it("names the Variables tab on Railway in the VAULT_NAME remedy", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: { kind: "vault-not-found", vaultName: "Notes", vaultNames: [] },
      hostingPlatform: "railway",
    })

    expect(html).toContain(
      "Fix <code>VAULT_NAME</code> in the service's Variables tab on Railway, redeploy, then sign in here again.",
    )
  })

  it("keeps the generic remedy when the hosting platform is unknown", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: { kind: "vault-name-unset" },
    })

    expect(html).toContain(
      "Add <code>VAULT_NAME</code> to your deployment's settings — your vault's name, the same as it is in Obsidian — then redeploy and sign in here again.",
    )
  })

  it("asks for a rename when two vaults share the name", () => {
    const html = renderSetupPage({
      kind: "blocked",
      accountEmail: "user@example.com",
      problem: { kind: "vault-name-ambiguous", vaultName: "Notes" },
    })

    expect(html).toContain("more than one vault named <code>Notes</code>")
  })
})

describe("renderSetupPage — complete", () => {
  it("shows the account, polls /healthz, and names the MCP URL", () => {
    const html = renderSetupPage({
      kind: "complete",
      accountEmail: "user@example.com",
      mcpUrl: "https://vault.example.com/mcp",
    })

    // The restarting notice lives in the waiting block, so the ready block
    // replaces it rather than stacking beneath it.
    expect(html).toContain(
      '<div id="waiting">\n    <p>Signed in as <strong>user@example.com</strong>. The server is restarting to download your vault',
    )
    expect(html).toContain(
      '<div id="ready" hidden>\n    <p>Signed in as <strong>user@example.com</strong>. Your vault is ready.</p>',
    )
    expect(html).toContain("fetch('/healthz',{cache:'no-store'})")
    expect(html).toContain("b.mode!=='setup'")
    expect(html).toContain(
      'Connect your MCP client to <a href="https://vault.example.com/mcp"><code>https://vault.example.com/mcp</code></a>',
    )
    expect(html).toContain("<code>docker start vault-cortex</code>")
  })

  it("falls back to a relative /mcp hint without a public URL", () => {
    const html = renderSetupPage({
      kind: "complete",
      accountEmail: "user@example.com",
      mcpUrl: undefined,
    })

    expect(html).toContain(
      "Connect your MCP client to this server's <code>/mcp</code> address",
    )
  })
})

describe("renderSetupPage — configured", () => {
  it("says the server is set up, with no Obsidian Sync claims or instructions", () => {
    const html = renderSetupPage({ kind: "configured" })

    expect(html).toContain("<h1>Already set up</h1>")
    expect(html).toContain(
      "This server is set up and running — there is nothing to do on this page.",
    )
    // The local image serves this page too and never touches Obsidian Sync,
    // so the copy stays mode-neutral.
    expect(html).not.toContain("Obsidian Sync")
    expect(html).not.toContain("<form")
  })
})

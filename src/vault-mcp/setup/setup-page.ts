/** HTML for the /setup flow — the first page a one-click deploy shows, so
 *  it is written for an Obsidian user with no terminal: what to enter, where
 *  the MCP token comes from, and what happens next. Same visual shell as the
 *  OAuth consent page. */

import { escapeHtml } from "../../utils/escape-html.js"
import { NEWEST_SUPPORTED_ENCRYPTION_VERSION } from "./vault-key.js"

/** Why sign-in cannot finish: the deployment's own settings would make the
 *  next boot fail, so the token is not written until they are fixed. */
export type PreflightProblem =
  | { kind: "vault-name-unset" }
  | { kind: "vault-not-found"; vaultName: string; vaultNames: string[] }
  | { kind: "vault-name-ambiguous"; vaultName: string }
  | { kind: "password-missing"; vaultName: string }
  /** Obsidian refused the key derived from VAULT_PASSWORD; `apiMessage` is
   *  the API's own text, the same line `ob sync-setup` would print. */
  | { kind: "vault-access-rejected"; vaultName: string; apiMessage: string }
  /** This server cannot derive the vault's key: the vault's encryption
   *  version is newer than the Sync client the image ships, or the listing
   *  entry lacks a field the check needs (`encryptionVersion` undefined). */
  | {
      kind: "vault-key-underivable"
      vaultName: string
      encryptionVersion: number | undefined
    }

/** The container hosting platforms whose dashboards the page can name.
 *  Undefined means unknown, and the copy falls back to "your deployment's
 *  settings". */
export type HostingPlatform = "render" | "railway"

/** Where the reader finds the deployment's settings, as a noun phrase that
 *  slots after "from", "in", or "to". The platform phrases use each deploy
 *  guide's exact tab name so the page and the guide agree. */
export const settingsLocation = (
  hostingPlatform: HostingPlatform | undefined,
): string => {
  if (hostingPlatform === "render")
    return "the service's Environment tab on Render"
  if (hostingPlatform === "railway")
    return "the service's Variables tab on Railway"
  return "your deployment's settings"
}

export type SetupView =
  | {
      kind: "sign-in"
      error?: string | undefined
      /** The saved login was rejected at boot — say so above the form. */
      savedLoginRejected: boolean
      /** The page arrived over plain HTTP from a non-local address. */
      insecureTransport: boolean
      hostingPlatform?: HostingPlatform | undefined
    }
  | { kind: "mfa"; requestId: string; error?: string | undefined }
  | {
      kind: "blocked"
      accountEmail: string
      problem: PreflightProblem
      hostingPlatform?: HostingPlatform | undefined
    }
  | {
      kind: "complete"
      accountEmail: string
      /** Where the MCP client connects once the server is up; undefined when
       *  PUBLIC_URL is not set. */
      mcpUrl: string | undefined
    }
  | { kind: "configured" }

const STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1117;color:#e4e4e7;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:1rem}
  .card{background:#1c1c22;border:1px solid #2e2e38;border-radius:12px;padding:2rem;max-width:460px;width:100%}
  h1{font-size:1.25rem;margin-bottom:1rem;color:#fafafa}
  p{font-size:.9rem;line-height:1.5;margin-bottom:1rem;color:#d4d4d8}
  p.muted{color:#a1a1aa;font-size:.85rem}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;color:#fafafa;word-break:break-all}
  a{color:#a5b4fc}
  ul{padding-left:1.25rem;margin-bottom:1rem;font-size:.9rem;line-height:1.5}
  .field{margin-bottom:1rem}
  .label{display:block;font-size:.75rem;color:#a1a1aa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
  .hint{font-size:.8rem;color:#a1a1aa;margin-top:.25rem}
  input{width:100%;padding:.6rem .75rem;background:#0f1117;border:1px solid #2e2e38;border-radius:6px;color:#fafafa;font-size:.9rem}
  input:focus{outline:none;border-color:#6366f1}
  .token-input{display:flex;gap:.5rem}
  .token-input input{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .reveal{flex:0 0 auto;padding:0 .75rem;background:#27272a;border:1px solid #2e2e38;border-radius:6px;color:#a1a1aa;font-size:.8rem;cursor:pointer}
  .reveal:hover{background:#2e2e38;color:#e4e4e7}
  button.primary{width:100%;padding:.6rem 1rem;border:none;border-radius:6px;font-size:.9rem;cursor:pointer;font-weight:500;background:#6366f1;color:#fff;margin-top:.5rem}
  button.primary:hover{background:#4f46e5}
  .error{background:#7f1d1d;border:1px solid #991b1b;color:#fca5a5;padding:.5rem .75rem;border-radius:6px;font-size:.85rem;margin-bottom:1rem}
  .notice{background:#1e293b;border:1px solid #334155;color:#cbd5e1;padding:.5rem .75rem;border-radius:6px;font-size:.85rem;margin-bottom:1rem}
  .spinner{display:inline-block;width:.8rem;height:.8rem;border:2px solid #6366f1;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite;vertical-align:-.1rem;margin-right:.4rem}
  @keyframes spin{to{transform:rotate(360deg)}}
`

const shell = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Vault Cortex</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`

const errorBox = (error: string | undefined): string =>
  error ? `<div class="error">${escapeHtml(error)}</div>` : ""

const tokenField = (
  settingsLocationPhrase: string,
): string => `<div class="field">
    <label class="label" for="token">MCP token</label>
    <div class="token-input">
      <input type="password" id="token" name="token" placeholder="MCP_AUTH_TOKEN" required autocomplete="off">
      <button type="button" class="reveal" aria-label="Show or hide token" onclick="var t=document.getElementById('token');var s=t.type==='password';t.type=s?'text':'password';this.textContent=s?'Hide':'Show'">Show</button>
    </div>
    <div class="hint">The <code>MCP_AUTH_TOKEN</code> value from ${settingsLocationPhrase} — it proves this is your server.</div>
  </div>`

const renderSignIn = ({
  error,
  savedLoginRejected,
  insecureTransport,
  hostingPlatform,
}: Extract<SetupView, { kind: "sign-in" }>): string =>
  shell(
    "Connect Obsidian Sync",
    `<h1>Connect Obsidian Sync</h1>
  ${
    savedLoginRejected
      ? `<div class="notice">Your saved Obsidian login stopped working. Sign in again to replace it.</div>`
      : ""
  }
  ${
    insecureTransport
      ? `<div class="notice">This page is not using HTTPS, so your password would travel unencrypted. Set up HTTPS before signing in.</div>`
      : ""
  }
  ${errorBox(error)}
  <p>Sign in with your Obsidian account so this server can sync your vault. Your email and password are sent to Obsidian once and not kept; only the Sync token they return is stored.</p>
  <form method="POST" action="/setup">
  ${tokenField(settingsLocation(hostingPlatform))}
  <div class="field">
    <label class="label" for="email">Obsidian account email</label>
    <input type="email" id="email" name="email" required autocomplete="username">
  </div>
  <div class="field">
    <label class="label" for="password">Obsidian account password</label>
    <input type="password" id="password" name="password" required autocomplete="current-password">
  </div>
  <button type="submit" class="primary">Sign in</button>
  </form>`,
  )

const renderMfa = ({
  requestId,
  error,
}: Extract<SetupView, { kind: "mfa" }>): string =>
  shell(
    "Two-factor code",
    `<h1>Two-factor code</h1>
  ${errorBox(error)}
  <p>Your Obsidian account uses two-factor authentication. Enter the code from your authenticator app.</p>
  <form method="POST" action="/setup">
  <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
  <div class="field">
    <label class="label" for="mfa">Code</label>
    <input type="text" id="mfa" name="mfa" inputmode="numeric" autocomplete="one-time-code" required autofocus>
  </div>
  <button type="submit" class="primary">Verify</button>
  </form>`,
  )

const problemCopy = (
  problem: PreflightProblem,
  settingsLocationPhrase: string,
): string => {
  switch (problem.kind) {
    case "vault-name-unset":
      return `<p><code>VAULT_NAME</code> is not set, so the server does not know which vault to sync.</p>
  <p>Add <code>VAULT_NAME</code> to ${settingsLocationPhrase} — your vault's name, the same as it is in Obsidian — then redeploy and sign in here again.</p>`
    case "vault-not-found": {
      const vaultList = problem.vaultNames.length
        ? `<p>Your account's vaults:</p><ul>${problem.vaultNames
            .map(
              (vaultName) => `<li><code>${escapeHtml(vaultName)}</code></li>`,
            )
            .join("")}</ul>`
        : `<p>Your account has no vaults in Obsidian Sync yet.</p>`
      return `<p>There is no vault named <code>${escapeHtml(problem.vaultName)}</code> in this Obsidian account (names are case-sensitive).</p>
  ${vaultList}
  <p>Fix <code>VAULT_NAME</code> in ${settingsLocationPhrase}, redeploy, then sign in here again.</p>`
    }
    case "vault-name-ambiguous":
      return `<p>This Obsidian account has more than one vault named <code>${escapeHtml(problem.vaultName)}</code>, so the server cannot tell which one to sync.</p>
  <p>Rename one of them in Obsidian, then sign in here again.</p>`
    case "password-missing":
      return `<p>The vault <code>${escapeHtml(problem.vaultName)}</code> is end-to-end encrypted, and <code>VAULT_PASSWORD</code> is not set.</p>
  <p>Add <code>VAULT_PASSWORD</code> — the vault's encryption password — to ${settingsLocationPhrase}, redeploy, then sign in here again.</p>`
    case "vault-access-rejected":
      return `<p>Obsidian did not accept <code>VAULT_PASSWORD</code> for the vault <code>${escapeHtml(problem.vaultName)}</code>: ${escapeHtml(problem.apiMessage)}</p>
  <p>Fix <code>VAULT_PASSWORD</code> — the vault's encryption password — in ${settingsLocationPhrase}, redeploy, then sign in here again.</p>`
    case "vault-key-underivable":
      return underivableKeyCopy(problem)
  }
}

const underivableKeyCopy = ({
  vaultName,
  encryptionVersion,
}: Extract<PreflightProblem, { kind: "vault-key-underivable" }>): string => {
  if (encryptionVersion === undefined) {
    return `<p>Obsidian's vault listing did not include what this server needs to check the password for <code>${escapeHtml(vaultName)}</code>, so syncing it would fail on the next start.</p>
  <p>Try again in a few minutes. If it keeps happening, report it with the vault's Obsidian Sync settings.</p>`
  }
  const remedy =
    encryptionVersion > NEWEST_SUPPORTED_ENCRYPTION_VERSION
      ? "Update the server to a newer release, redeploy, then sign in here again."
      : "Report it with the vault's Obsidian Sync settings."
  return `<p>The vault <code>${escapeHtml(vaultName)}</code> uses encryption version ${escapeHtml(String(encryptionVersion))}, which the Obsidian Sync client this server ships does not support, so syncing it would fail on the next start.</p>
  <p>${remedy}</p>`
}

const renderBlocked = ({
  accountEmail,
  problem,
  hostingPlatform,
}: Extract<SetupView, { kind: "blocked" }>): string =>
  shell(
    "One more setting",
    `<h1>One more setting</h1>
  <p>Signed in as <strong>${escapeHtml(accountEmail)}</strong>.</p>
  ${problemCopy(problem, settingsLocation(hostingPlatform))}
  <p class="muted">Nothing was saved this time; the sign-in only takes a moment to repeat.</p>`,
  )

/** Polls /healthz until the full server answers (no <code>mode: setup</code>
 *  in the body), tolerating the connection failures of the restart. */
const COMPLETE_SCRIPT = `(function(){function ready(){document.getElementById('waiting').hidden=true;document.getElementById('ready').hidden=false}function poll(){fetch('/healthz',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(b){if(b&&b.mode!=='setup'){ready();return}setTimeout(poll,5000)}).catch(function(){setTimeout(poll,5000)})}setTimeout(poll,5000)})();`

const renderComplete = ({
  accountEmail,
  mcpUrl,
}: Extract<SetupView, { kind: "complete" }>): string =>
  shell(
    "Setup complete",
    `<h1>Setup complete</h1>
  <div id="waiting">
    <p>Signed in as <strong>${escapeHtml(accountEmail)}</strong>. The server is restarting to download your vault and build its search index — a few minutes for a typical vault.</p>
    <p><span class="spinner"></span>Waiting for the server… this page updates by itself.</p>
    <p class="muted">If it never does: the container stopped and nothing restarted it. Start it again (for a plain <code>docker run</code>: <code>docker start vault-cortex</code>), then refresh this page.</p>
  </div>
  <div id="ready" hidden>
    <p>Signed in as <strong>${escapeHtml(accountEmail)}</strong>. Your vault is ready.</p>
    ${
      mcpUrl
        ? `<p>Connect your MCP client to <a href="${escapeHtml(mcpUrl)}"><code>${escapeHtml(mcpUrl)}</code></a> and approve it with your <code>MCP_AUTH_TOKEN</code>.</p>`
        : `<p>Connect your MCP client to this server's <code>/mcp</code> address and approve it with your <code>MCP_AUTH_TOKEN</code>.</p>`
    }
  </div>
  <script>${COMPLETE_SCRIPT}</script>`,
  )

const renderConfigured = (): string =>
  shell(
    "Already set up",
    `<h1>Already set up</h1>
  <p>This server is set up and running — there is nothing to do on this page.</p>`,
  )

export const renderSetupPage = (view: SetupView): string => {
  switch (view.kind) {
    case "sign-in":
      return renderSignIn(view)
    case "mfa":
      return renderMfa(view)
    case "blocked":
      return renderBlocked(view)
    case "complete":
      return renderComplete(view)
    case "configured":
      return renderConfigured()
  }
}

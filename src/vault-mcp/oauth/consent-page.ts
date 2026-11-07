/** Minimal HTML consent page for OAuth authorization flow. */

import { escapeHtml } from "../../utils/escape-html.js"

type ConsentPageParams = {
  /** The client's registered name; the page shows its ID when it has none. */
  clientName: string | undefined
  clientId: string
  redirectUri: string
  requestId: string
  error?: string
}

// A new sign-in always gets the vault scope, and no tool checks a scope, so
// approval grants whatever the tools allow.
const GRANT_DESCRIPTION = "Everything this server's tools can do in your vault"

/** Where Approve sends access, as the page shows it:
 *  - an address with a host: its scheme and host, port included. The scheme
 *    always shows, so an app link never reads as a website.
 *  - an address with no host, such as the app link `claude.ai:callback`: the
 *    address as written.
 *  The SDK passes only addresses URL.parse can read; one it cannot would also
 *  show as written. */
const redirectUriToDestination = (redirectUri: string): string => {
  const redirectUrl = URL.parse(redirectUri)

  if (!redirectUrl?.host) return redirectUri
  // Not URL.origin, which is "null" for an app scheme such as claude://.
  return `${redirectUrl.protocol}//${redirectUrl.host}`
}

export const renderConsentPage = ({
  clientName,
  clientId,
  redirectUri,
  requestId,
  error,
}: ConsentPageParams): string => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — Vault Cortex</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1117;color:#e4e4e7;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:1rem}
  .card{background:#1c1c22;border:1px solid #2e2e38;border-radius:12px;padding:2rem;max-width:420px;width:100%}
  h1{font-size:1.25rem;margin-bottom:1.5rem;color:#fafafa}
  .field{margin-bottom:1rem}
  .label{font-size:.75rem;color:#a1a1aa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
  .value{font-size:.9rem;color:#e4e4e7;word-break:break-all}
  .token-input{display:flex;gap:.5rem;margin-top:.25rem}
  .token-input input{flex:1;min-width:0;padding:.6rem .75rem;background:#0f1117;border:1px solid #2e2e38;border-radius:6px;color:#fafafa;font-size:.9rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .token-input input:focus{outline:none;border-color:#6366f1}
  .reveal{flex:0 0 auto;padding:0 .75rem;background:#27272a;border:1px solid #2e2e38;border-radius:6px;color:#a1a1aa;font-size:.8rem;cursor:pointer}
  .reveal:hover{background:#2e2e38;color:#e4e4e7}
  .actions{display:flex;gap:.75rem;margin-top:1.5rem}
  button{flex:1;padding:.6rem 1rem;border:none;border-radius:6px;font-size:.9rem;cursor:pointer;font-weight:500}
  .approve{background:#6366f1;color:#fff}
  .approve:hover{background:#4f46e5}
  .deny{background:#27272a;color:#a1a1aa;border:1px solid #2e2e38}
  .deny:hover{background:#2e2e38}
  .error{background:#7f1d1d;border:1px solid #991b1b;color:#fca5a5;padding:.5rem .75rem;border-radius:6px;font-size:.85rem;margin-bottom:1rem}
</style>
</head>
<body>
<div class="card">
  <h1>Authorize access</h1>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <div class="field">
    <div class="label">Application</div>
    <div class="value">${escapeHtml(clientName || clientId)}</div>
  </div>
  <div class="field">
    <div class="label">Client ID</div>
    <div class="value">${escapeHtml(clientId)}</div>
  </div>
  <div class="field">
    <div class="label">Sends access to</div>
    <div class="value">${escapeHtml(redirectUriToDestination(redirectUri))}</div>
  </div>
  <div class="field">
    <div class="label">Access</div>
    <div class="value">${escapeHtml(GRANT_DESCRIPTION)}</div>
  </div>
  <form method="POST" action="/oauth/decide">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <div class="field">
      <div class="label">Server token</div>
      <div class="token-input">
        <input type="password" id="token" name="token" placeholder="Enter your MCP_AUTH_TOKEN" required autocomplete="off">
        <button type="button" class="reveal" aria-label="Show or hide token" onclick="var tokenInput=document.getElementById('token');var hidden=tokenInput.type==='password';tokenInput.type=hidden?'text':'password';this.textContent=hidden?'Hide':'Show'">Show</button>
      </div>
    </div>
    <div class="actions">
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
      <button type="submit" name="action" value="approve" class="approve">Approve</button>
    </div>
  </form>
</div>
</body>
</html>`
}

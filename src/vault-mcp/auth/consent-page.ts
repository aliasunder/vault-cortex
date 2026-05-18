/** Minimal HTML consent page for OAuth authorization flow. */

export type ConsentPageParams = {
  clientName: string
  clientId: string
  scopes: string[]
  requestId: string
  error?: string
}

export const renderConsentPage = ({
  clientName,
  clientId,
  scopes,
  requestId,
  error,
}: ConsentPageParams): string => {
  const escapeHtml = (text: string): string =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")

  const scopeList = scopes.length
    ? scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")
    : "<li><em>No specific scopes requested</em></li>"

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — vault-cortex</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1117;color:#e4e4e7;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:1rem}
  .card{background:#1c1c22;border:1px solid #2e2e38;border-radius:12px;padding:2rem;max-width:420px;width:100%}
  h1{font-size:1.25rem;margin-bottom:1.5rem;color:#fafafa}
  .field{margin-bottom:1rem}
  .label{font-size:.75rem;color:#a1a1aa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
  .value{font-size:.9rem;color:#e4e4e7;word-break:break-all}
  ul{list-style:none;padding:0}
  ul li{padding:.25rem 0;font-size:.9rem}
  ul li::before{content:"\\2022";color:#6366f1;margin-right:.5rem}
  input[type=password]{width:100%;padding:.6rem .75rem;background:#0f1117;border:1px solid #2e2e38;border-radius:6px;color:#fafafa;font-size:.9rem;margin-top:.25rem}
  input[type=password]:focus{outline:none;border-color:#6366f1}
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
    <div class="value">${escapeHtml(clientName)}</div>
  </div>
  <div class="field">
    <div class="label">Client ID</div>
    <div class="value">${escapeHtml(clientId)}</div>
  </div>
  <div class="field">
    <div class="label">Requested scopes</div>
    <ul>${scopeList}</ul>
  </div>
  <form method="POST" action="/oauth/decide">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <div class="field">
      <div class="label">Server token</div>
      <input type="password" name="token" placeholder="Enter your MCP_AUTH_TOKEN" required autocomplete="off">
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

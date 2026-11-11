/** The page a browser gets at /authorize when the client's registration is
 *  gone. It names the recovery for each supported client and echoes nothing
 *  from the request, because the request came from a link anyone could
 *  have written. */

export const UNKNOWN_CLIENT_TITLE = "This sign-in can't continue"

export const renderUnknownClientPage = (): string => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in can't continue — Vault Cortex</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1117;color:#e4e4e7;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:1rem}
  .card{background:#1c1c22;border:1px solid #2e2e38;border-radius:12px;padding:2rem;max-width:480px;width:100%}
  h1{font-size:1.25rem;margin-bottom:1rem;color:#fafafa}
  p{font-size:.9rem;line-height:1.5;margin-bottom:1rem}
  ul{font-size:.9rem;line-height:1.5;padding-left:1.25rem}
  li{margin-bottom:.5rem}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;background:#0f1117;border:1px solid #2e2e38;border-radius:4px;padding:0 .3rem}
</style>
</head>
<body>
<div class="card">
  <h1>${UNKNOWN_CLIENT_TITLE}</h1>
  <p>The server no longer has this client's registration. That happens when the server's data was reset, or when a sign-in was started but never finished.</p>
  <p>To reconnect, remove the server from your client and add it again, so the client registers afresh:</p>
  <ul>
    <li><strong>Claude Code:</strong> <code>claude mcp remove &lt;name&gt;</code>, then <code>claude mcp add</code> with the same address.</li>
    <li><strong>claude.ai, Claude Desktop and the mobile apps:</strong> remove the connector under Settings → Connectors, then add it again.</li>
    <li><strong>mcp-remote:</strong> delete <code>~/.mcp-auth</code> and restart the client.</li>
    <li><strong>Other clients:</strong> remove the server and add it again.</li>
  </ul>
</div>
</body>
</html>`
}

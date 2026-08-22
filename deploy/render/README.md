# Render Quickstart (one-click)

Run Vault Cortex on [Render](https://render.com) from a button — no server to
manage. Render gives you HTTPS, restarts, and a log viewer; Obsidian Sync keeps
your vault current; MCP tools work from Claude Desktop, Claude Code, claude.ai,
or any MCP client.

The button deploys the `vault-cortex:remote` image — Obsidian Sync and the
MCP server supervised together in **one container** — from the
[`render.yaml`](../../render.yaml) Blueprint at the root of this repository,
with one persistent disk holding your vault, the search index, and Obsidian
Sync's device state
([how the container is put together →](../../ARCHITECTURE.md#container-startup)).
Prefer your own VPS? Use the [remote quickstart](../remote/) instead.

**Contents** — [Prerequisites](#prerequisites) · [Deploy](#deploy) · [Your URL and token](#your-url-and-token) · [Security](#security) · [First start](#first-start) · [Connect](#connect-your-mcp-client) · [Verify](#verify) · [Updating](#updating) · [Restart, stop, delete](#restart-stop-delete) · [Config](#configuration) · [Troubleshooting](#troubleshooting)

## Prerequisites

- A [Render](https://render.com) account with a payment card on file. The
  free Hobby workspace is enough; the **Standard** instance (1 CPU, 2 GB) and
  the 5 GB disk the Blueprint creates are paid compute — about
  **$26 USD/month**, billed by the second
  ([Render's pricing](https://render.com/pricing)).
- An [Obsidian Sync](https://obsidian.md/sync) subscription
- Your Obsidian Sync login token — see
  [Getting your Obsidian Sync token](#getting-your-obsidian-sync-token)
  below. It is the one step that happens on your own computer.

### Getting your Obsidian Sync token

The token lets the container log in to Obsidian Sync as you. Obsidian only
hands it out after an interactive login, so this step runs in a terminal on
your computer — once, before you click the button.

1. **Open a terminal.** macOS: **Applications → Utilities → Terminal**.
   Windows: search the Start menu for **Terminal** (or **PowerShell**).
2. **Install Node.js** if you don't have it: download the LTS installer from
   [nodejs.org](https://nodejs.org) and run it. (Already have Docker but not
   Node? See the alternative below.)
3. **Paste this line and press Enter:**

   ```bash
   npx vault-cortex@latest get-sync-token
   ```

   It asks for your Obsidian account email, password, and two-factor code
   (if you use one), prints the token, and exits. Nothing is installed
   permanently.

4. **Copy the token.** The deploy form asks for it as `OBSIDIAN_AUTH_TOKEN`.

With Docker instead of Node.js, the same helper runs in a throwaway
container:

```bash
docker run --rm -it --entrypoint get-sync-token \
  ghcr.io/aliasunder/vault-cortex:remote
```

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/aliasunder/vault-cortex)

Render asks for a card first if your workspace has none on file, then reads
the Blueprint and asks for a **Blueprint Name** (any name) and four values
before it creates anything:

| Field                 | Value                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBSIDIAN_AUTH_TOKEN` | The token from [Getting your Obsidian Sync token](#getting-your-obsidian-sync-token)                                                                                                                                            |
| `VAULT_NAME`          | Your vault's name, exactly as it appears in Obsidian Sync                                                                                                                                                                       |
| `VAULT_PASSWORD`      | Only if your vault uses end-to-end encryption; otherwise leave empty                                                                                                                                                            |
| `TZ`                  | Your timezone as an [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List) (`America/Toronto`) — decides what "today" means for daily notes, task due dates, and memory timestamps. Leave empty for UTC |

Fill the token, vault name, and (for an encrypted vault) password in
**before** the first deploy — a container that starts without them stops at
Obsidian Sync setup. A value you missed is added later under the service's
**Environment** tab, followed by **Manual Deploy** (see
[Troubleshooting](#troubleshooting)).

Click **Deploy Blueprint**. Render creates the service and disk, pulls the
image, and starts the first deploy. Everything else — the MCP token, the public URL, the
port, the storage layout — is set by the Blueprint.

## Your URL and token

- **URL:** shown at the top of the service page, `https://<name>.onrender.com`.
  Your MCP client connects at `https://<name>.onrender.com/mcp`.
- **Token:** `MCP_AUTH_TOKEN` under the service's **Environment** tab. Render
  generated it for you; your MCP client enters it once on the consent page.

## Security

Out of the box, every request to your instance travels over HTTPS to
Render's edge and is checked by the server before any vault data moves:

- **HTTPS everywhere.** Render provisions and renews the certificate and
  terminates TLS at its edge; the container is never reachable directly.
- **Nothing without the token.** `/mcp` answers `401` to any request that
  lacks a valid token. OAuth clients get one through the consent page (full
  OAuth 2.1 with PKCE and refresh-token rotation); scripts send
  `MCP_AUTH_TOKEN` as a bearer header. The login, registration, and token
  endpoints are rate-limited per visitor address — `TRUST_PROXY_HOPS=2` is
  what lets the server see that address through Render's proxies.
- **Encrypted at rest, snapshotted daily.** The disk holding your vault,
  index, and Sync device state is encrypted, and Render snapshots it every
  24 hours (kept at least seven days) — restore from **Disks → Snapshots**.
- **Logs carry no secrets.** The server logs note paths, headings, search
  queries, and error text — your vault's own metadata — never tokens,
  passwords, or note bodies.

What the server can't protect is the Render account that holds it: anyone
who can open this service in the dashboard can read the environment
variables, the logs, and the disk. Two steps close that, both from the
dashboard:

1. **Turn on two-factor authentication** for your Render account
   (**Account Settings → Account Security**). The environment variables
   hold the credentials that grant access to your vault.
2. **Keep the workspace to yourself.** Members you invite can read every
   environment variable and every log line, search queries included.

Optional settings narrow what a connected client can do — change them
under **Environment**: `READONLY_MODE=true` removes every tool that writes
to the vault, and `FILE_TOOLS_ENABLED=false` or `MEMORY_ENABLED=false` hide
those tool groups entirely (see [Configuration](#configuration)).

Rotating `MCP_AUTH_TOKEN` invalidates the access tokens issued under it;
clients that still hold a refresh token reconnect on their own, so remove
the server from a client you no longer trust rather than relying on
rotation alone. The full attack-surface inventory is in
[SECURITY.md](../../SECURITY.md).

## First start

The first deploy takes longer than later ones. In order, the container logs
in to Obsidian Sync, registers a device named **vault-cortex**, downloads your
vault, builds the search index, and only then answers health checks and
receives traffic. Render allows up to 15 minutes for this; a large vault can
take most of it.

Watch the **Logs** tab. Lines prefixed `[obsidian-sync]` are the Sync setup
and download; `[vault-cortex]` lines show the storage layout and the public
URL the container derived (`PUBLIC_URL derived from RENDER_EXTERNAL_URL`);
the structured JSON lines are the MCP server. `server started` means the
deploy is about to go live.

## Connect your MCP client

Add a remote MCP server with URL `https://<name>.onrender.com/mcp`. Leave
OAuth Client ID and Secret empty; a consent page opens in your browser —
enter your `MCP_AUTH_TOKEN` to approve. Claude Code accepts the URL
directly:

```bash
claude mcp add --scope user --transport http vault-cortex https://<name>.onrender.com/mcp
```

Client-by-client details, including the static bearer-token form for CLI
tools, are in the remote quickstart's
[Connect your MCP client](../remote/#connect-your-mcp-client).

## Verify

```bash
curl https://<name>.onrender.com/healthz
# → {"ok":true}
```

In your MCP client, run a search — results come from your vault.

## Updating

Image services on Render don't redeploy on their own when a new image is
published. To update: open the service, click **Manual Deploy → Deploy latest
reference**. Render pulls the current `:remote` image and restarts the
container; your vault, search index, and Sync device stay on the disk, so the
update is quick and registers no new device.

Release notes: [GitHub Releases](https://github.com/aliasunder/vault-cortex/releases).

## Restart, stop, delete

All from the service page:

- **Restart** — **Manual Deploy → Restart service**. Same container, same disk.
- **Stop** — **Settings → Suspend Service**. Billing stops; the disk and
  everything on it stay. **Resume** picks up where it left off.
- **Delete** — two steps, because the Blueprint would otherwise re-create
  the service: open the Blueprint (**Blueprints** in the left nav) →
  **Settings → Disconnect Blueprint**, then the service → **Settings →
  Delete Service**. Deleting the service deletes the disk too. Your vault in
  Obsidian Sync is untouched — the container only held a copy.

## Configuration

The Blueprint sets these; change them under the service's **Environment**
tab (each change triggers a redeploy):

| Variable              | Value           | What it does                                                                                                                                            |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_ROOT`        | `/persist`      | Where the disk is mounted — the vault, search index, Sync device state, and logs live under it. Leave as is.                                            |
| `PORT`                | `8000`          | The port the image listens on. Leave as is.                                                                                                             |
| `DEVICE_NAME`         | `vault-cortex`  | The device name that labels this container's changes in Obsidian's sync log.                                                                            |
| `TRUST_PROXY_HOPS`    | `2`             | Render's network puts two proxies between a visitor and the container; this lets the server see the visitor's real address in its logs and rate limits. |
| `MCP_AUTH_TOKEN`      | generated       | Your MCP client's token. Change it here to rotate it.                                                                                                   |
| `OBSIDIAN_AUTH_TOKEN` | yours           | Obsidian Sync login. Re-run `get-sync-token` and paste the new value if Sync ever rejects it.                                                           |
| `VAULT_NAME`          | yours           | The vault this container syncs.                                                                                                                         |
| `VAULT_PASSWORD`      | yours / empty   | End-to-end encryption password, if your vault has one.                                                                                                  |
| `TZ`                  | yours / empty   | Timezone for daily notes, task due dates, and memory timestamps. Empty means UTC.                                                                       |
| `MEMORY_ENABLED`      | `true`          | The About Me/ memory layer and its tools. Set `false` to hide them and skip creating the folder.                                                        |
| `EMBEDDING_ENABLED`   | `true`          | Semantic search. Set `false` to skip the models and use keyword search only — the container fits in much less memory.                                   |
| `READONLY_MODE`       | `false`         | Set `true` to hide every tool that changes the vault — clients can only read and search.                                                                |
| `FILE_TOOLS_ENABLED`  | `true`          | `vault_read_file` and `vault_list_files`. Set `false` when Obsidian Sync has attachment syncing off.                                                    |
| `SYNC_MODE`           | `bidirectional` | Sync direction: `bidirectional`, `pull-only`, or `push-only`.                                                                                           |

The last five are the settings most worth changing on a hosted instance;
the Blueprint pre-fills them with the image defaults so you can edit them in
place. Every other optional setting uses the same names as the remote
quickstart's [Configuration table](../remote/#configuration) — add it as a
new environment variable.

Don't set `PUBLIC_URL`, `LOG_DIR`, or `VAULT_PATH` — the container derives
them from `STORAGE_ROOT` and Render's own address variable at every start.

Instance size and disk size are changed under **Settings** (Render can grow a
disk, never shrink it).

## Troubleshooting

**The first deploy failed.** Open **Logs** and look at the last
`[obsidian-sync]` lines:

- `OBSIDIAN_AUTH_TOKEN is empty or unset` — the token wasn't entered. Add it
  under **Environment**, then **Manual Deploy**.
- `login was rejected` — the token is stale. Run `get-sync-token` again,
  update `OBSIDIAN_AUTH_TOKEN`, then **Manual Deploy**.
- `ob sync-setup failed` — the vault name doesn't match Obsidian Sync
  exactly (it is case-sensitive), or the vault is end-to-end encrypted and
  `VAULT_PASSWORD` is missing. Fix the variable, then **Manual Deploy**.
- `VAULT_NAME is not set` — add it under **Environment**, then **Manual
  Deploy**.

**The deploy timed out waiting for the health check.** Render allows 15
minutes from container start. The first start of a large vault — download
plus search-index build — can exceed that. Click **Manual Deploy** again: the
files and index that already reached the disk are reused, so the second
attempt is much faster. For very large vaults, set `EMBEDDING_ENABLED=false`
for the first deploy and remove it once the vault has synced.

**The logs show a fresh Obsidian Sync login and a full vault download on a
redeploy.** The container registered itself as a new device, which happens
when the disk was replaced or the device state under `/persist/config` was
removed. Nothing needs cleaning up — the old registration simply stops
syncing.

**`The vault is empty but this device has previously synced.`** The
container refused to start because the vault directory on the disk is empty
while the device state says a sync already happened — starting would push
deletions to your other devices. This happens only if something removed
`/persist/vault` by hand. Restore the disk from a snapshot (**Disks → Snapshots**
on the service page), or remove `/persist/config` as well to start over with
a fresh device.
